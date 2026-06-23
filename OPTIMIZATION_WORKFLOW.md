# Performance & Architecture Optimization Workflow

> **Goal:** Apply a set of **strictly behavior-preserving** performance/architecture
> optimizations to the Fangame Archive site. The rendered UI, every interaction, all
> API behavior, the auth flow, the version-counter/caching model, and the data-integrity
> invariants must remain **identical**. This is an optimization-only change set.
>
> **Audience:** an automation agent (or developer) executing the changes end-to-end.
>
> **Hard stop:** Do **all** edits in the working tree and **DO NOT `git commit` or
> `git push`**. The final phase only updates docs and prints a diff summary for review.

---

## Core design principle (read first)

The site has two delivery paths, and they must stay decoupled:

| Path | Entry | Transpile | React | Used for |
|---|---|---|---|---|
| **Dev** | `dev_server.py` serves `public/index.html` + `src/*.jsx` raw | in-browser **Babel Standalone** | `react.development.js` | local iteration |
| **Prod** | `pipelines/build_github_pages.py` → `github_pages_dist/` → `wrangler pages deploy` | **build-time esbuild** (new) | `react.production.min.js` (new) | the deployed site |

**Rule:** Optimizations that swap the toolchain (esbuild precompile, prod React, JSON
minify, preload hints) are applied **only inside `build_github_pages.py` / the dist
output**, leaving `public/index.html` and the dev path untouched. The **only** changes
made to `src/*` are dead-code removals that are provably no-ops in both paths.

`build_github_pages.py` is the single build entrypoint, invoked by:
- `deploy.bat` (direct),
- `pipelines/scrape_and_migrate_new_games.py` (`subprocess` near line 1647) → which is what
  CI (`.github/workflows/deploy.yml`) and `sync_and_deploy.bat` run.

So any new build-time dependency (esbuild) must be available in **all three** contexts.

---

## Behavior-preserving guardrails — DO NOT touch

- Clerk SDK loading/init (`src/app.jsx`, `src/auth.jsx`) — incl. v5 pin, `CLERK_JS_URL`,
  the memoized `__clerkLoadPromise`.
- Any `functions/**` API handler logic or response shape.
- The two version counters (`DATABASE_VERSION` / `APP_VERSION`) and the `?v=` cache-buster
  mechanism (arch §7.1/§7.2).
- The IndexedDB three-tier hydration + incremental `recent_changes.json` delta replay
  (arch §5.2) — the raw `gamesDb` map MUST still be cached for delta application.
- Data-integrity invariants (arch §8.6): `rating_count==0 ⇒ null`, seq_map tombstones,
  `clear_link ⇒ download_url=null`.
- `window.DATA` public shape consumed by views: keep `GAMES`, `TAGS`, `SCREENSHOTS`,
  `STORAGE_SIZE` exactly as-is.

---

## Phase 0 — Baseline & safety net

0.1 (Recommended) Create a working branch but **do not commit**:
```bash
git switch -c perf/build-optimizations
```

0.2 Record a behavioral baseline of the **current** site to compare against later:
- Build once: `python pipelines/build_github_pages.py`, then note the byte sizes of
  `github_pages_dist/data/games_part_*.json`, `search_index.json`, and the script tags in
  `github_pages_dist/index.html`.
- Serve the dist in a fresh **incognito** window (e.g.
  `python -m http.server -d github_pages_dist 8001`) and confirm the **Parity Checklist**
  (bottom of this doc) all pass. This is the reference behavior.

0.3 Confirm the dead-code claims still hold before deleting anything:
```bash
grep -rIn "DATA\.REVIEWS\|DATA\.COLLECTIONS\|DATA\.MISSING_ASSETS\|DATA\.DEAD_URLS\|DATA\.ORPHANED\|DATA\.CRAWLER_LOG" src/
grep -rIn "archive_game_" src/        # must show ONLY the read in app.jsx, no writers
```
If any of these now has a real reader/writer, **stop** and re-scope Phase 1.

---

## Phase 1 — Remove dead work from the hot reshape loop (`src/app.jsx`)

**Why safe:** these outputs have zero readers in any view (verified in 0.3); the prod
chunks contain no `reviews`; nothing ever writes `archive_game_<id>`.

**Target:** the `for (const [idStr, rawGame] of Object.entries(gamesDb))` loop and the block
right after it (≈ lines 707–920).

