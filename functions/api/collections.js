// Pages Function API: list the caller's collections + create a new one.
import { jsonResponse, errorResponse } from "./_lib/http.js";
import { LIMITS, cleanText } from "./_lib/collections.js";

const NO_STORE = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  "Pragma": "no-cache",
  "Expires": "0",
};

// GET /api/collections -> caller's collections (flat; client builds the tree
// from parent_id). Each row carries item_count + child_count.
export async function onRequestGet(context) {
  const { env } = context;
  const user = context.data.user;
  if (!user) return errorResponse("Unauthorized.", 401);

  try {
    const { results } = await env.DB.prepare(`
      SELECT c.id, c.parent_id, c.name, c.description, c.visibility,
             c.share_token, c.share_show_owner, c.moderation_status,
             c.reject_reason, c.sort_order, c.created_at, c.updated_at,
             (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = c.id) AS item_count,
             (SELECT COUNT(*) FROM collections k WHERE k.parent_id = c.id) AS child_count
      FROM collections c
      WHERE c.user_id = ?
      ORDER BY c.parent_id IS NOT NULL, c.sort_order IS NULL, c.sort_order, c.id
    `).bind(user.id).all();

    return jsonResponse({ success: true, collections: results }, 200, NO_STORE);
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}

// POST /api/collections { name?, description?, parentId? } -> create.
// Rules: ≤20 top-level per user; ≤5 subs per folder; 1-level nesting; a folder
// (has children) can't hold games and a list (has games) can't hold children —
// so a sub-collection may only be created under a childless, game-less parent.
export async function onRequestPost(context) {
  const { request, env } = context;
  const user = context.data.user;
  if (!user) return errorResponse("Unauthorized.", 401);

  try {
    const body = await request.json();
    const nameRes = cleanText(body.name, LIMITS.NAME, "Name");
    if (!nameRes.ok) return errorResponse(nameRes.error, 400);
    const descRes = cleanText(body.description, LIMITS.DESC, "Description");
    if (!descRes.ok) return errorResponse(descRes.error, 400);

    let parentId = null;
    if (body.parentId !== undefined && body.parentId !== null) {
      parentId = parseInt(body.parentId, 10);
      if (isNaN(parentId)) return errorResponse("Invalid parentId.", 400);

      const parent = await env.DB.prepare(
        `SELECT id, parent_id, visibility FROM collections WHERE id = ? AND user_id = ?`
      ).bind(parentId, user.id).first();
      if (!parent) return errorResponse("Parent collection not found.", 404);
      if (parent.parent_id !== null) return errorResponse("Collections can only nest one level deep.", 400);

      // Parent must not already be a list (hold games).
      const games = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM collection_items WHERE collection_id = ?`
      ).bind(parentId).first();
      if (games && games.n > 0) return errorResponse("This collection holds games and cannot contain sub-collections.", 400);

      const subs = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM collections WHERE parent_id = ?`
      ).bind(parentId).first();
      if (subs && subs.n >= LIMITS.SUBS) return errorResponse(`A collection can have at most ${LIMITS.SUBS} sub-collections.`, 400);

      // The parent becomes a folder now; folders can't be shared, so revoke any
      // existing share so we never leave a dangling link/public listing on it.
      if (parent.visibility && parent.visibility !== "private") {
        await env.DB.prepare(
          `UPDATE collections SET visibility='private', share_token=NULL, moderation_status=NULL, updated_at=? WHERE id=? AND user_id=?`
        ).bind(Date.now(), parentId, user.id).run();
      }
    } else {
      const top = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM collections WHERE user_id = ? AND parent_id IS NULL`
      ).bind(user.id).first();
      if (top && top.n >= LIMITS.TOP_LEVEL) return errorResponse(`You can create at most ${LIMITS.TOP_LEVEL} top-level collections.`, 400);
    }

    const now = Date.now();
    const res = await env.DB.prepare(`
      INSERT INTO collections (user_id, parent_id, name, description, visibility, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'private', ?, ?)
    `).bind(user.id, parentId, nameRes.value, descRes.value, now, now).run();

    const id = res.meta && res.meta.last_row_id;
    return jsonResponse({ success: true, id });
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}
