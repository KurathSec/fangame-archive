// GET /api/all — the whole catalog, or any slice of it.
//
// With no parameters it returns every game in the archive (that is the point of
// the endpoint). Every filter in functions/api/_lib/catalog.js applies here and
// composes freely, e.g.
//   /api/all?tag=needle&tag_not=trap&engine_not=Unity&date_in=2015-01-01:2018-12-31
//
// Paginate with ?limit= & ?offset= (limit=0 means "no limit"), trim the payload
// with ?fields=id,title,release_date.

import {
  preflight, json, badRequest, loadCatalog, parseQuery, buildResults,
  cacheLookup, cacheStore, isCacheable
} from "./_lib/catalog.js";

export async function onRequest(context) {
  const pre = preflight(context.request);
  if (pre) return pre;

  const url = new URL(context.request.url);
  const parsed = parseQuery(url.searchParams, { defaultLimit: 0, defaultSort: "id" });
  if (parsed.errors.length) return badRequest(parsed.errors[0], { errors: parsed.errors });

  const cacheable = isCacheable(parsed);
  const { cache, key, hit } = await cacheLookup(context, cacheable);
  if (hit) return hit;

  try {
    const games = await loadCatalog(url.origin);
    const built = buildResults(games, parsed, url.origin);
    const res = json({ success: true, catalog_size: games.length, ...built },
                     200, cacheable ? {} : { "Cache-Control": "no-store" });
    return cacheStore(context, cache, key, res);
  } catch (err) {
    return json({ success: false, error: err.message }, 500);
  }
}
