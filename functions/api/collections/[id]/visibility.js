// Pages Function API: set a collection's visibility.
// POST { mode: 'private'|'unlisted'|'public', turnstileToken? }
//  - unlisted: instant share link; allowed only when the name is empty/preset
//    and there is NO description (no free text to moderate).
//  - public : requires Turnstile + enters the moderation queue (pending) and
//    gets listed in the public library once approved. Name/description lock
//    (enforced in PATCH). Only a list (non-folder) can be shared/public.
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

    // Folders (with sub-collections) can never be shared.
    const kids = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM collections WHERE parent_id = ?`
    ).bind(col.id).first();
    const isFolder = kids && kids.n > 0;

    if (mode === "private") {
      await env.DB.prepare(
        `UPDATE collections SET visibility='private', share_token=NULL, moderation_status=NULL, updated_at=? WHERE id=? AND user_id=?`
      ).bind(Date.now(), col.id, user.id).run();
      return jsonResponse({ success: true, visibility: "private", share_token: null });
    }

    if (isFolder) return errorResponse("Folders cannot be shared. Share the individual game lists inside instead.", 400);

    if (mode === "unlisted") {
      if (!isShareableUnlisted(col.name, col.description)) {
        return errorResponse("A custom name or description can only be shared through \"Open to public\" (which is reviewed).", 400);
      }
      const token = col.share_token || genShareToken();
      await env.DB.prepare(
        `UPDATE collections SET visibility='unlisted', share_token=?, moderation_status=NULL, updated_at=? WHERE id=? AND user_id=?`
      ).bind(token, Date.now(), col.id, user.id).run();
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
        `UPDATE collections SET visibility='public', moderation_status='pending', share_token=?, reject_reason=NULL, updated_at=? WHERE id=? AND user_id=?`
      ).bind(token, Date.now(), col.id, user.id).run();
      return jsonResponse({ success: true, visibility: "public", moderation_status: "pending", share_token: token });
    }

    return errorResponse("Invalid visibility mode.", 400);
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}
