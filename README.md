# Fangame Archive Explorer

A serverless, client-rendered catalog and review platform for *I Wanna Be The Guy* fangames — **20,000+ games** and **150,000+ user reviews**, hosted entirely on the Cloudflare developer platform.

**Stack:** React 18 (dev: in-browser Babel · prod: esbuild-precompiled) · Cloudflare Pages + Pages Functions · R2 · D1 · KV · Clerk auth · Turnstile · Python ingestion pipelines.

> [!IMPORTANT]
> **No database or game files are included.**
> This repository contains only the website code, serverless API endpoints, data-processing pipelines, and Cloudflare configuration. It does **not** include the `games.json` catalog (~32 MB), the ~600 GB of game archives, or the screenshot assets. To run locally, seed the `data/` folder from the provided `*.sample.json` files.

---

## Architecture at a Glance

| Layer | Technology | Role |
|---|---|---|
| **Frontend** | React 18 — dev: in-browser Babel · prod: esbuild-precompiled | Catalog UI, search/filter, detail drawer, collections |
| **Hosting / API** | Cloudflare Pages + Pages Functions | Static assets and serverless `/api/*` endpoints |
| **Object storage** | Cloudflare R2 (`fangame-files`, `fangame-screenshots`) | Game archives, screenshots, master JSON |
| **Database** | Cloudflare D1 (`fangame-comments`) | Reviews, users, submissions, favorites, audit log |
| **Cache** | Cloudflare KV | Clerk profile cache + per-user daily quotas |
| **Identity** | Clerk (production instance) | Login, sessions, OAuth (Google/Discord/Microsoft), email code |
| **Bot defense** | Cloudflare Turnstile | CAPTCHA on all write endpoints |
| **Pipelines** | Python + GitHub Actions (cron / push) | Scrape, recompute metrics, chunk, sync to R2, deploy |

The catalog is split into **minified** chunks under Cloudflare Pages' 25 MB per-file limit and streamed into an IndexedDB client cache with incremental, version-based updates. Full detail lives in **[`project_architecture.md`](project_architecture.md)**.

---

## Key Features

* **High-density catalog** — responsive grid/list of game IDs, titles, authors, rating/difficulty averages, and tags, with client-side pagination.
* **Three-state tag filter** — *grey* (ignore), *blue* (include — must match all), *red* (exclude — hide any match).
* **Precise range filters** — rating/difficulty sliders paired with numeric inputs for exact (decimal) bounds.
* **Filtered randomizer** — "Roll Random" draws only from the current filtered set.
* **Detail drawer** — metadata, screenshots, and live reviews fetched on demand, with Markdown + click-to-reveal spoilers.
* **Accounts & reviews** — Clerk-backed login; submit reviews (optional rating/difficulty, custom tags) and suggest new games, all gated by Turnstile and daily quotas, then moderated.
* **Collections** — per-user favorites synced to D1.
* **Internationalization** — 8 languages (`en`, `zh-CN`, `zh-TW`, `ja`, `ko`, `ru`, `fr`, `de`) with live switching.
* **Public search API** — `/api/search?q=` / `?id=` for bots and integrations, edge-cached.

---

## Directory Structure

