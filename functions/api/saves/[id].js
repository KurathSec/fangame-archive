// One game's browser-play saves in the caller's account (/play/ keeps them in sync):
//   GET    -> { save: { data, updated_at } | null }
//   PUT    body: the player's exported saves (JSON {format: "gmrecomp-saves", files: [...]})
//          -> { updated_at }
//   DELETE -> removes them
import { jsonResponse, errorResponse } from "../_lib/http.js";

// D1 keeps a row under 2 MB; base64 makes the JSON a third larger than the files.
const MAX_BYTES = 1500000;
// games with saves per account
const MAX_GAMES = 30000;
const NO_STORE = { "Cache-Control": "no-store" };

function gameId(context) {
  const id = Number.parseInt(context.params.id, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function onRequestGet(context) {
  const user = context.data.user;
  if (!user) return errorResponse("Unauthorized.", 401);
  const id = gameId(context);
  if (!id) return errorResponse("Invalid game id.", 400);
  try {
    const row = await context.env.DB.prepare(
      "SELECT data, updated_at FROM game_saves WHERE user_id = ? AND game_id = ?"
    ).bind(user.id, id).first();
    return jsonResponse({ success: true, save: row || null }, 200, NO_STORE);
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}

export async function onRequestPut(context) {
  const user = context.data.user;
  if (!user) return errorResponse("Unauthorized.", 401);
  const id = gameId(context);
  if (!id) return errorResponse("Invalid game id.", 400);
  const text = await context.request.text();
  const size = new TextEncoder().encode(text).length;
  if (size > MAX_BYTES) return errorResponse("These saves are too large to keep in the account.", 413);
  let saves;
  try {
    saves = JSON.parse(text);
  } catch {
    return errorResponse("Saves must be JSON.", 400);
  }
  if (!saves || saves.format !== "gmrecomp-saves" || !Array.isArray(saves.files)) {
    return errorResponse("Not a gm-recomp saves file.", 400);
  }
  try {
    const { DB } = context.env;
    const exists = await DB.prepare("SELECT 1 FROM game_saves WHERE user_id = ? AND game_id = ?").bind(user.id, id).first();
    if (!exists) {
      const count = await DB.prepare("SELECT COUNT(*) AS n FROM game_saves WHERE user_id = ?").bind(user.id).first();
      if ((count?.n || 0) >= MAX_GAMES) return errorResponse("Too many games with saves in this account.", 409);
    }
    const now = Date.now();
    await DB.prepare(
      `INSERT INTO game_saves (user_id, game_id, data, size, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, game_id) DO UPDATE SET data = excluded.data, size = excluded.size, updated_at = excluded.updated_at`
    ).bind(user.id, id, text, size, now).run();
    return jsonResponse({ success: true, updated_at: now }, 200, NO_STORE);
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}

export async function onRequestDelete(context) {
  const user = context.data.user;
  if (!user) return errorResponse("Unauthorized.", 401);
  const id = gameId(context);
  if (!id) return errorResponse("Invalid game id.", 400);
  try {
    await context.env.DB.prepare("DELETE FROM game_saves WHERE user_id = ? AND game_id = ?").bind(user.id, id).run();
    return jsonResponse({ success: true }, 200, NO_STORE);
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}
