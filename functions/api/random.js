// GET /api/random — one or more random games from the catalog.
//
//   /api/random                 one game
//   /api/random?count=5         five distinct games
//   /api/random?tag=needle      restrict the pool to a tag
//
// Since v2026.014 the pool can be narrowed with the whole shared filter
// vocabulary (functions/api/_lib/catalog.js), so a roll can be scoped to, say,
// well-rated GameMaker 8 needle games from a specific era:
//   /api/random?count=3&tag=needle&engine=GameMaker%208&rating_min=7&date_in=2015-01-01:2018-12-31
//
// Responses are intentionally NOT cached, so every call re-samples.

import {
  preflight, json, badRequest, loadCatalog, parseQuery, applyFilters, shape
} from "./_lib/catalog.js";

export async function onRequest(context) {
  const pre = preflight(context.request);
  if (pre) return pre;

  const url = new URL(context.request.url);
  const parsed = parseQuery(url.searchParams, { defaultLimit: 1, maxLimit: 50, defaultSort: "random" });
  if (parsed.errors.length) return badRequest(parsed.errors[0], { errors: parsed.errors });

  // `count` is this endpoint's historical name for the sample size; it wins over
  // `limit` when both are present. Clamped to [1, 50].
  let count = parsed.limit;
  const rawCount = url.searchParams.get("count");
  if (rawCount !== null && rawCount.trim() !== "") {
    const n = Number(rawCount);
    if (!Number.isFinite(n)) return badRequest(`count must be a number (got "${rawCount}")`);
    count = Math.floor(n);
  }
  if (!Number.isFinite(count) || count < 1) count = 1;
  if (count > 50) count = 50;

  try {
    const games = await loadCatalog(url.origin);
    const pool = applyFilters(games, parsed.filters);

    // Sample `count` distinct games (or the whole pool when it is smaller).
    const n = Math.min(count, pool.length);
    const picked = [];
    const used = new Set();
    while (picked.length < n) {
      const i = Math.floor(Math.random() * pool.length);
      if (used.has(i)) continue;
      used.add(i);
      picked.push(pool[i]);
    }

    return json({
      success: true,
      count: picked.length,
      pool_size: pool.length,
      results: picked.map((g) => shape(g, parsed.fields, url.origin))
    }, 200, { "Cache-Control": "no-store" });
  } catch (err) {
    return json({ success: false, error: err.message }, 500);
  }
}
