// Pages Function API: one collection — detail (owner), update, delete.
import { jsonResponse, errorResponse } from "../_lib/http.js";
import { LIMITS, cleanText, isShareableUnlisted, getOwnedCollection } from "../_lib/collections.js";

const NO_STORE = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  "Pragma": "no-cache",
  "Expires": "0",
};

// GET /api/collections/:id -> owner-only detail incl. member game ids.
export async function onRequestGet(context) {
  const { env, params } = context;
  const user = context.data.user;
  if (!user) return errorResponse("Unauthorized.", 401);

  try {
    const col = await getOwnedCollection(env, user.id, params.id);
    if (!col) return errorResponse("Collection not found.", 404);

    const { results } = await env.DB.prepare(
      `SELECT game_id FROM collection_items WHERE collection_id = ? ORDER BY sort_order IS NULL, sort_order, created_at DESC`
    ).bind(col.id).all();

    col.game_ids = results.map(r => r.game_id);
    return jsonResponse({ success: true, collection: col }, 200, NO_STORE);
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}

// PATCH /api/collections/:id { name?, description?, sortOrder?, showOwner? }
// Lock rules: a public collection's name/description are immutable; editing an
// unlisted collection into custom free text reverts it to private (revokes the
// share link); editing a child of a PUBLIC folder into custom free text sends
// that child back to review (pending — hidden from the shared page meanwhile).
export async function onRequestPatch(context) {
  const { request, env, params } = context;
  const user = context.data.user;
  if (!user) return errorResponse("Unauthorized.", 401);

  try {
    const col = await getOwnedCollection(env, user.id, params.id);
    if (!col) return errorResponse("Collection not found.", 404);

    const body = await request.json();
    const wantsText = body.name !== undefined || body.description !== undefined;

    const sets = [];
    const binds = [];
    let pendingReview = false;

    if (wantsText) {
      if (col.visibility === "public") {
        return errorResponse("Public collections are locked. Revert to private to edit the name or description.", 409);
      }
      const nameRes = body.name !== undefined ? cleanText(body.name, LIMITS.NAME, "Name") : { ok: true, value: col.name };
      if (!nameRes.ok) return errorResponse(nameRes.error, 400);
      const descRes = body.description !== undefined ? cleanText(body.description, LIMITS.DESC, "Description") : { ok: true, value: col.description };
      if (!descRes.ok) return errorResponse(descRes.error, 400);

      sets.push("name = ?"); binds.push(nameRes.value);
      sets.push("description = ?"); binds.push(descRes.value);

      // Custom free text on an unlisted collection revokes its share link.
      if (col.visibility === "unlisted" && !isShareableUnlisted(nameRes.value, descRes.value)) {
        sets.push("visibility = 'private'");
        sets.push("share_token = NULL");
      }

      // Text change on a child of a PUBLIC folder re-gates it: custom text goes
      // back to pending review; reverting to preset/blank clears the flag.
      const textChanged = (nameRes.value || null) !== (col.name || null) ||
                          (descRes.value || null) !== (col.description || null);
      if (textChanged && col.parent_id !== null) {
        const parent = await env.DB.prepare(
          `SELECT visibility, moderation_status FROM collections WHERE id = ? AND user_id = ?`
        ).bind(col.parent_id, user.id).first();
        // A rejected public parent gates nothing (dead share page; a pending
        // child under it would be unreachable for admins).
        if (parent && parent.visibility === "public" && parent.moderation_status !== "rejected") {
          pendingReview = !isShareableUnlisted(nameRes.value, descRes.value);
          sets.push("moderation_status = ?"); binds.push(pendingReview ? "pending" : null);
          sets.push("reject_reason = NULL");
        }
      }
    }

    if (body.sortOrder !== undefined) {
      const so = parseInt(body.sortOrder, 10);
      if (isNaN(so)) return errorResponse("Invalid sortOrder.", 400);
      sets.push("sort_order = ?"); binds.push(so);
    }

    // Attribution toggle — not moderated text, so it stays editable even while
    // the collection is public.
    if (body.showOwner !== undefined) {
      sets.push("share_show_owner = ?"); binds.push(body.showOwner ? 1 : 0);
    }

    if (!sets.length) return errorResponse("Nothing to update.", 400);

    sets.push("updated_at = ?"); binds.push(Date.now());
    binds.push(col.id, user.id);

    await env.DB.prepare(
      `UPDATE collections SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`
    ).bind(...binds).run();

    return jsonResponse({ success: true, pendingReview });
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}

// DELETE /api/collections/:id -> delete the collection, its items, and (if a
// folder) its sub-collections and their items. D1 has no cascade, so do it by hand.
export async function onRequestDelete(context) {
  const { env, params } = context;
  const user = context.data.user;
  if (!user) return errorResponse("Unauthorized.", 401);

  try {
    const col = await getOwnedCollection(env, user.id, params.id);
    if (!col) return errorResponse("Collection not found.", 404);

    // Gather this collection + any children (all owned by the same user).
    const { results: children } = await env.DB.prepare(
      `SELECT id FROM collections WHERE parent_id = ? AND user_id = ?`
    ).bind(col.id, user.id).all();
    const ids = [col.id, ...children.map(c => c.id)];
    const placeholders = ids.map(() => "?").join(",");

    await env.DB.prepare(
      `DELETE FROM collection_items WHERE collection_id IN (${placeholders})`
    ).bind(...ids).run();
    await env.DB.prepare(
      `DELETE FROM collections WHERE id IN (${placeholders}) AND user_id = ?`
    ).bind(...ids, user.id).run();

    return jsonResponse({ success: true });
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}
