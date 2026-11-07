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
import datetime
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

# Shared `source` shape + wiki cross-linking rules (also used by the two
# backfill scripts, so the matching rules exist in exactly one place).
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import source_links

BUCKET_NAME = "fangame-files"
PUBLIC_DOMAIN = "https://file.fangame-archive.com"

GAMES_PATH = "data/games.json"
SEQ_MAP_PATH = "database/seq_to_orig_map.json"
TEMP_BASE_DIR = "temp/scraping_migration"

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

# ── 🌐 DELICIOUS FRUIT API ────────────────────────────────────────────────────
DF_API = "https://api.delicious-fruit.com"
DF_SITE = "https://delicious-fruit.com"
DF_PAGE_SIZE = 50  # the API returns at most 50 rows per page, whatever `limit` asks for
# DF_SYNC=off (deploy.yml) sends DF no request at all; the rest of the run carries on.
DF_SYNC = os.environ.get("DF_SYNC", "on").strip().lower() != "off"
# seq_map holds ~370 synthetic "DF ids" from 50002 up, left by an old mapping; DF
# answers 404 for them, so they say nothing about where its real ids have reached.
DF_SYNTHETIC_ID_FLOOR = 50000
DF_NEW_GAME_WINDOW_DAYS = 60
DF_ID_WALK_MISSES = 5
DF_RELEASE_DATE_BUDGET = 40
WIKI_PAGE_RE = re.compile(r"iwannawiki\.com/(?:[a-z]{2}/)?(?:games|fangamelist)/(\d+)", re.I)


def df_api(path, params=None):
    """Parsed JSON from DF's API, or None when DF answers 404. Raises after 3 failed
    attempts, so a bad response can never be mistaken for "nothing new"."""
    for backoff in (5, 20, None):
        try:
            res = requests.get(DF_API + path, params=params, headers=HEADERS, timeout=(15, 60))
            if res.status_code == 404:
                return None
            res.raise_for_status()
            return res.json()
        except Exception as e:
            if backoff is None:
                raise RuntimeError(f"DF API {path}: {e}") from e
            time.sleep(backoff)


def df_entry_gone(df_id):
    """True only when DF says a game is gone: flagged removed, or no such id."""
    try:
        game = df_api(f"/games/{df_id}")
        return game is None or bool(game.get("removed"))
    except Exception:
        return False


def df_game_row(a):
    """One API game as a row of the Step 4B scan. DF rates 0-100; the catalog stores rating/10."""
    rating, difficulty = a.get("rating"), a.get("difficulty")
    return {
        "df_id": str(a["id"]),
        "title": (a.get("name") or "").strip(),
        "avg_difficulty": None if difficulty is None else round(float(difficulty), 1),
        "avg_rating": None if rating is None else round(float(rating) / 10, 2),
        "rating_count": a.get("rating_count") or 0,
        "url": (a.get("url") or "").strip(),
    }


def fetch_new_df_games(known_ids):
    """DF games whose id the catalog has never mapped, as Step 4B rows; None on failure.

    Two lookups, because neither is enough alone. Date does not follow id: DF's wiki
    bot adds entries under the wiki's older date, so a newest-first walk stops too
    early (and `orderCol=id` isn't honored here). Ids have jumped before (28xxx to
    46xxx), so walking up from the highest id can stop short of a new range.
    """
    known = {int(k) for k in known_ids if str(k).isdigit()}
    real_ids = [k for k in known if k < DF_SYNTHETIC_ID_FLOOR]
    found = {}
    try:
        since = datetime.date.today() - datetime.timedelta(days=DF_NEW_GAME_WINDOW_DAYS)
        page = 0
        while True:
            batch = df_api("/games", {"limit": DF_PAGE_SIZE, "page": page, "orderCol": "date_created",
                                      "orderDir": "DESC", "createdFrom": f"{since.isoformat()}T00:00:00Z"})
            if not isinstance(batch, list):
                raise ValueError(f"unexpected /games response: {str(batch)[:120]}")
            found.update((a["id"], a) for a in batch)
            if len(batch) < DF_PAGE_SIZE:
                break
            page += 1
        next_id, misses = max(real_ids, default=0) + 1, 0
        while misses < DF_ID_WALK_MISSES:
            batch = df_api("/games", {"id": next_id, "limit": 1})
            if not isinstance(batch, list):
                raise ValueError(f"unexpected /games response: {str(batch)[:120]}")
            found.update((a["id"], a) for a in batch)
            misses = 0 if batch else misses + 1
            next_id += 1
    except Exception as e:
        log(f"[WARNING] Could not read new games from the Delicious Fruit API: {e}")
        return None
    return [df_game_row(a) for i, a in sorted(found.items()) if i not in known and not a.get("removed")]


def fetch_game_details(df_id):
    """(creator, creator_url, tags, screenshots) from DF's composite record. Creator is
    None (not "Unknown") on failure: the cross-source claim guard must not fail open."""
    log(f"  [Detail] Reading game details for DF ID {df_id}...")
    try:
        g = df_api(f"/composite/games/{df_id}/all")
        if not isinstance(g, dict) or not g.get("id"):
            raise ValueError(f"unexpected response: {str(g)[:120]}")
    except Exception as e:
        log(f"  [Detail FAIL] Failed to read DF ID {df_id}: {e}")
        return None, "#", [], []

    authors = [a.strip() for a in g.get("author") or [] if a and a.strip()]
    creator_url = f"{DF_SITE}/search?author={urllib.parse.quote(authors[0])}" if authors else "#"
    tags = []
    for t in g.get("tags") or []:
        name = (t.get("name") or "").strip().lower()
        if name and name not in tags:
            tags.append(name)
    screenshots = [{
        "id": shot["id"],
        "image_path": f"ratings/screenshots/{df_id}_{shot['id']:08x}.png",
        "by": shot.get("user_name") or "Anonymous",
    } for shot in sorted(g.get("screenshots") or [], key=lambda x: x["id"])
        if shot.get("approved") and not shot.get("removed")]
    return ", ".join(authors) or "Unknown", creator_url, tags, screenshots


def wiki_entry_for_df_link(url, wiki_by_id, wiki_by_url):
    """The wiki entry a DF download link points at: the wiki page itself, or the same file URL."""
    words = (url or "").split()
    if not words:
        return None
    page = WIKI_PAGE_RE.search(words[0])
    return wiki_by_id.get(page.group(1)) if page else wiki_by_url.get(words[0].lower())


def creator_name_of(game):
    c = game.get("creator")
    return (c.get("name") if isinstance(c, dict) else c) or ""


