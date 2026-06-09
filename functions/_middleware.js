// Global Pages Functions Middleware for CORS and Clerk Authentication.
import { jsonResponse, errorResponse } from "./api/_lib/http.js";
import { verifyClerkToken, getClerkUserProfile } from "./api/_lib/auth.js";

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // 1. Handle CORS Preflight Options request
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Turnstile-Token",
        "Access-Control-Max-Age": "86400"
      }
    });
  }

  // Helper to append standard CORS headers to all responses
  const addCorsHeaders = (response) => {
    response.headers.set("Access-Control-Allow-Origin", "*");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Turnstile-Token");
    return response;
  };

  context.data = context.data || {};
  context.data.user = null;

  // 2. Validate Clerk JWT token if Authorization header is present
  const authHeader = request.headers.get("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    const pubKey = env.CLERK_PUBLISHABLE_KEY;
    const secKey = env.CLERK_SECRET_KEY;

    const payload = await verifyClerkToken(token, pubKey);
    if (payload && payload.sub) {
      const userId = payload.sub;

      // Fetch user profile from cache/Clerk API
      const profile = await getClerkUserProfile(userId, secKey, env.ARCHIVE_KV);

      try {
        const user = await env.DB.prepare(
          "SELECT role, status, display_name, avatar_url FROM users WHERE id = ?"
        ).bind(userId).first();

        const now = Date.now();
        if (!user) {
          // Provision JIT user
          await env.DB.prepare(
            "INSERT INTO users (id, email, display_name, avatar_url, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'user', 'active', ?, ?)"
          ).bind(userId, profile.email, profile.display_name, profile.avatar_url, now, now).run();

          context.data.user = {
            id: userId,
            role: "user",
            status: "active",
            display_name: profile.display_name,
            avatar_url: profile.avatar_url
          };
        } else {
          // Check if account is banned or muted
          if (user.status === "banned") {
            if (request.method !== "GET" && request.method !== "OPTIONS") {
              return addCorsHeaders(errorResponse("Your account has been banned.", 403));
            }
          }

          if (user.status === "muted") {
            if (request.method !== "GET" && request.method !== "OPTIONS") {
              return addCorsHeaders(errorResponse("Your account is muted and cannot post reviews.", 403));
            }
          }

          // Sync user updates from Clerk profile into D1
          if (user.display_name !== profile.display_name || user.avatar_url !== profile.avatar_url) {
            await env.DB.prepare(
              "UPDATE users SET display_name = ?, avatar_url = ?, updated_at = ? WHERE id = ?"
            ).bind(profile.display_name, profile.avatar_url, now, userId).run();
          }

          context.data.user = {
            id: userId,
            role: user.role,
            status: user.status,
            display_name: profile.display_name,
            avatar_url: profile.avatar_url
          };
        }
      } catch (err) {
        console.error("D1 User Authentication Query Error:", err);
      }
    }
  }

  // 3. Enforce authorization on write requests
  const isApiWrite = url.pathname.startsWith("/api/") && request.method !== "GET" && request.method !== "OPTIONS";
  if (isApiWrite) {
    if (!context.data.user) {
      return addCorsHeaders(errorResponse("Unauthorized. Missing or invalid authentication token.", 401));
    }
  }

  // 4. Proceed to downstream handlers
  try {
    const response = await context.next();
    return addCorsHeaders(response);
  } catch (err) {
    console.error("Endpoint Execution Error:", err);
    return addCorsHeaders(errorResponse(err.message, 500));
  }
}
