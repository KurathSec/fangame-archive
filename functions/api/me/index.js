// GET /api/me - Returns current logged-in user's database profile (role, status).
import { jsonResponse } from "../_lib/http.js";

export async function onRequest(context) {
  const user = context.data.user; // Populated by global _middleware.js

  const headers = {
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "Pragma": "no-cache",
    "Expires": "0"
  };

  if (!user) {
    return jsonResponse({ success: true, user: null }, 200, headers);
  }

  return jsonResponse({ success: true, user }, 200, headers);
}