def creators_conflict(a, b):
    """Both known and sharing no name. DF lists every co-author under its current account
    name, so a different separator or a rename ("AlexBrogan69") is not a conflict."""
    split = lambda s: {n for n in (normalize_str(p) for p in re.split(r"[,，、&/+]|\band\b", s or "")) if n}
    names_a, names_b = split(a) - {"unknown"}, split(b) - {"unknown"}
    if not names_a or not names_b:
        return False
    return not any(x in y or y in x for x in names_a for y in names_b)

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

# ── 💬 REVIEWS SCRAPER & INTEGRATION ──────────────────────────────────────────
REVIEWS_JSON = "temp/reviews_scraped.json"
# Newest review the corpus held when the feed moved to the API. Rows since then carry
# `review_id`, and the highest one is where the next run stops reading.
DF_REVIEW_SEED_ID = 195213
# Paging is by offset, so a review disappearing between two page reads shifts the next
# page up and skips a row. Each run re-reads this many ids behind its stop point to pick
# such a row up; merge_reviews drops the ones already held.
DF_REVIEW_REREAD_IDS = 300
DF_REVIEW_MAX_PAGES = 200

def review_key(r):
    """Stable identity for a scraped review, used for de-duplication on merge.

    A written comment is identified by (game_id, author, user_id, text) so the same
    review re-scraped with a drifted date/rating/likes is NOT re-appended as a dupe.
    A named rating-only entry collapses on (game_id, author, user_id, rating, difficulty).
    Anonymous rating-only entries keep their full tuple so distinct anonymous ratings
    (which feed avg_rating / rating_count) are preserved.
    """
    text = (r.get("text") or "").strip()
    author = (r.get("author") or "").strip().lower()
    if text:
        return ("c", r.get("game_id"), author, r.get("user_id"), text)
    if author != "anonymous":
        return ("nr", r.get("game_id"), author, r.get("user_id"), r.get("rating"), r.get("difficulty"))
    tags_tuple = tuple(sorted(r.get("tags", []))) if r.get("tags") else ()
    return ("ar", r.get("game_id"), r.get("rating"), r.get("difficulty"), r.get("date"), tags_tuple)

def review_nums(g_reviews, field):
    """Collect parseable numeric values for a review field, skipping None/'na'/''
    and any malformed value (e.g. junk from a live scrape) instead of raising."""
    out = []
    for r in g_reviews:
        v = r.get(field)
        if v in (None, "na", ""):
            continue
        try:
            out.append(float(v))
        except (TypeError, ValueError):
            pass
    return out

def df_review_row(r, game_title=None):
    """One API review in the corpus's shape: rating 0-10 ('na' when unset), ||spoilers||,
    plain text otherwise, date like 'Oct 21, 2026'."""
    text = re.sub(r"\[spoiler\](.*?)\[/spoiler\]", r"||\1||", r.get("comment") or "", flags=re.I | re.S)
    text = re.sub(r"\[/?[biu]\]", "", text, flags=re.I).strip()
    created = datetime.datetime.fromisoformat(r["date_created"].replace("Z", "+00:00"))
    return {
        "review_id": r["id"],
        "author": r.get("user_name") or "Anonymous",
        "user_id": r.get("user_id"),
        "game_id": r["game_id"],
        "game_title": game_title or r.get("game_name") or "",
        "text": text,
        "likes": r.get("like_count") or 0,
        "rating": "na" if r.get("rating") is None else round(float(r["rating"]) / 10, 2),
        "difficulty": "na" if r.get("difficulty") is None else r["difficulty"],
        "date": f"{created:%b} {created.day}, {created.year}",
        "tags": [t["name"].strip().lower() for t in r.get("tags") or [] if t.get("name")],
    }

def fetch_new_df_reviews(after_id):
    """Reviews newer than after_id as corpus rows, oldest first; None on any failure.

    textReviewsFirst must stay off: it sorts by likes and ignores orderCol (the site's
    own pages send it). includeOwnerReview must stay on, or creators' reviews are left
    out. All or nothing: rows from a partial walk would move the stop point past the
    reviews not read yet.
    """
    rows, page = {}, 0
    try:
        while True:
            batch = df_api("/reviews", {"orderCol": "id", "orderDir": "DESC", "includeOwnerReview": "true",
                                        "limit": DF_PAGE_SIZE, "page": page})
            if not isinstance(batch, list):
                raise ValueError(f"unexpected /reviews response: {str(batch)[:120]}")
            ids = [r["id"] for r in batch]
            if ids != sorted(ids, reverse=True):
                raise ValueError("reviews are not newest-first")
            rows.update((r["id"], r) for r in batch if r["id"] > after_id)
            if len(batch) < DF_PAGE_SIZE or ids[-1] <= after_id:
                break
            page += 1
            if page >= DF_REVIEW_MAX_PAGES:
                raise ValueError(f"no review <= #{after_id} within {page} pages")
        return [df_review_row(rows[i]) for i in sorted(rows) if not rows[i].get("removed")]
    except Exception as e:
        log(f"[WARNING] Could not read new reviews from the Delicious Fruit API: {e}")
        return None

def fetch_all_game_reviews(game_id, game_title=""):
    """Every review of one game as corpus rows; None on failure."""
    log(f"  [Reviews] Reading all reviews for DF ID {game_id}...")
    rows, page = {}, 0
    try:
        while True:
            batch = df_api(f"/games/{game_id}/reviews", {"includeOwnerReview": "true",
                                                         "limit": DF_PAGE_SIZE, "page": page}) or []
            if not isinstance(batch, list):
                raise ValueError(f"unexpected response: {str(batch)[:120]}")
            rows.update((r["id"], r) for r in batch)
            if len(batch) < DF_PAGE_SIZE:
                break
            page += 1
        return [df_review_row(rows[i], game_title) for i in sorted(rows) if not rows[i].get("removed")]
    except Exception as e:
        log(f"  [WARNING] Could not read reviews for DF ID {game_id}: {e}")
        return None

def merge_reviews(corpus, incoming):
    """Add API review rows to the corpus in place; returns the rows actually added.

    A DF user has one review per game and an edit can reissue its id, so a new row
    replaces that user's older rows for the game instead of piling up beside them.
    Older rows may lack user_id, so the author name counts for those.
    """
    known_ids = {r.get("review_id") for r in corpus}
    fresh = [r for r in incoming if r["review_id"] not in known_ids]
    if not fresh:
        return []
    by_user = {(str(r["game_id"]), r["user_id"]) for r in fresh if r.get("user_id") is not None}
    by_name = {(str(r["game_id"]), r["author"].strip().lower()) for r in fresh if r["author"].strip().lower() != "anonymous"}

    def replaced(o):
        game = str(o.get("game_id"))
        if o.get("user_id") is not None:
            return (game, o["user_id"]) in by_user
        return (game, (o.get("author") or "").strip().lower()) in by_name

    corpus[:] = [o for o in corpus if not replaced(o)]
    keys = {review_key(o) for o in corpus}
    added = []
    for r in fresh:
        key = review_key(r)
        if key not in keys:
            keys.add(key)
            corpus.append(r)
            added.append(r)
    return added

