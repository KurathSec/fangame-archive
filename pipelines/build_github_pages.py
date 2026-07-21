import os
import shutil
import re
import json
import subprocess

DIST_DIR = "github_pages_dist"
SRC_DIR = "."

def main():
    print("Building GitHub Pages Clean Static Distribution with 25MB Database Chunking...")
    
    # 1. Re-create output directories
    if os.path.exists(DIST_DIR):
        print(f"Cleaning existing '{DIST_DIR}' directory...")
        shutil.rmtree(DIST_DIR)
        
    os.makedirs(DIST_DIR)
    os.makedirs(os.path.join(DIST_DIR, "src"))
    os.makedirs(os.path.join(DIST_DIR, "data"))
    
    # 2. Chunk database and copy
    print("Loading games.json to chunk...")
    with open(os.path.join(SRC_DIR, "data", "games.json"), "r", encoding="utf-8") as f:
        games = json.load(f)
        
    # Calculate R2 Storage Size dynamically from download URLs of mirrored games
    total_bytes = 0
    for key in games:
        url = games[key].get("download_url", "")
        if url and ("file.fangame-archive.com/" in url or "r2.dev/" in url):
            total_bytes += games[key].get("file_size", 0)
    total_gb = total_bytes / (1024 * 1024 * 1024)
    print(f"Calculated dynamic storage size: {total_gb:.2f} GB")

    # Sort keys numerically (already sorted alphabetically because we re-indexed!)
    sorted_keys = sorted(games.keys(), key=int)
    total_games = len(sorted_keys)
    
    # Split into 3 parts
    chunk_size = (total_games + 2) // 3
    parts = [{}, {}, {}]
    for idx, key in enumerate(sorted_keys):
        part_idx = min(idx // chunk_size, 2)
        
        game_data = dict(games[key])
        
        # Update avg_rating
        avg_rating = game_data.get("avg_rating")
        if avg_rating is None:
            avg_rating = game_data.get("rating")
            
        if avg_rating is not None and avg_rating != "na":
            avg_rating = float(avg_rating)
        else:
            avg_rating = None
            
        game_data["avg_rating"] = avg_rating
        
        # Update avg_difficulty
        avg_diff = game_data.get("avg_difficulty")
        if avg_diff is None:
            avg_diff = game_data.get("difficulty")
            
        if avg_diff is not None and avg_diff != "na":
            avg_diff = float(avg_diff)
        else:
            avg_diff = None
            
        game_data["avg_difficulty"] = avg_diff

        # A game with no reviews has no rating/difficulty: force N/A (null) even if a
        # source stored a literal 0.0 (e.g. Wiki-only ingests). "0 reviews => unrated"
        # always holds, so this also backfills historical 0.0 rows in games.json.
        if not game_data.get("rating_count"):
            game_data["avg_rating"] = None
            game_data["avg_difficulty"] = None

        # Remove reviews to save space since comments are now served via D1 SQL API
        if "reviews" in game_data:
            del game_data["reviews"]
            
        parts[part_idx][key] = game_data
        
    print(f"Splitting database into 3 parts to stay well under Cloudflare Pages' 25MB limit:")
    games_sizes = []
    for i, part in enumerate(parts):
        part_path = os.path.join(DIST_DIR, "data", f"games_part_{i+1}.json")
        with open(part_path, "w", encoding="utf-8") as f_part:
            # Compact JSON (no indent): smaller JSON.parse target + IndexedDB footprint.
            # Wire transfer is already gzip/brotli-compressed by Cloudflare.
            json.dump(part, f_part, separators=(",", ":"), ensure_ascii=False)
        size_bytes = os.path.getsize(part_path)
        games_sizes.append(size_bytes)
        print(f"  Part {i+1}: {len(part)} games | {size_bytes / (1024*1024):.2f} MB")
        
    # 2.5 Generate highly optimized search_index.json for Cloudflare Functions API
    print("Generating optimized search_index.json...")
    search_index = []
    for seq_id, game in games.items():
        creator_name = game.get("creator", {}).get("name", "Unknown") if isinstance(game.get("creator"), dict) else "Unknown"
        # Enriched public fields. A game with no reviews is unrated, so rating/difficulty
        # are forced to null (mirrors the catalog invariant rating_count == 0 => null, §8.6).
        rating_count = game.get("rating_count") or 0
        rating = game.get("avg_rating")
        difficulty = game.get("avg_difficulty")
        if not rating_count:
            rating = None
            difficulty = None
        search_index.append({
            "id": int(seq_id),
            "title": game.get("title", "Untitled"),
            "creator": creator_name,
            "url": game.get("download_url", ""),
            "tags": game.get("tags", []),
            "engine": game.get("engine"),
            "release_date": game.get("release_date"),
            "rating": rating,
            "difficulty": difficulty,
            "rating_count": rating_count,
            "file_size": game.get("file_size", 0) or 0
        })
        
    index_path = os.path.join(DIST_DIR, "data", "search_index.json")
    with open(index_path, "w", encoding="utf-8") as f_idx:
        # Compact JSON: the /api/search Worker re-parses this on every edge-cache miss.
        json.dump(search_index, f_idx, separators=(",", ":"), ensure_ascii=False)
    print(f"  Search index generated: {len(search_index)} games | {os.path.getsize(index_path) / (1024*1024):.2f} MB")

    # Copy profiles.json
    shutil.copy(
        os.path.join(SRC_DIR, "data", "profiles.json"),
        os.path.join(DIST_DIR, "data", "profiles.json")
    )
    profiles_size = os.path.getsize(os.path.join(DIST_DIR, "data", "profiles.json"))
    
    # Load recent_changes.json to get the version, prune it to stay under 10MB, and save it
    recent_changes_path = os.path.join(SRC_DIR, "data", "recent_changes.json")
    if os.path.exists(recent_changes_path):
        with open(recent_changes_path, "r", encoding="utf-8") as f_rc:
            recent_changes_data = json.load(f_rc)
        version = recent_changes_data.get("version", 1)
    else:
        # Initialize if it doesn't exist
        version = 1
        recent_changes_data = {
            "version": version,
            "timeline": {}
        }
        
    # Prune timeline to stay under a safe size limit (e.g., max 10 versions and total size < 10 MB)
    if "timeline" in recent_changes_data:
        timeline_keys = sorted(recent_changes_data["timeline"].keys(), key=int)
        if len(timeline_keys) > 10:
            for k in timeline_keys[:-10]:
                recent_changes_data["timeline"].pop(k, None)
            timeline_keys = timeline_keys[-10:]
        
        while len(timeline_keys) > 0:
            json_str = json.dumps(recent_changes_data, ensure_ascii=False)
            if len(json_str.encode('utf-8')) < 10 * 1024 * 1024:
                break
            oldest_key = timeline_keys.pop(0)
            recent_changes_data["timeline"].pop(oldest_key, None)

    # Save to src directory to keep repository database small
    os.makedirs(os.path.dirname(recent_changes_path), exist_ok=True)
    with open(recent_changes_path, "w", encoding="utf-8") as f_rc:
        json.dump(recent_changes_data, f_rc, indent=2, ensure_ascii=False)
        
    # Save to dist directory for Pages distribution
    dist_rc_path = os.path.join(DIST_DIR, "data", "recent_changes.json")
    with open(dist_rc_path, "w", encoding="utf-8") as f_rc:
        json.dump(recent_changes_data, f_rc, indent=2, ensure_ascii=False)
    
    # Copy changelog.json to dist
    changelog_path = os.path.join(SRC_DIR, "data", "changelog.json")
    if os.path.exists(changelog_path):
        shutil.copy(
            changelog_path,
            os.path.join(DIST_DIR, "data", "changelog.json")
		)
        
    # Load app version
    app_ver_path = os.path.join(SRC_DIR, "data", "app_version.json")
    if os.path.exists(app_ver_path):
        with open(app_ver_path, "r", encoding="utf-8") as f_app:
            app_ver_data = json.load(f_app)
        app_version = app_ver_data.get("version", "2026.004")
    else:
        app_version = "2026.004"

    db_version_hash = str(version)
    print(f"Loaded database version count: {db_version_hash}")
    
    # 3. Copy files that don't need changes
    print("Copying static styling and tweaks...")
    shutil.copy(
        os.path.join(SRC_DIR, "src", "styles.css"),
        os.path.join(DIST_DIR, "src", "styles.css")
    )
    shutil.copy(
        os.path.join(SRC_DIR, "src", "tweaks-panel.jsx"),
        os.path.join(DIST_DIR, "src", "tweaks-panel.jsx")
    )
    shutil.copy(
        os.path.join(SRC_DIR, "src", "data.jsx"),
        os.path.join(DIST_DIR, "src", "data.jsx")
    )
    shutil.copy(
        os.path.join(SRC_DIR, "src", "i18n.jsx"),
        os.path.join(DIST_DIR, "src", "i18n.jsx")
    )
    shutil.copy(
        os.path.join(SRC_DIR, "src", "explorer.jsx"),
        os.path.join(DIST_DIR, "src", "explorer.jsx")
    )
    shutil.copy(
        os.path.join(SRC_DIR, "src", "auth.jsx"),
        os.path.join(DIST_DIR, "src", "auth.jsx")
    )
    shutil.copy(
        os.path.join(SRC_DIR, "src", "account.jsx"),
        os.path.join(DIST_DIR, "src", "account.jsx")
    )
    shutil.copy(
        os.path.join(SRC_DIR, "src", "account.css"),
        os.path.join(DIST_DIR, "src", "account.css")
    )
    shutil.copy(
        os.path.join(SRC_DIR, "src", "collections.jsx"),
        os.path.join(DIST_DIR, "src", "collections.jsx")
    )
    if os.path.exists(os.path.join(SRC_DIR, "public", "favicon.ico")):
        shutil.copy(
            os.path.join(SRC_DIR, "public", "favicon.ico"),
            os.path.join(DIST_DIR, "favicon.ico")
        )

    # 4. Modify components.jsx (remove tabs, add CDN helper)
    print("Modifying components.jsx...")
    with open(os.path.join(SRC_DIR, "src", "components.jsx"), "r", encoding="utf-8") as f:
        comp_content = f.read()

    # Prepend getShotUrl if not already present
    if "function getShotUrl" not in comp_content:
        cdn_helper = """
// Prepend remote base URL for screenshots if hosted on Cloudflare R2 / S3
function getShotUrl(path) {
  if (!path) return "";
  const base = window.SCREENSHOT_BASE_URL || "";
  if (base) {
    const cleanBase = base.endsWith("/") ? base : base + "/";
    return cleanBase + path.replace(/\\\\/g, "/");
  }
  return path;
}
"""
        comp_content = cdn_helper + comp_content

        # Replace screenshot image paths to use helper
        comp_content = comp_content.replace(
            'src={cur?.image_path}',
            'src={getShotUrl(cur?.image_path)}'
        )
        comp_content = comp_content.replace(
            'src={s.image_path}',
            'src={getShotUrl(s.image_path)}'
        )

    # Modify Sidebar navigation array (Browse Games, Donation, Links, and Contact) if not already simplified
    if "Donation & Support" not in comp_content:
        comp_content = re.sub(
            r"const\s+NAV\s*=\s*\[.*?\];",
            "const NAV = [\n    { k: 'explorer',    label: 'Browse Games',      icon: ic.archive,  count: gameCount },\n    { k: 'donation',    label: 'Donation & Support', icon: ic.heart,    count: null },\n    { k: 'links',       label: 'Community Links',   icon: ic.ext,      count: null },\n    { k: 'contact',     label: 'About & Contact',   icon: ic.mail,     count: null }\n  ];",
            comp_content,
            flags=re.DOTALL
        )

    # Modify Sidebar footer to dynamically replace storage size
    comp_content = re.sub(
        r'Storage</span><b className="mono">[\d.]+ GB</b>',
        f'Storage</span><b className="mono">{total_gb:.2f} GB</b>',
        comp_content
    )

    with open(os.path.join(DIST_DIR, "src", "components.jsx"), "w", encoding="utf-8") as f:
        f.write(comp_content)

    # 5. Modify app.jsx (simplify view route, only mount Explorer, Donation, Links, Contact, load from parts)
    print("Modifying app.jsx to stream and merge database parts...")
    with open(os.path.join(SRC_DIR, "src", "app.jsx"), "r", encoding="utf-8") as f:
        app_content = f.read()


    # Replace loadData logic in app.jsx with multi-part stream loader
    old_load_logic = r"let gamesUrl = 'data/games.json';.*?gamesDb = JSON\.parse\(new TextDecoder\(\)\.decode\(gamesBytes\)\);"
    
    new_load_logic = """let parts = ['data/games_part_1.json', 'data/games_part_2.json', 'data/games_part_3.json'];
        if (window.location.pathname.includes('/src/')) {
          parts = ['../data/games_part_1.json', '../data/games_part_2.json', '../data/games_part_3.json'];
        }
        
        gamesDb = {};
        let loadedGames = 0;
        
        const cacheBuster = window.DATABASE_VERSION ? `?v=${window.DATABASE_VERSION}` : '';
        
        for (let i = 0; i < parts.length; i++) {
          setStatusText(`Fetching games database part ${i + 1} of 3...`);
          const partRes = await fetch(parts[i] + cacheBuster);
          if (!partRes.ok) throw new Error(`HTTP ${partRes.status} fetching games database part ${i + 1}`);
          
          const reader = partRes.body.getReader();
          const chunks = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loadedGames += value.length;
            setLoadedBytes(loadedGames);
          }
          
          setStatusText(`Parsing games database part ${i + 1} of 3...`);
          let partLoaded = 0;
          for (const c of chunks) partLoaded += c.length;
          const partBytes = new Uint8Array(partLoaded);
          let pos = 0;
          for (const c of chunks) {
            partBytes.set(c, pos);
            pos += c.length;
          }
          const partDb = JSON.parse(new TextDecoder().decode(partBytes));
          Object.assign(gamesDb, partDb);
        }
        
        let profilesUrl = 'data/profiles.json';
        if (window.location.pathname.includes('/src/')) {
          profilesUrl = '../data/profiles.json';
        }
        """
        
    app_content = re.sub(old_load_logic, new_load_logic, app_content, flags=re.DOTALL)

    # Set totalBytes accurately in app.jsx
    total_db_bytes = sum(games_sizes) + profiles_size
    app_content = re.sub(
        r"const\s+\[totalBytes,\s*setTotalBytes\]\s*=\s*React\.useState\(\d+\s*\+\s*\d+\);",
        f"const [totalBytes, setTotalBytes] = React.useState({sum(games_sizes)} + {profiles_size});",
        app_content
    )

    # Fix undeclared variable pos in subsequent profiles loading
    app_content = re.sub(
        r"(const\s+profilesBytes\s*=\s*new\s+Uint8Array\(loadedProfiles\);)\s*pos\s*=\s*0;",
        r"\1\n          let pos = 0;",
        app_content
    )

    # Append cacheBuster to profiles fetch
    app_content = app_content.replace(
        "const profilesRes = await fetch(profilesUrl);",
        "const profilesRes = await fetch(profilesUrl + cacheBuster);"
    )

    with open(os.path.join(DIST_DIR, "src", "app.jsx"), "w", encoding="utf-8") as f:
        f.write(app_content)

    # 5.5 Precompile JSX -> JS with esbuild (production toolchain). Local dev
    # (dev_server.py + public/index.html) keeps in-browser Babel + dev React; only the
    # deployed dist is precompiled. Classic JSX runtime (React.createElement on the global
    # `React`), NO bundling -- the components are order-dependent global scripts that
    # cross-reference via window.*, so the index.html load order must be preserved.
    print("Precompiling JSX to JS with esbuild...")
    probe = subprocess.run("npx --no-install esbuild --version", shell=True,
                           capture_output=True, text=True)
    if probe.returncode != 0:
        raise SystemExit(
            "ERROR: esbuild not found. Run `npm install` (or `npm ci`) before building "
            "(see OPTIMIZATION_WORKFLOW.md / README)."
        )
    print(f"  esbuild {probe.stdout.strip()}")
    src_out_dir = os.path.join(DIST_DIR, "src")
    jsx_files = sorted(fn for fn in os.listdir(src_out_dir) if fn.endswith(".jsx"))
    jsx_args = " ".join('"%s"' % os.path.join(src_out_dir, fn) for fn in jsx_files)
    esbuild_cmd = (
        f'npx --no-install esbuild {jsx_args} --outdir="{src_out_dir}" '
        f'--loader:.jsx=jsx --jsx=transform '
        f'--jsx-factory=React.createElement --jsx-fragment=React.Fragment '
        f'--target=es2019 --minify-whitespace --minify-syntax --log-level=warning'
    )
    subprocess.run(esbuild_cmd, shell=True, check=True)
    for fn in jsx_files:
        os.remove(os.path.join(src_out_dir, fn))
    print(f"  Precompiled {len(jsx_files)} JSX files to .js")

    # 6. Modify index.html (remove unneeded scripts, add window config)
    print("Modifying index.html...")
    with open(os.path.join(SRC_DIR, "public", "index.html"), "r", encoding="utf-8") as f:
        html_content = f.read()

    # --- Production toolchain swap (dist only; public/index.html stays dev-friendly) ---
    # React development -> production builds (smaller + faster; behaviour identical).
    html_content = re.sub(
        r'<script src="https://unpkg\.com/react@18\.3\.1/umd/react\.development\.js"[^>]*></script>',
        '<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js" '
        'integrity="sha384-DGyLxAyjq0f9SPpVevD6IgztCFlnMF6oW/XQGmfe+IsZ8TqEiDrcHkMLKI6fiB/Z" '
        'crossorigin="anonymous"></script>',
        html_content)
    html_content = re.sub(
        r'<script src="https://unpkg\.com/react-dom@18\.3\.1/umd/react-dom\.development\.js"[^>]*></script>',
        '<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js" '
        'integrity="sha384-gTGxhz21lVGYNMcdJOyq01Edg0jhn/c22nsx0kyqP0TxaV5WVdsSH1fSDUf5YJj1" '
        'crossorigin="anonymous"></script>',
        html_content)
    # Drop in-browser Babel: JSX is precompiled to .js at build time (step 5.5 above).
    html_content = re.sub(
        r'[ \t]*<script src="https://unpkg\.com/@babel/standalone[^"]*"[^>]*></script>\n',
        '', html_content)
    # Rewrite the precompiled module scripts: text/babel .jsx -> deferred .js
    # (load order preserved; the ?v= cache-buster below is re-applied to the .js refs).
    html_content = re.sub(
        r'<script type="text/babel" src="src/([^"?]+)\.jsx(\?v=[^"]*)?"></script>',
        r'<script defer src="src/\1.js\2"></script>',
        html_content)
    # Preload the catalog chunks so the largest downloads start in parallel with JS parse.
    preload_links = "".join(
        f'  <link rel="preload" as="fetch" crossorigin '
        f'href="data/games_part_{i}.json?v={db_version_hash}">\n'
        for i in (1, 2, 3))
    html_content = html_content.replace("</head>", preload_links + "</head>", 1)

    # Add or update SCREENSHOT_BASE_URL config in <head>
    if "window.DATABASE_VERSION" in html_content:
        html_content = re.sub(
            r'window\.DATABASE_VERSION\s*=\s*"[^"]*";',
            f'window.DATABASE_VERSION = "{db_version_hash}";',
            html_content
        )
    if "window.APP_VERSION" in html_content:
        html_content = re.sub(
            r'window\.APP_VERSION\s*=\s*"[^"]*";',
            f'window.APP_VERSION = "{app_version}";',
            html_content
        )
    else:
        html_content = re.sub(
            r'(window\.DATABASE_VERSION\s*=\s*"[^"]*";)',
            f'\\1\n    window.APP_VERSION = "{app_version}";',
            html_content
        )
    if "window.DATABASE_VERSION" not in html_content:
        head_config = f"""  <link rel="stylesheet" href="src/styles.css" />
  <script>
    // GitHub Pages / Static hosting configuration
    window.SCREENSHOT_BASE_URL = "https://screenshots.fangame-archive.com/";
    window.DATABASE_VERSION = "{db_version_hash}";
    window.APP_VERSION = "{app_version}";
  </script>
</head>"""
        html_content = re.sub(r'  <link rel="stylesheet" href="src/styles.css" />\s*</head>', head_config, html_content)

    # Update or append cache-buster to all local JSX scripts in index.html to force immediate browser cache refresh
    if "?v=" in html_content:
        html_content = re.sub(
            r'src="src/([^"]+?\.js)\?v=[^"]*"',
            f'src="src/\\1?v={db_version_hash}"',
            html_content
        )
    else:
        html_content = re.sub(
            r'src="src/([^"]+?\.js)"',
            f'src="src/\\1?v={db_version_hash}"',
            html_content
        )

    with open(os.path.join(DIST_DIR, "index.html"), "w", encoding="utf-8") as f:
        f.write(html_content)

    print("\nSUCCESS!")
    print(f"Pristine GitHub Pages static build compiled inside: './{DIST_DIR}'")

if __name__ == "__main__":
    main()
