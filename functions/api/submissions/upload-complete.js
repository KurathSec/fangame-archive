// Direct game-file upload, step 2: after the browser PUTs the file to R2 via
// the presigned URL, this verifies the staged object through the R2 binding —
// it exists, it's non-empty, and it's within the 500 MB cap (the presigned URL
// can't enforce size, so an oversize object is deleted right here). Returns
// the public URL the submit form plugs into external_url.

import { jsonResponse, errorResponse } from "../_lib/http.js";
import {
  MAX_GAME_FILE_BYTES, userOwnsStagingKey, publicUrlFor, inflightKvKey,
} from "../_lib/uploads.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const user = context.data.user;
  if (!user) return errorResponse("Unauthorized.", 401);

  try {
    const body = await request.json().catch(() => ({}));
    const key = (body.key || "").trim();

    if (!userOwnsStagingKey(key, user.id)) {
      return errorResponse("Invalid upload key.", 400);
    }
    const bucket = env.ARCHIVE_FILES;
    if (!bucket) return errorResponse("Direct upload isn't configured on this deployment.", 501);

    const head = await bucket.head(key);
    if (!head) {
      return errorResponse("Uploaded file not found — the upload may have failed.", 400);
    }
    const size = head.size || 0;
    if (!size) {
      try { await bucket.delete(key); } catch (e) {}
      return errorResponse("Uploaded file was empty.", 400);
    }
    if (size > MAX_GAME_FILE_BYTES) {
      try { await bucket.delete(key); } catch (e) {}
      return errorResponse("Uploaded file exceeds the 500 MB limit.", 400);
    }

    // The upload is settled; it no longer counts as in-flight.
    if (env.ARCHIVE_KV) {
      const inflightKey = inflightKvKey(user.id);
      const cur = await env.ARCHIVE_KV.get(inflightKey, { type: "json" }).catch(() => null);
      if (cur && cur.key === key) {
        await env.ARCHIVE_KV.delete(inflightKey);
      }
    }

    return jsonResponse({ success: true, url: publicUrlFor(key), key, size });
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}
