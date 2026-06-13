# Fangame Archive Explorer — System Architecture & Developer Reference

A complete technical specification of the **Fangame Archive Explorer**: a serverless, client-rendered catalog and review platform hosting **20,000+ games** and **156,000+ user reviews**. This document describes *what each subsystem is*, *the mechanism by which it is implemented*, and *how each capability is invoked* — both client-side (browser globals, React hooks) and server-side (HTTP endpoints, bindings).

> **Audience:** developers maintaining or extending the system. Every endpoint, binding, environment variable, and runtime contract referenced here is grounded in the live source under `functions/`, `src/`, `pipelines/`, and `database/`.

---

## 1. System Topology

The stack is fully serverless and decoupled: a static React SPA on Cloudflare Pages, server logic in Pages Functions (Workers runtime), and state split across R2 (objects), D1 (SQL), and KV (cache). Identity is delegated to Clerk; bot mitigation to Cloudflare Turnstile.

```mermaid
graph TD
    subgraph Cloudflare Storage
        R2[(R2 Buckets<br/>fangame-files / fangame-screenshots)]
        D1[(D1 SQL DB<br/>fangame-comments — binding DB)]
        KV[(KV Namespace<br/>binding ARCHIVE_KV)]
    end

    subgraph External Identity & Security
        Clerk[Clerk Production Instance<br/>FAPI: clerk.fangame-archive.com]
        Turnstile[Cloudflare Turnstile]
        OAuth[OAuth IdPs<br/>Google / Discord / Microsoft]
    end

    subgraph Pipelines
        GA[GitHub Actions<br/>cron + push]
        LB[Local Windows<br/>sync_and_deploy.bat]
    end

    subgraph Public Edge
        Pages[Cloudflare Pages<br/>static assets + Functions]
    end

    subgraph Client Browser
        IDB[(IndexedDB<br/>DeliciousArchiveDB)]
        LS[(localStorage<br/>auth cache / favorites mirror)]
        UI[React SPA — in-browser Babel]
    end

    GA & LB -- sync_db_r2 --> R2
    GA -- merge_approved_submissions --> D1 & R2
    GA & LB -- wrangler pages deploy --> Pages

    UI -- HTML + JSX + DB chunks --> Pages
    UI -- cache --> IDB
    UI -- optimistic identity --> LS
    UI -- load clerk-js (npm) + session --> Clerk
    Clerk -- redirect flow --> OAuth
    UI -- "REST: /api/*" --> Pages
    Pages -- verify JWT (JWKS) / fetch profile --> Clerk
    Pages -- siteverify --> Turnstile
    Pages -- SQL --> D1
    Pages -- profile cache / quotas --> KV
    UI -- download zips / screenshots --> R2
```

### 1.1 Infrastructure Components

| Component | Role | Binding / Host | Key constraint |
|---|---|---|---|
| **Cloudflare Pages** | Static hosting + Pages Functions (Workers) | project `fangame-archive` | 25 MB per-file limit → drives DB chunking |
| **Cloudflare R2** | Game zips + screenshots + master JSON | `fangame-files`, `fangame-screenshots` | served via `file.`/`screenshots.fangame-archive.com` |
| **Cloudflare D1** | SQL for users, comments, submissions, favorites, audit | binding `DB` → `fangame-comments` | accessed only from Functions |
| **Cloudflare KV** | Clerk profile cache + per-user daily quotas | binding `ARCHIVE_KV` | TTL-based expiry |
| **Clerk** | Identity, sessions, OAuth, account UI | FAPI `clerk.fangame-archive.com` | production keys (`pk_live`/`sk_live`) |
| **Turnstile** | CAPTCHA on writes | site key in `index.html`, secret in env | verified server-side |
| **GitHub Actions** | Scheduled (6 h) + push pipelines | `.github/workflows/deploy.yml` | orchestrates sync/scrape/build/deploy |

### 1.2 Runtime Configuration Reference

**Bindings** (`wrangler.toml`):
- `DB` — D1 database `fangame-comments` (`database_id` pinned in `wrangler.toml`).
- `ARCHIVE_KV` — KV namespace for profile cache and quotas.
- Pages build output: `github_pages_dist/`.

**Server environment variables** (Cloudflare Pages → Settings → Environment variables; **must redeploy after changes**):
- `CLERK_PUBLISHABLE_KEY` — `pk_live_…`; used to derive the JWKS URL for token verification.
- `CLERK_SECRET_KEY` — `sk_live_…`; used for Clerk Backend API profile lookups.
- `TURNSTILE_SECRET_KEY` — Turnstile siteverify secret (falls back to the Cloudflare test key if unset).

**Client globals injected in `public/index.html`:**
- `window.CLERK_PUBLISHABLE_KEY`, `window.CLERK_JS_URL` (FAPI-hosted SDK URL), `window.TURNSTILE_SITE_KEY`.
- `window.SCREENSHOT_BASE_URL`, `window.DATABASE_VERSION`, `window.APP_VERSION`, `window.ADMIN_URL`.

---

## 2. Data Model

