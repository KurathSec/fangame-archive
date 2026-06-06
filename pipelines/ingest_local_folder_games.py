import os
import sys
import json
import time
import shutil
import re

try:
    import boto3
    from botocore.config import Config
except ImportError:
    print("Error: 'boto3' library not found. Please install it to proceed.")
    sys.exit(1)

# Load R2 credentials dynamically from config.py
try:
    from config import CLOUDFLARE_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
except ImportError:
    sys.path.append(os.path.dirname(os.path.abspath(__file__)))
    from config import CLOUDFLARE_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY

BUCKET_NAME = "fangame-files"
PUBLIC_DOMAIN = "https://file.fangame-archive.com"

GAMES_JSON_PATH = r"data\games.json"
RECENT_CHANGES_PATH = r"data\recent_changes.json"
LOCAL_GAME_DIR = r"game"

def normalize_str(s):
    if not s:
        return ""
    s = s.lower().strip()
    s = re.sub(r'\s+', ' ', s)
    return s

def main():
    print("==============================================")
    print("      LOCAL FANGAME INGESTION SWEEP")
    print("==============================================")
    
    if not os.path.exists(LOCAL_GAME_DIR):
        print(f"Directory '{LOCAL_GAME_DIR}' not found. Creating it.")
        os.makedirs(LOCAL_GAME_DIR, exist_ok=True)
        return
        
    # Read files in game folder
    files = [f for f in os.listdir(LOCAL_GAME_DIR) if os.path.isfile(os.path.join(LOCAL_GAME_DIR, f))]
    # Ignore hidden system files
    files = [f for f in files if not f.startswith('.') and f.lower() != "desktop.ini"]
    
    if not files:
        print("No local games found in 'game/' directory. Skipping sweep.")
        return
        
    print(f"Found {len(files)} files to check and ingest.")
    
    if not os.path.exists(GAMES_JSON_PATH):
        print("Database games.json not found.")
        return
        
    with open(GAMES_JSON_PATH, "r", encoding="utf-8") as f:
        games = json.load(f)
        
    # Normalize titles of existing games
    existing_titles = {}
    for seq_id, g in games.items():
        title_norm = normalize_str(g.get("title", ""))
        if title_norm:
            existing_titles[title_norm] = seq_id
            
    # Initialize R2 Client
    try:
        endpoint_url = f"https://{CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
        r2_client = boto3.client(
            's3',
            endpoint_url=endpoint_url,
            aws_access_key_id=AWS_ACCESS_KEY_ID,
            aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
            config=Config(signature_version='s3v4')
        )
    except Exception as e:
        print(f"Error initializing R2 client: {e}")
        return
        
    updated_records = {}
    ingested_count = 0
    updated_count = 0
    
    for filename in files:
        file_path = os.path.join(LOCAL_GAME_DIR, filename)
        title, ext = os.path.splitext(filename)
        title_clean = title.strip()
        title_norm = normalize_str(title_clean)
        
        file_size = os.path.getsize(file_path)
        
        if not ext:
            ext = ".zip" # Default fallback
            
        print(f"\nProcessing: '{title_clean}' ({file_size / (1024*1024):.2f} MB)")
        
        target_seq_id = None
        is_new = False
        
        # Check if the filename matches the special format id[digits].ext
        id_match = re.match(r"^id(\d+)$", title_clean, re.IGNORECASE)
        if id_match:
            target_seq_id = id_match.group(1)
            is_new = target_seq_id not in games
            print(f"  Matched special pattern for ID: {target_seq_id}.")
        else:
            # Check if game exists by title
            if title_norm in existing_titles:
                target_seq_id = existing_titles[title_norm]
                existing_game = games[target_seq_id]
                existing_size = existing_game.get("file_size")
                if existing_size is not None and existing_size == file_size:
                    print(f"  Game already exists in database with ID: {target_seq_id} and matches the local file size ({file_size} bytes). Skipping upload and database update.")
                    # Delete local file safely
                    try:
                        os.remove(file_path)
                        print(f"  Successfully deleted local file: {file_path}.")
                    except Exception as del_err:
                        print(f"  Warning: Failed to delete local file: {del_err}.")
                    continue
                print(f"  Game already exists in database with ID: {target_seq_id}.")
                print("  Overwriting direct link and updating file size.")
                is_new = False
            else:
                # Assign new ID
                new_id = max(int(k) for k in games.keys()) + 1
                target_seq_id = str(new_id)
                print(f"  Game not found in database. Assigning new ID: {target_seq_id}.")
                is_new = True
            
        # Target key in bucket
        r2_filename = f"{target_seq_id}{ext.lower()}"
        r2_key = f"Game/{r2_filename}"
        download_url = f"{PUBLIC_DOMAIN}/{r2_key}"
        
        # Delete old file from R2 if it exists and is different from the new key
        if not is_new:
            existing_game = games[target_seq_id]
            old_url = existing_game.get("download_url", "")
            if old_url and old_url.startswith(PUBLIC_DOMAIN):
                old_key = old_url[len(PUBLIC_DOMAIN):].lstrip("/")
                if old_key != r2_key:
                    try:
                        print(f"  Deleting old file from R2: '{old_key}'...")
                        r2_client.delete_object(Bucket=BUCKET_NAME, Key=old_key)
                        print("  Old file successfully deleted from R2.")
                    except Exception as del_err:
                        print(f"  Warning: Failed to delete old file from R2: {del_err}.")
        
        print(f"  Uploading to Cloudflare R2 bucket '{BUCKET_NAME}' key '{r2_key}'...")
        try:
            r2_client.upload_file(
                file_path,
                BUCKET_NAME,
                r2_key,
                ExtraArgs={'ContentType': 'application/octet-stream'}
            )
            print(f"  Upload successful. Direct URL: {download_url}")
            
            # Update memory database
            if is_new:
                new_game = {
                    "id": int(target_seq_id),
                    "title": title_clean,
                    "creator": {"name": "Unknown", "url": "#"},
                    "avg_rating": 0.0,
                    "avg_difficulty": 0.0,
                    "download_url": download_url,
                    "tags": ["archive"],
                    "screenshots": [],
                    "reviews": [],
                    "rating_count": 0,
                    "file_size": file_size
                }
                games[target_seq_id] = new_game
                updated_records[target_seq_id] = new_game
                ingested_count += 1
            else:
                existing_game = games[target_seq_id]
                existing_game["download_url"] = download_url
                existing_game["file_size"] = file_size
                updated_records[target_seq_id] = existing_game
                updated_count += 1
                
            # Delete local file safely
            try:
                os.remove(file_path)
                print(f"  Successfully deleted local file: {file_path}")
            except Exception as del_err:
                print(f"  Warning: Failed to delete local file: {del_err}")
                
        except Exception as e:
            print(f"  [ERROR] Processing failed: {e}")
            
    if ingested_count > 0 or updated_count > 0:
        # Save updated database
        tmp_games_path = GAMES_JSON_PATH + ".tmp"
        with open(tmp_games_path, "w", encoding="utf-8") as f_tmp:
            json.dump(games, f_tmp, indent=2, ensure_ascii=False)
        os.replace(tmp_games_path, GAMES_JSON_PATH)
        print("\nSuccessfully updated games.json database.")
        
        # Save incremental timeline delta to recent_changes.json
        print("Generating timeline delta and incrementing version...")
        recent_changes = {}
        if os.path.exists(RECENT_CHANGES_PATH):
            try:
                with open(RECENT_CHANGES_PATH, "r", encoding="utf-8") as f_rc:
                    recent_changes = json.load(f_rc)
            except Exception as e:
                print(f"Warning: Failed to load recent_changes: {e}")
                
        if not recent_changes or "version" not in recent_changes:
            recent_changes = {
                "version": 1,
                "timeline": {}
            }
            
        new_version = recent_changes.get("version", 1) + 1
        recent_changes["version"] = new_version
        
        if "timeline" not in recent_changes:
            recent_changes["timeline"] = {}
            
        recent_changes["timeline"][str(new_version)] = {
            "timestamp": int(time.time()),
            "updated": updated_records,
            "deleted": []
        }
        
        timeline_keys = sorted(recent_changes["timeline"].keys(), key=int)
        if len(timeline_keys) > 30:
            for k in timeline_keys[:-30]:
                del recent_changes["timeline"][k]
                
        tmp_recent_path = RECENT_CHANGES_PATH + ".tmp"
        with open(tmp_recent_path, "w", encoding="utf-8") as f_tmp:
            json.dump(recent_changes, f_tmp, indent=2, ensure_ascii=False)
        os.replace(tmp_recent_path, RECENT_CHANGES_PATH)
        print(f"Incremented database version to: {new_version} and updated recent_changes.json.")
        
        # Trigger rebuild of static assets
        print("Rebuilding static build database files...")
        import subprocess
        subprocess.run([sys.executable, "pipelines/build_github_pages.py"])
    else:
        print("\nNo database updates occurred during this sweep.")

if __name__ == '__main__':
    main()