```text
fangame-archive/
├── public/                       # Static assets served at the root
│   ├── index.html                # Entry point: config globals + Babel script mounts
│   ├── favicon.ico
│   ├── img/                      # Static images
│   └── js/                       # Vendored libraries
├── src/                          # Frontend SPA (React via in-browser Babel)
│   ├── app.jsx                   # RootApp: cache hydration, DB streaming, Clerk init, router
│   ├── auth.jsx                  # Clerk loading, account block, avatars, Turnstile wrapper
│   ├── account.jsx               # Review editor, submission form, "my content"
│   ├── components.jsx            # Sidebar, cards/rows, detail drawer, lightbox
│   ├── explorer.jsx              # Search + tri-state tag filter + pagination
│   ├── collections.jsx           # Favorites grid + FavoritesAPI client
│   ├── i18n.jsx                  # Dictionaries, window.t(), language selector
│   ├── data.jsx                  # In-memory data shaping (window.DATA)
│   ├── tweaks-panel.jsx          # Theme/density/layout tweaks
│   └── styles.css / account.css  # Design tokens and layout
├── functions/                    # Cloudflare Pages Functions (Workers runtime)
│   ├── _middleware.js            # CORS + Clerk JWT verification + JIT user provisioning
│   └── api/
│       ├── _lib/                 # auth (JWKS verify), http helpers, validators (Turnstile)
│       ├── me/                   # /api/me, /api/me/comments, /api/me/submissions
│       ├── comments.js           # GET approved+own / POST review (Turnstile + quota)
│       ├── submissions.js        # POST game submission
│       ├── favorites.js          # GET/POST favorites  (+ favorites/[id].js DELETE)
│       ├── search.js             # Public keyword/ID search (edge-cached)
│       └── clerk-js.js           # Legacy first-party clerk-js proxy (fallback)
├── pipelines/                    # Python ingestion, cleanup, and build scripts
│   ├── scrape_and_migrate_new_games.py  # Master sync: scrape, recompute, reconcile
│   ├── build_github_pages.py            # Chunk+minify DB, esbuild-precompile JSX, compile dist
│   ├── merge_approved_submissions.py    # Merge approved user submissions into catalog/R2
│   ├── ingest_local_folder_games.py     # Bulk-ingest local game zips to R2
│   ├── sync_db_r2.py                    # download | upload master JSON ↔ R2
│   ├── sync_screenshots_to_r2.py        # Upload missing screenshots to R2
│   ├── update_storage_stats.py          # Recompute total storage figure
│   ├── dedupe_reviews.py                # De-duplicate temp/reviews_scraped.json
│   ├── sync_reviews_to_d1.py            # Bridge scraped reviews → D1 comments (drawer text)
│   ├── apply_duplicate_resolution.py    # Apply keep/delete/clear_link resolution to catalog + R2
│   └── config.py                        # R2 / Cloudflare credentials (git-ignored)
├── .github/workflows/
│   ├── deploy.yml                # CI: sync + scrape + build + deploy (push / 6 h cron)
│   └── backfill_reviews.yml      # Manual one-shot: load the full review corpus into D1
├── database/
│   ├── schema.sql                # D1 schema (comments, users, submissions, favorites, audit)
│   └── seq_to_orig_map.json      # Sequential ID ↔ origin ID mapping
├── data/                         # Catalog JSON (git-ignored; seed from *.sample.json)
├── wrangler.toml                 # Pages project, D1 + KV bindings
├── package.json                  # Pinned build/deploy tooling (esbuild, wrangler)
├── requirements.txt              # Python pipeline dependencies
├── dev_server.py                 # Local dev server (in-browser Babel; no build needed)
├── deploy.bat / sync_and_deploy.bat   # Build/deploy workflows
├── OPTIMIZATION_WORKFLOW.md       # Behavior-preserving perf/architecture workflow
└── project_architecture.md       # Full system architecture & developer reference
```

---

## Local Development

1. **Seed mock databases** — copy the samples in `data/`, dropping the `.sample`:
   ```bash
   cp data/games.sample.json data/games.json
   cp data/recent_changes.sample.json data/recent_changes.json
   cp data/profiles.sample.json data/profiles.json
   ```
2. **Configure credentials** — copy `.env.example` → `.env` and fill in Cloudflare account + R2 keys (git-ignored). Pipeline scripts also read `pipelines/config.py`.
3. **Run the dev server**:
   ```bash
   py dev_server.py
   ```
   Open `http://localhost:8000`. The server maps `/src/`, `/data/`, and `/ratings/` dynamically.

> Auth and write APIs depend on Clerk + D1 + Turnstile and only function against the deployed Cloudflare environment; local dev primarily exercises the read-only catalog UI.

---

## Build & Deployment

> **Local prerequisite:** run `npm install` once — the build precompiles the JSX with **esbuild** and deploys with **wrangler** (both pinned in `package.json`). Local UI iteration via `dev_server.py` needs no build (it uses in-browser Babel).

| Command | Action |
|---|---|
| `deploy.bat` | Download DBs from R2 → compile static `github_pages_dist/` → `wrangler pages deploy` |
| `sync_and_deploy.bat` | Full pipeline: download → scrape/recompute → ingest → sync screenshots → upload → deploy |
| `.github/workflows/deploy.yml` | CI: runs on push to `main` (matching paths) or every 6 h |
| `.github/workflows/backfill_reviews.yml` | Manual one-shot (`workflow_dispatch`): loads the full scraped-review corpus into D1 |

> **Reviews are dual-stored.** `temp/reviews_scraped.json` feeds the rating **averages** in `games.json`; the detail drawer renders review **text from D1**. The regular deploy syncs only each run's *new* reviews into D1 — the **backfill workflow** is what loads the historical corpus (e.g. to seed an empty D1). See [§8.7](project_architecture.md#87-reviews-dual-store-model--d1-sync-sync_reviews_to_d1py).

Apply D1 schema changes explicitly (not part of deploy):
```bash
npx wrangler d1 execute fangame-comments --remote --file database/schema.sql
```

> **Operational notes:** environment-variable changes in Cloudflare Pages apply only to *new* deployments (always redeploy after editing keys), and pipeline edits to `games.json` must be rebased on the current R2 master before upload. See the [Operational Runbook](project_architecture.md#10-operational-runbook-common-failure-modes).

---

## Documentation

* **[`project_architecture.md`](project_architecture.md)** — comprehensive reference: data schemas, the Clerk auth/identity flow, every API endpoint, the frontend component model, caching strategy, the ingestion/de-duplication pipelines, data-integrity invariants, and an operational runbook.
