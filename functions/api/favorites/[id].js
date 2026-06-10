// Pages Function API for deleting a user favorite in Cloudflare D1.
import { jsonResponse, errorResponse } from "../_lib/http.js";

export async function onRequestDelete(context) {
  const { params, env } = context;
  const user = context.data.user; // Injected by global middleware
  const gameId = params.id;

  if (!user) {
    return errorResponse("Unauthorized.", 401);
  }

  if (!gameId) {
    return errorResponse("Missing gameId parameter.", 400);
  }

  try {
    const gameIdInt = parseInt(gameId, 10);
    if (isNaN(gameIdInt)) {
      return errorResponse("Invalid gameId parameter.", 400);
    }

    await env.DB.prepare(`
      DELETE FROM user_favorites 
      WHERE user_id = ? AND game_id = ?
    `)
    .bind(user.id, gameIdInt)
    .run();

    return jsonResponse({ success: true });
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}
