// Clerk JWT verification and user profile fetching.

function base64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) {
    str += "=";
  }
  return atob(str);
}

function base64urlToUint8Array(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) {
    str += "=";
  }
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

let jwksCache = null;
let jwksCacheExpiry = 0;

async function fetchJwks(jwksUrl) {
  const now = Date.now();
  if (jwksCache && now < jwksCacheExpiry) {
    return jwksCache;
  }
  const res = await fetch(jwksUrl);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const data = await res.json();
  jwksCache = data.keys || [];
  jwksCacheExpiry = now + 10 * 60 * 1000; // 10 minutes cache
  return jwksCache;
}

function getJwksUrl(publishableKey) {
  if (!publishableKey) throw new Error("Missing CLERK_PUBLISHABLE_KEY");
  const parts = publishableKey.split("_");
  const encodedDomain = parts[parts.length - 1];
  let domainWithDollar = atob(encodedDomain);
  const domain = domainWithDollar.endsWith("$") ? domainWithDollar.slice(0, -1) : domainWithDollar;
  return `https://${domain}/.well-known/jwks.json`;
}

export async function verifyClerkToken(token, publishableKey) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const header = JSON.parse(base64urlDecode(parts[0]));
    const payload = JSON.parse(base64urlDecode(parts[1]));
    const signatureBytes = base64urlToUint8Array(parts[2]);

    if (header.alg !== "RS256") return null;

    const jwksUrl = getJwksUrl(publishableKey);
    const keys = await fetchJwks(jwksUrl);
    const jwk = keys.find(k => k.kid === header.kid);
    if (!jwk) return null;

    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const encoder = new TextEncoder();
    const dataToVerify = encoder.encode(parts[0] + "." + parts[1]);
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      signatureBytes,
      dataToVerify
    );

    if (!verified) return null;

    // Verify time claims
    const nowSecs = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < nowSecs) return null;
    if (payload.nbf && payload.nbf > nowSecs) return null;

    return payload; // Returns verified payload (contains payload.sub)
  } catch (err) {
    console.error("Token verification failed:", err);
    return null;
  }
}

// Fetch user profile from Clerk API or local KV cache
export async function getClerkUserProfile(userId, secretKey, kvNamespace, bypassCache = false) {
  const cacheKey = `user_profile:${userId}`;

  if (kvNamespace && !bypassCache) {
    try {
      const cached = await kvNamespace.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (e) {
      console.warn("KV profile cache read error:", e);
    }
  }

  // Fetch from Clerk Backend API
  try {
    const res = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json"
      }
    });

    if (!res.ok) {
      throw new Error(`Clerk backend API returned status ${res.status}`);
    }

    const rawUser = await res.json();

    // Format display_name
    let display_name = rawUser.username;
    if (!display_name && (rawUser.first_name || rawUser.last_name)) {
      display_name = [rawUser.first_name, rawUser.last_name].filter(Boolean).join(" ");
    }
    if (!display_name && rawUser.email_addresses && rawUser.email_addresses.length > 0) {
      display_name = rawUser.email_addresses[0].email_address.split("@")[0];
    }
    if (!display_name) {
      display_name = `User_${userId.slice(-6)}`;
    }

    const email = rawUser.email_addresses && rawUser.email_addresses.length > 0
      ? rawUser.email_addresses[0].email_address
      : "";

    const profile = {
      id: userId,
      email,
      display_name,
      avatar_url: rawUser.image_url || ""
    };

    // Cache in KV for 1 hour (3600 seconds)
    if (kvNamespace) {
      try {
        await kvNamespace.put(cacheKey, JSON.stringify(profile), { expirationTtl: 3600 });
      } catch (e) {
        console.warn("KV profile cache write error:", e);
      }
    }

    return profile;
  } catch (err) {
    console.error("Failed to fetch user profile from Clerk API:", err);
    return {
      id: userId,
      email: "",
      display_name: `User_${userId.slice(-6)}`,
      avatar_url: ""
    };
  }
}
