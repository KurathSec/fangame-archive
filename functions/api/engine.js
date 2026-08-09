// GET /api/engine — engine directory, and engine-filtered games.
//
//   /api/engine                          -> every detected engine with its count
//   /api/engine?engine=GameMaker%208     -> the games built with it
//   /api/engine?engine=unknown           -> games whose engine was never detected
//   /api/engine?engine_not=Unity,Godot   -> everything except those
//
// Engine names match case-insensitively. All the shared filters compose here, so
//   /api/engine?tag=needle&date_in=2020-01-01:
// answers "which engines do needle games since 2020 use".

import {
  preflight, json, badRequest, loadCatalog, parseQuery, applyFilters, buildResults,
  cacheLookup, cacheStore, isCacheable, ENGINE_UNKNOWN
} from "./_lib/catalog.js";

export async function onRequest(context) {
  const pre = preflight(context.request);
  if (pre) return pre;

  const url = new URL(context.request.url);
  const parsed = parseQuery(url.searchParams, { defaultLimit: 100, defaultSort: "rating" });
  if (parsed.errors.length) return badRequest(parsed.errors[0], { errors: parsed.errors });

  const f = parsed.filters;
  const wantsGames = Boolean(f.engineAny.length || f.engineNot.length || f.hasEngine !== null);

  const cacheable = isCacheable(parsed);
  const { cache, key, hit } = await cacheLookup(context, cacheable);
  if (hit) return hit;

  try {
    const games = await loadCatalog(url.origin);

    if (wantsGames) {
      const built = buildResults(games, parsed, url.origin);
      const res = json({ success: true, mode: "games", ...built },
                       200, cacheable ? {} : { "Cache-Control": "no-store" });
      return cacheStore(context, cache, key, res);
    }

    // Directory mode: count engines across whatever the other filters left.
    // Keys are the display spelling; `unknown` is the bucket for undetected.
    const pool = applyFilters(games, f);
    const counts = new Map();
    for (const g of pool) {
      const name = (g.engine || "").trim() || ENGINE_UNKNOWN;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    const engines = [...counts.entries()]
      .map(([engine, count]) => ({ engine, count }))
      .sort((a, b) => b.count - a.count || a.engine.localeCompare(b.engine));

    const res = json({
      success: true,
      mode: "engines",
      games_considered: pool.length,
      count: engines.length,
      engines,
      hint: `Add ?engine=<name> to list the games instead, e.g. ${url.origin}/api/engine?engine=${encodeURIComponent(engines[0] ? engines[0].engine : "GameMaker 8")}`
    });
    return cacheStore(context, cache, key, res);
  } catch (err) {
    return json({ success: false, error: err.message }, 500);
  }
}
