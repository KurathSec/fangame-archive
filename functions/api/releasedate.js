// GET /api/releasedate — release-date coverage, and date-filtered games.
//
//   /api/releasedate                                  -> coverage summary + per-year counts
//   /api/releasedate?date_from=2015-01-01&date_to=2018-12-31
//   /api/releasedate?date_in=2010-01-01:2012-12-31&date_in=2020-01-01:
//   /api/releasedate?date_not=2013-01-01:2014-12-31   -> everything outside that stretch
//   /api/releasedate?has_date=false                   -> games no source has dated
//
// `date_in` / `date_not` are repeatable and stack exactly like the sidebar's
// date-range chips: a game must fall inside at least one include range (when any
// is given) and inside no exclude range. Either side of a range may be left empty
// for an open bound ("2020-01-01:" = 2020 onwards). Undated games are inside no
// range at all, so include ranges drop them and exclude ranges leave them.
//
// Games come back newest-first by default; add ?order=asc for oldest-first.

import {
  preflight, json, badRequest, loadCatalog, parseQuery, applyFilters, buildResults,
  cacheLookup, cacheStore, isCacheable
} from "./_lib/catalog.js";

export async function onRequest(context) {
  const pre = preflight(context.request);
  if (pre) return pre;

  const url = new URL(context.request.url);
  const parsed = parseQuery(url.searchParams, { defaultLimit: 100, defaultSort: "date" });
  if (parsed.errors.length) return badRequest(parsed.errors[0], { errors: parsed.errors });

  const f = parsed.filters;
  const wantsGames = Boolean(f.dateRanges.length || f.hasDate !== null);

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

    // Coverage mode: how much of the (filtered) catalog is dated, and when.
    const pool = applyFilters(games, f);
    const byYear = new Map();
    let dated = 0;
    let earliest = null;
    let latest = null;
    for (const g of pool) {
      const d = g.release_date || null;
      if (!d) continue;
      dated++;
      if (!earliest || d < earliest) earliest = d;
      if (!latest || d > latest) latest = d;
      const year = d.slice(0, 4);
      byYear.set(year, (byYear.get(year) || 0) + 1);
    }
    const years = [...byYear.entries()]
      .map(([year, count]) => ({ year, count }))
      .sort((a, b) => a.year.localeCompare(b.year));

    const res = json({
      success: true,
      mode: "coverage",
      games_considered: pool.length,
      dated,
      undated: pool.length - dated,
      earliest,
      latest,
      by_year: years,
      hint: `Add ?date_from=&date_to= or repeatable ?date_in=FROM:TO / ?date_not=FROM:TO to list games, e.g. ${url.origin}/api/releasedate?date_in=2020-01-01:2020-12-31`
    });
    return cacheStore(context, cache, key, res);
  } catch (err) {
    return json({ success: false, error: err.message }, 500);
  }
}