Bulk catalog data lives as JSON in R2 (mirrored locally under `data/`/`database/`, git-ignored except `*.sample.json`). Live, user-mutable state lives in D1.

### 2.1 Catalog JSON (R2 / build inputs)

**`data/games.json`** — map of sequential string ID → game object:
```json
{
  "3": {
    "id": 3,
    "title": "(Demo) I wanna practice the making 2",
    "creator": { "name": "AHS1222", "url": "https://delicious-fruit.com/..." },
    "avg_rating": 8.4,          // float | null (unrated)
    "avg_difficulty": 50.0,     // float 0–100 | null
    "download_url": "https://file.fangame-archive.com/Game/3.zip",
    "tags": ["needle"],
    "screenshots": [{ "id": 28023, "image_path": "ratings/screenshots/24176_00006d77.png", "by": "Anonymous" }],
    "reviews": [ /* … */ ],
    "rating_count": 3,
    "file_size": 5952231        // bytes
  }
}
```
*Schema properties:* `avg_rating` — float average rating or `null` if unrated; `avg_difficulty` — float average difficulty (0–100) or `null`; `rating_count` — number of comments/reviews; `file_size` — size of the zip archive in bytes.

**`data/recent_changes.json`** — monotonic `version` + `timeline` of deltas, enabling incremental client sync. Each timeline entry carries a `timestamp`, an `updated` map (id → new game object), and a `deleted` array:
```json
{
  "version": 70,
  "timeline": {
    "70": {
      "timestamp": 1780962800,
      "updated": { "125": { "id": 125, "title": "Updated Title", "...": "..." } },
      "deleted": []
    }
  }
}
```

**`database/seq_to_orig_map.json`** — maps local sequential IDs to their origin IDs (Delicious Fruit IDs or I Wanna Wiki IDs) plus provenance flags (`new_game`/`wiki_game`/`title_match`, `tags_synced`):
```json
{
  "3": ["24176", "new_game", "tags_synced"],
  "20951": ["WIKI-46280", "wiki_game", "tags_synced"]
}
```
A mapping may persist as a **tombstone** after its game is removed from `games.json` by the duplicate-resolution tool — this intentionally keeps the origin id "claimed" so the live-scrape reconcile won't re-add the duplicate (see §8.6). Consumers must not assume a mapped sequential id still exists in `games.json`.

> `games.json` carries one resolution-derived state worth noting: a **`clear_link`** game keeps its full entry but with `download_url: null` and `file_size: 0` — it stays searchable but is not downloadable, and is excluded from the storage-size total.

**`temp/reviews_scraped.json`** — the complete offline corpus of ~156,800 user reviews. Each entry:
```json
{
  "author": "Moowool",
  "user_id": 1234,
  "game_id": 24176,
  "game_title": "(Demo) I wanna practice the making 2",
  "text": "Outstanding visuals!",
  "likes": 0,
  "rating": 8.4,
  "difficulty": 50,
  "date": "Jan 10, 2022",
  "tags": []
}
```

**Build artifact `data/search_index.json`** — slim per-game records (`id`, `title`, `creator`, `url`, `tags`) consumed by the `/api/search` endpoint.

### 2.2 D1 Schema (`fangame-comments`)

Canonical DDL lives in `database/schema.sql` and is applied with
`npx wrangler d1 execute fangame-comments --remote --file database/schema.sql` (all statements use `IF NOT EXISTS`, so re-running is safe).

**Overview**

| Table | Purpose |
|---|---|
| `users` | Clerk-synced account profiles (provisioned just-in-time by the middleware) |
| `comments` | Native + imported game reviews |
| `game_submissions` | User-submitted game suggestions pending merge |
| `user_favorites` | Per-user favorited games (Collections feature) |
| `audit_log` | Moderation/admin action audit trail |

**`users`** — user account profiles synchronized from Clerk.
- `id` (`TEXT PRIMARY KEY`): unique Clerk user identifier.
- `email` (`TEXT`): user's primary email.
- `display_name` (`TEXT`): resolved nickname of the user.
- `avatar_url` (`TEXT`): profile image CDN URL.
- `role` (`TEXT NOT NULL DEFAULT 'user'`): access privileges (`'user'`, `'mod'`, `'admin'`).
- `status` (`TEXT NOT NULL DEFAULT 'active'`): moderation status (`'active'`, `'muted'`, `'banned'`).
- `created_at` (`INTEGER NOT NULL`): account synchronization timestamp (epoch ms).
- `updated_at` (`INTEGER NOT NULL`): last update timestamp (epoch ms).

