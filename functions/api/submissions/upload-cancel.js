// Remove a staged upload the user changed their mind about (the "remove file"
// button, or replacing a finished upload). Idempotent; only the caller's own
// SubmissionUploads/<userId>/<uuid>.<ext> keys are reachable. Abandoned
// uploads that never get cancelled are cleaned by the CI sweep instead.

import { jsonResponse, errorResponse } from "../_lib/http.js";
import { userOwnsStagingKey, inflightKvKey } from "../_lib/uploads.js";

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

    try { await bucket.delete(key); } catch (e) {}

    if (env.ARCHIVE_KV) {
      const inflightKey = inflightKvKey(user.id);
      const cur = await env.ARCHIVE_KV.get(inflightKey, { type: "json" }).catch(() => null);
      if (cur && cur.key === key) {
        await env.ARCHIVE_KV.delete(inflightKey);
      }
    }

    return jsonResponse({ success: true });
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}
