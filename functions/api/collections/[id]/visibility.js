// Pages Function API: set a collection's visibility.
// POST { mode: 'private'|'unlisted'|'public', turnstileToken?, showOwner? }
//  - unlisted: instant share link; allowed only when the name is empty/preset
//    and there is NO description (no free text to moderate). Lists only.
//  - public : requires Turnstile + enters the moderation queue (pending) and
//    gets listed in the public library once approved. Name/description lock
//    (enforced in PATCH). Folders CAN go public: the submission covers their
//    sub-collections, whose custom-text names/descriptions are marked pending
//    alongside the folder (the shared page only renders preset-or-approved
//    children — see shared/[token].js).
import { jsonResponse, errorResponse } from "../../_lib/http.js";
import { verifyTurnstile } from "../../_lib/validate.js";
import { genShareToken, isShareableUnlisted, getOwnedCollection } from "../../_lib/collections.js";

const PUBLISH_LIMIT = 5; // per day

export async function onRequestPost(context) {
  const { request, env, params } = context;
  const user = context.data.user;
  if (!user) return errorResponse("Unauthorized.", 401);

  try {
    const col = await getOwnedCollection(env, user.id, params.id);
    if (!col) return errorResponse("Collection not found.", 404);

    const body = await request.json();
    const mode = body.mode;
    // Optional attribution flag: 1 = show the owner's username on the shared
    // page / public library, 0 = anonymous. Applied on share/publish below.
    const showOwner = body.showOwner === undefined ? null : (body.showOwner ? 1 : 0);

    const { results: children } = await env.DB.prepare(
      `SELECT id, name, description, visibility, moderation_status FROM collections WHERE parent_id = ? AND user_id = ?`
    ).bind(col.id, user.id).all();
    const isFolder = children.length > 0;

    if (mode === "private") {
      await env.DB.prepare(
        `UPDATE collections SET visibility='private', share_token=NULL, moderation_status=NULL, updated_at=? WHERE id=? AND user_id=?`
      ).bind(Date.now(), col.id, user.id).run();
      // Children's ride-along moderation flags only mean something under a
      // public parent. Only touch PRIVATE children: a child that is itself
      // unlisted/public has its own independent share/review state.
      if (isFolder) {
        await env.DB.prepare(
          `UPDATE collections SET moderation_status=NULL, reject_reason=NULL WHERE parent_id=? AND user_id=? AND visibility='private'`
        ).bind(col.id, user.id).run();
      }
      return jsonResponse({ success: true, visibility: "private", share_token: null });
    }

    // Only "Open to public" (reviewed) can share a folder; the instant link
    // path stays list-only because sub-collection names are free text.
    if (isFolder && mode === "unlisted") {
      return errorResponse("Folders can only be shared through \"Open to public\" (which is reviewed).", 400);
    }

    if (mode === "unlisted") {
      if (!isShareableUnlisted(col.name, col.description)) {
        return errorResponse("A custom name or description can only be shared through \"Open to public\" (which is reviewed).", 400);
      }
      const token = col.share_token || genShareToken();
      await env.DB.prepare(
        `UPDATE collections SET visibility='unlisted', share_token=?, moderation_status=NULL, share_show_owner=COALESCE(?, share_show_owner), updated_at=? WHERE id=? AND user_id=?`
      ).bind(token, showOwner, Date.now(), col.id, user.id).run();
      return jsonResponse({ success: true, visibility: "unlisted", share_token: token });
    }

    if (mode === "public") {
      // Turnstile (outward-facing, low-frequency).
      const turnstileSecret = env.TURNSTILE_SECRET_KEY || "1x000000000000000000000000000000aa";
      const remoteIp = request.headers.get("CF-Connecting-IP") || "";
      const ok = await verifyTurnstile(body.turnstileToken, turnstileSecret, remoteIp);
      if (!ok) return errorResponse("Turnstile verification failed.", 400);

      // Daily publish quota.
      const kv = env.ARCHIVE_KV;
      if (kv) {
        const today = new Date().toISOString().split("T")[0].replace(/-/g, "");
        const quotaKey = `quota:collection_publish:${user.id}:${today}`;
        const used = parseInt((await kv.get(quotaKey)) || "0", 10);
        if (used >= PUBLISH_LIMIT) return errorResponse("Daily publish limit reached. Try again tomorrow.", 429);
        await kv.put(quotaKey, String(used + 1), { expirationTtl: 129600 });
      }

      const token = col.share_token || genShareToken();
      await env.DB.prepare(
        `UPDATE collections SET visibility='public', moderation_status='pending', share_token=?, reject_reason=NULL, share_show_owner=COALESCE(?, share_show_owner), updated_at=? WHERE id=? AND user_id=?`
      ).bind(token, showOwner, Date.now(), col.id, user.id).run();

      // A folder submission covers its sub-collections: children carrying
      // custom free text join the review (pending); preset/blank children need
      // none and render on the shared page immediately once approved. Children
      // that are themselves unlisted/public keep their own independent state.
      for (const child of children) {
        if (child.visibility !== "private") continue;
        const status = isShareableUnlisted(child.name, child.description) ? null : "pending";
        if ((child.moderation_status || null) !== status) {
          await env.DB.prepare(
            `UPDATE collections SET moderation_status=?, reject_reason=NULL WHERE id=? AND user_id=?`
          ).bind(status, child.id, user.id).run();
        }
      }

      return jsonResponse({ success: true, visibility: "public", moderation_status: "pending", share_token: token });
    }

    return errorResponse("Invalid visibility mode.", 400);
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}
