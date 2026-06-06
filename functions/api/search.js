export async function onRequest(context) {
  const url = new URL(context.request.url);
  const q = url.searchParams.get('q');
  const id = url.searchParams.get('id');
  
  // Set CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json;charset=utf-8'
  };
  
  // Handle OPTIONS preflight request
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
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
    
    // 1. Search by ID
    if (id) {
      const match = games.find(g => String(g.id) === String(id));
      if (match) {
        return new Response(JSON.stringify({ success: true, results: [match] }), { headers: corsHeaders });
      } else {
        return new Response(JSON.stringify({ success: true, results: [] }), { headers: corsHeaders });
      }
    }
    
    // 2. Search by keyword (title, creator, tags)
    if (q) {
      const query = q.toLowerCase().trim();
      const results = games.filter(g => {
        const titleMatch = g.title.toLowerCase().includes(query);
        const creatorMatch = g.creator.toLowerCase().includes(query);
        const tagsMatch = g.tags.some(t => t.toLowerCase().includes(query));
        return titleMatch || creatorMatch || tagsMatch;
      });
      
      // Return top 100 matching results
      return new Response(JSON.stringify({ success: true, count: results.length, results: results.slice(0, 100) }), { headers: corsHeaders });
    }
    
    // 3. No query provided
    return new Response(JSON.stringify({
      error: "Please provide a query parameter 'q' (for keyword search) or 'id' (for game ID search)",
      example_id: `${url.origin}/api/search?id=17049`,
      example_query: `${url.origin}/api/search?q=Happil`
    }), {
      status: 400,
      headers: corsHeaders
    });
    
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: corsHeaders
    });
  }
}
