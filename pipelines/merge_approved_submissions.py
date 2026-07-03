import os
import sys
import re
import json
import time
import subprocess
import requests
import urllib.parse

# Ensure config path resolved correctly
try:
    from config import CLOUDFLARE_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
except ImportError:
    sys.path.append(os.path.dirname(os.path.abspath(__file__)))
    from config import CLOUDFLARE_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY

# Reuse the scraper's proven, host-aware downloaders (Mediafire / Dropbox /
# Google Drive / MEGA resolvers + HTML-vs-binary detection). Without these, a
# user-submitted link to a host *page* (not a direct file) gets saved as the
# game's HTML landing page and mirrored to R2 as a "bad link" instead of the
# real archive — the failure this addresses. Imported lazily so a problem in the
# heavy scraper module degrades a single download (we fall back to the external
# URL) rather than crashing the whole merge step at startup.
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

_NETDISK_FNS = None


def _netdisk_fns():
    global _NETDISK_FNS
    if _NETDISK_FNS is None:
        from scrape_and_migrate_new_games import download_netdisk_file, is_binary_stream, HEADERS
        _NETDISK_FNS = (download_netdisk_file, is_binary_stream, HEADERS)
    return _NETDISK_FNS

try:
    import boto3
    from botocore.config import Config
except ImportError:
    print("Warning: 'boto3' library not found. R2 uploads will be skipped. Run 'pip install boto3'")
    boto3 = None

GAMES_PATH = "data/games.json"
SEQ_MAP_PATH = "database/seq_to_orig_map.json"
RECENT_CHANGES_PATH = "data/recent_changes.json"

GAMES_BUCKET = "fangame-files"
SCREENSHOTS_BUCKET = "fangame-screenshots"
PUBLIC_GAMES_DOMAIN = "https://file.fangame-archive.com"

# Direct uploads from the submit form stage under this prefix in GAMES_BUCKET
# (see functions/api/_lib/uploads.js — keep prefix/limits in sync). The merge
# below promotes them with server-side copies instead of downloading, then
# deletes the staged object once the submission row is marked merged.
UPLOAD_PREFIX = "SubmissionUploads/"
UPLOAD_URL_PREFIX = f"{PUBLIC_GAMES_DOMAIN}/{UPLOAD_PREFIX}"
MAX_UPLOAD_BYTES = 500 * 1024 * 1024
MAX_UPLOAD_SHOT_BYTES = 8 * 1024 * 1024
UPLOAD_ORPHAN_HOURS = 48


def staged_key_from_url(url):
    """The SubmissionUploads/... key behind one of our staging URLs, else None."""
    if not isinstance(url, str) or not url.startswith(UPLOAD_URL_PREFIX):
        return None
    return url[len(PUBLIC_GAMES_DOMAIN) + 1:].split("?")[0]


def get_r2_client():
    if not boto3:
        return None
    if not CLOUDFLARE_ACCOUNT_ID or not AWS_ACCESS_KEY_ID or not AWS_SECRET_ACCESS_KEY:
        print("[WARNING] Cloudflare R2 credentials are not set in config.py or environment variables. Uploads will be skipped.")
        return None
        
    endpoint_url = f"https://{CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
    return boto3.client(
        's3',
        endpoint_url=endpoint_url,
        aws_access_key_id=AWS_ACCESS_KEY_ID,
        aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
        config=Config(signature_version='s3v4')
    )

