import os
import sys
import boto3
from botocore.config import Config

# Ensure config path resolved correctly
try:
    from config import CLOUDFLARE_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
except ImportError:
    sys.path.append(os.path.dirname(os.path.abspath(__file__)))
    from config import CLOUDFLARE_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY

BUCKET_NAME = "fangame-files"
DB_FILES = {
    # The engine state must upload BEFORE games.json: if its PUT fails while
    # games.json succeeds, the stale state merely causes a redundant (idempotent)
    # re-recognition later; the reverse order could persist "success" entries for
    # engine labels that never reached the R2 games.json, losing them forever.
    "data/engine_recognition_state.json": "Database/engine_recognition_state.json",
    "data/games.json": "Database/games.json",
    "data/recent_changes.json": "Database/recent_changes.json",
    "data/profiles.json": "Database/profiles.json",
    "database/seq_to_orig_map.json": "Database/seq_to_orig_map.json",
    "temp/reviews_scraped.json": "Database/reviews_scraped.json"
}

def get_r2_client():
    if not CLOUDFLARE_ACCOUNT_ID or not AWS_ACCESS_KEY_ID or not AWS_SECRET_ACCESS_KEY:
        print("[ERROR] Cloudflare R2 credentials are not set in environment variables or .env!")
        sys.exit(1)
        
    endpoint_url = f"https://{CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
    return boto3.client(
        's3',
        endpoint_url=endpoint_url,
        aws_access_key_id=AWS_ACCESS_KEY_ID,
        aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
        config=Config(signature_version='s3v4')
    )

def download_databases(r2_client):
    print("Downloading databases from Cloudflare R2...")
    for local_path, r2_key in DB_FILES.items():
        os.makedirs(os.path.dirname(local_path), exist_ok=True)
        print(f"  Downloading '{r2_key}' -> '{local_path}'...")
        try:
            r2_client.download_file(BUCKET_NAME, r2_key, local_path)
            print(f"  [SUCCESS] Downloaded {os.path.basename(local_path)}")
        except Exception as e:
            # For recent_changes.json, profiles.json or mapping files, if they don't exist on R2 yet, we can skip or write defaults
            print(f"  [WARNING/ERROR] Failed to download {os.path.basename(local_path)}: {e}")
            if os.path.basename(local_path) == "games.json":
                print("[FATAL] Could not download games.json. Sync aborted.")
                sys.exit(1)

def upload_databases(r2_client):
    print("Uploading databases to Cloudflare R2...")
    
    for local_path, r2_key in DB_FILES.items():
        if not os.path.exists(local_path):
            print(f"  [SKIP] Local file '{local_path}' does not exist.")
            continue
            
        print(f"  Uploading '{local_path}' -> '{r2_key}'...")
        try:
            r2_client.upload_file(
                local_path,
                BUCKET_NAME,
                r2_key,
                ExtraArgs={
                    'ContentType': 'application/json',
                    'CacheControl': 'no-cache, no-store, must-revalidate'
                }
            )
            print(f"  [SUCCESS] Uploaded {os.path.basename(local_path)}")
        except Exception as e:
            print(f"  [ERROR] Failed to upload {os.path.basename(local_path)}: {e}")

def main():
    if len(sys.argv) < 2 or sys.argv[1].lower() not in ["download", "upload"]:
        print("Usage: python sync_db_r2.py [download|upload]")
        sys.exit(1)
        
    action = sys.argv[1].lower()
    r2_client = get_r2_client()
    
    if action == "download":
        download_databases(r2_client)
    elif action == "upload":
        upload_databases(r2_client)

if __name__ == "__main__":
    main()
