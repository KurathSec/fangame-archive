// Pages Function API for keyword and ID directory search.
// Optimized using Cloudflare Edge Cache API.

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const q = url.searchParams.get("q");
  const id = url.searchParams.get("id");

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json;charset=utf-8"
  };

  if (context.request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // 1. Edge caching lookup
  const useCache = typeof caches !== "undefined";
  let cacheKey, cache;
  if (useCache) {
    cache = caches.default;
    cacheKey = new Request(context.request.url, context.request);
    try {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        return cachedResponse;
      }
    } catch (e) {
      console.warn("Cache match failed:", e);
    }
  }

  try {
    // Fetch search_index.json from our own deployment
    const indexUrl = `${url.origin}/data/search_index.json`;
    const res = await fetch(indexUrl);
    if (!res.ok) {
      return new Response(JSON.stringify({ error: "Failed to load database search index" }), {
        status: 500,
        headers: corsHeaders
      });
    }

    const games = await res.json();
    let responseData = {};
    let status = 200;

    if (id) {
      const match = games.find(g => String(g.id) === String(id));
      responseData = { success: true, results: match ? [match] : [] };
    } else if (q) {
      const query = q.toLowerCase().trim();
      const results = games.filter(g => {
        const titleMatch = g.title.toLowerCase().includes(query);
        const creatorMatch = g.creator.toLowerCase().includes(query);
        const tagsMatch = g.tags.some(t => t.toLowerCase().includes(query));
        return titleMatch || creatorMatch || tagsMatch;
      });
      responseData = { success: true, count: results.length, results: results.slice(0, 100) };
    } else {
      responseData = {
        error: "Please provide a query parameter 'q' (for keyword search) or 'id' (for game ID search)",
        example_id: `${url.origin}/api/search?id=17049`,
        example_query: `${url.origin}/api/search?q=Happil`
      };
      status = 400;
    }

    const finalResponse = new Response(JSON.stringify(responseData), {
      status,
      headers: corsHeaders
    });

    // Write to Edge Cache if query succeeded (expires in 10 minutes)
    if (useCache && status === 200 && context.request.method === "GET") {
      finalResponse.headers.set("Cache-Control", "public, max-age=600");
      try {
        context.waitUntil(cache.put(cacheKey, finalResponse.clone()));
      } catch (e) {
        console.warn("Cache write failed:", e);
      }
    }

    return finalResponse;
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: corsHeaders
    });
  }
}