**`comments`** — user-submitted game reviews (native and crawled).
- `id` (`INTEGER PRIMARY KEY AUTOINCREMENT`): auto-incremented ID.
- `game_id` (`INTEGER NOT NULL`): reference matching the sequential catalog game ID.
- `user` (`TEXT NOT NULL`): submitter display name/nickname (snapshot; live name resolved via `LEFT JOIN users`).
- `rating` (`REAL`): numeric score, or `NULL` if omitted.
- `difficulty` (`INTEGER`): difficulty score (0–100), or `NULL` if omitted.
- `likes` (`INTEGER DEFAULT 0`): count of thumbs up.
- `date` (`TEXT`): formatted publication date (e.g. `Jun 10, 2026`).
- `content` (`TEXT NOT NULL`): the review/comment body.
- `tags` (`TEXT`): JSON-encoded tag list (max 10 tags, max 20 chars each).
- `user_id` (`TEXT`): submitter's Clerk user ID reference.
- `status` (`TEXT NOT NULL DEFAULT 'pending'`): moderation state (`'pending'`, `'approved'`, `'rejected'`).
- `source` (`TEXT NOT NULL DEFAULT 'native'`): channel (`'native'` for site submissions, `'imported'` for crawls).
- `created_ts` (`INTEGER`): submission epoch ms.
- `reviewed_by` (`TEXT`): username/ID of the moderator who reviewed it.

**`game_submissions`** — pending/approved user game submissions before merge into the JSON catalog.
- `id` (`INTEGER PRIMARY KEY AUTOINCREMENT`): submission ID.
- `submitter_id` (`TEXT NOT NULL`): Clerk user ID of the submitter.
- `title` (`TEXT NOT NULL`): title of the submitted game.
- `author_name` (`TEXT NOT NULL`): creator name(s) (supports comma-separated co-creators).
- `external_url` (`TEXT NOT NULL`): original download URL.
- `tags` (`TEXT`): JSON-encoded tag list (max-10 count, 20-char constraints).
- `screenshots` (`TEXT`): JSON array of up to 5 screenshot URLs.
- `description` (`TEXT`): short submission description.
- `status` (`TEXT NOT NULL DEFAULT 'pending'`): state (`'pending'`, `'approved'`, `'rejected'`, `'merged'`).
- `reject_reason` (`TEXT`): rejection description if rejected.
- `assigned_game_id` (`INTEGER`): final sequential game ID assigned after merge.
- `created_at` (`INTEGER NOT NULL`): submission timestamp.
- `reviewed_at` (`INTEGER`): moderation review timestamp.
- `reviewed_by` (`TEXT`): moderator identifier.
- `merged_at` (`INTEGER`): catalog-integration timestamp.

**`user_favorites`** — per-user favorited games backing the Collections feature.
- `id` (`INTEGER PRIMARY KEY AUTOINCREMENT`): row ID (favorites are listed `ORDER BY id DESC`, i.e. newest first).
- `user_id` (`TEXT NOT NULL`): Clerk user ID of the owner.
- `game_id` (`INTEGER NOT NULL`): favorited sequential game ID.
- `created_at` (`INTEGER NOT NULL`): epoch ms when favorited.
- `UNIQUE (user_id, game_id)`: makes `INSERT OR IGNORE` idempotent; indexed on `user_id`.

**`audit_log`** — audits administration-panel actions.
- `id` (`INTEGER PRIMARY KEY AUTOINCREMENT`): log ID.
- `actor_id` (`TEXT NOT NULL`): Clerk user ID of the admin/moderator who acted.
- `action` (`TEXT NOT NULL`): action description (e.g. `'approve_comment'`).
- `target_type` (`TEXT NOT NULL`): target entity type (`'comment'`, `'submission'`).
- `target_id` (`TEXT NOT NULL`): primary key of the target entity.
- `meta` (`TEXT`): JSON-encoded audit metadata.
- `created_at` (`INTEGER NOT NULL`): event timestamp.

---

## 3. Authentication & Identity (Clerk)

Authentication is the most intricate subsystem. It spans a lazily-loaded client SDK, a redirect-based OAuth flow, server-side JWT verification, and just-in-time user provisioning. The following details the exact mechanism and the rationale behind each design choice.

### 3.1 Production instance & domains

The app uses a **Clerk production instance** whose Frontend API (FAPI) is the first-party subdomain **`clerk.fangame-archive.com`**, encoded inside the publishable key `pk_live_…` (base64url of `clerk.fangame-archive.com$`). Production requires DNS CNAMEs (`clerk`, `accounts`, `clkmail`, `clk._domainkey`, `clk2._domainkey`) pointing to Clerk, with SSL issued — without them the FAPI does not resolve and the SDK hangs. The Account Portal lives at `accounts.fangame-archive.com`.

### 3.2 SDK loading mechanism (`src/app.jsx`, `src/auth.jsx`)

The clerk-js SDK is **loaded from the FAPI domain, not bundled and not proxied**:

```js
window.CLERK_JS_URL =
  "https://clerk.fangame-archive.com/npm/@clerk/clerk-js@5/dist/clerk.browser.js";
```

Two deliberate constraints are encoded here:

1. **Pinned to v5 (pre-RHC).** clerk-js **v6** defaults to *Remotely-Hosted Code*: `clerk.browser.js` no longer bundles the sign-in/sign-up UI and requires the host to inject a UI constructor into `Clerk.load()`. With our manual init that yields `"Clerk was not loaded with Ui components"` on `openSignIn()`. **v5** is the monolithic build (`mountComponentRenderer`) where `Clerk.load(options)` mounts the UI internally — which is what this codebase relies on.
2. **Loaded from the FAPI domain, not the `/api/clerk-js` proxy.** clerk-js is code-split; calling `openSignIn()` lazily fetches `vendors_/signin_/ui-common_` chunks whose base URL is derived from the main script's location. A single-file proxy cannot serve those chunks (they 404 as HTML → `ChunkLoadError`). Serving from the FAPI resolves every chunk. `functions/api/clerk-js.js` remains only as an inert fallback.

