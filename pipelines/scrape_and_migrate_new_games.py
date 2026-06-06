import sys
import types
import asyncio

# Monkeypatch asyncio.coroutine which was removed in Python 3.11+
if not hasattr(asyncio, "coroutine"):
    asyncio.coroutine = lambda f: f

import os
import json
import re
import urllib.request
import urllib.parse
import shutil
import time
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor

# Set UTF-8 encoding for console output on Windows
sys.stdout.reconfigure(encoding='utf-8')

# Ensure external libraries are imported
try:
    from bs4 import BeautifulSoup
except ImportError:
    print("Error: 'beautifulsoup4' library not found! Please run 'pip install beautifulsoup4' first.")
    sys.exit(1)

try:
    import requests
except ImportError:
    print("Error: 'requests' library not found! Please run 'pip install requests' first.")
    sys.exit(1)

try:
    import boto3
    from botocore.config import Config
except ImportError:
    print("Error: 'boto3' library not found! Please run 'pip install boto3' first.")
    sys.exit(1)

try:
    from mega import Mega
except ImportError:
    print("Error: 'mega.py' library not found! Please run 'pip install mega.py' first.")
    sys.exit(1)

# ── ⚙️ CONFIGURATION ────────────────────────────────────────────────────────
# Load R2 credentials dynamically from config.py
try:
    from config import CLOUDFLARE_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
except ImportError:
    sys.path.append(os.path.dirname(os.path.abspath(__file__)))
    from config import CLOUDFLARE_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY

BUCKET_NAME = "fangame-files"
PUBLIC_DOMAIN = "https://file.fangame-archive.com"

GAMES_PATH = r"data\games.json"
SEQ_MAP_PATH = r"database\seq_to_orig_map.json"
TEMP_BASE_DIR = r"temp\scraping_migration"

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}

# Thread safety locks
print_lock = threading.Lock()
db_lock = threading.Lock()

def log(msg):
    with print_lock:
        print(msg)
        sys.stdout.flush()

def heal_mojibake(text):
    if not text:
        return ""
    # If the text has high-ascii / Latin-1 characters, try to encode CP1252 / Latin-1 and decode as UTF-8
    if any(ord(c) > 127 for c in text):
        try:
            return text.encode('cp1252').decode('utf-8')
        except Exception:
            try:
                return text.encode('latin1').decode('utf-8')
            except Exception:
                pass
    return text.strip()

def normalize_str(s):
    if not s:
        return ""
    s = s.lower().strip()
    s = re.sub(r'\s+', ' ', s)
    return s

# ── 🌐 DELICIOUS FRUIT SCRAPER ────────────────────────────────────────────────
def scrape_full_list():
    log("Fetching game list from delicious-fruit.com/ratings/full.php?q=ALL...")
    url = "https://delicious-fruit.com/ratings/full.php?q=ALL"
    
    try:
        res = requests.get(url, headers=HEADERS, timeout=30)
        res.raise_for_status()
        res.encoding = 'utf-8' # Force requests to use UTF-8 decoding
    except Exception as e:
        log(f"[WARNING] Failed to download Delicious Fruit games list: {e}")
        log("Skipping Delicious Fruit scraping and sync due to network error.")
        return None

    log("Parsing Delicious Fruit game table...")
    soup = BeautifulSoup(res.text, 'html.parser')
    table = soup.find('table', class_='tablesorter')
    if not table:
        log("[WARNING] Could not find 'tablesorter' table in Delicious Fruit page.")
        return None
        
    rows = table.find('tbody').find_all('tr')
    log(f"Found {len(rows)} games in live Delicious Fruit list.")
    
    scraped_games = []
    for row in rows:
        cols = row.find_all('td')
        if len(cols) < 4:
            continue
        
        col_game = cols[0]
        col_diff = cols[1]
        col_rating = cols[2]
        col_count = cols[3]
        
        link = col_game.find('a')
        if not link:
            continue
            
        href = link.get('href', '')
        title = heal_mojibake(link.text.strip())
        
        match_id = re.search(r'id=(\d+)', href)
        if not match_id:
            continue
        df_id = match_id.group(1)
        
        # Parse difficulty
        diff_text = col_diff.text.strip()
        difficulty = 0.0 if diff_text == 'N/A' else float(diff_text)
        
        # Parse rating
        rating_text = col_rating.text.strip()
        rating = 0.0 if rating_text == 'N/A' else float(rating_text)
        
        # Parse ratings count
        count_text = col_count.text.strip()
        rating_count = 0 if count_text in ('—', 'N/A') or not count_text.isdigit() else int(count_text)
        
        scraped_games.append({
            "df_id": df_id,
            "title": title,
            "avg_difficulty": difficulty,
            "avg_rating": rating,
            "rating_count": rating_count
        })
        
    return scraped_games

