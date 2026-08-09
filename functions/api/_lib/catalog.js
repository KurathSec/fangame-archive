// Shared catalog query engine for the public read-only APIs
// (/api/all, /api/tag, /api/engine, /api/releasedate, /api/search, /api/random).
//
// Every endpoint parses the SAME filter vocabulary through `parseFilters`, so the
// filters compose freely across endpoints: /api/tag?tag=needle&engine_not=Unity
// is the same predicate set as /api/all?tag=needle&engine_not=Unity.
//
// Tri-state filtering mirrors the sidebar Explorer exactly (src/explorer.jsx):
//   <field>      -> OR   (game must match ANY of the listed values)
//   <field>_all  -> AND  (game must match ALL of the listed values)
//   <field>_not  -> NOT  (game must match NONE of the listed values)
// A field that is not mentioned is neutral and filters nothing.

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json;charset=utf-8"
};

export const ENGINE_UNKNOWN = "unknown";

// Public page for a game on each site that documents it. `source` on a game
// record is a list of {type, id} (ingest origin first, then cross-links such as
// the IWanna Wiki entry found for a Delicious Fruit ingest); the URL is derived
// here so the stored catalog stays compact.
const SOURCE_SITES = {
  df: {
    label: "Delicious Fruit",
    url: (id) => `https://delicious-fruit.com/ratings/game_details.php?id=${encodeURIComponent(id)}`
  },
  wiki: {
    label: "IWanna Wiki",
    url: (id) => `https://iwannawiki.com/games/${encodeURIComponent(id)}`
  }
};

/** One {type, id} -> a resolvable link, or null when the site is unknown. */
export function sourceLink(source) {
  if (!source || !source.type || !source.id) return null;
  const site = SOURCE_SITES[source.type];
  if (!site) return null;
  return { type: source.type, id: String(source.id), site: site.label, url: site.url(source.id) };
}

/** A game's `source` (list, or a bare object from older records) -> link list. */
export function sourceLinks(source) {
  const list = Array.isArray(source) ? source : (source ? [source] : []);
  return list.map(sourceLink).filter(Boolean);
}

/** The type of a game's ingest origin (first entry), or "none". */
export function primarySourceType(source) {
  const list = Array.isArray(source) ? source : (source ? [source] : []);
  const first = list.find((s) => s && s.type);
  return first ? String(first.type).toLowerCase() : "none";
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, ...extraHeaders }
  });
}

export function badRequest(error, extra = {}) {
  return json({ success: false, error, ...extra }, 400);
}

export function preflight(request) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  return null;
}

// ── Edge cache ──────────────────────────────────────────────────────────────
// Endpoints are pure functions of the URL, so the whole response is cacheable.
// (Callers that must re-sample per request — /api/random — skip this.)

export async function cacheLookup(context, enabled = true) {
  if (!enabled || typeof caches === "undefined") return { cache: null, key: null, hit: null };
  try {
    const cache = caches.default;
    const key = new Request(context.request.url, context.request);
    const hit = await cache.match(key);
    return { cache, key, hit: hit || null };
  } catch (e) {
    console.warn("Cache match failed:", e);
    return { cache: null, key: null, hit: null };
  }
}

export function cacheStore(context, cache, key, response, maxAge = 600) {
  if (!cache || !key || context.request.method !== "GET" || response.status !== 200) return response;
  response.headers.set("Cache-Control", `public, max-age=${maxAge}`);
  try {
    context.waitUntil(cache.put(key, response.clone()));
  } catch (e) {
    console.warn("Cache write failed:", e);
  }
  return response;
}

// ── Catalog load ────────────────────────────────────────────────────────────

export async function loadCatalog(origin) {
  const res = await fetch(`${origin}/data/search_index.json`);
  if (!res.ok) throw new Error(`Failed to load database search index (HTTP ${res.status})`);
  return res.json();
}

// ── Filter parsing ──────────────────────────────────────────────────────────

function listParam(sp, name) {
  // Accepts both repeated params (?tag=a&tag=b) and comma lists (?tag=a,b).
  const out = [];
  for (const raw of sp.getAll(name)) {
    for (const piece of String(raw).split(",")) {
      const v = piece.trim();
      if (v) out.push(v);
    }
  }
  return out;
}

function lowerList(sp, name) {
  return listParam(sp, name).map((v) => v.toLowerCase());
}

function numParam(sp, name, errors, { min = -Infinity, max = Infinity } = {}) {
  const raw = sp.get(name);
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    errors.push(`${name} must be a number (got "${raw}")`);
    return null;
  }
  if (n < min || n > max) {
    errors.push(`${name} must be between ${min} and ${max} (got ${n})`);
    return null;
  }
  return n;
}

