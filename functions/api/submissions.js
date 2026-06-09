// Pages Function API for submitting games from D1.
// Supports Turnstile checks, daily KV limits (max 5), and recording to D1.

import { jsonResponse, errorResponse } from "./_lib/http.js";
import { verifyTurnstile } from "./_lib/validate.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const user = context.data.user; // Verified by middleware

  if (!user) {
    return errorResponse("Unauthorized.", 401);
  }

  try {
    const body = await request.json();
    const { title, author_name, external_url, tags, description, turnstile_token } = body;

    if (!title || !author_name || !external_url) {
      return errorResponse("Missing required fields.", 400);
    }

    // 1. Turnstile CAPTCHA validation
    const turnstileSecret = env.TURNSTILE_SECRET_KEY || "1x000000000000000000000000000000aa";
    const remoteIp = request.headers.get("CF-Connecting-IP") || "";
    const isCaptchaValid = await verifyTurnstile(turnstile_token, turnstileSecret, remoteIp);
    if (!isCaptchaValid) {
      return errorResponse("Turnstile verification failed.", 400);
    }

    // 2. Daily submission quota check (max 5 per day)
    const kv = env.ARCHIVE_KV;
    if (kv) {
      const todayStr = new Date().toISOString().split("T")[0].replace(/-/g, "");
      const quotaKey = `quota:submit:${user.id}:${todayStr}`;
      const usedVal = await kv.get(quotaKey);
      const usedCount = usedVal ? parseInt(usedVal, 10) : 0;
      if (usedCount >= 5) {
        return errorResponse("Daily submission limit reached (5/5).", 429);
      }
      // Increment and set TTL to 36 hours (129600 seconds)
      await kv.put(quotaKey, String(usedCount + 1), { expirationTtl: 129600 });
    }

    const tagsStr = JSON.stringify(tags || []);
    const createdTs = Date.now();

    // 3. Write submission into D1 as 'pending'
    await env.DB.prepare(`
      INSERT INTO game_submissions (submitter_id, title, author_name, external_url, tags, description, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `)
    .bind(
      user.id,
      title.trim(),
      author_name.trim(),
      external_url.trim(),
      tagsStr,
      description ? description.trim() : null,
      createdTs
    )
    .run();

    return jsonResponse({ success: true });
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}