1.1 Drop the per-game localStorage curation read and its derived constants. Replace the
per-iteration `localStorage.getItem(\`archive_game_${id}\`)` + `curation`/`hours` logic with
the constant defaults it always produces today: `status:'unplayed'`, `personal:0`,
`notes:''`, `hours:0`, `flags.perf:false`.
> Bulletproof variant: enumerate `Object.keys(localStorage)` **once** before the loop into a
> `Set`; only `getItem` for ids present in that set. With zero such keys this is a no-op but
> stays correct even if a key ever exists.

1.2 Remove the `if (rawGame.reviews) { … }` block (review-tag aggregation + `gameReviews`
build). Prod chunks have no `reviews`, so this never runs in prod; tags come from
`rawGame.tags`. Stop populating `REVIEWS`.

1.3 Remove the unused mock datasets and their full-catalog scans: `needleGameIds` /
`avoidanceGameIds` / `adventureGameIds` / `bossGameIds`, `COLLECTIONS`, `MISSING_ASSETS`,
`DEAD_URLS`, `ORPHANED`, `CRAWLER_LOG` (each `GAMES.filter(...)` here is a wasted 20k pass).

1.4 Update the final assignment to keep the **public shape** but cheap:
```js
window.DATA = { TAGS, GAMES, SCREENSHOTS, STORAGE_SIZE: R2_STORAGE_SIZE,
                REVIEWS: {}, COLLECTIONS: [] };
```
(Keep `REVIEWS`/`COLLECTIONS` as empty stubs only if you want defensive belt-and-suspenders;
otherwise drop them — grep proved no readers.)

**Guardrail:** leave the `totalBytes` initializer in its `React.useState(<int> + <int>)`
form — `build_github_pages.py` rewrites it via a `\d+ + \d+` regex.

**Acceptance:** `python pipelines/build_github_pages.py` succeeds; serve dist incognito;
Parity Checklist passes; catalog count, tag chips/counts, and screenshots are unchanged.
(Optional: wrap the loop in `console.time('reshape')` before/after to show the reduction.)

---

## Phase 2 — Production build asset optimization (`build_github_pages.py` + dist `index.html` only)

All of Phase 2 is emitted by the build; **`public/index.html` and the dev path stay on
Babel + dev React.**

2.1 **Production React** (dist index.html). In the step-6 index.html transform, swap:
- `react.development.js` → `react.production.min.js`
- `react-dom.development.js` → `react-dom.production.min.js`
Recompute the SRI for the prod files (pinned `@18.3.1`):
```bash
curl -sL https://unpkg.com/react@18.3.1/umd/react.production.min.js     | openssl dgst -sha384 -binary | openssl base64 -A
curl -sL https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js | openssl dgst -sha384 -binary | openssl base64 -A
```
Set the new `integrity="sha384-…"`. (If SRI can't be computed in the build env, omit the
attribute rather than ship a wrong hash — files load over HTTPS from a pinned version.)

2.2 **esbuild JSX precompile** (new build step, after dist `src/*.jsx` are written in step 5,
before the index.html transform in step 6). For each `github_pages_dist/src/<name>.jsx`,
transpile to `<name>.js` and delete the `.jsx`:
```
esbuild <file>.jsx --loader=jsx --jsx=transform \
        --jsx-factory=React.createElement --jsx-fragment=React.Fragment \
        --target=es2019 --minify-whitespace --minify-syntax \
        --outfile=<file>.js
```
- `--jsx=transform` = **classic** runtime → emits `React.createElement`, matching today's
  Babel output and relying on the global `React`. Do **NOT** use `--jsx=automatic` (injects
  imports and breaks the global-script model).
- **No `--bundle`** — files are order-dependent global scripts that cross-reference via
  `window.*`; bundling would change semantics.
- Default to `--minify-whitespace --minify-syntax` (no identifier renaming → zero risk of
  breaking a cross-file global). Only enable full `--minify` after the Parity Checklist
  passes with it.
- Invoke esbuild from the pinned local install (`node_modules/.bin/esbuild`, see Phase 3);
  **fail the build loudly** if esbuild/Node is missing (never emit un-transpiled `.jsx` as
  `.js`).

2.3 **Rewrite index.html script tags** (dist only, in the step-6 transform):
- Remove the `@babel/standalone` `<script>`.
- For each module script, change
  `<script type="text/babel" src="src/<name>.jsx?v=N">` →
  `<script defer src="src/<name>.js?v=N">`, **preserving the existing load order**
  (tweaks → data → i18n → components → auth → account → explorer → collections → app).