function boolParam(sp, name, errors) {
  const raw = sp.get(name);
  if (raw === null || raw.trim() === "") return null;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(v)) return true;
  if (["0", "false", "no", "n"].includes(v)) return false;
  errors.push(`${name} must be true or false (got "${raw}")`);
  return null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value, label, errors) {
  const v = String(value || "").trim();
  if (!v) return null;
  if (!DATE_RE.test(v)) {
    errors.push(`${label} must be an ISO date YYYY-MM-DD (got "${v}")`);
    return null;
  }
  return v;
}

// "2015-01-01:2018-12-31" -> {from, to}; either side may be empty for an open bound.
function parseRange(raw, label, errors) {
  const s = String(raw).trim();
  if (!s) return null;
  const parts = s.split(":");
  if (parts.length !== 2) {
    errors.push(`${label} must be FROM:TO with ISO dates, e.g. 2015-01-01:2018-12-31 (got "${s}")`);
    return null;
  }
  const from = parts[0].trim() ? parseDate(parts[0], `${label} start`, errors) : null;
  const to = parts[1].trim() ? parseDate(parts[1], `${label} end`, errors) : null;
  if (!from && !to) {
    errors.push(`${label} needs at least one bound (got "${s}")`);
    return null;
  }
  // Tolerate reversed bounds rather than silently returning nothing.
  if (from && to && from > to) return { from: to, to: from };
  return { from, to };
}

function rangeList(sp, name, errors) {
  const out = [];
  for (const raw of sp.getAll(name)) {
    const r = parseRange(raw, name, errors);
    if (r) out.push(r);
  }
  return out;
}

export const SORT_KEYS = ["id", "title", "creator", "rating", "difficulty", "date", "reviews", "size", "random"];

/**
 * A `sort=random` response must not be cached — the edge would freeze one
 * shuffle for 10 minutes and the endpoint would stop looking random. Endpoints
 * pass this to both cacheLookup (don't serve a stale shuffle) and the response
 * headers (don't let the browser freeze it either).
 */
export function isCacheable(parsed) {
  return parsed.sort !== "random";
}

/**
 * Parse the shared filter vocabulary out of a URLSearchParams.
 * Returns { filters, sort, order, limit, offset, fields, errors }.
 * `errors` is non-empty when a param was malformed — endpoints reject with 400
 * rather than silently ignoring it, so a typo never looks like "no results".
 */
export function parseQuery(sp, { defaultLimit = 100, maxLimit = 0, defaultSort = "id" } = {}) {
  const errors = [];

  const dateRanges = rangeList(sp, "date_in", errors).map((r) => ({ ...r, mode: "in" }));
  const excludeRanges = rangeList(sp, "date_not", errors).map((r) => ({ ...r, mode: "out" }));
  const from = parseDate(sp.get("date_from") || "", "date_from", errors);
  const to = parseDate(sp.get("date_to") || "", "date_to", errors);
  if (from || to) dateRanges.push({ from, to, mode: "in" });

  const ids = listParam(sp, "id").concat(listParam(sp, "ids"));
  for (const id of ids) {
    if (!/^\d+$/.test(id)) errors.push(`id must be a positive integer (got "${id}")`);
  }

  const sources = lowerList(sp, "source");
  const sourcesNot = lowerList(sp, "source_not");
  for (const s of sources.concat(sourcesNot)) {
    if (!["df", "wiki", "none"].includes(s)) errors.push(`source must be df, wiki or none (got "${s}")`);
  }

  const filters = {
    q: (sp.get("q") || "").trim().toLowerCase(),
    title: (sp.get("title") || "").trim().toLowerCase(),
    creator: (sp.get("creator") || "").trim().toLowerCase(),
    ids: ids.length ? new Set(ids.map(String)) : null,

    tagAny: lowerList(sp, "tag"),
    tagAll: lowerList(sp, "tag_all"),
    tagNot: lowerList(sp, "tag_not"),

    engineAny: lowerList(sp, "engine"),
    engineNot: lowerList(sp, "engine_not"),
    hasEngine: boolParam(sp, "has_engine", errors),

    dateRanges: dateRanges.concat(excludeRanges),
    hasDate: boolParam(sp, "has_date", errors),

    ratingMin: numParam(sp, "rating_min", errors, { min: 0, max: 10 }),
    ratingMax: numParam(sp, "rating_max", errors, { min: 0, max: 10 }),
    difficultyMin: numParam(sp, "difficulty_min", errors, { min: 0, max: 100 }),
    difficultyMax: numParam(sp, "difficulty_max", errors, { min: 0, max: 100 }),
    reviewsMin: numParam(sp, "reviews_min", errors, { min: 0 }),
    reviewsMax: numParam(sp, "reviews_max", errors, { min: 0 }),
    sizeMinMb: numParam(sp, "size_min_mb", errors, { min: 0 }),
    sizeMaxMb: numParam(sp, "size_max_mb", errors, { min: 0 }),

    sources,
    sourcesNot,
    sourceId: (sp.get("source_id") || "").trim(),

    local: boolParam(sp, "local", errors),
    hasDownload: boolParam(sp, "has_download", errors)
  };

  let sort = (sp.get("sort") || defaultSort).trim().toLowerCase();
  if (!SORT_KEYS.includes(sort)) {
    errors.push(`sort must be one of ${SORT_KEYS.join(", ")} (got "${sort}")`);
    sort = defaultSort;
  }
  const orderRaw = (sp.get("order") || "").trim().toLowerCase();
  if (orderRaw && !["asc", "desc"].includes(orderRaw)) {
    errors.push(`order must be asc or desc (got "${orderRaw}")`);
  }
  // Ranked fields read best highest-first; identifiers read best lowest-first.
  const defaultOrder = ["rating", "difficulty", "date", "reviews", "size"].includes(sort) ? "desc" : "asc";
  const order = ["asc", "desc"].includes(orderRaw) ? orderRaw : defaultOrder;

  let limit = numParam(sp, "limit", errors, { min: 0 });
  if (limit === null) limit = defaultLimit;
  limit = Math.floor(limit);
  if (maxLimit > 0 && (limit === 0 || limit > maxLimit)) limit = maxLimit;

  let offset = numParam(sp, "offset", errors, { min: 0 });
  offset = offset === null ? 0 : Math.floor(offset);

  const fields = listParam(sp, "fields");

  return { filters, sort, order, limit, offset, fields, errors };
}

