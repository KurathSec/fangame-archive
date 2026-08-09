// GET /api/tag — tag directory, and tag-filtered games.
//
// Two modes, chosen by whether a tag filter is present:
//   /api/tag                       -> every tag with its game count (the directory)
//   /api/tag?tag=needle            -> the games carrying that tag
//
// Tri-state, like the sidebar Explorer:
//   ?tag=a,b       any of a, b
//   ?tag_all=a,b   all of a and b
//   ?tag_not=c     none of c
// The directory mode honours the other filters too, so
//   /api/tag?engine=GameMaker%208&date_in=2020-01-01:
// answers "which tags exist among GM8 games released since 2020, and how many".

import {
  preflight, json, badRequest, loadCatalog, parseQuery, applyFilters, buildResults,
  cacheLookup, cacheStore, isCacheable
} from "./_lib/catalog.js";

export async function onRequest(context) {
  const pre = preflight(context.request);
  if (pre) return pre;

  const url = new URL(context.request.url);
  const sp = url.searchParams;
  const parsed = parseQuery(sp, { defaultLimit: 100, defaultSort: "rating" });
  if (parsed.errors.length) return badRequest(parsed.errors[0], { errors: parsed.errors });

  const wantsGames = Boolean(
    parsed.filters.tagAny.length || parsed.filters.tagAll.length || parsed.filters.tagNot.length
  );

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

    // Directory mode: count tags across whatever the other filters left.
    const pool = applyFilters(games, parsed.filters);
    const counts = new Map();
    for (const g of pool) {
      if (!Array.isArray(g.tags)) continue;
      for (const raw of g.tags) {
        const t = String(raw).trim().toLowerCase();
        if (t) counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
    const tags = [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

    const res = json({
      success: true,
      mode: "tags",
      games_considered: pool.length,
      count: tags.length,
      tags,
      hint: `Add ?tag=<name> to list the games instead, e.g. ${url.origin}/api/tag?tag=${encodeURIComponent(tags[0] ? tags[0].tag : "needle")}`
    });
    return cacheStore(context, cache, key, res);
  } catch (err) {
    return json({ success: false, error: err.message }, 500);
  }
}