- Keep the `?v=<DATABASE_VERSION>` cache-buster (rewrite the `.jsx`→`.js` extension *first*,
  then apply the existing cache-buster regex, or update the regex to target `.js`).

2.4 **Minify served JSON.** Change the dist `json.dump(...)` calls for
`games_part_*.json` (≈ line 89) and `search_index.json` (≈ line 109) from `indent=2` to
`separators=(",", ":")`. (Wire transfer is already brotli/gzip'd by Cloudflare; this shrinks
the `JSON.parse` target + IndexedDB footprint + the `/api/search` Worker parse.) Leave the
source `data/recent_changes.json` human-readable if preferred; only the served copies need
compacting.

2.5 **Preload the catalog chunks** (dist index.html `<head>`):
```html
<link rel="preload" as="fetch" crossorigin href="data/games_part_1.json?v=N">
<link rel="preload" as="fetch" crossorigin href="data/games_part_2.json?v=N">
<link rel="preload" as="fetch" crossorigin href="data/games_part_3.json?v=N">
```
Substitute `N = DATABASE_VERSION`. These start the largest downloads in parallel with JS
parse; they don't change what loads, only when it starts.

**Ordering guardrail:** the build's existing textual transforms (getShotUrl injection, NAV
rewrite, storage-size, `totalBytes`, cache-buster) must run **before** esbuild consumes the
files. Keep step 5 (write transformed `src/*.jsx`) → **new** esbuild step → step 6
(index.html) order.

**Acceptance:** build succeeds; `github_pages_dist/src/` contains `.js` (no `.jsx`); dist
`index.html` has prod React, no Babel, `defer` `.js` tags in original order, and 3 preload
links; chunks/search_index are single-line. Serve dist incognito → Parity Checklist passes.

---

## Phase 3 — Pin tooling so Phase 2 is reproducible (and CI-cacheable)