def sweep_staged_uploads(r2_client):
    """Housekeeping for the direct-upload staging area (anti wallet-attack).

    Deletes staged objects that are (a) oversize — a raw S3 PUT on a presigned
    URL can bypass the 500 MB check the API applies at upload-complete — or
    (b) older than UPLOAD_ORPHAN_HOURS with no undecided submission referencing
    them (abandoned uploads, leftovers from failed reject cleanups). Files
    referenced by a pending/approved-unmerged submission are kept indefinitely.
    Skips silently if the D1 reference query fails, so a transient wrangler
    error can never delete a referenced file.
    """
    if not r2_client:
        return

    objects = []
    token = None
    while True:
        kwargs = {"Bucket": GAMES_BUCKET, "Prefix": UPLOAD_PREFIX}
        if token:
            kwargs["ContinuationToken"] = token
        resp = r2_client.list_objects_v2(**kwargs)
        objects.extend(resp.get("Contents") or [])
        if not resp.get("IsTruncated"):
            break
        token = resp.get("NextContinuationToken")
    if not objects:
        return
    print(f"Staged-upload sweep: {len(objects)} object(s) under {UPLOAD_PREFIX}...")

    query = "SELECT external_url, screenshots FROM game_submissions WHERE merged_at IS NULL AND status != 'rejected'"
    cmd = f'npx -y wrangler d1 execute fangame-comments --remote --command "{query}" --json'
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True, encoding="utf-8")
    if result.returncode != 0:
        print("[WARNING] Staged-upload sweep skipped: D1 reference query failed.")
        return
    try:
        data = json.loads(result.stdout)
        rows = data[0].get("results", []) if isinstance(data, list) and data else []
    except Exception:
        print("[WARNING] Staged-upload sweep skipped: unparsable D1 output.")
        return

    referenced = set()
    for row in rows:
        k = staged_key_from_url(row.get("external_url") or "")
        if k:
            referenced.add(k)
        try:
            for u in json.loads(row.get("screenshots") or "[]"):
                k = staged_key_from_url(u)
                if k:
                    referenced.add(k)
        except Exception:
            pass

    now = time.time()
    removed = 0
    for obj in objects:
        key = obj.get("Key", "")
        size = obj.get("Size", 0) or 0
        lm = obj.get("LastModified")
        age_hours = (now - lm.timestamp()) / 3600 if lm else 0
        oversize = size > MAX_UPLOAD_BYTES
        orphaned = key not in referenced and age_hours > UPLOAD_ORPHAN_HOURS
        if not oversize and not orphaned:
            continue
        try:
            r2_client.delete_object(Bucket=GAMES_BUCKET, Key=key)
            removed += 1
            print(f"  Swept {key} ({'oversize' if oversize else 'orphaned'}, {size / (1024*1024):.1f} MB)")
        except Exception as e:
            print(f"  Warning: sweep failed to delete {key}: {e}")
    if removed:
        print(f"Staged-upload sweep removed {removed} object(s).")


def download_file(url, local_path):
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
    try:
        r = requests.get(url, headers=headers, stream=True, timeout=60)
        r.raise_for_status()
        with open(local_path, 'wb') as f:
            for chunk in r.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
        return True
    except Exception as e:
        print(f"  [ERROR] Failed to download from {url}: {e}")
        return False


# Hosts that serve a download *page*, not a direct file — route them through the
# scraper's resolvers so we fetch the actual binary, not the HTML wrapper.
NETDISK_HOSTS = (
    "mediafire.com", "dropbox.com", "drive.google.com", "docs.google.com",
    "mega.nz", "mega.co.nz",
)


def _download_direct(url, local_dir):
    """Stream a direct download link, rejecting HTML/JSON 'landing pages'.

    Returns (local_path, None) on success or (None, error). Unlike a naive GET,
    this refuses to save a web page as if it were the game archive.
    """
    try:
        _, is_binary_stream, headers = _netdisk_fns()
        with requests.get(url, headers=headers, stream=True, timeout=60, allow_redirects=True) as res:
            res.raise_for_status()
            if not is_binary_stream(res):
                return None, "URL returned a web page (HTML/JSON), not a downloadable file"
            filename = None
            cd = res.headers.get("Content-Disposition", "")
            if "filename=" in cd:
                m = re.search(r"filename\*?=(?:UTF-8'')?\"?([^\";]+)\"?", cd)
                if m:
                    filename = urllib.parse.unquote(m.group(1)).strip()
            if not filename:
                filename = os.path.basename(urllib.parse.urlparse(url).path)
            if not filename:
                filename = "game.zip"
            filename = re.sub(r'[\\/:*?"<>|]', '_', filename)
            local_path = os.path.join(local_dir, filename)
            with open(local_path, "wb") as f:
                for chunk in res.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        f.write(chunk)
        if os.path.getsize(local_path) == 0:
            os.remove(local_path)
            return None, "Downloaded file was empty"
        return local_path, None
    except Exception as e:
        return None, str(e)


