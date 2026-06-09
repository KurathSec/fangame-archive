import os
import sys
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

def main():
    print("==========================================================")
    print("      MERGING APPROVED GAME SUBMISSIONS TO CATALOG")
    print("==========================================================")

    # 1. Fetch approved and unmerged submissions from D1 database
    db_name = "fangame-comments"
    query = "SELECT id, title, author_name, external_url, tags, screenshots, description FROM game_submissions WHERE status = 'approved' AND merged_at IS NULL"
    
    cmd = f'npx wrangler d1 execute {db_name} --remote --command "{query}" --json'
    
    print("Fetching pending mergers from D1 remote...")
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True, encoding="utf-8")
    
    if result.returncode != 0:
        print("Error executing wrangler command:")
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
        
    if not submissions:
        print("No approved submissions to merge.")
        return
        
    print(f"Found {len(submissions)} approved submissions to merge.")
    
    # Initialize R2 Client
    r2_client = get_r2_client()
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
        
        # A. Download and Upload Game File to R2
        parsed_url = urllib.parse.urlparse(url)
        path_part = parsed_url.path.split('?')[0]
        _, ext = os.path.splitext(path_part)
        ext = ext.lower()
        if ext not in [".zip", ".rar", ".7z", ".exe", ".tar", ".gz"]:
            ext = ".zip" # Default fallback
            
        local_game_path = os.path.join(local_temp_dir, f"game_{sub_id}{ext}")
        print(f"  Downloading game package from {url}...")
        download_success = download_file(url, local_game_path)
        
        game_download_url = url
        file_size = 0
        
        if download_success:
            file_size = os.path.getsize(local_game_path)
            if r2_client:
                r2_game_key = f"Game/{max_id}{ext}"
                print(f"  Uploading game to R2 bucket '{GAMES_BUCKET}' key '{r2_game_key}' ({file_size / (1024*1024):.2f} MB)...")
                try:
                    r2_client.upload_file(
                        local_game_path,
                        GAMES_BUCKET,
                        r2_game_key,
                        ExtraArgs={'ContentType': 'application/octet-stream'}
                    )
                    game_download_url = f"{PUBLIC_GAMES_DOMAIN}/{r2_game_key}"
                    print(f"  [SUCCESS] Uploaded game to R2: {game_download_url}")
                except Exception as e:
                    print(f"  [ERROR] R2 game upload failed: {e}. Falling back to original URL.")
            else:
                print("  R2 client missing. Falling back to original URL.")
        else:
            print("  [WARNING] Game download failed. Falling back to original URL.")
            
        # B. Download and Upload Screenshots to R2
        screenshots_list = []
        try:
            screenshots = json.loads(sub.get("screenshots") or "[]")
        except Exception:
            screenshots = []
            
        for idx, img_url in enumerate(screenshots):
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
        
        merged_sub_ids.append((sub_id, max_id))
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
    for sub_id, seq_id in merged_sub_ids:
        update_query = f"UPDATE game_submissions SET merged_at = {now_epoch}, assigned_game_id = {seq_id} WHERE id = {sub_id}"
        update_cmd = f'npx wrangler d1 execute {db_name} --remote --command "{update_query}"'
        
        res = subprocess.run(update_cmd, shell=True, capture_output=True, text=True, encoding="utf-8")
        if res.returncode != 0:
            print(f"Warning: Failed to update submission {sub_id} in D1 remote:")
            print(res.stderr)
        else:
            print(f"  Submission {sub_id} marked as merged in D1.")
            
    print("All mergers finished successfully!")

if __name__ == "__main__":
    main()