**Initialization sequence** (runs in the background on first paint so it never blocks DB loading):

1. A `<script>` is injected with `src = window.CLERK_JS_URL` and `data-clerk-publishable-key`. A `<link rel="preconnect">` to the FAPI (in `index.html`) warms the TLS handshake.
2. clerk-js auto-instantiates `window.Clerk` (an instance, because the publishable key is read from the script attribute).
3. `Clerk.load(options)` is called **exactly once**, guarded by a shared promise to avoid a race between the background loader (`app.jsx`) and the login button (`auth.jsx`):
   ```js
   await (window.__clerkLoadPromise =
     window.__clerkLoadPromise || window.Clerk.load({ /* localization, appearance */ }));
   ```
   A second concurrent `load()` in clerk-js resets internal state and breaks UI wiring; the memoization prevents that.
4. `options` apply the **"Nickname-only" customization**: `localization` maps the *First Name* label/placeholder to "Nickname"; `appearance.elements.formFieldRow__lastName: { display: 'none' }` hides Last Name.

### 3.3 Sign-in surface & identity providers

The login button (`AccountBlock` in `src/auth.jsx`) calls `Clerk.openSignIn()` once the SDK is loaded; if a click arrives early it transparently triggers loading first ("Loading Auth…" → "Initializing Auth…"). Configured first-factor strategies (managed in the Clerk Dashboard, surfaced via the FAPI `/v1/environment` config):

- **OAuth:** Google, Discord, Microsoft. In a **production** instance each provider requires **custom OAuth credentials** (client id/secret) registered in the provider console, with the redirect URI `https://clerk.fangame-archive.com/v1/oauth_callback`. (Shared Clerk dev credentials do not exist for production — omitting custom credentials yields provider errors such as `AADSTS900144: missing client_id`.)
- **Email code (OTP)** is the recommended universal fallback (works where Google/Discord are network-blocked); enabled per-instance in the Dashboard.

### 3.4 Post-login client sync (`src/app.jsx`)

`Clerk.addListener` drives a `syncUser()` routine that reconciles three layers of identity:

1. **Optimistic cache.** `auth`/`identity` React state initialize from `localStorage['archive_auth_cache']`, so a returning user sees their avatar/name instantly instead of a "logged-out" flash.
2. **Clerk session (authoritative for logged-in state).** As soon as `Clerk.user` exists, `auth` is set to `'user'` and identity is resolved via `getClerkIdentity()` (priority: First Name/Nickname → username → email local-part → "Member"; deterministic avatar color from the name). This flips the UI immediately **even if the backend cannot verify the token**.
3. **D1 enrichment via `/api/me`.** A bearer token (`Clerk.session.getToken()`) is sent to `/api/me`; on success it upgrades the role (e.g. `'admin'`) and the canonical D1 `display_name`/`avatar_url`, and rewrites `archive_auth_cache`.

Because social-login redirects reload the SPA, `app.jsx` serializes the active `view` and open `activeGame` to `sessionStorage` and restores them on the redirect callback, preserving navigation context.

### 3.5 Server-side verification & JIT provisioning (`functions/_middleware.js`)

Every request passes through the global middleware, which:

1. **Handles CORS** (OPTIONS preflight + permissive headers on all responses).
2. **Verifies the JWT** when an `Authorization: Bearer` header is present, via `verifyClerkToken(token, env.CLERK_PUBLISHABLE_KEY)` in `functions/api/_lib/auth.js`:
   - Derives the JWKS URL from the publishable key — base64url-decode the encoded domain (with padding restored before `atob`) → `https://clerk.fangame-archive.com/.well-known/jwks.json`.
   - Fetches and **caches the JWKS for 10 minutes**, imports the matching `kid` as an `RSASSA-PKCS1-v1_5 / SHA-256` key via WebCrypto, verifies the signature, and checks `exp`/`nbf`.
3. **Resolves the profile** with `getClerkUserProfile(userId, env.CLERK_SECRET_KEY, env.ARCHIVE_KV)` — KV-cached (1 h) Clerk Backend API (`api.clerk.com/v1/users/{id}`) lookup; `/api/me` forces `bypassCache` so profile edits propagate instantly.
4. **Provisions the user just-in-time** in D1 (`INSERT … role='user', status='active'` if absent) and re-syncs `display_name`/`avatar_url` on change. The resolved record is attached as `context.data.user` for downstream handlers.
5. **Enforces moderation + write-auth**: `banned`/`muted` users are blocked from non-GET writes (403); any `/api/*` write without a verified user is rejected (401).

