// Pages Function API: which of the caller's lists contain a game (+ main favorite).
// GET /api/collections/membership?gameId=
import { jsonResponse, errorResponse } from "../_lib/http.js";

const NO_STORE = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  "Pragma": "no-cache",
  "Expires": "0",
};

export async function onRequestGet(context) {
  const { request, env } = context;
  const user = context.data.user;
  if (!user) return errorResponse("Unauthorized.", 401);

  try {
    const gameId = parseInt(new URL(request.url).searchParams.get("gameId"), 10);
    if (isNaN(gameId)) return errorResponse("Invalid gameId.", 400);

    const { results } = await env.DB.prepare(`
      SELECT ci.collection_id FROM collection_items ci
      JOIN collections c ON c.id = ci.collection_id
      WHERE c.user_id = ? AND ci.game_id = ?
    `).bind(user.id, gameId).all();

    const main = await env.DB.prepare(
      `SELECT 1 FROM user_favorites WHERE user_id = ? AND game_id = ?`
    ).bind(user.id, gameId).first();

    return jsonResponse({
      success: true,
      collectionIds: results.map(r => r.collection_id),
      main: !!main,
    }, 200, NO_STORE);
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}
