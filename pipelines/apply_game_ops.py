# Apply admin-queued game operations (delete / clear_link / replace_link) from
# the D1 `game_ops` table into the catalog (data/games.json) and R2, then mark
# each row applied/failed. Runs in the 6-hourly CI right after the approved-
# submission merge and before the scrape.
#
# Reuses the existing, proven building blocks:
#   * apply_duplicate_resolution.py — R2 key mapping + batched deletes + the
#     delete/clear_link catalog semantics and version-delta convention.
#   * merge_approved_submissions.py — acquire_game_file() (host-aware, HTML-safe
#     downloader) + the R2 client + bucket/domain constants (replace_link).
#
# Auth: needs CLOUDFLARE_API_TOKEN (D1 edit) + CLOUDFLARE_ACCOUNT_ID + R2 keys.

import os
import sys
import json
import time
import subprocess

sys.stdout.reconfigure(encoding="utf-8")
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from apply_duplicate_resolution import (
    r2_game_key, _r2_batch_delete, GAMES, CHANGES, FILES_BUCKET, SHOTS_BUCKET,
)
from merge_approved_submissions import (
    acquire_game_file, get_r2_client, GAMES_BUCKET, PUBLIC_GAMES_DOMAIN,
)

DB_NAME = "fangame-comments"
TEMP_DIR = "temp_game_ops"
GAME_EXTS = [".zip", ".rar", ".7z", ".exe", ".tar", ".gz"]


def _run(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, encoding="utf-8")


def ensure_table():
    """Create the queue table if it doesn't exist yet (idempotent), so this step
    never fails on a missing table before the admin has been used."""
    ddl = (
        "CREATE TABLE IF NOT EXISTS game_ops ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL, game_id INTEGER NOT NULL, "
        "new_url TEXT, status TEXT NOT NULL DEFAULT 'pending', requested_by TEXT, reason TEXT, "
        "result TEXT, created_at INTEGER NOT NULL, applied_at INTEGER); "
        "CREATE INDEX IF NOT EXISTS idx_game_ops_status ON game_ops(status);"
    )
    cmd = f'npx -y wrangler d1 execute {DB_NAME} --remote --command "{ddl}"'
    res = _run(cmd)
    if res.returncode != 0:
        print("Error ensuring game_ops table exists:")
        print(res.stdout)
        print(res.stderr)
        sys.exit(1)


def fetch_pending_ops():
    query = ("SELECT id, op, game_id, new_url FROM game_ops "
             "WHERE status = 'pending' ORDER BY id ASC")
    cmd = f'npx -y wrangler d1 execute {DB_NAME} --remote --command "{query}" --json'
    res = _run(cmd)
    if res.returncode != 0:
        print("Error querying game_ops from D1:")
        print(res.stdout)
        print(res.stderr)
        sys.exit(1)
    try:
        data = json.loads(res.stdout)
    except Exception as e:
        print("Failed to parse wrangler JSON output:")
        print(res.stdout)
        print(e)
        sys.exit(1)
    if isinstance(data, list) and data:
        return data[0].get("results", [])
    return []


def sql_escape(s):
    return str(s).replace("'", "''")


def mark_op(op_id, status, note):
    note = sql_escape(note)[:300]
    q = (f"UPDATE game_ops SET status='{status}', applied_at={int(time.time()*1000)}, "
         f"result='{note}' WHERE id={int(op_id)}")
    cmd = f'npx -y wrangler d1 execute {DB_NAME} --remote --command "{q}"'
    res = _run(cmd)
    if res.returncode != 0:
        print(f"  [WARN] Failed to mark op {op_id} as {status}: {res.stderr.strip()}")
    else:
        print(f"  Op {op_id} -> {status} ({note})")


