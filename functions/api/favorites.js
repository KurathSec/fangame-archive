// Pages Function API for listing and adding user favorites in Cloudflare D1.
import { jsonResponse, errorResponse } from "./_lib/http.js";

export async function onRequestGet(context) {
  const { env } = context;
  const user = context.data.user; // Injected by global middleware

  if (!user) {
    return errorResponse("Unauthorized.", 401);
  }

  try {
    const { results } = await env.DB.prepare(`
      SELECT game_id FROM user_favorites 
      WHERE user_id = ?
      ORDER BY id DESC
    `)
    .bind(user.id)
    .all();

    const ids = results.map(r => r.game_id);
    return jsonResponse(ids, 200, {
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
  const user = context.data.user; // Injected by global middleware

  if (!user) {
    return errorResponse("Unauthorized.", 401);
  }

  try {
    const body = await request.json();
    const { gameId } = body;

    if (gameId === undefined || gameId === null) {
      return errorResponse("Missing gameId parameter.", 400);
    }

    const gameIdInt = parseInt(gameId, 10);
    if (isNaN(gameIdInt)) {
      return errorResponse("Invalid gameId parameter.", 400);
    }

    const createdTs = Date.now();

    // Use INSERT OR IGNORE to prevent unique constraint failures
    await env.DB.prepare(`
      INSERT OR IGNORE INTO user_favorites (user_id, game_id, created_at)
      VALUES (?, ?, ?)
    `)
    .bind(user.id, gameIdInt, createdTs)
    .run();

    return jsonResponse({ success: true });
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}
