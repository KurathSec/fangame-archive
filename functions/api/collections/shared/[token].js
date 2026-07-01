// Pages Function API: read a shared collection by its opaque token. No auth.
// Serves unlisted collections always, and public collections only once approved.
// GET /api/collections/shared/:token
import { jsonResponse, errorResponse } from "../../_lib/http.js";

export async function onRequestGet(context) {
  const { env, params } = context;
  try {
    const token = params.token;
    if (!token) return errorResponse("Missing token.", 400);

    const col = await env.DB.prepare(`
      SELECT c.id, c.name, c.description, c.visibility, c.moderation_status,
             c.share_show_owner, c.created_at, u.status AS owner_status,
             CASE WHEN c.share_show_owner = 1 THEN u.display_name ELSE NULL END AS owner_name
      FROM collections c
      LEFT JOIN users u ON u.id = c.user_id
      WHERE c.share_token = ?
    `).bind(token).first();

    // Only unlisted, or public that has been approved, are readable by link —
    // and never from a banned owner.
    const shareable = col && col.owner_status !== "banned" && (
      col.visibility === "unlisted" ||
      (col.visibility === "public" && col.moderation_status === "approved")
    );
    if (!shareable) return errorResponse("Shared collection not found.", 404);

    const { results } = await env.DB.prepare(
      `SELECT game_id FROM collection_items WHERE collection_id = ? ORDER BY sort_order IS NULL, sort_order, created_at DESC`
    ).bind(col.id).all();

    return jsonResponse({
      success: true,
      collection: {
        name: col.name || null,
        description: col.description || null,
        owner_name: col.owner_name || null,
        visibility: col.visibility,
        game_ids: results.map(r => r.game_id),
      },
    }, 200, { "Cache-Control": "public, max-age=120" });
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}
