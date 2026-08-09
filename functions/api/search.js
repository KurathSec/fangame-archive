// GET /api/search — keyword and ID lookup over the catalog.
//
//   /api/search?q=Happil     substring over title, creator and tags
//   /api/search?id=17049     one game by its archive ID
//
// Since v2026.014 this shares the filter engine in functions/api/_lib/catalog.js
// with /api/all, /api/tag, /api/engine and /api/releasedate, so the tri-state
// tag/engine filters and date ranges compose here as well:
//   /api/search?q=needle&engine=GameMaker%208&tag_not=trap&date_in=2018-01-01:
//
// Results are capped at 100 by default (raise with ?limit=, page with ?offset=).

import {
  preflight, json, badRequest, loadCatalog, parseQuery, buildResults,
  cacheLookup, cacheStore, isCacheable
} from "./_lib/catalog.js";

export async function onRequest(context) {
  const pre = preflight(context.request);
  if (pre) return pre;

  const url = new URL(context.request.url);
  const sp = url.searchParams;
  const parsed = parseQuery(sp, { defaultLimit: 100, defaultSort: "id" });
  if (parsed.errors.length) return badRequest(parsed.errors[0], { errors: parsed.errors });

  // An ID lookup is exact and single, so it ignores the 100-row default cap.
  if (parsed.filters.ids) parsed.limit = 0;

  const f = parsed.filters;
  const hasAnyFilter = Boolean(
    f.q || f.title || f.creator || f.ids ||
    f.tagAny.length || f.tagAll.length || f.tagNot.length ||
    f.engineAny.length || f.engineNot.length || f.hasEngine !== null ||
    f.dateRanges.length || f.hasDate !== null ||
    f.ratingMin !== null || f.ratingMax !== null ||
    f.difficultyMin !== null || f.difficultyMax !== null ||
    f.reviewsMin !== null || f.reviewsMax !== null ||
    f.sizeMinMb !== null || f.sizeMaxMb !== null ||
    f.sources.length || f.sourcesNot.length || f.sourceId ||
    f.local !== null || f.hasDownload !== null
  );
  if (!hasAnyFilter) {
    return json({
      error: "Please provide a query parameter 'q' (for keyword search) or 'id' (for game ID search)",
      example_id: `${url.origin}/api/search?id=17049`,
      example_query: `${url.origin}/api/search?q=Happil`,
      example_filtered: `${url.origin}/api/search?q=needle&engine=GameMaker%208&tag_not=trap`,
      full_catalog: `${url.origin}/api/all`,
      other_endpoints: ["/api/all", "/api/tag", "/api/engine", "/api/releasedate", "/api/random"],
      docs: "Full parameter reference: the About & Contact page on this site."
    }, 400);
  }

  const cacheable = isCacheable(parsed);
  const { cache, key, hit } = await cacheLookup(context, cacheable);
  if (hit) return hit;

  try {
    const games = await loadCatalog(url.origin);
    const built = buildResults(games, parsed, url.origin);
    // `count` stays the total number of matches (not the page size) for
    // backwards compatibility with the pre-v2026.014 response shape.
    const res = json({
      success: true,
      count: built.total,
      total: built.total,
      returned: built.count,
      offset: built.offset,
      limit: built.limit,
      results: built.results
    }, 200, cacheable ? {} : { "Cache-Control": "no-store" });
    return cacheStore(context, cache, key, res);
  } catch (err) {
    return json({ success: false, error: err.message }, 500);
  }
}