> **Operational note:** if `CLERK_PUBLISHABLE_KEY`/`CLERK_SECRET_KEY` hold dev values (or the project was not redeployed after setting them), verification fails silently → `context.data.user` is `null` → `/api/me` returns `user: null` and write endpoints return 401, even though the client UI shows the user as logged in.

---

## 4. Serverless API Gateway (`functions/api/`)

All handlers run on the Workers runtime as Pages Functions. Responses use the `jsonResponse`/`errorResponse` helpers (`_lib/http.js`); authenticated state is read from `context.data.user` (populated by the middleware in §3.5). Standard envelope: `{ success: boolean, … }` or `{ success: false, error }`.

| Endpoint | Method | Auth | Purpose & mechanism |
|---|---|---|---|
| `/api/me` | GET | optional | Returns `{ user }` from `context.data.user` (or `null`). No-store headers. Forces Clerk profile cache bypass for instant propagation. |
| `/api/me/comments` | GET | required | Lists the caller's own comments (`WHERE user_id = ?`), incl. moderation `status`. |
| `/api/me/submissions` | GET | required | Lists the caller's own submissions with `status`/`reject_reason`. |
| `/api/comments` | GET | optional | Returns approved comments for a `game_id` **plus the caller's own pending ones** (`status='approved' OR user_id=?`); `LEFT JOIN users` resolves live display names for native comments. |
| `/api/comments` | POST | required | Submits a review as `pending`. Pipeline below. |
| `/api/submissions` | POST | required | Submits a game suggestion as `pending`. Validates title/author/URL, ≤10 tags (≤20 chars), ≤5 screenshot URLs. Same Turnstile + quota pipeline. |
| `/api/favorites` | GET | required | Returns the caller's favorited `game_id`s (newest first) from `user_favorites`. |
| `/api/favorites` | POST | required | `INSERT OR IGNORE` a favorite (idempotent via the unique constraint). Body `{ gameId }`. |
| `/api/favorites/:id` | DELETE | required | Removes a favorite by `game_id` for the caller. |
| `/api/search` | GET | none | Public bot/keyword search; see §4.2. |
| `/api/clerk-js` | GET | none | Inert legacy proxy for clerk-js (no longer the primary load path; see §3.2). |

### 4.1 Write pipeline (comments & submissions)

`POST /api/comments` and `POST /api/submissions` share a hardened mechanism:

1. **Auth gate** — reject if `context.data.user` is absent (401).
2. **Field + constraint validation** — required fields; ≤10 tags × ≤20 chars; submissions additionally enforce ≤5 valid `http(s)` screenshot URLs.
3. **Turnstile verification** — `verifyTurnstile(token, env.TURNSTILE_SECRET_KEY, CF-Connecting-IP)` POSTs to Cloudflare `siteverify`; failure → 400.
4. **Daily quota (KV)** — keys `quota:comment:{userId}:{YYYYMMDD}` (limit **20/day**) and `quota:submit:{userId}:{YYYYMMDD}` (limit **5/day**), each with a 36 h TTL; over-limit → 429.
5. **Insert** into D1 with `status='pending'` (and `source='native'` for comments), awaiting moderation.

### 4.2 Search endpoint (`/api/search`)

A public read API (also usable by bots). It fetches the deployment's own `data/search_index.json`, then:
- `?id=` → exact match by game id.
- `?q=` → case-insensitive substring match over title/creator/tags, capped at 100 results.
Successful GETs are stored in the **edge cache** (`caches.default`, `Cache-Control: public, max-age=600`) keyed by URL, so repeat queries are served without re-reading the index.

---

## 5. Frontend Architecture (`src/`)

A React 18 SPA transpiled **in-browser by Babel Standalone** (`type="text/babel"` scripts). There is no bundler step at runtime; the Python build only rewrites paths and injects config. Component tree:

```
index.html (config globals + script mounts)
 └─ RootApp (cache load, DB hydration, mounts App)
     └─ App (state: view, activeGame, auth, identity, toasts)
         ├─ Sidebar / AccountBlock (nav, dynamic storage size, auth menu)
         ├─ Explorer (search, tri-state tag filter, grid/list, pagination)
         │    ├─ Card  └─ ListRow
         ├─ Drawer (game detail, lazy comment fetch, Turnstile, CommentEditor)
         ├─ Collections (favorites grid, reorder, stats)
         └─ Donation / Links / Contact / Updates views
```

### 5.1 Configuration injection (`index.html`)
The Python compiler writes runtime globals (`window.DATABASE_VERSION`, `APP_VERSION`, `SCREENSHOT_BASE_URL`, Clerk + Turnstile keys, `CLERK_JS_URL`) and appends `?v=<version>` cache-busters to every JSX/CSS import.

### 5.2 Bootloader & client cache (`src/app.jsx`)
`RootApp` hydrates the catalog into memory with a three-tier strategy against **IndexedDB `DeliciousArchiveDB`**:
1. **Cache hit** — if `String(localVersion) === String(DATABASE_VERSION)`, load instantly from IndexedDB (no network).
2. **Incremental update** — otherwise fetch `recent_changes.json?v=…` and replay `updated`/`deleted` timeline deltas from `localVersion` → latest, then persist.
3. **Full fallback** — if the timeline is incomplete (history pruned), fetch `games_part_1..3.json` in parallel, merge, and persist.
The merged catalog is exposed as `window.DATA = { TAGS, GAMES, REVIEWS, SCREENSHOTS, COLLECTIONS, … }`.

