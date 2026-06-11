export async function onRequest(context) {
  // Pin to clerk-js v5: v6 defaults to RHC (remotely-hosted UI) which breaks our manual
  // Clerk.load() init. This proxy is a dead fallback; the app loads clerk-js from the
  // Frontend API domain (window.CLERK_JS_URL) instead.
  const url = "https://unpkg.com/@clerk/clerk-js@5/dist/clerk.browser.js";
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return new Response(`// Failed to fetch Clerk: ${response.status}`, {
        status: 500,
        headers: { "Content-Type": "application/javascript" }
      });
    }
    return new Response(response.body, {
      headers: {
        "Content-Type": "application/javascript",
        "Cache-Control": "public, max-age=86400" // Cache for 1 day
      }
    });
  } catch (err) {
    return new Response(`// Error proxying Clerk: ${err.message}`, {
      status: 500,
      headers: { "Content-Type": "application/javascript" }
    });
  }
}
