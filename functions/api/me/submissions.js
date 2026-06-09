// GET /api/me/submissions - returns the current logged-in user's own submissions history.

import { jsonResponse, errorResponse } from "../_lib/http.js";

export async function onRequestGet(context) {
  const { env } = context;
  const user = context.data.user; // Injected by global middleware

  if (!user) {
    return errorResponse("Unauthorized.", 401);
  }

  try {
    const { results } = await env.DB.prepare(`
      SELECT id, title, author_name, external_url, tags, description, status, reject_reason, created_at
      FROM game_submissions
      WHERE submitter_id = ?
      ORDER BY id DESC
    `)
    .bind(user.id)
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
        id: `sub-${r.id}`,
        title: r.title,
        author: r.author_name,
        url: r.external_url,
        tags: parsedTags,
        description: r.description || "",
        status: r.status,
        reason: r.reject_reason || null,
        time: new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ')
      };
    });

    return jsonResponse({ success: true, submissions: formatted });
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}