def save_reviews(corpus):
    try:
        os.makedirs(os.path.dirname(REVIEWS_JSON), exist_ok=True)
        tmp_path = REVIEWS_JSON + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(corpus, f, indent=2, ensure_ascii=False)
        os.replace(tmp_path, REVIEWS_JSON)
        log("Saved reviews database successfully.")
    except Exception as e:
        log(f"  [WARNING] Failed to save reviews database: {e}")

def apply_review_stats(game, rows):
    """Set a game's averages and count from its review rows (same rounding as Step 4A)."""
    ratings = review_nums(rows, "rating")
    difficulties = review_nums(rows, "difficulty")
    if ratings:
        game["avg_rating"] = round(sum(ratings) / len(ratings), 2)
    if difficulties:
        game["avg_difficulty"] = round(sum(difficulties) / len(difficulties), 1)
    if rows:
        game["rating_count"] = len(rows)

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

    # Engine recognition (the v2026.009 `engine` field): new games are
    # recognized inline while their downloaded file is still local, and a
    # bounded backlog sweep runs later before the timeline delta. Attempts
    # persist in data/engine_recognition_state.json (synced to R2 by
    # sync_db_r2.py) so a settled game is never re-downloaded. Everything
    # engine-related is defensive: a failure must never break the sync.
    engine_recog = None
    engine_state = {}
    try:
        import engine_recognition as engine_recog
        engine_state = engine_recog.load_state()
        if not engine_state:
            # An empty/missing local state is either the genuine first run OR a
            # transient failure of the R2 download step. Seed only when R2
            # confirms the object truly does not exist; otherwise disable engine
            # work for this run so the final upload can never replace the real
            # attempt history with a fresh seed.
            if CLOUDFLARE_ACCOUNT_ID and AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY:
                probe_client = boto3.client(
                    's3',
                    endpoint_url=f"https://{CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com",
                    aws_access_key_id=AWS_ACCESS_KEY_ID,
                    aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
                    config=Config(signature_version='s3v4')
                )
                if engine_recog.r2_state_exists(probe_client) is not False:
                    raise RuntimeError(
                        "local engine state is empty but the R2 copy exists or is "
                        "unverifiable (transient download failure?); skipping engine "
                        "recognition this run to protect the attempt history")
            engine_state, seeded_ok, seeded_failed = engine_recog.build_seed_state(games)
            log(f"Engine recognition state was empty; seeded from catalog "
                f"({seeded_ok} recognized, {seeded_failed} known-failed locally).")
        log(f"Engine recognition ready: {len(engine_state)} attempt records; "
            f"7z {'found' if engine_recog.SEVEN_ZIP else 'MISSING'}, "
            f"upx {'found' if engine_recog.UPX else 'MISSING'}.")
    except Exception as e:
        engine_recog = None
        log(f"[WARNING] Engine recognition unavailable: {e}")
    
    # 2C. Read new reviews and merge them
    scraped_reviews = []
    if os.path.exists(REVIEWS_JSON):
        try:
            with open(REVIEWS_JSON, "r", encoding="utf-8") as f:
                scraped_reviews = json.load(f)
        except Exception as e:
            log(f"  [WARNING] Failed to load existing reviews: {e}")

    newly_added = []
    if DF_SYNC:
        last_review = max((r.get("review_id") or 0 for r in scraped_reviews), default=0) or DF_REVIEW_SEED_ID
        log(f"Reading Delicious Fruit reviews newer than #{last_review}...")
        read_after = max(DF_REVIEW_SEED_ID, last_review - DF_REVIEW_REREAD_IDS)
        newly_added = merge_reviews(scraped_reviews, fetch_new_df_reviews(read_after) or [])
        log(f"Merged {len(newly_added)} new reviews from feed.")
        if newly_added:
            save_reviews(scraped_reviews)
    else:
        log("DF_SYNC=off: no Delicious Fruit requests this run (reviews, new games, release dates, ghost sweep).")

    # Make the newly-scraped reviews visible in the drawer by inserting them into D1
    # (source='imported', status='approved'). Idempotent via the unique index; failures
    # here must not abort the rest of the sync.
    if newly_added:
        try:
            from sync_reviews_to_d1 import sync_reviews_to_d1
            log(f"Syncing {len(newly_added)} new reviews into D1 (imported/approved)...")
            sync_reviews_to_d1(newly_added, apply=True)
        except Exception as e:
            log(f"  [WARNING] Failed to sync new reviews into D1: {e}")

    # Build reviews by DF ID mapping
    reviews_by_df_id = {}
    for r in scraped_reviews:
        df_id_str = str(r["game_id"])
        if df_id_str not in reviews_by_df_id:
            reviews_by_df_id[df_id_str] = []
        reviews_by_df_id[df_id_str].append(r)

    # 2D. Fetch complete Wiki tag mappings
    log("Fetching Wiki tags list for tag merging...")
    wiki_tags_list = []
    try:
        req = urllib.request.Request("https://api.iwannawiki.com/api/v1/tags", headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=15) as res:
            data = json.loads(res.read().decode('utf-8'))
            wiki_tags_list = data.get("tags", [])
    except Exception as e:
        log(f"  [WARNING] Error fetching Wiki tags list: {e}")

    # Map wiki_game_id -> set of tags
    wiki_game_tags = {}
    for t in wiki_tags_list:
        t_id = t["id"]
        t_name = t["name"].strip().lower()
        t_count = t["taggings_count"]
        log(f"  Fetching games for Wiki tag '{t_name}' ({t_count} games)...")
        
        per_page = 5000
        pages = (t_count + per_page - 1) // per_page
        for page in range(1, pages + 1):
            url = f"https://api.iwannawiki.com/api/v1/tags/{t_id}/games?per_page={per_page}&page={page}"
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            for attempt in range(3):
                try:
                    with urllib.request.urlopen(req, timeout=20) as res:
                        data = json.loads(res.read().decode('utf-8'))
                        for wg in data.get("games", []):
                            wg_id = wg["id"]
                            if wg_id not in wiki_game_tags:
                                wiki_game_tags[wg_id] = set()
                            wiki_game_tags[wg_id].add(t_name)
                    break
                except Exception as e:
                    time.sleep(1)
            time.sleep(0.1)
    
    # 2E. Run database mojibake self-healing sweep
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
            
    # 3. DF games the catalog has never mapped. Existing games take their numbers from
    # the reviews merged above, so nothing else needs the full 15k-game list.
    scraped_games = []
    if DF_SYNC:
        log("Checking the Delicious Fruit API for new games...")
        scraped_games = fetch_new_df_games(orig_to_seq_map)
        if scraped_games is None:
            log("[WARNING] Skipping Delicious Fruit ingestion this run.")
            scraped_games = []
        else:
            log(f"Found {len(scraped_games)} Delicious Fruit game(s) not mapped yet.")

    # Load complete I Wanna Wiki game catalog unconditionally
    wiki_games = fetch_wiki_games()
    if not wiki_games:
        log("[WARNING] Wiki games catalog is empty or unreachable. Skipping Wiki ingestion.")
        wiki_games = []
        
    # Build indices for Wiki matching
    wiki_by_id = {str(wg.get("id")): wg for wg in wiki_games}
    wiki_by_url = {}
    wiki_by_title_creator = {}
    wiki_by_title = {}

    for wg in wiki_games:
        url = wg.get("url", "").strip().lower()
        if url:
            wiki_by_url[url] = wg
        title_lower = wg.get("name", "").strip().lower()
        creator = wg.get("creator", "").strip().lower()
        if title_lower:
            wiki_by_title_creator[(title_lower, creator)] = wg
            if title_lower not in wiki_by_title:
                wiki_by_title[title_lower] = wg
    
    # Setup stats tracking
    update_count = 0
    new_game_count = 0
    new_games_to_process = []
    # Games that already exist from a non-DF source (Wiki ingest / community
    # submission) and were re-mapped to their DF id this run instead of being
    # ingested a second time; their DF reviews are pulled in Step 5.
    claimed_cross_source = []
    
    # 4A. Recalculate stats for all existing local games using reviews database
    log("Recalculating ratings, difficulties, and tags for all existing local games...")
    for seq_id, g in games.items():
        val = seq_map.get(str(seq_id))
        if not val or not isinstance(val, list) or len(val) == 0:
            continue
        df_id = str(val[0])
        if df_id.startswith("WIKI-"):
            continue
            
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
            
        if "flags" in g:
            g.pop("flags")
            changed = True
            
        # Recalculate from reviews
        g_reviews = reviews_by_df_id.get(df_id, [])
        new_count = len(g_reviews)
        
        ratings = review_nums(g_reviews, "rating")
        difficulties = review_nums(g_reviews, "difficulty")
        
        new_rating = sum(ratings) / len(ratings) if ratings else None
        new_difficulty = sum(difficulties) / len(difficulties) if difficulties else None
        
        curr_diff = g.get("avg_difficulty")
        curr_rating = g.get("avg_rating")
        curr_count = g.get("rating_count", 0)
        
        if new_rating is not None:
            new_rating = round(new_rating, 2)
        if new_difficulty is not None:
            new_difficulty = round(new_difficulty, 1)
            
        # Update values if they changed
        if new_difficulty is not None and curr_diff != new_difficulty:
            g["avg_difficulty"] = new_difficulty
            changed = True
        if new_rating is not None and curr_rating != new_rating:
            g["avg_rating"] = new_rating
            changed = True
        if new_count > 0 and curr_count != new_count:
            g["rating_count"] = new_count
            changed = True
            
        # Calculate unified tags: review tags + Wiki tags
        reviews_tags = set()
        for r in g_reviews:
            for t in r.get("tags", []):
                t_clean = (t or "").strip().lower()
                if t_clean:
                    reviews_tags.add(t_clean)
                    
        wiki_tags = set()
        val = seq_map.get(str(seq_id))
        w_game = None
        if val and isinstance(val, list) and len(val) > 0 and val[0].startswith("WIKI-"):
            w_id = int(val[0].split("-")[1])
            w_tags = wiki_game_tags.get(w_id, set())
            wiki_tags.update(w_tags)
        else:
            url = (g.get("download_url") or "").strip().lower()
            title_lower = (g.get("title") or "").strip().lower()
            creator = ((g.get("creator", {}).get("name") or "").strip().lower()) if isinstance(g.get("creator"), dict) else ""
            
            if url in wiki_by_url:
                w_game = wiki_by_url[url]
            elif (title_lower, creator) in wiki_by_title_creator:
                w_game = wiki_by_title_creator[(title_lower, creator)]
            elif creator in ("unknown", "") and title_lower in wiki_by_title:
                w_game = wiki_by_title[title_lower]
                
            if w_game:
                wiki_tags.update(wiki_game_tags.get(w_game["id"], set()))
                
        new_tags = reviews_tags | wiki_tags
        if "archive" in g.get("tags", []):
            new_tags.add("archive")
            
        curr_tags = set((t or "").strip().lower() for t in g.get("tags", []) if t is not None)
        
        if curr_tags != new_tags:
            g["tags"] = sorted(list(new_tags))
            changed = True
            
        if changed:
            update_count += 1
            log(f"  [RECALC] #{update_count} | Seq ID {seq_id} | DF ID {df_id} | '{g.get('title')}' | Diff: {curr_diff}->{new_difficulty} | Rate: {curr_rating}->{new_rating} | Count: {curr_count}->{new_count}")

    # 4B. Check live scraped games for new games or live stat updates
    if scraped_games:
        log("Comparing live scraped Delicious Fruit game catalog with local database...")
        for sg in scraped_games:
            df_id = sg["df_id"]
            title = sg["title"]
            scraped_diff = sg["avg_difficulty"]
            scraped_rating = sg["avg_rating"]
            scraped_count = sg["rating_count"]
            
            seq_id = None
            if df_id in orig_to_seq_map:
                seq_id = orig_to_seq_map[df_id]
            else:
                # Try matching by Title fallback
                title_norm = normalize_str(title)
                if title_norm in title_to_seq_ids:
                    matches = title_to_seq_ids[title_norm]
                    unclaimed_matches = [m for m in matches if str(m) not in seq_map]
                    if len(unclaimed_matches) == 1 and str(unclaimed_matches[0]) in games:
                        seq_id = unclaimed_matches[0]
                        seq_map[str(seq_id)] = [df_id, "title_match"]
                        orig_to_seq_map[str(df_id)] = str(seq_id)
                        log(f"  [HEAL] Mapped unlinked local game ID {seq_id} -> DF ID {df_id} via title match '{title}'")
                        
                        # Recalculate stats for this newly mapped game immediately
                        g = games[seq_id]
                        changed = False
                        if "avg_difficulty" not in g and "difficulty" in g:
                            g["avg_difficulty"] = float(g.pop("difficulty", 0.0))
                            changed = True
                        if "avg_rating" not in g and "rating" in g:
                            g["avg_rating"] = float(g.pop("rating", 0.0))
                            changed = True
                        if "rating_count" not in g and "reviews" in g:
                            g["rating_count"] = int(g.pop("reviews", 0))
                            changed = True
                        if "flags" in g:
                            g.pop("flags")
                            changed = True
                            
                        g_reviews = reviews_by_df_id.get(df_id, [])
                        new_count = len(g_reviews)
                        ratings = review_nums(g_reviews, "rating")
                        difficulties = review_nums(g_reviews, "difficulty")
                        new_rating = sum(ratings) / len(ratings) if ratings else None
                        new_difficulty = sum(difficulties) / len(difficulties) if difficulties else None
                        
                        curr_diff = g.get("avg_difficulty")
                        curr_rating = g.get("avg_rating")
                        curr_count = g.get("rating_count", 0)
                        
                        if new_rating is not None:
                            new_rating = round(new_rating, 2)
                        if new_difficulty is not None:
                            new_difficulty = round(new_difficulty, 1)
                            
                        if new_difficulty is not None and curr_diff != new_difficulty:
                            g["avg_difficulty"] = new_difficulty
                            changed = True
                        if new_rating is not None and curr_rating != new_rating:
                            g["avg_rating"] = new_rating
                            changed = True
                        if new_count > 0 and curr_count != new_count:
                            g["rating_count"] = new_count
                            changed = True
                        if changed:
                            update_count += 1
                            log(f"  [RECALC HEALED] #{update_count} | Seq ID {seq_id} | DF ID {df_id} | '{title}' | Diff: {curr_diff}->{new_difficulty} | Rate: {curr_rating}->{new_rating} | Count: {curr_count}->{new_count}")
                            
            # A deleted (de-duplicated) game can still be claimed in seq_map as a tombstone
            # so the live scrape won't re-add it; skip it here since it's no longer in games.
            if seq_id and str(seq_id) in games:
                # Game exists locally and its stats were already recalculated in Step 4A
                # Let's check if it has no reviews and we need to update it using the live scraped list rating/difficulty
                g = games[str(seq_id)]
                g_reviews = reviews_by_df_id.get(df_id, [])
                
                # Only fallback/update using live scraped list if there are no reviews in our local reviews database
                if len(g_reviews) == 0:
                    changed = False
                    curr_diff = g.get("avg_difficulty")
                    curr_rating = g.get("avg_rating")
                    curr_count = g.get("rating_count", 0)
                    
                    if scraped_diff is not None and curr_diff != scraped_diff:
                        g["avg_difficulty"] = scraped_diff
                        changed = True
                    if scraped_rating is not None and curr_rating != scraped_rating:
                        g["avg_rating"] = scraped_rating
                        changed = True
                    if scraped_count != curr_count:
                        g["rating_count"] = scraped_count
                        changed = True
                        
                    if changed:
                        update_count += 1
                        log(f"  [LIVE UPDATE] #{update_count} | Seq ID {seq_id} | DF ID {df_id} | '{title}' | Diff: {curr_diff}->{scraped_diff} | Rate: {curr_rating}->{scraped_rating} | Count: {curr_count}->{scraped_count}")
            elif seq_id:
                # Mapped in seq_map but deliberately removed from the catalog —
                # a de-dup/deletion tombstone. Never re-add it, no matter how
                # long it stays listed on Delicious Fruit.
                continue
            else:
                # Cross-source duplicate guard. The same game may already be in
                # the catalog from a non-DF source — the Wiki ingest or an
                # approved community submission that landed before DF listed it
                # (DF outage, or plain listing lag). The DF id alone can't see
                # that, and blindly ingesting produced live duplicates
                # (21085/21087, 21093/21094, 21100/21101). If an existing
                # Wiki/submission entry has the same normalized title, claim it
                # for this DF id instead of adding a second entry.
                claim_seq = None
                claim_orig = ""
                # DF's own link settles it: its wiki bot copies the wiki entry's URL.
                linked_wg = wiki_entry_for_df_link(sg.get("url"), wiki_by_id, wiki_by_url)
                linked_seq = orig_to_seq_map.get(f"WIKI-{linked_wg.get('id')}") if linked_wg else None
                claim_proven = bool(linked_seq and linked_seq in games)
                if claim_proven:
                    claim_seq = linked_seq
                    claim_orig = str(seq_map[linked_seq][0])
                else:
                    for m in title_to_seq_ids.get(normalize_str(title), []):
                        m_str = str(m)
                        mapping = seq_map.get(m_str)
                        orig = str(mapping[0]) if isinstance(mapping, list) and mapping else ""
                        if m_str in games and (orig.startswith("WIKI-") or orig.startswith("SUBMISSION-")):
                            claim_seq = m_str
                            claim_orig = orig
                            break

                if claim_seq:
                    # Same title from another source: confirm via the creator
                    # before merging — different games can legitimately share a
                    # title. Only a definite conflict blocks the claim.
                    df_creator, df_creator_url, _df_tags, df_shots = fetch_game_details(df_id)
                    df_reviews = fetch_all_game_reviews(df_id, title) if df_creator is not None else None
                    if df_reviews is None:
                        # The creator can't be verified or the reviews would be lost,
                        # so neither claim nor ingest this run; the next cycle retries.
                        log(f"  [CLAIM DEFERRED] DF ID {df_id} '{title}' matches seq {claim_seq} ({claim_orig}), but the DF API is unreachable — deferring to the next run.")
                        continue
                    local_creator = creator_name_of(games[claim_seq])
                    if not claim_proven and creators_conflict(df_creator, local_creator):
                        log(f"  [CLAIM SKIPPED] DF ID {df_id} '{title}' matches seq {claim_seq} ({claim_orig}) by title, but creators differ ('{df_creator}' vs '{local_creator}') — treating as a distinct game.")
                        claim_seq = None

                if claim_seq:
                    g = games[claim_seq]
                    seq_map[claim_seq] = [df_id, "new_game", "tags_synced"]
                    orig_to_seq_map[str(df_id)] = claim_seq
                    apply_review_stats(g, df_reviews)
                    g["tags"] = sorted(set(g.get("tags") or []) | {t for r in df_reviews for t in r["tags"]})
                    # Backfill what the non-DF ingest couldn't know. The screenshot
                    # dicts are already in catalog shape; the screenshot sync mirrors
                    # them like any DF ingest's.
                    creator_obj = g.get("creator") or {}
                    if isinstance(creator_obj, str):
                        creator_obj = {"name": creator_obj, "url": "#"}
                    if df_creator != "Unknown" and normalize_str(creator_obj.get("name", "")) in ("", "unknown"):
                        creator_obj["name"] = df_creator
                    if df_creator_url and df_creator_url != "#" and creator_obj.get("url") in ("", "#", None):
                        creator_obj["url"] = df_creator_url
                    g["creator"] = creator_obj
                    if df_shots and not g.get("screenshots"):
                        g["screenshots"] = df_shots
                    claimed_cross_source.append({"df_id": df_id, "title": title, "seq_id": claim_seq, "reviews": df_reviews})
                    update_count += 1
                    log(f"  [CROSS-SOURCE CLAIM] Seq ID {claim_seq} ('{title}', was {claim_orig}) is the same game as DF ID {df_id} — remapped instead of duplicating.")
                    continue

                # Brand new game detected!
                new_game_count += 1
                new_games_to_process.append(sg)
                log(f"  [NEW GAME DETECTED] #{new_game_count} | DF ID {df_id} | '{title}' | Difficulty: {scraped_diff} | Rating: {scraped_rating} | Count: {scraped_count}")

    log("\n" + "="*50)
    log(f"Delicious Fruit scan complete. Updates to apply: {update_count}. New games to ingest: {len(new_games_to_process)}.")
    log("="*50 + "\n")
    
    # 5. Process new games
    wiki_only_games_to_process = []
    # Brand-new games' freshly-scraped reviews, to push into D1 after Step 6 writes the
    # seq map to disk — sync_reviews_to_d1 resolves game_id->seq_id from that file, and
    # these games' mappings don't exist on disk until then.
    new_game_reviews_for_d1 = []

    # Cross-source claimed games were ingested from the Wiki/a submission, so their DF
    # reviews were never read. Merge the ones the claim fetched (their stats are set).
    for cg in claimed_cross_source:
        if cg["reviews"]:
            log(f"  Found {len(cg['reviews'])} DF review(s) for claimed game '{cg['title']}' (seq {cg['seq_id']}). Merging...")
            new_game_reviews_for_d1.extend(cg["reviews"])
            merge_reviews(scraped_reviews, cg["reviews"])
    if claimed_cross_source:
        save_reviews(scraped_reviews)

    existing_normalized_titles = set(title_to_seq_ids.keys())
    for sg in new_games_to_process:
        existing_normalized_titles.add(normalize_str(sg["title"]))
        
    # WIKI ids already present in seq_map — including tombstones of deleted
    # games (deletion removes the games.json entry but keeps the mapping).
    # The title check below can't see a deleted game, so without this an
    # admin-deleted wiki-listed game would be re-ingested on the next run —
    # the wiki-side twin of the DF tombstone guard in the scan above.
    mapped_wiki_ids = set()
    for val in seq_map.values():
        if isinstance(val, list) and val and str(val[0]).startswith("WIKI-"):
            mapped_wiki_ids.add(str(val[0]))

    enqueued_wiki_titles = set()
    for wg in wiki_games:
        if f"WIKI-{wg.get('id')}" in mapped_wiki_ids:
            continue
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
            
            log(f"\nINGESTING NEW GAME #{idx+1}/{len(new_games_to_process)}: '{title}' (DF ID: {df_id})")
            
            # Step 5A: Read details (creator, tags, screenshots) and all reviews
            creator_name, creator_url, df_tags, screenshots = fetch_game_details(df_id)
            new_game_reviews = fetch_all_game_reviews(df_id, title) if creator_name is not None else None
            if new_game_reviews is None:
                # Still unmapped, so the next run finds this game again.
                log(f"  [INGEST DEFERRED] DF API unreachable for DF ID {df_id}; retrying next run.")
                new_game_count -= 1
                continue
            log(f"  Creator: {creator_name} | Initial Tags: {df_tags} | Screenshots found: {len(screenshots)}")

            if new_game_reviews:
                log(f"  Found {len(new_game_reviews)} reviews for new game. Merging...")
                new_game_reviews_for_d1.extend(new_game_reviews)
                merge_reviews(scraped_reviews, new_game_reviews)
                save_reviews(scraped_reviews)

            # Step 5B: Assign next sequential ID
            new_seq_id = max(int(k) for k in games.keys()) + 1
            new_seq_id_str = str(new_seq_id)
            
            # Step 5C: Search matching game in I Wanna Wiki
            matched_wg = (wiki_entry_for_df_link(new_g.get("url"), wiki_by_id, wiki_by_url)
                          or find_wiki_game_match(wiki_games, title, creator_name))
            wiki_url = matched_wg.get("url", "") if matched_wg else ""
            # DF's own link serves a game the wiki doesn't list; a link to a wiki page isn't a file.
            df_link = (new_g.get("url") or "").split()
            download_link = wiki_url or ("" if not df_link or WIKI_PAGE_RE.search(df_link[0]) else df_link[0])
            log(f"  Download link: {download_link or 'None'}")
            
            # Merge tags from I Wanna Wiki if matched
            wiki_tags = set()
            if matched_wg:
                w_tags = wiki_game_tags.get(matched_wg.get("id"), set())
                wiki_tags.update(w_tags)
                
            # Collect review tags
            reviews_tags = set()
            g_reviews = [r for r in new_game_reviews if str(r["game_id"]) == str(df_id)]
            for r in g_reviews:
                for t in r.get("tags", []):
                    t_clean = t.strip().lower()
                    if t_clean:
                        reviews_tags.add(t_clean)
                        
            # Combined tags
            final_tags = sorted(list(reviews_tags | wiki_tags))
            log(f"  Merged Tags: {final_tags}")
            
            # Calculate rating/difficulty/count
            ratings = review_nums(g_reviews, "rating")
            difficulties = review_nums(g_reviews, "difficulty")
            
            rating_count = len(g_reviews)
            rating = round(sum(ratings) / len(ratings), 2) if ratings else None
            difficulty = round(sum(difficulties) / len(difficulties), 1) if difficulties else None
            
            download_url = ""
            file_size = 0
            detected_engine = None

            # Step 5D: If supported netdisk, download and upload to R2
            if download_link:
                game_temp_dir = os.path.join(TEMP_BASE_DIR, new_seq_id_str)
                os.makedirs(game_temp_dir, exist_ok=True)
                
                log(f"  Downloading from netdisk link: {download_link}...")
                local_path, err = download_netdisk_file(download_link, game_temp_dir)
                
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

                    # Recognize the engine while the file is still on disk (the
                    # backlog sweep would otherwise re-download it from R2).
                    if engine_recog is not None:
                        try:
                            detected_engine, eng_result = engine_recog.recognize_for_catalog(
                                local_path, game_temp_dir, new_seq_id, log=log)
                            engine_recog.record_attempt(engine_state, new_seq_id, eng_result, "ci-inline")
                            log(f"  [ENGINE] ID {new_seq_id}: {detected_engine or 'unrecognized (' + str(eng_result.get('error') or 'unknown') + ')'}")
                        except Exception as eng_err:
                            log(f"  [ENGINE] Recognition error for ID {new_seq_id}: {eng_err}")

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
                "tags": final_tags,
                "screenshots": screenshots,
                "reviews": [],
                "rating_count": rating_count,
                "file_size": file_size
            }
            
            if detected_engine:
                new_game_obj["engine"] = detected_engine

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
            detected_engine = None

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

                    # Recognize the engine while the file is still on disk (the
                    # backlog sweep would otherwise re-download it from R2).
                    if engine_recog is not None:
                        try:
                            detected_engine, eng_result = engine_recog.recognize_for_catalog(
                                local_path, game_temp_dir, new_seq_id, log=log)
                            engine_recog.record_attempt(engine_state, new_seq_id, eng_result, "ci-inline")
                            log(f"  [ENGINE] ID {new_seq_id}: {detected_engine or 'unrecognized (' + str(eng_result.get('error') or 'unknown') + ')'}")
                        except Exception as eng_err:
                            log(f"  [ENGINE] Recognition error for ID {new_seq_id}: {eng_err}")

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
                "avg_rating": None,
                "avg_difficulty": None,
                "download_url": download_url,
                "tags": tags,
                "screenshots": screenshots,
                "reviews": [],
                "rating_count": 0,
                "file_size": file_size
            }
            
            if detected_engine:
                new_game_obj["engine"] = detected_engine

            # Wiki entries created after the 2019-11-14 bulk import carry an
            # organic created_at ~= the game's release/announcement date (we
            # ingest within ~6h of entry creation). Older stamps are just the
            # import moment — never a release date.
            wiki_created = str(wg.get("created_at") or "")[:10]
            if re.fullmatch(r"\d{4}-\d{2}-\d{2}", wiki_created) and wiki_created > "2019-11-21":
                new_game_obj["release_date"] = wiki_created

            # Save into memory
            with db_lock:
                games[new_seq_id_str] = new_game_obj
                seq_map[new_seq_id_str] = [f"WIKI-{w_id}", "wiki_game", "tags_synced"]
                
            log(f"  Ingestion successfully completed! Saved as sequential ID: {new_seq_id_str}")

        # Clean up temp base directory completely
        if os.path.exists(TEMP_BASE_DIR):
            try: shutil.rmtree(TEMP_BASE_DIR)
            except Exception: pass
            
    # ── Release-date sweep ────────────────────────────────────────────────────
    # DF-mapped games without a date take DF's dateCreated (UTC date), newest ids first
    # and bounded per run; a date already set is never overwritten. Runs BEFORE the
    # delta generation so dates ride the normal incremental update. A failed read just
    # leaves the game dateless for the next run's retry.
    if DF_SYNC:
        try:
            rd_targets = {}
            for rd_seq, rd_val in seq_map.items():
                if rd_seq not in games or games[rd_seq].get("release_date"):
                    continue
                rd_orig = str(rd_val[0]) if isinstance(rd_val, list) and rd_val else ""
                if rd_orig.isdigit() and int(rd_orig) < DF_SYNTHETIC_ID_FLOOR:
                    rd_targets[int(rd_orig)] = rd_seq
            for rd_df in sorted(rd_targets, reverse=True)[:DF_RELEASE_DATE_BUDGET]:
                rd_date = ((df_api(f"/games/{rd_df}") or {}).get("dateCreated") or "")[:10]
                if re.fullmatch(r"\d{4}-\d{2}-\d{2}", rd_date):
                    games[rd_targets[rd_df]]["release_date"] = rd_date
                    log(f"  [RELEASE DATE] Seq {rd_targets[rd_df]} (DF {rd_df}) -> {rd_date}")
        except Exception as e:
            log(f"  [WARNING] Release-date sweep failed: {e}")

    # ── Source provenance ─────────────────────────────────────────────────────
    # Stamp every mapped game with where it was ingested from, so the drawer and
    # the public API can link back to the upstream entry. seq_map is the single
    # source of truth; this runs after every claim/ingest above and BEFORE the
    # delta generation, so newly ingested games carry `source` in the normal
    # incremental update instead of waiting for backfill_source_links.py (which
    # stays in CI only as a no-op safety net for remappings). Locally submitted
    # games ("SUBMISSION-*") have no upstream page and are left unsourced.
    src_count = 0
    with db_lock:
        for src_seq, src_val in seq_map.items():
            src_game = games.get(str(src_seq))
            if src_game is None:
                continue
            src_entry = source_links.source_from_mapping(src_val)
            if src_entry and source_links.merge_source(src_game, src_entry, primary=True):
                src_count += 1
    if src_count:
        log(f"Stamped upstream source on {src_count} game(s).")

    # ── Wiki cross-link for new games ─────────────────────────────────────────
    # A game ingested from Delicious Fruit also gets its IWanna Wiki entry linked
    # when the two catalogs agree on the title (rules in source_links.py). The
    # historical ~12k links ride the committed data/wiki_links.json artifact
    # (backfill_wiki_links.py); this pass only covers games ingested since the
    # artifact was generated, so the delta stays small.
    #
    # `wiki_games` is whatever fetch_wiki_games() managed to collect and it
    # *breaks out on error*, so a partial catalog is possible. Matching on a
    # partial catalog is unsafe (a title whose duplicate is missing looks unique
    # and would be mislinked), so the pass is skipped unless the catalog is at
    # least as large as when the artifact was built.
    try:
        wl_min = 0
        wl_path = "data/wiki_links.json"
        wl_known = set()
        if os.path.exists(wl_path):
            with open(wl_path, "r", encoding="utf-8") as f_wl:
                wl_artifact = json.load(f_wl)
            wl_min = int(wl_artifact.get("wiki_catalog_size") or 0)
            wl_known = set(wl_artifact.get("links") or {})
        if not wiki_games or len(wiki_games) < wl_min:
            log(f"  Wiki cross-link pass skipped: catalog looks incomplete "
                f"({len(wiki_games)} < {wl_min}); retried next run.")
        else:
            with db_lock:
                # Games the artifact never considered — i.e. ingested since.
                wl_scope = {s for s in games if s not in wl_known}
                wl_links, wl_stats = source_links.match_wiki_links(
                    games, wiki_games, only_seq_ids=wl_scope)
                for wl_seq, wl_id in wl_links.items():
                    source_links.merge_source(
                        games[wl_seq], {"type": source_links.WIKI, "id": wl_id})
                    log(f"  [WIKI LINK] Seq {wl_seq} '{games[wl_seq].get('title')}' -> wiki {wl_id}")
            if wl_links:
                log(f"Cross-linked {len(wl_links)} game(s) to the IWanna Wiki "
                    f"({wl_stats['reject_creator_conflict']} rejected on creator mismatch).")
    except Exception as e:
        log(f"  [WARNING] Wiki cross-link pass failed: {e}")

    # Final normalization: a game with no ratings (rating_count == 0) is unrated, so
    # its avg_rating/avg_difficulty must be null (N/A), never 0.0. Runs after Steps 4A/4B
    # so rating_count is final (e.g. Delicious Fruit games keep their aggregate rating).
    # Editing games here — rather than only in the build — means the correction is carried
    # in the version delta below, so it reaches cached/incremental clients, not just fresh
    # full-loads. This also backfills historical 0.0 rows (e.g. older Wiki-only ingests).
    norm_count = 0
    with db_lock:
        for seq_id, g in games.items():
            if not g.get("rating_count"):
                if g.get("avg_rating") is not None or g.get("avg_difficulty") is not None:
                    g["avg_rating"] = None
                    g["avg_difficulty"] = None
                    norm_count += 1
    if norm_count:
        log(f"Normalized {norm_count} unrated game(s) (rating_count=0) to null rating/difficulty.")

    # Upstream-ghost sweep (pipelines/upstream_ghosts.py): retire DF listings
    # that DF deleted while a same-title, same-creator copy survives — e.g. a
    # game submitted to DF twice. Needs a complete live list: on a partial one,
    # live games would look deleted (each ghost is also 404-confirmed).
    if scraped_games and CLOUDFLARE_ACCOUNT_ID and AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY:
        try:
            import upstream_ghosts
            live_df_ids = {str(sg["df_id"]) for sg in scraped_games}
            held_df_ids = {d for g in games.values() for d in upstream_ghosts.df_ids(g)}
            if len(live_df_ids) < 0.9 * len(held_df_ids):
                log(f"\nUpstream-ghost sweep skipped: live DF list has {len(live_df_ids)} ids "
                    f"vs {len(held_df_ids)} held — looks incomplete.")
            else:
                ghosts = upstream_ghosts.find_ghosts(games, live_df_ids)
                log(f"\nUpstream-ghost sweep: {len(ghosts)} candidate(s).")
                if ghosts:
                    ghost_client = boto3.client(
                        's3',
                        endpoint_url=f"https://{CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com",
                        aws_access_key_id=AWS_ACCESS_KEY_ID,
                        aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
                        config=Config(signature_version='s3v4')
                    )
                    result = upstream_ghosts.resolve(
                        games, ghosts, ghost_client, confirm_gone=df_entry_gone, log=log,
                        engine_state=engine_state if engine_recog is not None else None)
                    log(f"  Upstream-ghost sweep: {len(result['deleted'])} deleted "
                        f"({len(result['moved'])} after handing their file to the survivor), "
                        f"{len(result['review'])} left for review.")
        except Exception as e:
            log(f"  [WARNING] Upstream-ghost sweep failed: {e}")

    # Engine recognition backlog sweep: recognize a bounded batch of R2-hosted
    # games that still lack `engine` (approved submissions merged earlier in the
    # CI run, earlier inline failures, admin-replaced links). Runs BEFORE the
    # timeline delta below so the new engine values ride the normal incremental
    # version bump out to cached clients.
    if engine_recog is not None:
        try:
            if CLOUDFLARE_ACCOUNT_ID and AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY:
                sweep_client = boto3.client(
                    's3',
                    endpoint_url=f"https://{CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com",
                    aws_access_key_id=AWS_ACCESS_KEY_ID,
                    aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
                    config=Config(signature_version='s3v4')
                )
                log("\nRunning engine recognition backlog sweep...")
                engine_recog.sweep_backlog(
                    games, engine_state, sweep_client, TEMP_BASE_DIR,
                    max_games=int(os.environ.get("ENGINE_SWEEP_MAX_GAMES", "20")),
                    max_seconds=int(os.environ.get("ENGINE_SWEEP_MAX_SECONDS", "900")),
                    max_file_mb=int(os.environ.get("ENGINE_SWEEP_MAX_FILE_MB", "1024")),
                    log=log,
                )
            else:
                log("Engine backlog sweep skipped: R2 credentials not configured.")
        except Exception as e:
            log(f"  [WARNING] Engine backlog sweep failed: {e}")
        finally:
            try:
                engine_recog.save_state(engine_state)
            except Exception as e:
                log(f"  [WARNING] Failed to save engine recognition state: {e}")

    # Generate timeline delta changes
    log("\nGenerating database timeline delta changes...")
    RECENT_CHANGES_PATH = "data/recent_changes.json"

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
            
            # Prune timeline to stay under a safe size limit (e.g., max 10 versions and total size < 10 MB)
            timeline_keys = sorted(recent_changes["timeline"].keys(), key=int)
            if len(timeline_keys) > 10:
                for k in timeline_keys[:-10]:
                    recent_changes["timeline"].pop(k, None)
                timeline_keys = timeline_keys[-10:]
            
            while len(timeline_keys) > 0:
                json_str = json.dumps(recent_changes, ensure_ascii=False)
                if len(json_str.encode('utf-8')) < 10 * 1024 * 1024:
                    break
                oldest_key = timeline_keys.pop(0)
                recent_changes["timeline"].pop(oldest_key, None)
                    
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

    # 6B. Sync brand-new and claimed games' reviews into D1 now that the seq map is on disk.
    # The feed sync earlier only covers reviews for games that were already mapped.
    if new_game_reviews_for_d1:
        try:
            from sync_reviews_to_d1 import sync_reviews_to_d1
            log(f"Syncing {len(new_game_reviews_for_d1)} new-game review(s) into D1 (imported/approved)...")
            sync_reviews_to_d1(new_game_reviews_for_d1, apply=True)
        except Exception as e:
            log(f"  [WARNING] Failed to sync new-game reviews into D1: {e}")

    # 7. Synchronize storage statistics
    log("\nRunning storage statistics synchronizer...")
    try:
        subprocess.run([sys.executable, "pipelines/update_storage_stats.py"], check=True)
    except Exception as e:
        log(f"  [ERROR] update_storage_stats.py failed: {e}")
        
    # 8. Recompile the frontend static pages
    log("\nRebuilding Pages static distribution compiler...")
    try:
        subprocess.run([sys.executable, "pipelines/build_github_pages.py"], check=True)
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
