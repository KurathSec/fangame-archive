// HTTP response helpers for Pages Functions API.

export function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...headers
    }
  });
}

export function errorResponse(message, status = 500) {
  return jsonResponse({ success: false, error: message }, status);
}