// ── Predicate ───────────────────────────────────────────────────────────────

function gameEngine(g) {
  const e = (g.engine || "").trim();
  return e ? e.toLowerCase() : ENGINE_UNKNOWN;
}

// Every site that documents this game, not just the one it was ingested from —
// so `source=wiki` reads as "has a wiki entry", which is what a caller wants.
function sourceTypes(g) {
  const list = Array.isArray(g.source) ? g.source : (g.source ? [g.source] : []);
  const types = list.filter((s) => s && s.type).map((s) => String(s.type).toLowerCase());
  return types.length ? types : ["none"];
}

function sourceIds(g) {
  const list = Array.isArray(g.source) ? g.source : (g.source ? [g.source] : []);
  return list.filter((s) => s && s.id).map((s) => String(s.id));
}

function inRange(date, r) {
  // An undated game is inside no range at all (mirrors the Explorer): include
  // ranges therefore drop it, exclude ranges leave it alone.
  if (!date) return false;
  if (r.from && date < r.from) return false;
  if (r.to && date > r.to) return false;
  return true;
}

export function matchesFilters(g, f) {
  if (f.ids && !f.ids.has(String(g.id))) return false;

  const title = String(g.title || "").toLowerCase();
  const creator = String(g.creator || "").toLowerCase();
  const tags = Array.isArray(g.tags) ? g.tags.map((t) => String(t).toLowerCase()) : [];

  if (f.q && !(title.includes(f.q) || creator.includes(f.q) || tags.some((t) => t.includes(f.q)))) return false;
  if (f.title && !title.includes(f.title)) return false;
  if (f.creator && !creator.includes(f.creator)) return false;

  if (f.tagAny.length && !tags.some((t) => f.tagAny.includes(t))) return false;
  if (f.tagAll.length && !f.tagAll.every((t) => tags.includes(t))) return false;
  if (f.tagNot.length && tags.some((t) => f.tagNot.includes(t))) return false;

  const eng = gameEngine(g);
  if (f.engineAny.length && !f.engineAny.includes(eng)) return false;
  if (f.engineNot.length && f.engineNot.includes(eng)) return false;
  if (f.hasEngine !== null && (eng !== ENGINE_UNKNOWN) !== f.hasEngine) return false;

  const date = g.release_date || null;
  if (f.hasDate !== null && Boolean(date) !== f.hasDate) return false;
  if (f.dateRanges.length) {
    const includes = f.dateRanges.filter((r) => r.mode === "in");
    if (includes.length && !includes.some((r) => inRange(date, r))) return false;
    if (f.dateRanges.some((r) => r.mode === "out" && inRange(date, r))) return false;
  }

  // Unrated games (rating_count == 0) carry null rating/difficulty; a floor above
  // 0 is a request for rated games, so they drop out — same rule as the Explorer.
  if (f.ratingMin !== null || f.ratingMax !== null) {
    if (g.rating === null || g.rating === undefined) {
      if (f.ratingMin !== null && f.ratingMin > 0) return false;
    } else {
      if (f.ratingMin !== null && g.rating < f.ratingMin) return false;
      if (f.ratingMax !== null && g.rating > f.ratingMax) return false;
    }
  }
  if (f.difficultyMin !== null || f.difficultyMax !== null) {
    if (g.difficulty === null || g.difficulty === undefined) {
      if (f.difficultyMin !== null && f.difficultyMin > 0) return false;
    } else {
      if (f.difficultyMin !== null && g.difficulty < f.difficultyMin) return false;
      if (f.difficultyMax !== null && g.difficulty > f.difficultyMax) return false;
    }
  }

  const reviews = Number(g.rating_count || 0);
  if (f.reviewsMin !== null && reviews < f.reviewsMin) return false;
  if (f.reviewsMax !== null && reviews > f.reviewsMax) return false;

  const sizeMb = Number(g.file_size || 0) / (1024 * 1024);
  if (f.sizeMinMb !== null && sizeMb < f.sizeMinMb) return false;
  if (f.sizeMaxMb !== null && sizeMb > f.sizeMaxMb) return false;

  const st = sourceTypes(g);
  if (f.sources.length && !st.some((t) => f.sources.includes(t))) return false;
  if (f.sourcesNot.length && st.some((t) => f.sourcesNot.includes(t))) return false;
  if (f.sourceId && !sourceIds(g).includes(f.sourceId)) return false;

  const url = String(g.url || "");
  if (f.hasDownload !== null && Boolean(url) !== f.hasDownload) return false;
  if (f.local !== null) {
    const isLocal = url.includes("file.fangame-archive.com") || url.includes("r2.dev");
    if (isLocal !== f.local) return false;
  }

  return true;
}

