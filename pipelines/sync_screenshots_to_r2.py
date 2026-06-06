import os
import urllib.request
import re
import time
import sys
import json
from concurrent.futures import ThreadPoolExecutor

try:
    import boto3
    from botocore.config import Config
except ImportError:
    print("Error: 'boto3' library not found! Please run 'pip install boto3' in your terminal first.")
    sys.exit(1)

sys.stdout.reconfigure(encoding='utf-8')

# ── ⚙️ CONFIGURATION ────────────────────────────────────────────────────────
# Load R2 credentials dynamically from config.py
try:
    from config import CLOUDFLARE_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
except ImportError:
    sys.path.append(os.path.dirname(os.path.abspath(__file__)))
    from config import CLOUDFLARE_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
BUCKET_NAME = "fangame-screenshots"

INDEX_URL = "https://delicious-fruit.com/ratings/screenshots/"
LOCAL_DIR = r"ratings\screenshots"

def download_and_upload_single(filename, r2_client, headers):
    url = INDEX_URL + filename
    local_path = os.path.join(LOCAL_DIR, filename)
    r2_key = f"ratings/screenshots/{filename}"
    
    # 1. Download screenshot file
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=10) as response:
            with open(local_path, "wb") as f:
                f.write(response.read())
    except Exception as e:
        return filename, False, f"Download failed: {e}"
        
    # 2. Upload to Cloudflare R2
    try:
        r2_client.upload_file(
            local_path,
            BUCKET_NAME,
            r2_key,
            ExtraArgs={'ContentType': 'image/png'}
        )
        # Clean up local file after upload to keep workspace clean
        if os.path.exists(local_path):
            os.remove(local_path)
        return filename, True, None
    except Exception as e:
        # Clean up local file even if upload fails
        if os.path.exists(local_path):
            os.remove(local_path)
        return filename, False, f"R2 upload failed: {e}"

def main():
    print("==============================================")
    print("    STARTING INCREMENTAL SCREENSHOT SYNC")
    print("==============================================")
    print(f"Index source: {INDEX_URL}")
    print(f"R2 target bucket: {BUCKET_NAME}")
    print(f"Local storage path: {os.path.abspath(LOCAL_DIR)}")
    print()
    
    # Ensure local directory exists
    os.makedirs(LOCAL_DIR, exist_ok=True)
    
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
    
    start_time = time.time()
    
    # 1. Initialize S3 client for Cloudflare R2
    print("Initializing Cloudflare R2 Client...")
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
        print(f"  [ERROR] Failed to initialize R2 client: {e}")
        sys.exit(1)

    # 2. Scan remote R2 bucket screenshots
    print("Scanning Cloudflare R2 bucket for existing screenshots...")
    r2_files = set()
    try:
        paginator = r2_client.get_paginator('list_objects_v2')
        pages = paginator.paginate(Bucket=BUCKET_NAME, Prefix="ratings/screenshots/")
        for page in pages:
            for obj in page.get('Contents', []):
                key = obj['Key']
                r2_files.add(os.path.basename(key))
        print(f"  Cloudflare R2 bucket contains: {len(r2_files)} screenshots.")
    except Exception as e:
        print(f"  [WARNING] Failed to list R2 objects: {e}. Falling back to empty set.")
    
    # 3. Database-Direct scan
    print("Reading games.json to cross-reference defined screenshot assets...")
    games_path = "data/games.json"
    if not os.path.exists(games_path):
        print("  [ERROR] Database games.json not found! Cannot proceed.")
        sys.exit(1)
        
    with open(games_path, "r", encoding="utf-8") as f:
        games = json.load(f)
        
    referenced_shots = []
    for gid, g in games.items():
        for shot in g.get("screenshots", []):
            path = shot.get("image_path")
            if path:
                referenced_shots.append(os.path.basename(path))
                
    # Filter uniquely defined screenshots that don't exist in R2
    unique_referenced = set(referenced_shots)
    missing_files = sorted(list(unique_referenced - r2_files))
    print(f"  Database contains {len(unique_referenced)} uniquely referenced screenshots.")
    print(f"  Delta verification completed. Missing in R2: {len(missing_files)} screenshots.")
    
    if not missing_files:
        print("\nAll remote screenshots are fully synchronized. No action needed.")
        sys.exit(0)
        
    # 4. Execute multi-threaded incremental download & upload
    max_workers = 10
    print(f"\nStarting concurrent ingestion pool ({max_workers} active threads)...")
    
    success_count = 0
    failure_count = 0
    
    def process_task(filename):
        return download_and_upload_single(filename, r2_client, headers)
        
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        results = executor.map(process_task, missing_files)
        
        for idx, (filename, success, err) in enumerate(results):
            if success:
                success_count += 1
                print(f"  [{idx+1}/{len(missing_files)}] Sync complete: {filename}")
            else:
                failure_count += 1
                print(f"  [{idx+1}/{len(missing_files)}] [FAILED] {filename}: {err}")
                
    print()
    print("==============================================")
    print("         SCREENSHOT SYNC COMPLETED")
    print("==============================================")
    print(f"Total processed: {len(missing_files)}")
    print(f"Successfully synced: {success_count}")
    print(f"Failed items: {failure_count}")
    print(f"Elapsed time: {time.time() - start_time:.1f} seconds.")
    print("==============================================")

if __name__ == '__main__':
    main()
