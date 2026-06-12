// Pages Function API for fetching and posting game comments from D1.
// Supports native comments, Turnstile checks, and daily KV quotas.

import { jsonResponse, errorResponse } from "./_lib/http.js";
import { verifyTurnstile } from "./_lib/validate.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const gameId = url.searchParams.get("game_id");

  if (!gameId) {
    return errorResponse("Missing game_id parameter.", 400);
  }

  // Get current logged-in user ID if present (injected by _middleware.js)
  const currentUserId = context.data.user ? context.data.user.id : "";

  try {
    // Left join users table to get the latest display name for native comments
    const { results } = await env.DB.prepare(`
      SELECT 
        c.id, 
        c.game_id, 
        c.user AS legacy_user, 
        u.display_name AS native_user, 
        c.rating, 
        c.difficulty, 
        c.likes, 
        c.date, 
        c.content, 
        c.tags, 
        c.source, 
        c.status,
        c.user_id
      FROM comments c
      LEFT JOIN users u ON c.user_id = u.id
      WHERE c.game_id = ? AND (c.status = 'approved' OR c.user_id = ?)
      ORDER BY c.id DESC
    `)
    .bind(parseInt(gameId, 10), currentUserId)
    .all();

    const formatted = results.map(r => {
      let parsedTags = [];
      if (r.tags) {
        try {
          parsedTags = JSON.parse(r.tags);
        } catch (e) {
          parsedTags = [];
        }
      }
      return {
        id: r.id,
        user: (r.source === "native" && r.native_user) ? r.native_user : r.legacy_user,
        rating: r.rating,
        diff: r.difficulty,
        liked: r.likes || 0,
        date: r.date,
        body: r.content,
        tags: parsedTags,
        source: r.source || "imported",
        status: r.status || "approved",
        user_id: r.user_id || null
      };
    });

    return jsonResponse({ success: true, comments: formatted }, 200, {
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    });
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const user = context.data.user; // Verified by middleware

  if (!user) {
    return errorResponse("Unauthorized.", 401);
  }

  try {
    const body = await request.json();
    const { game_id, rating, difficulty, content, tags, turnstile_token } = body;

    if (!game_id || !content) {
      return errorResponse("Missing required fields.", 400);
    }

    // Validate tag constraints (max 10 tags, 20 characters per tag)
    if (tags && Array.isArray(tags)) {
      if (tags.length > 10) {
        return errorResponse("Maximum of 10 tags allowed.", 400);
      }
      for (const t of tags) {
        if (typeof t !== 'string' || t.length > 20) {
          return errorResponse("Each tag must be a string and under 20 characters.", 400);
        }
      }
    }

    // 1. Turnstile CAPTCHA validation
    const turnstileSecret = env.TURNSTILE_SECRET_KEY || "1x000000000000000000000000000000aa";
    const remoteIp = request.headers.get("CF-Connecting-IP") || "";
    const isCaptchaValid = await verifyTurnstile(turnstile_token, turnstileSecret, remoteIp);
    if (!isCaptchaValid) {
      return errorResponse("Turnstile verification failed.", 400);
    }

    // 2. Daily comment quota check (max 20 per day)
    const kv = env.ARCHIVE_KV;
    if (kv) {
      const todayStr = new Date().toISOString().split("T")[0].replace(/-/g, "");
      const quotaKey = `quota:comment:${user.id}:${todayStr}`;
      const usedVal = await kv.get(quotaKey);
      const usedCount = usedVal ? parseInt(usedVal, 10) : 0;
      if (usedCount >= 20) {
        return errorResponse("Daily comment limit reached (20/20).", 429);
      }
      // Increment and set TTL to 36 hours (129600 seconds)
      await kv.put(quotaKey, String(usedCount + 1), { expirationTtl: 129600 });
    }

    const dateStr = new Date().toISOString().split("T")[0];
    const tagsStr = JSON.stringify(tags || []);
    const createdTs = Date.now();

    // 3. Write native comment into D1 as 'pending'
    // INSERT OR IGNORE pairs with the unique dedup index (game_id, user, content) so an
    // accidental exact re-post cannot create a duplicate row.
    await env.DB.prepare(`
      INSERT OR IGNORE INTO comments (game_id, user, user_id, rating, difficulty, date, content, tags, source, status, created_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'native', 'pending', ?)
    `)
    .bind(
      parseInt(game_id, 10),
      user.display_name,
      user.id,
      rating !== undefined && rating !== null ? parseFloat(rating) : null,
      difficulty !== undefined && difficulty !== null ? parseFloat(difficulty) : null,
      dateStr,
      content,
      tagsStr,
      createdTs
    )
    .run();

    return jsonResponse({ success: true });
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}
