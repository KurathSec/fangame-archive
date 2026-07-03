// Shared constants + helpers for user-facing direct uploads on the submit-game
// form. Uploaded files stage under SubmissionUploads/<userId>/<uuid>.<ext> in
// the fangame-files bucket (publicly served at file.fangame-archive.com, keys
// unguessable). Lifecycle: the CI merge step promotes referenced files into
// Game/<id>.<ext> / the screenshots bucket and deletes the staging objects; the
// admin app deletes them on reject; a CI sweep removes oversize and >48h
// unreferenced leftovers. Keep the prefix/limits in sync with
// pipelines/merge_approved_submissions.py and the admin app's queue.js.

export const UPLOAD_PREFIX = "SubmissionUploads/";
export const FILES_PUBLIC_DOMAIN = "https://file.fangame-archive.com";

export const MAX_GAME_FILE_BYTES = 500 * 1024 * 1024; // per-file hard cap
export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
export const POOL_MAX_BYTES = 5 * 1024 * 1024 * 1024; // everyone's staged uploads combined

export const GAME_FILE_EXTS = [".zip", ".rar", ".7z", ".tar", ".gz", ".exe"];

// Daily per-user mints, tracked in KV alongside the existing submit quota.
export const DAILY_FILE_UPLOADS = 5;
export const DAILY_SCREENSHOT_UPLOADS = 25;
export const QUOTA_TTL_SECONDS = 129600; // 36 h, same as the submit quota keys

export function gameFileExtOf(filename) {
  const m = /(\.[A-Za-z0-9]{1,6})$/.exec(String(filename || "").trim());
  const ext = m ? m[1].toLowerCase() : "";
  return GAME_FILE_EXTS.includes(ext) ? ext : null;
}

export function stagingKeyFor(userId, ext) {
  return `${UPLOAD_PREFIX}${userId}/${crypto.randomUUID()}${ext}`;
}

export function publicUrlFor(key) {
  return `${FILES_PUBLIC_DOMAIN}/${key}`;
}

// Reverse of publicUrlFor: the staging key a public URL points at, or null if
// the URL is not one of ours.
export function stagingKeyFromUrl(url) {
  const prefix = `${FILES_PUBLIC_DOMAIN}/${UPLOAD_PREFIX}`;
  if (typeof url !== "string" || !url.startsWith(prefix)) return null;
  return url.slice(FILES_PUBLIC_DOMAIN.length + 1).split("?")[0];
}

// A key this user is allowed to touch: their own prefix and our exact
// <uuid>.<ext> shape, so a crafted key can't reach anything else.
export function userOwnsStagingKey(key, userId) {
  const own = `${UPLOAD_PREFIX}${userId}/`;
  if (typeof key !== "string" || !key.startsWith(own)) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,6}$/.test(key.slice(own.length));
}

// Total bytes currently staged (all users). One paginated list per upload
// attempt is fine at this scale — the pool holds at most a few dozen objects.
export async function poolUsageBytes(bucket) {
  let sum = 0;
  let cursor;
  do {
    const page = await bucket.list({ prefix: UPLOAD_PREFIX, cursor });
    for (const obj of page.objects) sum += obj.size || 0;
    cursor = page.truncated ? page.cursor : null;
  } while (cursor);
  return sum;
}

export function inflightKvKey(userId) {
  return `upload:inflight:${userId}`;
}

export function dailyQuotaKvKey(kind, userId) {
  const day = new Date().toISOString().split("T")[0].replace(/-/g, "");
  return `quota:${kind}:${userId}:${day}`;
}

// Consume one unit of a KV-backed daily quota. Returns false when exhausted.
// KV missing (local dev) fails open — the pool cap and auth still apply.
export async function consumeDailyQuota(kv, kind, userId, max) {
  if (!kv) return true;
  const key = dailyQuotaKvKey(kind, userId);
  const used = parseInt((await kv.get(key)) || "0", 10) || 0;
  if (used >= max) return false;
  await kv.put(key, String(used + 1), { expirationTtl: QUOTA_TTL_SECONDS });
  return true;
}

// Magic-byte sniff for the image formats we accept. Returns
// {ext, contentType} or null. The client-supplied filename/type is ignored.
export function sniffImage(bytes) {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { ext: ".png", contentType: "image/png" };
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { ext: ".jpg", contentType: "image/jpeg" };
  }
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return { ext: ".gif", contentType: "image/gif" };
  }
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return { ext: ".webp", contentType: "image/webp" };
  }
  return null;
}

export function r2Credentials(env) {
  const accountId = env.R2_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID;
  const accessKeyId = env.R2_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) return null;
  return { accountId, accessKeyId, secretAccessKey };
}
