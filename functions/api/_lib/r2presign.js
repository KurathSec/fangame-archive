// Minimal AWS Signature V4 *query-string* presigner, implemented with Web Crypto
// (no dependencies, runs as-is in Cloudflare Pages Functions). It produces a
// short-lived URL the browser can PUT a file to directly on R2's S3-compatible
// endpoint — bypassing the ~100 MB Worker/Pages request-body limit (a single
// presigned PUT handles objects up to ~5 GB).
//
// Ported verbatim from the admin app's functions/api/_r2presign.js — keep the
// two copies in sync if the signing logic ever changes.

const enc = new TextEncoder();

function hex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

async function sha256Hex(message) {
  const data = typeof message === "string" ? enc.encode(message) : message;
  const hash = await crypto.subtle.digest("SHA-256", data);
  return hex(new Uint8Array(hash));
}

async function hmac(key, msg) {
  const raw = typeof key === "string" ? enc.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(msg)));
}

// RFC3986 percent-encoding. AWS encodes every byte except the unreserved set;
// "/" is preserved in the path but encoded (%2F) inside query values.
function uriEncode(str, encodeSlash) {
  let out = "";
  for (const ch of String(str)) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch;
    } else if (ch === "/" && !encodeSlash) {
      out += "/";
    } else {
      for (const b of enc.encode(ch)) out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

// Core signer. `canonicalUri` must already be path-encoded. `amzDate`
// (YYYYMMDDTHHMMSSZ) is injectable for testing; otherwise "now" is used.
export async function presignS3({
  method = "PUT", host, canonicalUri, accessKeyId, secretAccessKey,
  region = "auto", service = "s3", expires = 3600, amzDate = null,
}) {
  amzDate = amzDate || new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;

  const params = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.keys(params).sort()
    .map((k) => uriEncode(k, true) + "=" + uriEncode(params[k], true))
    .join("&");

  const canonicalRequest = [
    method, canonicalUri, canonicalQuery,
    `host:${host}\n`, "host", "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest),
  ].join("\n");

  let key = await hmac("AWS4" + secretAccessKey, dateStamp);
  key = await hmac(key, region);
  key = await hmac(key, service);
  key = await hmac(key, "aws4_request");
  const signature = hex(await hmac(key, stringToSign));

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// Presign a PUT to an R2 object (bucket/key) on the account's S3 endpoint.
export async function presignPutUrl({ accountId, accessKeyId, secretAccessKey, bucket, key, expires = 3600, region = "auto" }) {
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = "/" + uriEncode(bucket, false) + "/" + uriEncode(key, false);
  return presignS3({ method: "PUT", host, canonicalUri, accessKeyId, secretAccessKey, region, expires });
}