### 5.3 Search & filter engine (`src/explorer.jsx`)
State: `searchTitle`, `searchCreator`, `tags` (`Map` of tag → `'or'|'and'|'not'`), `rating`/`diff` range tuples, `page`. Tag logic: **AND** (must include all), **OR** (must include at least one when any OR filter is active), **NOT** (must exclude all). Range filters exclude unrated (`null`) games unless the bound sits at its default minimum. Inline `<input type="number">` controls allow precise (decimal) bounds, committed on blur. The **"Roll Random"** action (`window.rollRandomGame`) draws exclusively from the currently filtered set.

The **author-search dispatcher** is registered by `Explorer` and invoked by every author link (card, list row, drawer header):
```javascript
window.setCreatorSearch = (creatorName) => {
  if (window.setView) window.setView('explorer');
  setSearchCreator(creatorName);
  setSearchTitle('');
  setPage(1);
};
```

### 5.4 Detail drawer, reviews & favorites (`src/components.jsx`, `src/collections.jsx`)
- Opening a game drawer lazily fetches `GET /api/comments?game_id=…` and pages results client-side.
- `CommentEditor` exposes optional rating/difficulty via independent toggles (`hasRating`/`hasDiff`) — disabled toggles submit `null`. Custom tags validated to ≤10 × ≤20 chars. Bodies render via `CommentBody` (bold/italic/links/newlines) with `||spoiler||` → blurred `Spoiler` component.
- **Turnstile** widgets mount on-demand when a write form opens, yielding the token submitted to the API.
- **Favorites client** (`FavoritesAPI` in `collections.jsx`) wraps `GET/POST /api/favorites` and `DELETE /api/favorites/:id`, attaching the Clerk bearer token. It mirrors state to `localStorage` and broadcasts a `favorites:changed` event so every favorite button and the Collections grid stay in sync. When no auth token is present it degrades to a local-only mock.

### 5.5 Global invocation hooks
Cross-component actions are dispatched through window-level hooks rather than prop drilling:

| Global | Defined in | Invoked to |
|---|---|---|
| `window.setView(view)` | `app.jsx` | switch the active panel (`explorer`/`collections`/…). |
| `window.toggleSidebar()` / `closeSidebar()` | `app.jsx` | control the mobile sidebar. |
| `window.__pushToast({title,sub,kind})` | `app.jsx` | show a transient toast (`pushToast()` helper in `auth.jsx`). |
| `window.rollRandomGame()` | `explorer.jsx` | pick a random game from the *current filtered* set. |
| `window.setCreatorSearch(name)` | `explorer.jsx` | jump to Explorer and filter by author (used by every author link). |
| `window.forceAppUpdate()` | `app.jsx` | re-render after a language switch. |
| `window.__clerkLoadPromise` | `app.jsx`/`auth.jsx` | memoized single `Clerk.load()` (see §3.2). |
| `window.t(key, params)` / `setLanguage()` / `LanguageSelector` | `i18n.jsx` | i18n lookup, switch, and selector component. |

### 5.6 Internationalization (`src/i18n.jsx`)
Dictionaries for 8 locales (`en`, `zh-CN`, `zh-TW`, `ja`, `ko`, `ru`, `fr`, `de`); proper nouns (game/creator names, "Archive", "fangame") stay untranslated. `window.t` resolves keys with English fallback and `{named}` interpolation. The default is English; a manual selection persists to `localStorage['fangame_archive_lang']`. The header `LanguageSelector` switches locale live.

---

## 6. Anti-Abuse & Moderation

- **Turnstile** — every write requires a verified token (§4.1); server siteverify is authoritative.
- **Daily KV quotas** — 20 comments/day, 5 submissions/day per user, 36 h TTL keys.
- **Moderation states** — comments/submissions enter as `pending`; only `approved` content is public (the author additionally sees their own pending items). `users.status` (`muted`/`banned`) blocks writes. Admin/mod actions are recorded in `audit_log`.
- **Role gating** — `role='admin'` (from D1 via `/api/me`) unlocks the admin dashboard link; the SPA never trusts client-claimed roles for server actions.

---

## 7. Caching & Invalidation

A layered strategy guarantees clients see fresh data without manual cache clears:

1. **Config injection** — the build writes the current `DATABASE_VERSION` into `index.html`.
2. **Script cache-busting** — every JSX/CSS import gets `?v=<version>`; a new deploy changes the query and forces re-download.
3. **DB fetch cache-busting** — catalog fetches append `?v=${window.DATABASE_VERSION}` to bypass CDN/browser caches.
4. **Edge cache** — `/api/search` results cached at `caches.default` for 10 min.
5. **KV TTLs** — Clerk profiles 1 h (bypassed on `/api/me`); quota counters 36 h.
6. **No-store** on identity/comment responses to prevent stale auth/UI.