def fetch_game_details(df_id):
    url = f"https://delicious-fruit.com/ratings/game_details.php?id={df_id}"
    log(f"  [Detail Scrape] Crawling game details for DF ID {df_id}...")
    
    for attempt in range(3):
        try:
            res = requests.get(url, headers=HEADERS, timeout=15)
            res.raise_for_status()
            res.encoding = 'utf-8' # Force requests to use UTF-8 decoding
            soup = BeautifulSoup(res.text, 'html.parser')
            
            # 1. Creator info
            creator_label = soup.find('h2', id='creator-label')
            creator_a = creator_label.find('a') if creator_label else None
            creator_name = heal_mojibake(creator_a.text.strip()) if creator_a else 'Unknown'
            creator_url = creator_a.get('href', '#').strip() if creator_a else '#'
            
            # Resolve relative creator URLs
            if creator_url.startswith('/'):
                creator_url = "https://delicious-fruit.com" + creator_url
            elif creator_url != '#' and not creator_url.startswith('http'):
                creator_url = "https://delicious-fruit.com/ratings/" + creator_url
                
            # 2. Tags (lowercase, strip, map correctly)
            tags = []
            for a in soup.find_all('a', class_='tag'):
                href = a.get('href', '')
                if 'tags=' in href:
                    tag_name = heal_mojibake(a.text.split('(')[0].strip().lower())
                    if tag_name and tag_name not in tags:
                        tags.append(tag_name)
            
            # 3. Screenshots
            screenshots = []
            img_ul = soup.find('ul', id='images')
            li_tags = img_ul.find_all('li') if img_ul else []
            for li in li_tags:
                a_tag = li.find('a')
                img_tag = li.find('img')
                if a_tag and img_tag:
                    href = a_tag.get('href', '')
                    src = img_tag.get('src', '').strip().lstrip('/')
                    match_s_id = re.search(r'id=(\d+)', href)
                    if match_s_id:
                        s_id = int(match_s_id.group(1))
                        # Append extension if missing
                        image_path = src
                        if not any(image_path.lower().endswith(ext) for ext in ['.png', '.jpg', '.jpeg', '.gif']):
                            image_path += ".png"
                        
                        by_text = li.find('span')
                        by = heal_mojibake(by_text.text.replace('by', '').strip()) if by_text else 'Anonymous'
                        
                        screenshots.append({
                            "id": s_id,
                            "image_path": image_path,
                            "by": by
                        })
            
            return creator_name, creator_url, tags, screenshots
        except Exception as e:
            if attempt == 2:
                log(f"  [Detail Scrape FAIL] Failed to crawl DF ID {df_id}: {e}")
                return "Unknown", "#", [], []
            time.sleep(2)

# ── 🔍 WIKI API INTEGRATION ──────────────────────────────────────────────────
def fetch_wiki_games():
    log("Loading complete I Wanna Wiki game catalog...")
    wiki_games = []
    page = 1
    
    while True:
        url = f"https://api.iwannawiki.com/api/v1/games?per_page=5000&page={page}"
        try:
            res = requests.get(url, headers=HEADERS, timeout=15)
            res.raise_for_status()
            data = res.json()
            games = data.get("games", [])
            if not games:
                break
            wiki_games.extend(games)
            log(f"  Fetched page {page} ({len(games)} games)")
            page += 1
        except Exception as e:
            log(f"  Error fetching Wiki page {page}: {e}")
            break
            
    log(f"Successfully loaded {len(wiki_games)} games from Wiki API.")
    return wiki_games

def find_wiki_game_match(wiki_games, title, creator):
    title_norm = normalize_str(title)
    creator_norm = normalize_str(creator)
    
    # Try exact match of title and creator
    for wg in wiki_games:
        w_title = normalize_str(wg.get("name", ""))
        w_creator = normalize_str(wg.get("creator", ""))
        if w_title == title_norm and w_creator == creator_norm:
            return wg
                
    # Try match by title only (fallback, if title is unique or matches)
    matches = []
    for wg in wiki_games:
        w_title = normalize_str(wg.get("name", ""))
        if w_title == title_norm:
            matches.append(wg)
                
    if len(matches) == 1:
        return matches[0]
    elif len(matches) > 1:
        return matches[0]
        
    return None

def fetch_wiki_tags(w_id):
    url = f"https://api.iwannawiki.com/api/v1/games/{w_id}"
    log(f"  [Wiki Detail Fetch] Fetching tags for Wiki ID {w_id}...")
    for attempt in range(3):
        try:
            res = requests.get(url, headers=HEADERS, timeout=10)
            res.raise_for_status()
            data = res.json()
            tags = []
            for t in data.get("tags", []):
                t_name = t.get("name", "").strip().lower()
                if t_name and t_name not in tags:
                    tags.append(t_name)
            return tags
        except Exception as e:
            if attempt == 2:
                log(f"  [Wiki Detail Fetch FAIL] Failed to fetch tags for Wiki ID {w_id}: {e}")
                return []
            time.sleep(1)
    return []

