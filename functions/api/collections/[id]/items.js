// Pages Function API: add a game to a collection (list). POST { gameId }.
import { jsonResponse, errorResponse } from "../../_lib/http.js";
import { LIMITS, getOwnedCollection } from "../../_lib/collections.js";

export async function onRequestPost(context) {
  const { request, env, params } = context;
  const user = context.data.user;
  if (!user) return errorResponse("Unauthorized.", 401);

  try {
    const col = await getOwnedCollection(env, user.id, params.id);
    if (!col) return errorResponse("Collection not found.", 404);

    // A folder (has sub-collections) cannot hold games.
    const kids = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM collections WHERE parent_id = ?`
    ).bind(col.id).first();
    if (kids && kids.n > 0) return errorResponse("This collection contains sub-collections and cannot hold games.", 400);

    const body = await request.json();
    if (body.gameId === undefined || body.gameId === null) return errorResponse("Missing gameId parameter.", 400);
    const gameId = parseInt(body.gameId, 10);
    if (isNaN(gameId)) return errorResponse("Invalid gameId parameter.", 400);

    // Only enforce the cap for a genuinely new membership — re-adding a game
    // that is already in the list is an idempotent no-op, never a "full" error.
    const existing = await env.DB.prepare(
      `SELECT 1 FROM collection_items WHERE collection_id = ? AND game_id = ?`
    ).bind(col.id, gameId).first();
    if (!existing) {
      const count = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM collection_items WHERE collection_id = ?`
      ).bind(col.id).first();
      if (count && count.n >= LIMITS.ITEMS) return errorResponse(`This collection is full (max ${LIMITS.ITEMS} games).`, 400);
    }

    await env.DB.prepare(
      `INSERT OR IGNORE INTO collection_items (collection_id, game_id, created_at) VALUES (?, ?, ?)`
    ).bind(col.id, gameId, Date.now()).run();

    // Touch the collection so listings re-sort by recency if desired.
    await env.DB.prepare(`UPDATE collections SET updated_at = ? WHERE id = ?`).bind(Date.now(), col.id).run();

    return jsonResponse({ success: true });
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}