> **Deploy caveats learned in production:** (a) the JSX cache-buster only changes when `DATABASE_VERSION` changes — a code-only redeploy needs a Cloudflare cache purge + hard refresh to take effect; (b) Pages **environment-variable changes apply only to new deployments** — always redeploy after editing keys.

---

## 8. Python Pipelines (`pipelines/`)

Data harvesting, metric recomputation, chunking, and R2 sync.

### 8.1 `scrape_and_migrate_new_games.py` — master sync
Run: `python pipelines/scrape_and_migrate_new_games.py` (via `sync_and_deploy.bat` or GitHub Actions). The script is resilient by design: a failed live scrape (network/timeout) is logged and skipped rather than aborting the run.

1. **Latest-reviews scrape** — Delicious Fruit global feed (`limit=120`, 0.5 s spacing, 5 s timeout × 2 retries).
2. **Merge into `temp/reviews_scraped.json`** — de-duplicated by `review_key(r)`, a *stable identity* key:
   * written comment → `("c", game_id, author, user_id, text)` (ignores date/rating/likes drift, so a re-scraped review is not re-appended);
   * named rating-only entry → `("nr", game_id, author, user_id, rating, difficulty)`;
   * anonymous rating-only entry → full tuple incl. date, so distinct anonymous ratings stay counted toward averages.
   This prevents the historical duplicate-accumulation where the old full-tuple key let date-drifted re-scrapes pile up.
