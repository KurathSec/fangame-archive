// Pages Function API: return one or more random games from the catalog.
// Reads the same data/search_index.json the /api/search endpoint uses, so every
// record carries the enriched public fields (rating, difficulty, rating_count,
// file_size, tags, download url). Responses are intentionally NOT cached so each
// call re-samples.
//
// Query params:
//   ?count=N  -> number of distinct random games (default 1, clamped to 1..50)
//   ?tag=foo  -> restrict the pool to games carrying that tag (case-insensitive)

export async function onRequest(context) {
  const url = new URL(context.request.url);

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json;charset=utf-8"
  };

  if (context.request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // count: default 1, clamped to [1, 50].
  let count = parseInt(url.searchParams.get("count") || "1", 10);
  if (!Number.isFinite(count) || count < 1) count = 1;
  if (count > 50) count = 50;

  const tag = (url.searchParams.get("tag") || "").toLowerCase().trim();

  try {
    const indexUrl = `${url.origin}/data/search_index.json`;
    const res = await fetch(indexUrl);
    if (!res.ok) {
      return new Response(JSON.stringify({ success: false, error: "Failed to load database search index" }), {
        status: 500,
        headers: corsHeaders
      });
    }

    let games = await res.json();

    if (tag) {
      games = games.filter(g => Array.isArray(g.tags) && g.tags.some(t => String(t).toLowerCase() === tag));
    }

    // Sample `count` distinct games (or all of them if the pool is smaller).
    const n = Math.min(count, games.length);
    const picked = [];
    const used = new Set();
    while (picked.length < n) {
      const i = Math.floor(Math.random() * games.length);
      if (used.has(i)) continue;
      used.add(i);
      picked.push(games[i]);
    }

    return new Response(JSON.stringify({ success: true, count: picked.length, results: picked }), {
      status: 200,
      headers: { ...corsHeaders, "Cache-Control": "no-store" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: corsHeaders
    });
  }
}
