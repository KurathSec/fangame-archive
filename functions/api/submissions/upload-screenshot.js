// Screenshot upload for the submit-game form. Screenshots are small (≤ 8 MB),
// so the bytes stream through this Function into the R2 binding — no presigned
// URL, no extra credentials. The format is sniffed from magic bytes (the
// client-supplied filename and Content-Type are ignored) and the object is
// stored with the matching Content-Type so it renders inline. Returns the
// public URL the form drops into the screenshot slot.

import { jsonResponse, errorResponse } from "../_lib/http.js";
import {
  MAX_SCREENSHOT_BYTES, POOL_MAX_BYTES, DAILY_SCREENSHOT_UPLOADS,
  stagingKeyFor, publicUrlFor, poolUsageBytes, consumeDailyQuota, sniffImage,
} from "../_lib/uploads.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const user = context.data.user;
  if (!user) return errorResponse("Unauthorized.", 401);

  try {
    const bucket = env.ARCHIVE_FILES;
    if (!bucket) return errorResponse("Direct upload isn't configured on this deployment.", 501);

    const declared = parseInt(request.headers.get("Content-Length") || "0", 10) || 0;
    if (declared > MAX_SCREENSHOT_BYTES) {
      return errorResponse("Image exceeds the 8 MB limit.", 413);
    }

    if (!(await consumeDailyQuota(env.ARCHIVE_KV, "upshot", user.id, DAILY_SCREENSHOT_UPLOADS))) {
      return errorResponse(`Daily screenshot upload limit reached (${DAILY_SCREENSHOT_UPLOADS}/day).`, 429);
    }

    const buf = new Uint8Array(await request.arrayBuffer());
    if (!buf.length) return errorResponse("Empty upload.", 400);
    if (buf.length > MAX_SCREENSHOT_BYTES) {
      return errorResponse("Image exceeds the 8 MB limit.", 413);
    }

    const img = sniffImage(buf);
    if (!img) {
      return errorResponse("Not a supported image. Allowed: PNG, JPEG, GIF, WebP.", 400);
    }

    // Screenshots share the staged pool and count toward its 5 GB cap.
    const used = await poolUsageBytes(bucket);
    if (used + buf.length > POOL_MAX_BYTES) {
      return errorResponse("Upload storage is temporarily full. Please try again later or submit a link instead.", 503);
    }

    const key = stagingKeyFor(user.id, img.ext);
    await bucket.put(key, buf, { httpMetadata: { contentType: img.contentType } });

    return jsonResponse({ success: true, url: publicUrlFor(key), key, size: buf.length });
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}