def acquire_game_file(url, local_dir):
    """Resolve + download the real game binary. Returns (local_path, error).

    Known file hosts use the scraper's host-specific resolvers; anything else is
    treated as a direct link but still verified to be a binary, so we never
    mirror a 'bad link' landing page into R2.
    """
    url_lower = (url or "").lower()
    if any(h in url_lower for h in NETDISK_HOSTS):
        try:
            download_netdisk_file, _, _ = _netdisk_fns()
        except Exception as e:
            return None, f"host resolver unavailable: {e}"
        return download_netdisk_file(url, local_dir)
    return _download_direct(url, local_dir)

def main():
    print("==========================================================")
    print("      MERGING APPROVED GAME SUBMISSIONS TO CATALOG")
    print("==========================================================")

    # 1. Fetch approved and unmerged submissions from D1 database
    db_name = "fangame-comments"
    query = "SELECT id, title, author_name, external_url, tags, screenshots, description FROM game_submissions WHERE status = 'approved' AND merged_at IS NULL"
    
    cmd = f'npx -y wrangler d1 execute {db_name} --remote --command "{query}" --json'
    
    print("Fetching pending mergers from D1 remote...")
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True, encoding="utf-8")
    
    if result.returncode != 0:
        print("Error executing wrangler command:")
        print("STDOUT:")
        print(result.stdout)
        print("STDERR:")
        print(result.stderr)
        sys.exit(1)
        
    try:
        data = json.loads(result.stdout)
    except Exception as e:
        print("Failed to parse wrangler JSON output:")
        print(result.stdout)
        print(e)
        sys.exit(1)
        
    submissions = []
    if isinstance(data, list) and len(data) > 0:
        submissions = data[0].get("results", [])
        
    # Initialize R2 Client (the staging sweep below needs it even when there
    # is nothing to merge).
    r2_client = get_r2_client()

    # Staging-area housekeeping runs every cycle.
    try:
        sweep_staged_uploads(r2_client)
    except Exception as e:
        print(f"[WARNING] Staged-upload sweep failed: {e}")

    if not submissions:
        print("No approved submissions to merge.")
        return

    print(f"Found {len(submissions)} approved submissions to merge.")

    if not r2_client:
        print("[WARNING] Proceeding without R2 client. External links will be kept as-is.")

    # 2. Load games.json and seq_to_orig_map.json
    if not os.path.exists(GAMES_PATH):
        print(f"Error: games database not found at {GAMES_PATH}")
        sys.exit(1)
    if not os.path.exists(SEQ_MAP_PATH):
        print(f"Error: sequence map database not found at {SEQ_MAP_PATH}")
        sys.exit(1)
        
    with open(GAMES_PATH, "r", encoding="utf-8") as f:
        games = json.load(f)
        
    with open(SEQ_MAP_PATH, "r", encoding="utf-8") as f:
        seq_map = json.load(f)
        
    # Calculate next sequence ID
    max_id = max(int(k) for k in games.keys())
    
    # Load recent_changes.json
    if os.path.exists(RECENT_CHANGES_PATH):
        with open(RECENT_CHANGES_PATH, "r", encoding="utf-8") as f:
            recent_changes = json.load(f)
    else:
        recent_changes = {"version": 1, "timeline": {}}
        
    new_version = recent_changes.get("version", 0) + 1
    recent_changes["version"] = new_version
    
    version_timeline_entry = {
        "timestamp": int(time.time()),
        "updated": {}
    }
    
    merged_sub_ids = []
    now_epoch = int(time.time() * 1000) # Epoch milliseconds
    
    local_temp_dir = "temp_submissions"
    os.makedirs(local_temp_dir, exist_ok=True)
    
    for sub in submissions:
        max_id += 1
        new_id_str = str(max_id)
        
        sub_id = sub["id"]
        title = sub["title"]
        author = sub["author_name"]
        url = sub["external_url"]
        desc = sub.get("description")
        
        try:
            tags = json.loads(sub.get("tags") or "[]")
        except Exception:
            tags = []
            
        print(f"\nProcessing submission #{sub_id}: '{title}' by {author}...")
        
        game_download_url = url
        file_size = 0
        staged_keys = []  # staged uploads to delete once this sub is marked merged
        promoted_copies = []  # server-side copies made for this sub, undone on skip

        # A. Acquire the game file. A direct upload from the submit form already
        # sits in our bucket — promote it with a server-side copy instead of
        # downloading. Staged URLs never take the download path, and a failed
        # promote SKIPS the submission for this run (it stays approved-unmerged
        # and retries next cycle): publishing the staging URL instead would put
        # a dead link in the catalog the moment the sweep collects the object.
        staged_game_key = staged_key_from_url(url)
        if staged_game_key is not None:
            promoted = False
            if r2_client:
                try:
                    head = r2_client.head_object(Bucket=GAMES_BUCKET, Key=staged_game_key)
                    staged_size = head.get("ContentLength", 0) or 0
                    if 0 < staged_size <= MAX_UPLOAD_BYTES:
                        _, ext = os.path.splitext(staged_game_key)
                        ext = ext.lower()
                        if ext not in [".zip", ".rar", ".7z", ".exe", ".tar", ".gz"]:
                            ext = ".zip"  # Default fallback
                        r2_game_key = f"Game/{max_id}{ext}"
                        print(f"  Promoting staged upload {staged_game_key} -> {r2_game_key} ({staged_size / (1024*1024):.2f} MB, server-side copy)...")
                        r2_client.copy_object(
                            Bucket=GAMES_BUCKET, Key=r2_game_key,
                            CopySource={"Bucket": GAMES_BUCKET, "Key": staged_game_key},
                            MetadataDirective="REPLACE", ContentType="application/octet-stream",
                        )
                        game_download_url = f"{PUBLIC_GAMES_DOMAIN}/{r2_game_key}"
                        file_size = staged_size
                        staged_keys.append(staged_game_key)
                        promoted_copies.append((GAMES_BUCKET, r2_game_key))
                        promoted = True
                        print(f"  [SUCCESS] Promoted staged upload: {game_download_url}")
                    else:
                        print(f"  [WARNING] Staged upload is empty or oversize ({staged_size} bytes).")
                except Exception as e:
                    print(f"  [WARNING] Could not promote staged upload: {e}")
            else:
                print("  R2 client missing.")
            if not promoted:
                print(f"  [SKIP] Submission #{sub_id} left unmerged — its uploaded file couldn't be promoted this cycle; it will retry next run.")
                max_id -= 1  # id was never used; hand it to the next submission
                continue
        else:
            # Download (host-aware) and upload the game file to R2
            print(f"  Downloading game package from {url}...")
            local_game_path, dl_err = acquire_game_file(url, local_temp_dir)

            if local_game_path:
                real_size = os.path.getsize(local_game_path)
                _, ext = os.path.splitext(local_game_path)
                ext = ext.lower()
                if ext not in [".zip", ".rar", ".7z", ".exe", ".tar", ".gz"]:
                    ext = ".zip"  # Default fallback
                if r2_client:
                    r2_game_key = f"Game/{max_id}{ext}"
                    print(f"  Uploading game to R2 bucket '{GAMES_BUCKET}' key '{r2_game_key}' ({real_size / (1024*1024):.2f} MB)...")
                    try:
                        r2_client.upload_file(
                            local_game_path,
                            GAMES_BUCKET,
                            r2_game_key,
                            ExtraArgs={'ContentType': 'application/octet-stream'}
                        )
                        game_download_url = f"{PUBLIC_GAMES_DOMAIN}/{r2_game_key}"
                        file_size = real_size
                        print(f"  [SUCCESS] Uploaded game to R2: {game_download_url}")
                    except Exception as e:
                        print(f"  [ERROR] R2 game upload failed: {e}. Falling back to original URL.")
                else:
                    print("  R2 client missing. Falling back to original URL.")
            else:
                print(f"  [WARNING] Could not mirror game file ({dl_err}). Keeping the original submission URL as the download link.")
            
        # B. Download and Upload Screenshots to R2
        screenshots_list = []
        try:
            screenshots = json.loads(sub.get("screenshots") or "[]")
        except Exception:
            screenshots = []
            
        staged_shot_failed = False
        for idx, img_url in enumerate(screenshots):
            # A staged screenshot upload is promoted with a server-side copy
            # (cross-bucket) instead of a download; like the game file, staged
            # URLs never take the download path, and a failed promote skips the
            # whole submission for this run (unlike external screenshot links,
            # which die all the time and are skipped individually — a staged
            # object is known-good, so a failure here is transient).
            staged_shot_key = staged_key_from_url(img_url)
            if staged_shot_key is not None:
                if not r2_client:
                    staged_shot_failed = True
                    break
                _, s_ext = os.path.splitext(staged_shot_key)
                s_ext = s_ext.lower()
                if s_ext not in [".png", ".jpg", ".jpeg", ".gif", ".webp"]:
                    # Unreachable via the API (upload sniffs magic bytes); a
                    # hand-crafted URL just loses its slot.
                    print(f"  [WARNING] Staged screenshot {staged_shot_key} is not an image; skipped.")
                    continue
                try:
                    s_content_type = {
                        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                        ".gif": "image/gif", ".webp": "image/webp",
                    }[s_ext]
                    r2_img_key = f"ratings/screenshots/{max_id}_shot_{idx}{s_ext}"
                    print(f"  Promoting staged screenshot {idx+1}/{len(screenshots)} -> {r2_img_key} (server-side copy)...")
                    r2_client.copy_object(
                        Bucket=SCREENSHOTS_BUCKET, Key=r2_img_key,
                        CopySource={"Bucket": GAMES_BUCKET, "Key": staged_shot_key},
                        MetadataDirective="REPLACE", ContentType=s_content_type,
                    )
                    screenshots_list.append({
                        "id": idx,
                        "image_path": r2_img_key,
                        "by": author
                    })
                    staged_keys.append(staged_shot_key)
                    promoted_copies.append((SCREENSHOTS_BUCKET, r2_img_key))
                    print(f"  [SUCCESS] Promoted staged screenshot: {r2_img_key}")
                except Exception as e:
                    print(f"  [ERROR] Staged screenshot promote failed: {e}")
                    staged_shot_failed = True
                    break
                continue

            img_parsed = urllib.parse.urlparse(img_url)
            img_path_part = img_parsed.path.split('?')[0]
            _, img_ext = os.path.splitext(img_path_part)
            img_ext = img_ext.lower()
            if img_ext not in [".png", ".jpg", ".jpeg", ".gif", ".webp"]:
                img_ext = ".png" # Default fallback
                
            local_img_path = os.path.join(local_temp_dir, f"img_{sub_id}_{idx}{img_ext}")
            print(f"  Downloading screenshot {idx+1}/{len(screenshots)} from {img_url}...")
            img_download_success = download_file(img_url, local_img_path)
            
            if img_download_success:
                if r2_client:
                    r2_img_key = f"ratings/screenshots/{max_id}_shot_{idx}{img_ext}"
                    print(f"  Uploading screenshot to R2 bucket '{SCREENSHOTS_BUCKET}' key '{r2_img_key}'...")
                    try:
                        content_type = "image/png"
                        if img_ext in [".jpg", ".jpeg"]:
                            content_type = "image/jpeg"
                        elif img_ext == ".gif":
                            content_type = "image/gif"
                        elif img_ext == ".webp":
                            content_type = "image/webp"
                            
                        r2_client.upload_file(
                            local_img_path,
                            SCREENSHOTS_BUCKET,
                            r2_img_key,
                            ExtraArgs={'ContentType': content_type}
                        )
                        screenshots_list.append({
                            "id": idx,
                            "image_path": r2_img_key,
                            "by": author
                        })
                        print(f"  [SUCCESS] Uploaded screenshot: {r2_img_key}")
                    except Exception as e:
                        print(f"  [ERROR] R2 screenshot upload failed: {e}")
                else:
                    print("  R2 client missing. Screenshot skipped.")
            else:
                print("  Screenshot download failed. Skipping.")
                
        if staged_shot_failed:
            print(f"  [SKIP] Submission #{sub_id} left unmerged — a staged screenshot couldn't be promoted this cycle; it will retry next run.")
            # Undo this run's server-side copies so the retry starts clean.
            for b, k in promoted_copies:
                try:
                    r2_client.delete_object(Bucket=b, Key=k)
                except Exception:
                    pass
            max_id -= 1  # id was never used; hand it to the next submission
            continue

        # C. Construct Catalog Game Record
        new_game_obj = {
            "id": max_id,
            "title": title,
            "creator": {
                "name": author,
                "url": "#"
            },
            "avg_rating": None,
            "avg_difficulty": None,
            "download_url": game_download_url,
            "tags": tags,
            "screenshots": screenshots_list,
            "reviews": [],
            "rating_count": 0,
            "file_size": file_size
        }
        
        if desc:
            new_game_obj["desc"] = desc.strip()
            
        # Add to databases
        games[new_id_str] = new_game_obj
        seq_map[new_id_str] = [f"SUBMISSION-{sub_id}", "community_game", "tags_synced"]
        
        # Add to changes timeline
        version_timeline_entry["updated"][new_id_str] = new_game_obj
        
        merged_sub_ids.append((sub_id, max_id, staged_keys))
        print(f"-> Successfully Merged '{title}' -> assigned sequential ID {max_id}")
        
    # Clean up local temporary files
    print("\nCleaning up local temporary files...")
    for file in os.listdir(local_temp_dir):
        file_path = os.path.join(local_temp_dir, file)
        try:
            if os.path.isfile(file_path):
                os.unlink(file_path)
        except Exception as e:
            print(f"Failed to delete local temp file {file_path}: {e}")
    try:
        os.rmdir(local_temp_dir)
    except Exception:
        pass
        
    # Save databases
    with open(GAMES_PATH, "w", encoding="utf-8") as f:
        json.dump(games, f, indent=2, ensure_ascii=False)
        
    with open(SEQ_MAP_PATH, "w", encoding="utf-8") as f:
        json.dump(seq_map, f, indent=2, ensure_ascii=False)
        
    recent_changes["timeline"][str(new_version)] = version_timeline_entry
    with open(RECENT_CHANGES_PATH, "w", encoding="utf-8") as f:
        json.dump(recent_changes, f, indent=2, ensure_ascii=False)
        
    print("Local database files saved successfully.")
    
    # 3. Update database rows in D1 remote database
    print("Updating D1 remote database rows to 'merged'...")
    for sub_id, seq_id, sub_staged_keys in merged_sub_ids:
        update_query = f"UPDATE game_submissions SET merged_at = {now_epoch}, assigned_game_id = {seq_id} WHERE id = {sub_id}"
        update_cmd = f'npx -y wrangler d1 execute {db_name} --remote --command "{update_query}"'

        res = subprocess.run(update_cmd, shell=True, capture_output=True, text=True, encoding="utf-8")
        if res.returncode != 0:
            print(f"Warning: Failed to update submission {sub_id} in D1 remote:")
            print("STDOUT:")
            print(res.stdout)
            print("STDERR:")
            print(res.stderr)
        else:
            print(f"  Submission {sub_id} marked as merged in D1.")
            # Only now is the staged copy redundant — deleting before the row
            # is marked merged would break a retry of this same submission.
            for k in sub_staged_keys:
                try:
                    r2_client.delete_object(Bucket=GAMES_BUCKET, Key=k)
                    print(f"  Deleted staged upload {k}")
                except Exception as e:
                    print(f"  Warning: failed to delete staged upload {k}: {e} (the sweep will retry)")
            
    print("All mergers finished successfully!")

if __name__ == "__main__":
    main()