3. **Recompute metrics — Step 4A** (`for seq_id, g in games.items()`): for each non-WIKI game, gather its reviews by Delicious Fruit id and compute `avg_rating`, `avg_difficulty`, `rating_count`. All rating/difficulty parsing goes through **`review_nums()`**, which skips `None`/`'na'`/`''` and any non-numeric value via `try/except` (live-scraped junk can't crash the run).
4. **Tag aggregation** — review tags ∪ matched I Wanna Wiki page tags, preserving an existing `archive` tag.
5. **Live-catalog reconcile — Step 4B** (`if scraped_games:`): compare the live `full.php?q=ALL` list against local. New releases get a fresh sequential id, details from `game_details.php`, and the zip mirrored to R2. **Deleted (de-duplicated) games are skipped here** — see the tombstone invariant in §8.6 — guarded by `str(seq_id) in games`.
6. **Version delta** — if anything changed, bump `recent_changes.json` `version` and append a timeline entry (`updated`/`deleted`); prune timeline history to keep the file < 10 MB.
7. **Compile** — invoke `update_storage_stats.py` then `build_github_pages.py`.

### 8.2 `build_github_pages.py` — static compiler
Run: `python pipelines/build_github_pages.py`.
1. Chunk `games.json` into `games_part_1..3.json` (each < 25 MB).
2. Emit slim `search_index.json`.
3. Rewrite `src/app.jsx` to read the 3 parts; rewrite `index.html` to inject config + `?v=` cache-busters.

### 8.3 Supporting scripts
- `sync_db_r2.py {download|upload}` — sync `games.json`, `recent_changes.json`, `profiles.json`, `seq_to_orig_map.json`, `reviews_scraped.json` ↔ R2.
- `sync_screenshots_to_r2.py` — upload missing screenshots from `ratings/screenshots/`.
- `update_storage_stats.py` — sum `file_size` of R2-hosted games; update sidebar/donation storage figure.
- `merge_approved_submissions.py` — fetch `approved` (un-merged) submissions from D1, copy package → `fangame-files` (`Game/{id}{ext}`) and screenshots → `fangame-screenshots` (`ratings/screenshots/{id}_shot_{n}{ext}`), build the catalog entry, bump version, and mark the submission `merged` with its `assigned_game_id`.

### 8.4 `dedupe_reviews.py` — source de-duplication
Repeatable cleanup of `temp/reviews_scraped.json` using the same identity model as `review_key` (§8.1.2). Collapses duplicate written comments and named rating-only entries to the **best** representative (prefers a row that has a date, then higher `likes`), while leaving anonymous rating-only entries intact so rating averages are unaffected. Removing true duplicates *corrects* previously double-counted averages.
* `py pipelines/dedupe_reviews.py` — dry-run (reports counts only).
* `py pipelines/dedupe_reviews.py apply` — backs up to `reviews_scraped.backup.json`, then rewrites.

### 8.5 `apply_duplicate_resolution.py` — catalog + R2 duplicate resolution
Applies a hand-authored `duplicate_resolution_report.json` of the form `{ "keep": [...], "delete": [...], "clear_link": [...] }` (IDs are sequential catalog IDs):
* **keep** — no change.
* **delete** — remove the game from `games.json`, delete its R2 game file (`Game/{id}.{ext}` in `fangame-files`) and its screenshots (`fangame-screenshots`), and record the id in the new timeline delta's `deleted` array.
* **clear_link** — keep the catalog entry but set `download_url=null` + `file_size=0`, delete the R2 game file (screenshots kept), and record the entry in the delta's `updated` map.

Safety model and invocation:
* dry-run by default — prints the plan and writes `temp/r2_delete_manifest.json` (exact bucket/key list) without changing anything;
* `--apply` — backs up `games.json`/`recent_changes.json` to `*.before_dupres.json`, edits them, and bumps the catalog version with a proper timeline delta so cached clients sync the removals;
* `--delete-r2` (requires `--apply`) or `--r2-from-manifest` — performs the **irreversible** R2 object deletes (batched ≤1000) from the manifest. External (non-R2) download links are detected and never touched.

> **Rebase caution:** because this edits the local `games.json`, it must run against the **current** R2 master. If the 6-hourly cron has advanced the master since the last `download`, upload-without-rebasing would clobber newly-added games and collide the version counter — always `sync_db_r2.py download` first, re-apply, then `upload`.

### 8.6 Data-integrity invariants
The pipeline and APIs depend on a few invariants that the cleanup tools deliberately maintain:
* **seq_map tombstones** — a deleted game keeps its `seq_to_orig_map` entry. This claims its Delicious Fruit id so the live-scrape reconcile (§8.1.5) treats it as *already mapped* and does **not** re-add the duplicate. The pipeline therefore must tolerate a mapped `seq_id` that is absent from `games` (every `games[seq_id]` read in Step 4B is guarded by `str(seq_id) in games`).
* **`comments` dedup index** — an optional `UNIQUE (game_id, user, content)` index makes imports idempotent; the comments `POST` uses `INSERT OR IGNORE` so it coexists with the index without 500s.
* **`clear_link` ⇒ `download_url=null`** — every pipeline accessor of `download_url` must be null-safe (`(g.get("download_url") or "")`); the storage-stat summers already skip falsy URLs, so cleared games drop out of the storage total automatically.

---

## 9. Build & Deployment

### 9.1 Local (Windows batch)
- **`deploy.bat`** — download DBs from R2 → run the page compiler → `wrangler pages deploy github_pages_dist`.
- **`sync_and_deploy.bat`** — `sync_db_r2 download` → `scrape_and_migrate_new_games` → `ingest_local_folder_games` → `sync_screenshots_to_r2` → `sync_db_r2 upload` → `wrangler pages deploy`.

### 9.2 Cloud (`.github/workflows/deploy.yml`)
On push to `main` (matching paths) or every 6 h: set up Python 3.10 + Node 20 → `sync_db_r2 download` → `merge_approved_submissions` → `scrape_and_migrate_new_games` → `sync_screenshots_to_r2` → `sync_db_r2 upload` → `npx -y wrangler pages deploy`.

### 9.3 D1 migrations
Apply schema changes to the live DB explicitly (not part of the deploy):
```
npx wrangler d1 execute fangame-comments --remote --file database/schema.sql
```

---

## 10. Operational Runbook (common failure modes)

| Symptom | Root cause | Resolution |
|---|---|---|
| Auth spinner never resolves | Production FAPI DNS/SSL not provisioned | Add Clerk CNAMEs (DNS-only), verify SSL issued |
| `ChunkLoadError` / MIME error on `openSignIn` | clerk-js loaded via single-file proxy | Load from FAPI `…/npm/@clerk/clerk-js@5/…` (`window.CLERK_JS_URL`) |
| "Clerk was not loaded with Ui components" | clerk-js v6 (RHC) with manual init | Pin to **v5** |
| Login button reverts / no-ops | Concurrent double `Clerk.load()` | Memoized `window.__clerkLoadPromise` |
| OAuth error (e.g. `AADSTS900144`) | Production provider missing custom credentials/redirect URI | Register client id/secret + `…/v1/oauth_callback` in the provider console, enter in Clerk |
| UI shows logged-out after login / writes 401 | Backend env keys are dev values or not redeployed | Set `pk_live`/`sk_live` in Pages env, **redeploy** |
| "Favorites service did not respond" | `user_favorites` table missing | Apply `database/schema.sql` to remote D1 |
| Fix deployed but no effect | JSX `?v=` unchanged / env change without redeploy | Purge Cloudflare cache + hard refresh; redeploy after env edits |
| Comments show duplicates / blank dates | Historical D1 seeding had no unique constraint; `reviews_scraped.json` itself carries dupes/blank-date/anonymous rows from the source | Run `dedupe_reviews.py apply`; de-dupe `comments` table + add the unique index (§8.6) |
| Cron: `AttributeError: 'NoneType' … strip()` in recalc | `clear_link` set `download_url=null`; an accessor assumed a string | Null-coalesce the accessor (`(… or "")`); already hardened in `scrape_and_migrate` |
| Cron: `KeyError: '<id>'` at `games[seq_id]` | A `delete`d game's seq_map tombstone resolved to a now-absent `games` entry | Guard the access with `str(seq_id) in games` (§8.6); the tombstone is intentional |
| Cron run clobbers freshly-added games / version collision | Edited a stale local `games.json` and uploaded without rebasing | `download` current master → re-apply edit → `upload` (§8.5 rebase caution) |
| Deleted duplicates reappear after a scrape | seq_map tombstone was removed, freeing the df_id for re-add | Keep the tombstone entry; never strip deleted ids from `seq_to_orig_map.json` |