export function applyFilters(games, f) {
  return games.filter((g) => matchesFilters(g, f));
}

// ── Sorting ─────────────────────────────────────────────────────────────────

function nullsLast(a, b) {
  // Returns a comparison when exactly one side is missing, else null.
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  return null;
}

export function sortGames(games, sort, order) {
  if (sort === "random") {
    for (let i = games.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [games[i], games[j]] = [games[j], games[i]];
    }
    return games;
  }
  const dir = order === "desc" ? -1 : 1;
  games.sort((a, b) => {
    let cmp = 0;
    switch (sort) {
      case "title": cmp = String(a.title || "").localeCompare(String(b.title || "")); break;
      case "creator": cmp = String(a.creator || "").localeCompare(String(b.creator || "")); break;
      case "rating": {
        const n = nullsLast(a.rating, b.rating);
        // Missing values always sink to the bottom, whichever direction is asked
        // for, so `dir` is undone for them.
        cmp = n !== null ? n * dir : a.rating - b.rating;
        break;
      }
      case "difficulty": {
        const n = nullsLast(a.difficulty, b.difficulty);
        cmp = n !== null ? n * dir : a.difficulty - b.difficulty;
        break;
      }
      case "date": {
        const n = nullsLast(a.release_date || null, b.release_date || null);
        cmp = n !== null ? n * dir : String(a.release_date).localeCompare(String(b.release_date));
        break;
      }
      case "reviews": cmp = Number(a.rating_count || 0) - Number(b.rating_count || 0); break;
      case "size": cmp = Number(a.file_size || 0) - Number(b.file_size || 0); break;
      default: cmp = Number(a.id) - Number(b.id); break;
    }
    if (cmp === 0) return Number(a.id) - Number(b.id);
    return cmp * dir;
  });
  return games;
}

// ── Output shaping ──────────────────────────────────────────────────────────

export function shape(g, fields, origin = "") {
  const out = {
    id: g.id,
    title: g.title,
    creator: g.creator,
    url: g.url,
    tags: g.tags,
    engine: g.engine ?? null,
    release_date: g.release_date ?? null,
    rating: g.rating ?? null,
    difficulty: g.difficulty ?? null,
    rating_count: g.rating_count ?? 0,
    file_size: g.file_size ?? 0,
    page_url: `${origin}/?game=${g.id}`,
    // Every upstream page that documents this game, ingest origin first.
    source: sourceLinks(g.source)
  };
  if (!fields || !fields.length) return out;
  const picked = {};
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(out, f)) picked[f] = out[f];
  }
  // An all-unknown `fields` list would return empty objects, which reads as a
  // broken endpoint; fall back to the full record instead.
  return Object.keys(picked).length ? picked : out;
}

/** Filter -> sort -> paginate -> shape, the body every games-returning endpoint shares. */
export function buildResults(games, parsed, origin = "") {
  const matched = applyFilters(games, parsed.filters);
  sortGames(matched, parsed.sort, parsed.order);
  const total = matched.length;
  const start = Math.min(parsed.offset, total);
  const page = parsed.limit > 0 ? matched.slice(start, start + parsed.limit) : matched.slice(start);
  return {
    total,
    offset: start,
    limit: parsed.limit,
    count: page.length,
    results: page.map((g) => shape(g, parsed.fields, origin))
  };
}
