// Turnstile CAPTCHA validator using Cloudflare Siteverify API.

export async function verifyTurnstile(token, secretKey, remoteIp) {
  if (!token) return false;

  // Cloudflare Turnstile siteverify requires a POST request
  try {
    const formData = new FormData();
    formData.append("secret", secretKey);
    formData.append("response", token);
    if (remoteIp) {
      formData.append("remoteip", remoteIp);
    }

    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: formData
    });

    if (!res.ok) return false;

    const outcome = await res.json();
    return !!outcome.success;
  } catch (err) {
    console.error("Turnstile verification failed:", err);
    return false;
  }
}