3.1 Add a root `package.json` (and commit-less `npm install` to generate `package-lock.json`)
pinning the build/deploy tools as devDependencies:
- `esbuild` (used by `build_github_pages.py`)
- `wrangler` (replaces cold `npx -y wrangler` downloads; align with the admin repo's `^4`)
Add convenience scripts, e.g. `"build": "python pipelines/build_github_pages.py"`,
`"deploy": "wrangler pages deploy github_pages_dist --project-name fangame-archive"`.

3.2 Add `requirements.txt` pinning the pipeline's pip deps (currently inline in CI):
`requests`, `beautifulsoup4`, `boto3`, `mega.py` (pin versions). Enables pip caching +
reproducibility.

3.3 Local note (for README): run `npm install` once before `deploy.bat` / `sync_and_deploy.bat`
so esbuild + wrangler resolve locally.

**Acceptance:** fresh `npm install` produces `node_modules/.bin/esbuild`;
`python pipelines/build_github_pages.py` finds and runs it.

---

## Phase 4 — GitHub Actions: adapt + optimize (`.github/workflows/deploy.yml`)

### 4A — Required adaptation (so the optimized build runs in CI)
The scrape step calls `build_github_pages.py`, which now needs esbuild. Make Node deps
available **before** the scrape step:
- After "Set up Node.js", add an **Install Node deps** step: `npm ci`.
- Change pip install to `pip install -r requirements.txt`.
- (Optional) deploy via the pinned wrangler instead of `npx -y wrangler`.
- **Keep all existing env wiring unchanged** — esp. `CLOUDFLARE_API_TOKEN` on the scraper,
  `apply_game_ops`, `merge_approved_submissions`, and deploy steps (arch §9.2 requires it for
  the in-pipeline D1 review sync).

### 4B — Optimizations (safe, recommended)
- **Concurrency guard (highest value — prevents a documented failure mode).** The 6-hourly
  cron and a `push` can currently overlap and clobber the R2 master / collide the version
  counter (arch §8.5 rebase caution, §10 "Cron run clobbers freshly-added games"). Add at
  workflow top level:
  ```yaml
  concurrency:
    group: fangame-archive-deploy
    cancel-in-progress: false   # let the in-flight sync finish; queue the next
  ```
- **Dependency caching:** `actions/setup-python@v5` with `cache: pip` (needs
  `requirements.txt`) and `actions/setup-node@v4` with `cache: npm` (needs
  `package-lock.json`). Cuts install time every run.
- **Least privilege:** add `permissions: { contents: read }` at workflow level (the job
  deploys via API token; it doesn't push to the repo).
- **Timeout:** add `timeout-minutes: 45` to the job so a hung scrape can't burn the slot.
- Leave the `schedule` + `workflow_dispatch` + `paths` triggers as-is — the new/edited files
  (`src/**`, `pipelines/**`, `public/**`, `.github/workflows/**`) are already covered.

**Acceptance:** `deploy.yml` parses (e.g. `actionlint` or a `workflow_dispatch` dry idea);
step order is `checkout → setup-python(+cache) → setup-node(+cache) → npm ci → pip install -r
→ … → scrape (builds, now finds esbuild) → … → deploy`.

---

## Phase 5 — Update documentation (do this, still no commit)

5.1 `project_architecture.md`:
- §1.1 / §5: change "React via in-browser Babel (no build step)" to reflect the **split** —
  dev uses in-browser Babel + dev React; **prod ships esbuild-precompiled JS + production
  React**.
- §5.2: note the reshape loop no longer builds unused `REVIEWS`/mock collections and no
  longer does per-game `localStorage` reads.
- §7: note served chunks + `search_index.json` are minified and `<link rel=preload>` hints
  were added; the `?v=` / version-counter model is unchanged.
- §8.2: document the new build steps — esbuild precompile, React dev→prod swap, JSON minify,
  preload injection — in order.
- §9 / §1.2: document the new CI steps (`npm ci`, pip/npm caching, **concurrency guard**,
  `requirements.txt`, `package.json`) and add those files to the directory structure.

5.2 `README.md`:
- "Key Features" / stack line: clarify prod is precompiled (dev keeps the no-build Babel
  path).
- Directory Structure: add `package.json`, `requirements.txt`, `OPTIMIZATION_WORKFLOW.md`.
- Local Development: add the one-time `npm install` before building; `py dev_server.py` is
  unchanged for UI iteration.
- Build & Deployment table: mention esbuild precompile + `npm ci` in the build row.

Keep doc edits factual; describe changes as "precompiled / minified / preloaded" — do **not**
invent specific millisecond numbers.

---

## Phase 6 — Final verification, then STOP (no commit)

6.1 Clean build: `python pipelines/build_github_pages.py` — must succeed and produce
`.js` (no `.jsx`) under `github_pages_dist/src/`, prod React in `index.html`, no Babel,
minified chunks, preload links.

6.2 Prod parity: serve `github_pages_dist` incognito (`python -m http.server -d
github_pages_dist 8001`) → run the full **Parity Checklist**; compare against the Phase-0
baseline. Watch the console for errors (esp. any "X is not defined" from minification — if so,
fall back to `--minify-whitespace --minify-syntax` only, per 2.2).

6.3 Dev parity: `py dev_server.py` (source path) incognito → confirm dev still works on Babel
+ dev React (the source files are untouched except the Phase-1 dead-code removal).

6.4 Record before/after: React dev→prod size, Babel removed (~3 MB), chunk/search_index sizes
(pretty→compact), and (optional) the `reshape` console.time delta.

6.5 **STOP.** Print `git status` and `git diff --stat`, summarize the changes and the
before/after numbers, and hand back for review. **Do not `git add`, `git commit`, or
`git push`.**

---

## Parity Checklist (must be identical before vs after)

- Catalog loads; game **count** in the sidebar matches baseline.
- Tag tri-state filter (grey/blue/red), and tag chip **counts**, behave identically.
- Rating/difficulty range sliders + numeric inputs (incl. unrated/null exclusion rules).
- Sort field + direction (`id/title/rating/diff/size/rev`); default id-desc.
- "Roll Random" draws from the current filtered set.
- Drawer: opens, screenshots render (R2 base URL), reviews load from `/api/comments`,
  spoilers/markdown render, pagination of reviews.
- Deep link `?game=<id>` opens the drawer; Back/Forward + copy-share-link work.
- Language switch across all 8 locales.
- Auth surfaces render (logged-out + cached-identity optimistic state); Collections/MyContent
  views mount.
- Incremental update path: load once (caches vN), bump nothing, reload → instant from cache;
  (if testable) simulate an older cached version → delta replay still works.
