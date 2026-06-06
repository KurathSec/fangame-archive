// Pages Function API for fetching and posting game comments from Cloudflare D1.

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const gameId = url.searchParams.get("game_id");

  if (!gameId) {
    return new Response(JSON.stringify({ success: false, error: "Missing game_id parameter." }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }

  try {
    const { results } = await env.DB.prepare(
      "SELECT id, user, rating, difficulty, likes, date, content, tags FROM comments WHERE game_id = ? ORDER BY id DESC"
    )
    .bind(parseInt(gameId, 10))
    .all();

    // Parse tags JSON string back to array safely
    const formatted = results.map(r => {
      let parsedTags = [];
      if (r.tags) {
        try {
          parsedTags = JSON.parse(r.tags);
        } catch (e) {
          parsedTags = [];
        }
      }
      return {
        id: r.id,
        user: r.user,
        rating: r.rating,
        diff: r.difficulty,
        liked: r.likes,
        date: r.date,
        body: r.content,
        tags: parsedTags
      };
    });

    return new Response(JSON.stringify({ success: true, comments: formatted }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  
  try {
    const body = await request.json();
    const { game_id, user, rating, difficulty, content, tags } = body;

    if (!game_id || !user || !content) {
      return new Response(JSON.stringify({ success: false, error: "Missing required fields." }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const dateStr = new Date().toISOString().split('T')[0];
    const tagsStr = JSON.stringify(tags || []);

    await env.DB.prepare(
      "INSERT INTO comments (game_id, user, rating, difficulty, date, content, tags) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(
      parseInt(game_id, 10),
      user,
      rating !== undefined && rating !== null ? parseFloat(rating) : null,
      difficulty !== undefined && difficulty !== null ? parseInt(difficulty, 10) : null,
      dateStr,
      content,
      tagsStr
    )
    .run();

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
