// GET /api/me - Returns current logged-in user's database profile (role, status).
import { jsonResponse } from "../_lib/http.js";

export async function onRequest(context) {
  const user = context.data.user; // Populated by global _middleware.js

  if (!user) {
    return jsonResponse({ success: true, user: null });
  }

  return jsonResponse({ success: true, user });
}
