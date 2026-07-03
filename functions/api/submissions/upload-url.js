// Direct game-file upload, step 1: mint a short-lived presigned PUT URL so the
// browser uploads the archive straight to R2 (bypassing the ~100 MB
// Worker/Pages body limit; up to 500 MB accepted). No bytes pass through here.
//
// Abuse limits, layered (the presigned URL itself can't constrain size):
//   * Clerk auth required (middleware) + banned/muted users already rejected.
//   * DAILY_FILE_UPLOADS mints per user per day (KV).
//   * One in-flight upload per user — a new mint deletes the previous staged
//     object, so parallel mints can't stack storage.
//   * Global staged pool capped at POOL_MAX_BYTES, checked against a live
//     bucket listing before every mint.
//   * Oversize objects are deleted at upload-complete, and the CI sweep
//     removes anything oversize or unreferenced after 48 h as a backstop.

import { jsonResponse, errorResponse } from "../_lib/http.js";
import { presignPutUrl } from "../_lib/r2presign.js";
import {
  MAX_GAME_FILE_BYTES, POOL_MAX_BYTES, DAILY_FILE_UPLOADS,
  gameFileExtOf, stagingKeyFor, poolUsageBytes,
  inflightKvKey, consumeDailyQuota, r2Credentials, GAME_FILE_EXTS,
} from "../_lib/uploads.js";

const BUCKET_NAME = "fangame-files";
const URL_EXPIRES = 3600; // seconds; must cover a 500 MB upload on a slow link

export async function onRequestPost(context) {
  const { request, env } = context;
  const user = context.data.user;
  if (!user) return errorResponse("Unauthorized.", 401);

  try {
    const body = await request.json().catch(() => ({}));
    const filename = (body.filename || "").trim();
    const size = parseInt(body.size, 10);

    const ext = gameFileExtOf(filename);
    if (!ext) {
      return errorResponse(`Unsupported file type. Allowed: ${GAME_FILE_EXTS.join(", ")}`, 400);
    }
    if (!Number.isInteger(size) || size <= 0) {
      return errorResponse("A valid file size is required.", 400);
    }
    if (size > MAX_GAME_FILE_BYTES) {
      return errorResponse("File exceeds the 500 MB upload limit.", 400);
    }

    const bucket = env.ARCHIVE_FILES;
    const creds = r2Credentials(env);
    if (!bucket || !creds) {
      return errorResponse("Direct upload isn't configured on this deployment.", 501);
    }

    const kv = env.ARCHIVE_KV;
    if (!(await consumeDailyQuota(kv, "upfile", user.id, DAILY_FILE_UPLOADS))) {
      return errorResponse(`Daily upload limit reached (${DAILY_FILE_UPLOADS}/day).`, 429);
    }

    // One in-flight upload per user: replace (and clean up) any previous one.
    const inflightKey = inflightKvKey(user.id);
    if (kv) {
      const prev = await kv.get(inflightKey, { type: "json" }).catch(() => null);
      if (prev && prev.key) {
        try { await bucket.delete(prev.key); } catch (e) {}
      }
    }

    // Global staged-pool cap — the wallet-attack ceiling.
    const used = await poolUsageBytes(bucket);
    if (used + size > POOL_MAX_BYTES) {
      return errorResponse("Upload storage is temporarily full. Please try again later or submit a link instead.", 503);
    }

    const key = stagingKeyFor(user.id, ext);
    const url = await presignPutUrl({
      ...creds, bucket: BUCKET_NAME, key, expires: URL_EXPIRES,
    });

    if (kv) {
      await kv.put(inflightKey, JSON.stringify({ key, size, ts: Date.now() }), { expirationTtl: URL_EXPIRES * 2 });
    }

    return jsonResponse({ success: true, url, key, expires: URL_EXPIRES, max_bytes: MAX_GAME_FILE_BYTES });
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}