# ── 📥 DOWNLOADERS & R2 UPLOADERS ─────────────────────────────────────────────
def is_binary_stream(res):
    content_type = res.headers.get("Content-Type", "").lower()
    if "text/html" in content_type or "application/json" in content_type:
        return False
    return True

# 1. Mediafire Resolver and Downloader
def download_mediafire(url, local_dir):
    try:
        res = requests.get(url, headers=HEADERS, timeout=15)
        html = res.text
        
        matches = re.findall(r'href="((?:https?:)?//download[^"]*?)"', html)
        if not matches:
            matches = re.findall(r'href=[\'"]([^\'"]*?download[^\'"]*?)[\'"]', html)
            
        direct_url = None
        for m in matches:
            if 'download' in m and 'mediafire.com' in m and 'download_repair' not in m:
                direct_url = m
                break
                
        if not direct_url:
            return None, "Failed to resolve Mediafire direct download link"
            
        # Parse filename from URL
        parsed = urllib.parse.urlparse(direct_url)
        filename = os.path.basename(parsed.path)
        if not filename:
            filename = "mediafire_game.zip"
        else:
            filename = urllib.parse.unquote(filename)
            filename = re.sub(r'[\\/:*?"<>|]', '_', filename)
            
        local_path = os.path.join(local_dir, filename)
        
        # Download
        with requests.get(direct_url, headers=HEADERS, stream=True, timeout=60) as dl_res:
            dl_res.raise_for_status()
            if not is_binary_stream(dl_res):
                return None, "Mediafire returned web content instead of binary file"
            with open(local_path, 'wb') as f:
                for chunk in dl_res.iter_content(chunk_size=1024*1024):
                    if chunk:
                        f.write(chunk)
                        
        return local_path, None
    except Exception as e:
        return None, str(e)

# 2. Dropbox Downloader
def download_dropbox(url, local_dir):
    try:
        # Rewrite URL to force download
        if "dl=0" in url:
            direct_url = url.replace("dl=0", "raw=1")
        elif "?" in url:
            direct_url = url + "&raw=1"
        else:
            direct_url = url + "?raw=1"
            
        res = requests.get(direct_url, headers=HEADERS, stream=True, timeout=30)
        res.raise_for_status()
        
        if not is_binary_stream(res):
            return None, "Dropbox returned HTML web page instead of raw file"
            
        content_disp = res.headers.get("Content-Disposition", "")
        filename = None
        if "filename=" in content_disp:
            m = re.search(r'filename="?([^"]+)"?', content_disp)
            if m:
                filename = m.group(1)
        if not filename:
            filename = os.path.basename(urllib.parse.urlparse(url).path)
        if not filename:
            filename = "dropbox_game.zip"
            
        clean_filename = re.sub(r'[\\/:*?"<>|]', '_', filename)
        local_path = os.path.join(local_dir, clean_filename)
        
        with open(local_path, 'wb') as f:
            for chunk in res.iter_content(chunk_size=1024*1024):
                if chunk:
                    f.write(chunk)
                    
        return local_path, None
    except Exception as e:
        return None, str(e)

# 3. Google Drive Downloader
def download_gdrive(url, local_dir):
    try:
        match = re.search(r'/file/d/([a-zA-Z0-9_-]+)', url)
        file_id = match.group(1) if match else None
        if not file_id:
            match_id = re.search(r'[?&]id=([a-zA-Z0-9_-]+)', url)
            if match_id:
                file_id = match_id.group(1)
                
        if not file_id:
            return None, "Could not extract Google Drive File ID"
            
        session = requests.Session()
        download_url = "https://docs.google.com/uc?export=download"
        
        res = session.get(download_url, params={'id': file_id}, headers=HEADERS, stream=True, timeout=20)
        res.raise_for_status()
        
        content_type = res.headers.get("Content-Type", "")
        if "text/html" in content_type:
            # Parse warning/confirmation page
            soup = BeautifulSoup(res.content, 'html.parser')
            form = soup.find('form', id='download-form')
            if not form:
                return None, "File is restricted, private, or deleted on Google Drive"
                
            action_url = form.get('action')
            params = {}
            for inp in form.find_all('input'):
                name = inp.get('name')
                val = inp.get('value', '')
                if name:
                    params[name] = val
                    
            res = session.get(action_url, params=params, headers=HEADERS, stream=True, timeout=30)
            res.raise_for_status()
            
        content_disp = res.headers.get("Content-Disposition", "")
        filename = None
        if "filename=" in content_disp:
            m = re.search(r'filename="?([^"]+)"?', content_disp)
            if m:
                filename = m.group(1)
        if not filename:
            filename = "gdrive_game.zip"
            
        clean_filename = re.sub(r'[\\/:*?"<>|]', '_', filename)
        local_path = os.path.join(local_dir, clean_filename)
        
        with open(local_path, 'wb') as f:
            for chunk in res.iter_content(chunk_size=1024*1024):
                if chunk:
                    f.write(chunk)
                    
        return local_path, None
    except Exception as e:
        return None, str(e)

