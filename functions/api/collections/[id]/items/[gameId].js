// Pages Function API: remove a game from a collection. DELETE.
import { jsonResponse, errorResponse } from "../../../_lib/http.js";
import { getOwnedCollection } from "../../../_lib/collections.js";

export async function onRequestDelete(context) {
  const { env, params } = context;
  const user = context.data.user;
  if (!user) return errorResponse("Unauthorized.", 401);

  try {
    const col = await getOwnedCollection(env, user.id, params.id);
    if (!col) return errorResponse("Collection not found.", 404);

    const gameId = parseInt(params.gameId, 10);
    if (isNaN(gameId)) return errorResponse("Invalid gameId parameter.", 400);

    await env.DB.prepare(
      `DELETE FROM collection_items WHERE collection_id = ? AND game_id = ?`
    ).bind(col.id, gameId).run();

    return jsonResponse({ success: true });
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}
