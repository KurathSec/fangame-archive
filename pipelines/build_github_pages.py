import os
import shutil
import re
import json

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
        
    # Sort keys numerically (already sorted alphabetically because we re-indexed!)
    sorted_keys = sorted(games.keys(), key=int)
    total_games = len(sorted_keys)
    
    # Split into 3 parts
    chunk_size = (total_games + 2) // 3
    parts = [{}, {}, {}]
    for idx, key in enumerate(sorted_keys):
        part_idx = min(idx // chunk_size, 2)
        
        game_data = dict(games[key])
        
        # Check if there are any reviews with actual rating/difficulty values
        has_real_rating = False
        has_real_difficulty = False
        reviews = game_data.get("reviews", [])
        if reviews:
            for r in reviews:
                r_rating = r.get("rating")
                if r_rating is not None and r_rating != "na":
                    has_real_rating = True
                r_diff = r.get("difficulty")
                if r_diff is not None and r_diff != "na":
                    has_real_difficulty = True
                    
        # Update avg_rating
        avg_rating = game_data.get("avg_rating")
        if avg_rating is None:
            avg_rating = game_data.get("rating")
            
        if avg_rating is not None:
            avg_rating = float(avg_rating)
            
        if not has_real_rating:
            avg_rating = None
            
        game_data["avg_rating"] = avg_rating
        
        # Update avg_difficulty
        avg_diff = game_data.get("avg_difficulty")
        if avg_diff is None:
            avg_diff = game_data.get("difficulty")
            
        if avg_diff is not None:
            avg_diff = float(avg_diff)
            
        if not has_real_difficulty:
            avg_diff = None
            
        game_data["avg_difficulty"] = avg_diff

        # Remove reviews to save space since comments are now served via D1 SQL API
        if "reviews" in game_data:
            del game_data["reviews"]
            
        parts[part_idx][key] = game_data
        
    print(f"Splitting database into 3 parts to stay well under Cloudflare Pages' 25MB limit:")
    games_sizes = []
    for i, part in enumerate(parts):
        part_path = os.path.join(DIST_DIR, "data", f"games_part_{i+1}.json")
        with open(part_path, "w", encoding="utf-8") as f_part:
            json.dump(part, f_part, indent=2, ensure_ascii=False)
        size_bytes = os.path.getsize(part_path)
        games_sizes.append(size_bytes)
        print(f"  Part {i+1}: {len(part)} games | {size_bytes / (1024*1024):.2f} MB")
        
    # 2.5 Generate highly optimized search_index.json for Cloudflare Functions API
    print("Generating optimized search_index.json...")
    search_index = []
    for seq_id, game in games.items():
        creator_name = game.get("creator", {}).get("name", "Unknown") if isinstance(game.get("creator"), dict) else "Unknown"
        search_index.append({
            "id": int(seq_id),
            "title": game.get("title", "Untitled"),
            "creator": creator_name,
            "url": game.get("download_url", ""),
            "tags": game.get("tags", [])
        })
        
    index_path = os.path.join(DIST_DIR, "data", "search_index.json")
    with open(index_path, "w", encoding="utf-8") as f_idx:
        json.dump(search_index, f_idx, indent=2, ensure_ascii=False)
    print(f"  Search index generated: {len(search_index)} games | {os.path.getsize(index_path) / (1024*1024):.2f} MB")

    # Copy profiles.json
    shutil.copy(
        os.path.join(SRC_DIR, "data", "profiles.json"),
        os.path.join(DIST_DIR, "data", "profiles.json")
    )
    profiles_size = os.path.getsize(os.path.join(DIST_DIR, "data", "profiles.json"))
    
    # Load recent_changes.json to get the version, and copy it to dist
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
        os.makedirs(os.path.dirname(recent_changes_path), exist_ok=True)
        with open(recent_changes_path, "w", encoding="utf-8") as f_rc:
            json.dump(recent_changes_data, f_rc, indent=2, ensure_ascii=False)
            
    shutil.copy(
        recent_changes_path,
        os.path.join(DIST_DIR, "data", "recent_changes.json")
    )
    
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
        app_version = app_ver_data.get("version", "2026.002")
    else:
        app_version = "2026.002"

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
        os.path.join(SRC_DIR, "src", "explorer.jsx"),
        os.path.join(DIST_DIR, "src", "explorer.jsx")
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

    # Modify Sidebar footer if not already simplified
    if "Fangame Archive" not in comp_content:
        sb_foot_pattern = r'<div className="sb-foot">.*?</div>\s*</div>'
        new_sb_foot = """<div className="sb-foot">
        <div className="sb-stat"><span><span className="sb-pulse" />Storage</span><b className="mono">618.67 GB</b></div>
        <div className="sb-stat"><span>Archived</span><b className="mono">{gameCount.toLocaleString()}</b></div>
        <div className="sb-stat"><span>Sync Status</span><b className="mono" style={{ color: 'oklch(0.72 0.15 152)' }}>Online</b></div>
        <div style={{ padding: '10px 0 0 0', borderTop: '1px solid var(--border)', marginTop: '10px', fontSize: '9.5px', color: 'var(--muted)', letterSpacing: '0.01em', lineHeight: '1.45' }}>
          Fangame Archive © Kureist 2026<br/>
          Developer & Designer
        </div>
      </div>"""
        comp_content = re.sub(sb_foot_pattern, new_sb_foot, comp_content, flags=re.DOTALL)

    with open(os.path.join(DIST_DIR, "src", "components.jsx"), "w", encoding="utf-8") as f:
        f.write(comp_content)

    # 5. Modify app.jsx (simplify view route, only mount Explorer, Donation, Links, Contact, load from parts)
    print("Modifying app.jsx to stream and merge database parts...")
    with open(os.path.join(SRC_DIR, "src", "app.jsx"), "r", encoding="utf-8") as f:
        app_content = f.read()

    # Simplify View Router
    simplified_router = """      <main className="main">
        {view === 'explorer'    && <window.Explorer    tweaks={tweaks} setTweak={setTweak} onOpenGame={openGame} activeId={activeGame?.id} />}
        {view === 'donation'    && <window.DonationView />}
        {view === 'links'       && <window.LinksView />}
        {view === 'updates'     && <window.UpdateLogView />}
        {view === 'contact'     && <window.ContactView />}
        {activeGame && view === 'explorer' && <window.Drawer game={activeGame} isRoll={isRoll} onClose={closeDrawer} />}
      </main>"""
    app_content = re.sub(
      r"<main className=\"main\">.*?</main>",
      simplified_router,
      app_content,
      flags=re.DOTALL
    )

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

    # 6. Modify index.html (remove unneeded scripts, add window config)
    print("Modifying index.html...")
    with open(os.path.join(SRC_DIR, "public", "index.html"), "r", encoding="utf-8") as f:
        html_content = f.read()

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
            r'src="src/([^"]+?\.jsx)\?v=[^"]*"',
            f'src="src/\\1?v={db_version_hash}"',
            html_content
        )
    else:
        html_content = re.sub(
            r'src="src/([^"]+?\.jsx)"',
            f'src="src/\\1?v={db_version_hash}"',
            html_content
        )

    with open(os.path.join(DIST_DIR, "index.html"), "w", encoding="utf-8") as f:
        f.write(html_content)

    print("\nSUCCESS!")
    print(f"Pristine GitHub Pages static build compiled inside: './{DIST_DIR}'")

if __name__ == "__main__":
    main()