# 4. MEGA Downloader
def download_mega(url, local_dir):
    try:
        mega_client = Mega().login()
        # mega.py download_url takes URL and dest_path, and saves it
        downloaded_path = mega_client.download_url(url, dest_path=local_dir)
        if not downloaded_path or not os.path.exists(downloaded_path):
            return None, "Mega download failed, file not found on disk"
        return downloaded_path, None
    except Exception as e:
        return None, str(e)

# Master Downloader Router
def download_netdisk_file(url, local_dir):
    url_lower = url.lower()
    if "mediafire.com" in url_lower and "/folder/" not in url_lower:
        return download_mediafire(url, local_dir)
    elif "dropbox.com" in url_lower:
        return download_dropbox(url, local_dir)
    elif "drive.google.com" in url_lower or "docs.google.com" in url_lower:
        return download_gdrive(url, local_dir)
    elif "mega.nz" in url_lower or "mega.co.nz" in url_lower:
        return download_mega(url, local_dir)
    return None, "Unsupported netdisk or format"

# ── 🛠️ MAIN IMPLEMENTATION PIPELINE ──────────────────────────────────────────
def main():
    log("==========================================================")
    log("      DELICIOUS FRUIT AUTOMATED RATINGS & SYNC PIPELINE")
    log("==========================================================")
    
    # 1. Check database paths
    if not os.path.exists(GAMES_PATH):
        log(f"[FATAL] Games list database not found at: {GAMES_PATH}")
        sys.exit(1)
    if not os.path.exists(SEQ_MAP_PATH):
        log(f"[FATAL] Mapping file not found at: {SEQ_MAP_PATH}")
        sys.exit(1)
        
    # 2. Load existing files
    with open(GAMES_PATH, "r", encoding="utf-8") as f:
        games = json.load(f)
        
    import copy
    old_games = copy.deepcopy(games)
    
    with open(SEQ_MAP_PATH, "r", encoding="utf-8") as f:
        seq_map = json.load(f)
        
    log(f"Loaded {len(games)} existing local games.")
    log(f"Loaded {len(seq_map)} sequential-to-original game ID mappings.")
    
    # 2A. Run database mojibake self-healing sweep
    log("Running database mojibake self-healing sweep...")
    healed_db_count = 0
    for seq_id, g in games.items():
        healed = False
        
        # Heal Title
        t = g.get("title", "")
        healed_t = heal_mojibake(t)
        if healed_t != t:
            g["title"] = healed_t
            healed = True
            
        # Heal Creator name
        if isinstance(g.get("creator"), dict):
            c_name = g["creator"].get("name", "")
            healed_c = heal_mojibake(c_name)
            if healed_c != c_name:
                g["creator"]["name"] = healed_c
                healed = True
        elif isinstance(g.get("creator"), str):
            c_name = g["creator"]
            healed_c = heal_mojibake(c_name)
            if healed_c != c_name:
                g["creator"] = healed_c
                healed = True
                
        # Heal Tags
        tags = g.get("tags", [])
        if isinstance(tags, list):
            new_tags = []
            tags_changed = False
            for tag in tags:
                healed_tag = heal_mojibake(tag).lower()
                if healed_tag != tag:
                    tags_changed = True
                new_tags.append(healed_tag)
            if tags_changed:
                g["tags"] = new_tags
                healed = True
                
        if healed:
            healed_db_count += 1
            
    if healed_db_count > 0:
        log(f"Database mojibake self-healing sweep complete. Healed {healed_db_count} records.")
    else:
        log("No mojibake detected in existing database records.")
        
    # 2B. Run Wiki-only games tag sync sweep
    log("Running Wiki games tag synchronization sweep...")
    unsynced_games = []
    for seq_id, g in games.items():
        if seq_id in seq_map:
            mapping = seq_map[seq_id]
            if isinstance(mapping, list) and len(mapping) > 0:
                orig_id = str(mapping[0])
                if orig_id.startswith("WIKI-"):
                    # Check if tags have already been synced
                    has_synced = len(mapping) >= 3 and mapping[2] == "tags_synced"
                    if not has_synced:
                        w_id = orig_id.replace("WIKI-", "")
                        unsynced_games.append((seq_id, w_id, g, mapping))
                        
    if unsynced_games:
        log(f"  Found {len(unsynced_games)} unsynced Wiki games. Fetching tags concurrently...")
        
        def process_single_game(item):
            seq_id, w_id, g, mapping = item
            wiki_tags = fetch_wiki_tags(w_id)
            return seq_id, w_id, g, mapping, wiki_tags
            
        wiki_tags_synced_count = 0
        with ThreadPoolExecutor(max_workers=15) as executor:
            results = list(executor.map(process_single_game, unsynced_games))
            
        for seq_id, w_id, g, mapping, wiki_tags in results:
            g["tags"] = wiki_tags
            m_type = mapping[1] if len(mapping) >= 2 else "wiki_game"
            seq_map[seq_id] = [mapping[0], m_type, "tags_synced"]
            wiki_tags_synced_count += 1
            if wiki_tags:
                log(f"  [WIKI TAG SYNC] Synced {len(wiki_tags)} tags for game ID {seq_id} ('{g.get('title')}')")
            else:
                log(f"  [WIKI TAG SYNC] Confirmed no tags exist for game ID {seq_id} ('{g.get('title')}')")
                
        log(f"Wiki tag sync sweep complete. Synced {wiki_tags_synced_count} games.")
    else:
        log("No missing Wiki tags detected.")
    
    # Create reverse map of orig_id (Delicious Fruit ID) -> seq_id
    orig_to_seq_map = {}
    for seq_id, val in seq_map.items():
        if isinstance(val, list) and len(val) > 0:
            orig_to_seq_map[str(val[0])] = str(seq_id)
            
    # Create a normalized Title map of local games for title-matching fallback
    title_to_seq_ids = {}
    for seq_id, g in games.items():
        t_norm = normalize_str(g.get("title", ""))
        if t_norm:
            if t_norm not in title_to_seq_ids:
                title_to_seq_ids[t_norm] = []
            title_to_seq_ids[t_norm].append(seq_id)
            
    # 3. Scrape the full list from Delicious Fruit
    scraped_games = scrape_full_list()
    if scraped_games is None:
        log("[WARNING] Scraped games list is empty or unreachable. Skipping Delicious Fruit ingestion.")
        scraped_games = []
        
    # Load complete I Wanna Wiki game catalog unconditionally
    wiki_games = fetch_wiki_games()
    if not wiki_games:
        log("[WARNING] Wiki games catalog is empty or unreachable. Skipping Wiki ingestion.")
        wiki_games = []
    
    # Setup stats tracking
    update_count = 0
    new_game_count = 0
    new_games_to_process = []
    
    # 4. Check for differences or new games
    for sg in scraped_games:
        df_id = sg["df_id"]
        title = sg["title"]
        scraped_diff = sg["avg_difficulty"]
        scraped_rating = sg["avg_rating"]
        scraped_count = sg["rating_count"]
        
        seq_id = None
        
        # Direct lookup by ID
        if df_id in orig_to_seq_map:
            seq_id = orig_to_seq_map[df_id]
        else:
            # Try matching by Title fallback
            title_norm = normalize_str(title)
            if title_norm in title_to_seq_ids:
                matches = title_to_seq_ids[title_norm]
                # Filter out seq_ids that are already claimed/mapped in seq_map
                unclaimed_matches = [m for m in matches if str(m) not in seq_map]
                if len(unclaimed_matches) == 1:
                    seq_id = unclaimed_matches[0]
                    # Self-heal mapping
                    seq_map[str(seq_id)] = [df_id, "title_match"]
                    orig_to_seq_map[str(df_id)] = str(seq_id)
                    log(f"  [HEAL] Mapped unlinked local game ID {seq_id} -> DF ID {df_id} via title match '{title}'")
                    
        if seq_id:
            # Game exists in local database, check for updates
            g = games[seq_id]
            changed = False
            
            # Normalize schema to average rating/difficulty/rating_count
            if "avg_difficulty" not in g and "difficulty" in g:
                g["avg_difficulty"] = float(g.pop("difficulty", 0.0))
                changed = True
            if "avg_rating" not in g and "rating" in g:
                g["avg_rating"] = float(g.pop("rating", 0.0))
                changed = True
            if "rating_count" not in g and "reviews" in g:
                g["rating_count"] = int(g.pop("reviews", 0))
                changed = True
                
            # Clean up flags if they exist in schema2
            if "flags" in g:
                g.pop("flags")
                changed = True
            
            # Check numerical changes
            curr_diff = g.get("avg_difficulty", 0.0)
            curr_rating = g.get("avg_rating", 0.0)
            curr_count = g.get("rating_count", 0)
            
            if curr_diff != scraped_diff:
                g["avg_difficulty"] = scraped_diff
                changed = True
            if curr_rating != scraped_rating:
                g["avg_rating"] = scraped_rating
                changed = True
            if curr_count != scraped_count:
                g["rating_count"] = scraped_count
                changed = True
                
            if changed:
                update_count += 1
                log(f"  [UPDATE] #{update_count} | Seq ID {seq_id} | DF ID {df_id} | '{title}' | Diff: {curr_diff}->{scraped_diff} | Rate: {curr_rating}->{scraped_rating} | Count: {curr_count}->{scraped_count}")
        else:
            # Brand new game found!
            new_game_count += 1
            new_games_to_process.append(sg)
            log(f"  [NEW GAME DETECTED] #{new_game_count} | DF ID {df_id} | '{title}' | Difficulty: {scraped_diff} | Rating: {scraped_rating} | Count: {scraped_count}")

    log("\n" + "="*50)
    log(f"Delicious Fruit scan complete. Updates to apply: {update_count}. New games to ingest: {len(new_games_to_process)}.")
    log("="*50 + "\n")
    
    # 5. Process new games
    wiki_only_games_to_process = []
    existing_normalized_titles = set(title_to_seq_ids.keys())
    for sg in new_games_to_process:
        existing_normalized_titles.add(normalize_str(sg["title"]))
        
    enqueued_wiki_titles = set()
    for wg in wiki_games:
        w_title = wg.get("name", "")
        w_title_norm = normalize_str(w_title)
        if not w_title_norm:
            continue
        if w_title_norm not in existing_normalized_titles and w_title_norm not in enqueued_wiki_titles:
            wiki_only_games_to_process.append(wg)
            enqueued_wiki_titles.add(w_title_norm)
            
    log(f"Found {len(wiki_only_games_to_process)} Wiki-only games to ingest.")
    
    if len(new_games_to_process) > 0 or len(wiki_only_games_to_process) > 0:
        # Initialize boto3 Cloudflare R2 Client
        endpoint_url = f"https://{CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
        r2_client = boto3.client(
            's3',
            endpoint_url=endpoint_url,
            aws_access_key_id=AWS_ACCESS_KEY_ID,
            aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
            config=Config(signature_version='s3v4')
        )
        
        # Create temp folder for downloads
        os.makedirs(TEMP_BASE_DIR, exist_ok=True)
        
        # Ingest Delicious Fruit new games
        for idx, new_g in enumerate(new_games_to_process):
            df_id = new_g["df_id"]
            title = new_g["title"]
            rating = new_g["avg_rating"]
            difficulty = new_g["avg_difficulty"]
            rating_count = new_g["rating_count"]
            
            log(f"\nINGESTING NEW GAME #{idx+1}/{len(new_games_to_process)}: '{title}' (DF ID: {df_id})")
            
            # Step 5A: Scrape details (creator, tags, screenshots) from game_details.php
            creator_name, creator_url, tags, screenshots = fetch_game_details(df_id)
            log(f"  Creator: {creator_name} | Tags: {tags} | Screenshots found: {len(screenshots)}")
            
            # Step 5B: Assign next sequential ID
            new_seq_id = max(int(k) for k in games.keys()) + 1
            new_seq_id_str = str(new_seq_id)
            
            # Step 5C: Search matching game in I Wanna Wiki
            matched_wg = find_wiki_game_match(wiki_games, title, creator_name)
            wiki_url = matched_wg.get("url", "") if matched_wg else ""
            log(f"  Matched Wiki Link: {wiki_url if wiki_url else 'None'}")
            
            # Merge tags from I Wanna Wiki if matched
            if matched_wg:
                wiki_tags = fetch_wiki_tags(matched_wg.get("id"))
                for t in wiki_tags:
                    t_clean = heal_mojibake(t).lower().strip()
                    if t_clean and t_clean not in tags:
                        tags.append(t_clean)
                log(f"  Merged Tags: {tags}")
            
            download_url = ""
            file_size = 0
            
            # Step 5D: If supported netdisk, download and upload to R2
            if wiki_url:
                game_temp_dir = os.path.join(TEMP_BASE_DIR, new_seq_id_str)
                os.makedirs(game_temp_dir, exist_ok=True)
                
                log(f"  Downloading from netdisk link: {wiki_url}...")
                local_path, err = download_netdisk_file(wiki_url, game_temp_dir)
                
                if err:
                    log(f"  [DOWNLOAD FAIL] ID {new_seq_id} ('{title}'): {err}")
                    # Clean up temp folder
                    try: shutil.rmtree(game_temp_dir)
                    except Exception: pass
                elif local_path and os.path.exists(local_path):
                    # Successful download! Get extension
                    filename = os.path.basename(local_path)
                    ext = os.path.splitext(filename)[1].lower()
                    if not ext or len(ext) > 5:
                        ext = ".zip" # Default fallback
                        
                    # Target R2 name
                    r2_filename = f"{new_seq_id}{ext}"
                    r2_key = f"Game/{r2_filename}"
                    
                    actual_size = os.path.getsize(local_path)
                    log(f"  Downloaded successfully. Size: {actual_size / (1024*1024):.2f} MB. Uploading to Cloudflare R2...")
                    
                    try:
                        r2_client.upload_file(
                            local_path,
                            BUCKET_NAME,
                            r2_key,
                            ExtraArgs={'ContentType': 'application/octet-stream'}
                        )
                        
                        download_url = f"{PUBLIC_DOMAIN}/{r2_key}"
                        file_size = actual_size
                        log(f"  [UPLOAD SUCCESS] R2 Direct Link: {download_url}")
                    except Exception as upload_err:
                        log(f"  [R2 UPLOAD FAIL] ID {new_seq_id}: {upload_err}")
                        
                    # Clean up local temporary file immediately
                    try:
                        os.remove(local_path)
                        os.rmdir(game_temp_dir)
                    except Exception:
                        pass
            
            # Step 5E: Construct new game object
            new_game_obj = {
                "id": new_seq_id,
                "title": title,
                "creator": {
                    "name": creator_name,
                    "url": creator_url
                },
                "avg_rating": rating,
                "avg_difficulty": difficulty,
                "download_url": download_url,
                "tags": tags,
                "screenshots": screenshots,
                "reviews": [],
                "rating_count": rating_count,
                "file_size": file_size
            }
            
            # Save into memory
            with db_lock:
                games[new_seq_id_str] = new_game_obj
                seq_map[new_seq_id_str] = [df_id, "new_game", "tags_synced"]
                
            log(f"  Ingestion successfully completed! Saved as sequential ID: {new_seq_id_str}")

        # Ingest I Wanna Wiki new games
        for idx, wg in enumerate(wiki_only_games_to_process):
            w_id = wg.get("id")
            title = wg.get("name", "Untitled Wiki Game")
            creator_name = wg.get("creator", "Unknown")
            wiki_url = wg.get("url", "").strip()
            
            log(f"\nINGESTING WIKI-ONLY GAME #{idx+1}/{len(wiki_only_games_to_process)}: '{title}' (Wiki ID: {w_id})")
            
            creator_url = "#"
            tags = fetch_wiki_tags(w_id)
            log(f"  Wiki Tags found: {tags}")
            screenshots = []
            
            # Assign next sequential ID
            new_seq_id = max(int(k) for k in games.keys()) + 1
            new_seq_id_str = str(new_seq_id)
            
            download_url = ""
            file_size = 0
            
            # If supported netdisk, download and upload to R2
            if wiki_url:
                game_temp_dir = os.path.join(TEMP_BASE_DIR, new_seq_id_str)
                os.makedirs(game_temp_dir, exist_ok=True)
                
                log(f"  Downloading from netdisk link: {wiki_url}...")
                local_path, err = download_netdisk_file(wiki_url, game_temp_dir)
                
                if err:
                    log(f"  [DOWNLOAD FAIL] ID {new_seq_id} ('{title}'): {err}")
                    # Clean up temp folder
                    try: shutil.rmtree(game_temp_dir)
                    except Exception: pass
                    # Since download failed, fall back to the original Wiki download URL directly!
                    download_url = wiki_url
                elif local_path and os.path.exists(local_path):
                    # Successful download! Get extension
                    filename = os.path.basename(local_path)
                    ext = os.path.splitext(filename)[1].lower()
                    if not ext or len(ext) > 5:
                        ext = ".zip" # Default fallback
                        
                    # Target R2 name
                    r2_filename = f"{new_seq_id}{ext}"
                    r2_key = f"Game/{r2_filename}"
                    
                    actual_size = os.path.getsize(local_path)
                    log(f"  Downloaded successfully. Size: {actual_size / (1024*1024):.2f} MB. Uploading to Cloudflare R2...")
                    
                    try:
                        r2_client.upload_file(
                            local_path,
                            BUCKET_NAME,
                            r2_key,
                            ExtraArgs={'ContentType': 'application/octet-stream'}
                        )
                        
                        download_url = f"{PUBLIC_DOMAIN}/{r2_key}"
                        file_size = actual_size
                        log(f"  [UPLOAD SUCCESS] R2 Direct Link: {download_url}")
                    except Exception as upload_err:
                        log(f"  [R2 UPLOAD FAIL] ID {new_seq_id}: {upload_err}")
                        download_url = wiki_url # Fallback to original
                        
                    # Clean up local temporary file immediately
                    try:
                        os.remove(local_path)
                        os.rmdir(game_temp_dir)
                    except Exception:
                        pass
            
            # Construct new game object
            new_game_obj = {
                "id": new_seq_id,
                "title": title,
                "creator": {
                    "name": creator_name,
                    "url": creator_url
                },
                "avg_rating": 0.0,
                "avg_difficulty": 0.0,
                "download_url": download_url,
                "tags": tags,
                "screenshots": screenshots,
                "reviews": [],
                "rating_count": 0,
                "file_size": file_size
            }
            
            # Save into memory
            with db_lock:
                games[new_seq_id_str] = new_game_obj
                seq_map[new_seq_id_str] = [f"WIKI-{w_id}", "wiki_game", "tags_synced"]
                
            log(f"  Ingestion successfully completed! Saved as sequential ID: {new_seq_id_str}")

        # Clean up temp base directory completely
        if os.path.exists(TEMP_BASE_DIR):
            try: shutil.rmtree(TEMP_BASE_DIR)
            except Exception: pass
            
    # Generate timeline delta changes
    log("\nGenerating database timeline delta changes...")
    RECENT_CHANGES_PATH = r"data\recent_changes.json"
    
    updated = {}
    deleted = []
    
    with db_lock:
        # Compare old_games with current games
        for seq_id, game in games.items():
            if seq_id not in old_games:
                updated[seq_id] = game
            elif game != old_games[seq_id]:
                updated[seq_id] = game
                
        for seq_id in old_games:
            if seq_id not in games:
                deleted.append(seq_id)
                
    if updated or deleted:
        log(f"  Detected changes: {len(updated)} updated/added, {len(deleted)} deleted.")
        with db_lock:
            # Load or initialize recent_changes.json
            recent_changes = {}
            if os.path.exists(RECENT_CHANGES_PATH):
                try:
                    with open(RECENT_CHANGES_PATH, "r", encoding="utf-8") as f_rc:
                        recent_changes = json.load(f_rc)
                except Exception as rc_err:
                    log(f"  [WARNING] Failed to load recent_changes.json: {rc_err}")
            
            if not recent_changes or "version" not in recent_changes:
                recent_changes = {
                    "version": 1,
                    "timeline": {}
                }
            
            # Increment version
            new_version = recent_changes.get("version", 1) + 1
            recent_changes["version"] = new_version
            
            if "timeline" not in recent_changes:
                recent_changes["timeline"] = {}
                
            # Add delta version block
            recent_changes["timeline"][str(new_version)] = {
                "timestamp": int(time.time()),
                "updated": updated,
                "deleted": deleted
            }
            
            # Sliding window of last 30 versions
            timeline_keys = sorted(recent_changes["timeline"].keys(), key=int)
            if len(timeline_keys) > 30:
                keys_to_delete = timeline_keys[:-30]
                for k in keys_to_delete:
                    del recent_changes["timeline"][k]
                    
            # Save recent_changes.json atomically
            tmp_recent_path = RECENT_CHANGES_PATH + ".tmp"
            with open(tmp_recent_path, "w", encoding="utf-8") as f_tmp:
                json.dump(recent_changes, f_tmp, indent=2, ensure_ascii=False)
            os.replace(tmp_recent_path, RECENT_CHANGES_PATH)
            log(f"  Incremented database version to: {new_version} and updated recent_changes.json.")
    else:
        log("  No changes detected between old and new database. Version unchanged.")
        # If the file does not exist at all, initialize version 1 empty to keep build script happy
        if not os.path.exists(RECENT_CHANGES_PATH):
            with db_lock:
                initial_rc = {
                    "version": 1,
                    "timeline": {}
                }
                with open(RECENT_CHANGES_PATH, "w", encoding="utf-8") as f_tmp:
                    json.dump(initial_rc, f_tmp, indent=2, ensure_ascii=False)
                log("  Initialized empty recent_changes.json at version 1.")
            
    # 6. Save databases atomically
    log("\nSaving databases atomically...")
    with db_lock:
        # Save games.json
        tmp_games_path = GAMES_PATH + ".tmp"
        with open(tmp_games_path, "w", encoding="utf-8") as f_tmp:
            json.dump(games, f_tmp, indent=2, ensure_ascii=False)
        os.replace(tmp_games_path, GAMES_PATH)
        
        # Save seq_to_orig_map.json
        tmp_map_path = SEQ_MAP_PATH + ".tmp"
        with open(tmp_map_path, "w", encoding="utf-8") as f_tmp:
            json.dump(seq_map, f_tmp, indent=2, ensure_ascii=False)
        os.replace(tmp_map_path, SEQ_MAP_PATH)
        
    log("Databases successfully written to disk.")
    
    # 7. Synchronize storage statistics
    log("\nRunning storage statistics synchronizer...")
    try:
        subprocess.run(["py", "pipelines/update_storage_stats.py"], check=True)
    except Exception as e:
        log(f"  [ERROR] update_storage_stats.py failed: {e}")
        
    # 8. Recompile the frontend static pages
    log("\nRebuilding Pages static distribution compiler...")
    try:
        subprocess.run(["py", "pipelines/build_github_pages.py"], check=True)
    except Exception as e:
        log(f"  [ERROR] build_github_pages.py failed: {e}")
        
    log("\n==========================================================")
    log("      ENTIRE SYNC, INGEST, AND MIGRATION JOB COMPLETE!")
    log("==========================================================")
    log(f"  Total games updated: {update_count}")
    log(f"  Total new Delicious Fruit games ingested: {new_game_count}")
    log(f"  Total new Wiki-only games ingested: {len(wiki_only_games_to_process)}")
    log("==========================================================")

if __name__ == "__main__":
    main()
