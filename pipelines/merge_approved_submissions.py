import os
import sys
import json
import time
import subprocess

GAMES_PATH = "data/games.json"
SEQ_MAP_PATH = "database/seq_to_orig_map.json"
RECENT_CHANGES_PATH = "data/recent_changes.json"

def main():
    print("==========================================================")
    print("      MERGING APPROVED GAME SUBMISSIONS TO CATALOG")
    print("==========================================================")

    # 1. Fetch approved and unmerged submissions from D1 database
    db_name = "fangame-comments"
    query = "SELECT id, title, author_name, external_url, tags, description FROM game_submissions WHERE status = 'approved' AND merged_at IS NULL"
    
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
            
        new_game_obj = {
            "id": max_id,
            "title": title,
            "creator": {
                "name": author,
                "url": "#"
            },
            "avg_rating": None,
            "avg_difficulty": None,
            "download_url": url,
            "tags": tags,
            "screenshots": [],
            "reviews": [],
            "rating_count": 0,
            "file_size": 0
        }
        
        if desc:
            new_game_obj["desc"] = desc.strip()
            
        # Add to databases
        games[new_id_str] = new_game_obj
        seq_map[new_id_str] = [f"SUBMISSION-{sub_id}", "community_game", "tags_synced"]
        
        # Add to changes timeline
        version_timeline_entry["updated"][new_id_str] = new_game_obj
        
        merged_sub_ids.append((sub_id, max_id))
        print(f"  Merged '{title}' by {author} -> assigned sequential ID {max_id}")
        
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
