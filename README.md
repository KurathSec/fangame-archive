# Fangame Archive Explorer

This repository contains the front-end code, serverless API endpoints, and data processing scripts for the Fangame Archive Explorer—a client-side catalog and search engine for platformer games.

> [!IMPORTANT]
> **No Database or Game Files Included**
> This repository only includes the website code, data compilation pipelines, and Cloudflare Pages configuration. It **does not** contain the actual `games.json` database (~32MB) or the 618GB of game archives and screenshot assets. You will need to set up local database files from samples to run or test the project locally.

---

## Key Features

* **High-Density Catalog**: A compact, responsive grid view displaying game IDs, titles, authors, difficulty/rating averages, and tags.
* **Three-State Tag Filter**:
  * *Grey (Unchecked)*: Ignore tag.
  * *Blue (Include)*: Show only games containing all checked tags.
  * *Red (Exclude)*: Hide any game containing these tags.
* **Filtered Randomizer**: The "Roll Random" button pulls a random game exclusively from your currently filtered list.
* **Details Drawer**: Pop-up panel for game metadata, player reviews, and screenshot previews.
* **Serverless APIs**: Cloudflare Pages Functions linking to a Cloudflare D1 SQL database for comments and bot search queries.

---

## Directory Structure

```text
fangame-archive/
├── database/                 # D1 SQL schemas and ID mappings
│   ├── schema.sql            # Comments table structure for D1
│   └── seq_to_orig_map.json  # Internal sequential ID mapping database
├── data/                     # JSON database directory (Ignored by Git)
│   ├── games.sample.json     # Sample database structure
│   ├── profiles.sample.json  # Sample profiles structure
│   └── recent_changes.sample.json # Sample changelog structure
├── functions/                # Cloudflare Pages Functions
│   └── api/
│       ├── comments.js       # Comment retrieval and submission
│       └── search.js         # API endpoint for bot queries
├── public/                   # Static assets served at the root
│   ├── favicon.ico
│   ├── index.html            # Main entrypoint HTML
│   └── js/                   # Legacy libraries
├── src/                      # Frontend SPA source code (React & CSS)
│   ├── app.jsx               # App loading and streaming logic
│   ├── components.jsx        # Sidebar, listings, detail drawer, and lightbox
│   ├── explorer.jsx          # Tag matrix filter matching
│   └── styles.css            # Responsive layout and design tokens
├── pipelines/                # Data pipelines and build scripts
│   ├── build_github_pages.py        # Compiles React files and chunks databases
│   ├── ingest_local_folder_games.py # Uploads local game zips to R2 and updates metadata
│   ├── scrape_and_migrate_new_games.py # Scrapes external database updates
│   ├── sync_screenshots_to_r2.py    # Incrementally checks and uploads screenshots to R2
│   └── update_storage_stats.py      # Recalculates total bucket size
├── .gitignore                # Git ignore configuration
├── wrangler.toml             # Cloudflare Pages & D1 database bindings
├── deploy.bat                # Build and deploy script
└── sync_and_deploy.bat       # Full scraper, sync, build, and deploy script
```

---

## Local Development Setup

To run the dev server locally:

1. **Create local mock databases**:
   Go to the `data/` folder, duplicate the sample files, and remove the `.sample` extension:
   ```bash
   cp data/games.sample.json data/games.json
   cp data/recent_changes.sample.json data/recent_changes.json
   cp data/profiles.sample.json data/profiles.json
   ```

2. **Configure Cloudflare Credentials**:
   Copy `.env.example` in the root directory to `.env` and fill in your Cloudflare account and R2 keys. This file is git-ignored.
   ```bash
   cp .env.example .env
   ```

3. **Start the server**:
   Run the development script:
   ```bash
   py dev_server.py
   ```
   Open `http://localhost:8000` in your browser. The server maps requests to `/src/`, `/data/`, and `/ratings/` directories dynamically.

---

## Build and Deployment

* **Full Sync**: Run `sync_and_deploy.bat` to scrape the latest game catalogs, sync screenshots to R2, split the main database into chunked JSON files, and deploy to Cloudflare Pages.
* **Code Build Only**: Run `deploy.bat` to compile JSX components and styles into `github_pages_dist/` and push it to Cloudflare Pages.