def main():
    print("==========================================================")
    print("        APPLYING ADMIN GAME OPERATIONS TO CATALOG")
    print("==========================================================")

    ensure_table()
    ops = fetch_pending_ops()
    if not ops:
        print("No pending game operations.")
        return
    print(f"Found {len(ops)} pending game operation(s).")

    if not os.path.exists(GAMES) or not os.path.exists(CHANGES):
        print(f"Error: catalog files not found ({GAMES} / {CHANGES}).")
        sys.exit(1)

    games = json.load(open(GAMES, encoding="utf-8"))
    changes = json.load(open(CHANGES, encoding="utf-8"))
    r2 = get_r2_client()
    if not r2:
        print("[WARNING] No R2 client; replace_link mirroring and R2 deletes will be skipped.")

    updated = {}        # gid -> game obj (clear_link / replace_link)
    deleted = []        # gid (delete)
    file_keys = []      # (bucket, key) R2 game files to delete
    shot_keys = []      # (bucket, key) R2 screenshots to delete
    outcomes = []       # (op_id, status, note)

    os.makedirs(TEMP_DIR, exist_ok=True)

    for op in ops:
        op_id = op["id"]
        kind = op["op"]
        gid = str(op["game_id"])
        new_url = (op.get("new_url") or "").strip()

        print(f"\nOp #{op_id}: {kind} game {gid}" + (f" -> {new_url}" if new_url else ""))
        entry = games.get(gid)
        if not entry:
            outcomes.append((op_id, "failed", f"game {gid} not in catalog"))
            continue

        if kind == "delete":
            k = r2_game_key(entry.get("download_url"))
            if k:
                file_keys.append((FILES_BUCKET, k))
            for s in entry.get("screenshots", []):
                p = s.get("image_path")
                if p:
                    shot_keys.append((SHOTS_BUCKET, p.lstrip("/")))
            del games[gid]
            deleted.append(gid)
            outcomes.append((op_id, "applied", "removed from catalog"))

        elif kind == "clear_link":
            k = r2_game_key(entry.get("download_url"))
            if k:
                file_keys.append((FILES_BUCKET, k))
            entry["download_url"] = None
            entry["file_size"] = 0
            updated[gid] = entry
            outcomes.append((op_id, "applied", "download link cleared"))

        elif kind == "replace_link":
            if not new_url:
                outcomes.append((op_id, "failed", "replace_link missing new_url"))
                continue
            # Remove the old R2-hosted file (if ours); external links left alone.
            old_k = r2_game_key(entry.get("download_url"))
            if old_k:
                file_keys.append((FILES_BUCKET, old_k))
            local_path, err = acquire_game_file(new_url, TEMP_DIR)
            if local_path and r2:
                size = os.path.getsize(local_path)
                _, ext = os.path.splitext(local_path)
                ext = ext.lower()
                if ext not in GAME_EXTS:
                    ext = ".zip"
                key = f"Game/{gid}{ext}"
                try:
                    r2.upload_file(local_path, GAMES_BUCKET, key,
                                   ExtraArgs={"ContentType": "application/octet-stream"})
                    entry["download_url"] = f"{PUBLIC_GAMES_DOMAIN}/{key}"
                    entry["file_size"] = size
                    outcomes.append((op_id, "applied", f"mirrored new file to R2 ({size} bytes)"))
                except Exception as ex:
                    entry["download_url"] = new_url
                    entry["file_size"] = 0
                    outcomes.append((op_id, "applied", f"R2 upload failed, set external URL: {ex}"))
            else:
                # Couldn't mirror (bad/HTML link or no R2) — point at the URL directly.
                entry["download_url"] = new_url
                entry["file_size"] = 0
                outcomes.append((op_id, "applied", f"could not mirror ({err or 'no R2 client'}); set external URL"))
            updated[gid] = entry

        else:
            outcomes.append((op_id, "failed", f"unknown op '{kind}'"))

    # Clean up downloaded temp files
    try:
        for fn in os.listdir(TEMP_DIR):
            try:
                os.unlink(os.path.join(TEMP_DIR, fn))
            except Exception:
                pass
        os.rmdir(TEMP_DIR)
    except Exception:
        pass

    # Persist catalog changes with a proper version delta so cached/incremental
    # clients sync the removals/changes (same convention as the other tools).
    if updated or deleted:
        new_version = int(changes.get("version", 0)) + 1
        changes["version"] = new_version
        changes.setdefault("timeline", {})[str(new_version)] = {
            "timestamp": int(time.time()),
            "updated": updated,
            "deleted": deleted,
        }
        for path, data in ((GAMES, games), (CHANGES, changes)):
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(tmp, path)
        print(f"\nCatalog updated: {len(deleted)} deleted, {len(updated)} changed. "
              f"Version -> {new_version}.")

        if (file_keys or shot_keys) and r2:
            n = _r2_batch_delete(file_keys + shot_keys)
            print(f"Deleted {n} object(s) from R2.")
        elif file_keys or shot_keys:
            print("[WARNING] R2 client missing; skipped deleting "
                  f"{len(file_keys) + len(shot_keys)} object(s).")
    else:
        print("\nNo catalog changes to write.")

    # Mark every op's outcome back in D1.
    print("\nUpdating game_ops rows in D1...")
    for op_id, status, note in outcomes:
        mark_op(op_id, status, note)

    print("\nDone applying game operations.")


if __name__ == "__main__":
    main()
