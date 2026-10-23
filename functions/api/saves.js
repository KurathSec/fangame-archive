// The caller's browser-play saves (/play/): which games have saves in the account, newest
// first. The saves themselves are at /api/saves/:gameId.
import { jsonResponse, errorResponse } from "./_lib/http.js";

const NO_STORE = { "Cache-Control": "no-store" };

export async function onRequestGet(context) {
  const user = context.data.user;
  if (!user) return errorResponse("Unauthorized.", 401);
  try {
    const { results } = await context.env.DB.prepare(
      "SELECT game_id, size, updated_at FROM game_saves WHERE user_id = ? ORDER BY updated_at DESC"
    ).bind(user.id).all();
    return jsonResponse({ success: true, saves: results }, 200, NO_STORE);
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}
