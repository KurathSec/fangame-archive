// GET /api/me/comments - returns the current logged-in user's comments history.

import { jsonResponse, errorResponse } from "../_lib/http.js";

export async function onRequestGet(context) {
  const { env } = context;
  const user = context.data.user; // Injected by global middleware

  if (!user) {
    return errorResponse("Unauthorized.", 401);
  }

  try {
    const { results } = await env.DB.prepare(`
      SELECT id, game_id, rating, difficulty, date, content, status, reviewed_by, created_ts
      FROM comments
      WHERE user_id = ?
      ORDER BY id DESC
    `)
    .bind(user.id)
    .all();

    const formatted = results.map(r => {
      return {
        id: `cmt-${r.id}`,
        game_id: r.game_id,
        snippet: r.content,
        rating: r.rating,
        status: r.status,
        time: r.date
      };
    });

    return jsonResponse({ success: true, comments: formatted });
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}
