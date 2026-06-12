# Apply a duplicate-resolution report to the catalog and R2.
#
# Report shape (JSON): { "keep": [...], "delete": [...], "clear_link": [...] }
#   keep        -> no change
#   delete      -> remove the game from games.json + delete its R2 game file and screenshots
#   clear_link  -> remove the download link from games.json + delete its R2 game file (game stays)
#
# Safety model:
#   * Dry-run by default: prints a summary and writes an R2 deletion manifest. No changes.
#   * --apply       : backs up and rewrites data/games.json and data/recent_changes.json.
#   * --delete-r2   : actually deletes the listed objects from R2 (IRREVERSIBLE). Requires --apply.
#
# Usage:
#   py pipelines/apply_duplicate_resolution.py REPORT.json                 # dry-run
#   py pipelines/apply_duplicate_resolution.py REPORT.json --apply         # edit JSON only
#   py pipelines/apply_duplicate_resolution.py REPORT.json --apply --delete-r2   # + delete R2 objects

import json
import os
import sys
import time
from urllib.parse import urlparse

sys.stdout.reconfigure(encoding="utf-8")
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

GAMES = "data/games.json"
CHANGES = "data/recent_changes.json"
MANIFEST = "temp/r2_delete_manifest.json"
FILES_BUCKET = "fangame-files"
SHOTS_BUCKET = "fangame-screenshots"
OUR_HOSTS = ("fangame-archive.com", "r2.dev")


def r2_game_key(download_url):
    """Map a download_url hosted on our R2 to its object key, else None."""
    if not download_url:
        return None
    host = urlparse(download_url).netloc
    if not any(h in host for h in OUR_HOSTS):
        return None  # external link — nothing of ours to delete
    return urlparse(download_url).path.lstrip("/")  # e.g. "Game/19567.zip"


def _r2_batch_delete(items):
    """Delete (bucket, key) tuples from R2 in batches of 1000. Returns count deleted."""
    from sync_db_r2 import get_r2_client
    client = get_r2_client()
    by_bucket = {}
    for bucket, key in items:
        by_bucket.setdefault(bucket, []).append(key)
    total = 0
    for bucket, keys in by_bucket.items():
        for i in range(0, len(keys), 1000):
            chunk = keys[i:i + 1000]
            resp = client.delete_objects(
                Bucket=bucket,
                Delete={"Objects": [{"Key": k} for k in chunk], "Quiet": True},
            )
            errs = resp.get("Errors", [])
            total += len(chunk) - len(errs)
            for er in errs:
                print(f"  [R2 ERROR] {bucket}/{er.get('Key')}: {er.get('Message')}")
    return total


def main():
    args = sys.argv[1:]
    if not args or args[0].startswith("--"):
        print("Usage: py pipelines/apply_duplicate_resolution.py REPORT.json [--apply] [--delete-r2]")
        sys.exit(1)
    report_path = args[0]
    do_apply = "--apply" in args
    do_r2 = "--delete-r2" in args
    r2_only = "--r2-from-manifest" in args
    if do_r2 and not do_apply:
        print("[ERROR] --delete-r2 requires --apply.")
        sys.exit(1)

    if r2_only:
        # Delete exactly what the previously-written manifest lists; no JSON changes.
        man = json.load(open(MANIFEST, encoding="utf-8"))
        items = [tuple(x) for x in man.get("files", [])] + [tuple(x) for x in man.get("screenshots", [])]
        print(f"Deleting {len(items)} objects from R2 per {MANIFEST} ...")
        _r2_batch_delete(items)
        return

    report = json.load(open(report_path, encoding="utf-8"))
    games = json.load(open(GAMES, encoding="utf-8"))
    changes = json.load(open(CHANGES, encoding="utf-8"))

    delete_ids = [str(i) for i in report.get("delete", [])]
    clear_ids = [str(i) for i in report.get("clear_link", [])]
    keep_ids = [str(i) for i in report.get("keep", [])]

    # Build R2 deletion plan
    file_keys = []   # (bucket, key)
    shot_keys = []
    for gid in delete_ids:
        e = games.get(gid)
        if not e:
            continue
        k = r2_game_key(e.get("download_url"))
        if k:
            file_keys.append((FILES_BUCKET, k))
        for s in e.get("screenshots", []):
            p = s.get("image_path")
            if p:
                shot_keys.append((SHOTS_BUCKET, p.lstrip("/")))
    for gid in clear_ids:
        e = games.get(gid)
        if not e:
            continue
        k = r2_game_key(e.get("download_url"))
        if k:
            file_keys.append((FILES_BUCKET, k))
        # screenshots kept — the game stays in the catalog

    print("=== Duplicate-resolution plan ===")
    print(f"keep        : {len(keep_ids)} (no change)")
    print(f"delete      : {len(delete_ids)} games removed from catalog")
    print(f"clear_link  : {len(clear_ids)} games keep entry, lose download link")
    print(f"R2 game files to delete : {len(file_keys)}")
    print(f"R2 screenshots to delete: {len(shot_keys)}")

    os.makedirs("temp", exist_ok=True)
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump({"files": file_keys, "screenshots": shot_keys}, f, indent=2)
    print(f"Wrote deletion manifest -> {MANIFEST}")

    if not do_apply:
        print("\nDry-run only. Re-run with --apply to edit the JSON (and --delete-r2 to delete R2 objects).")
        return

    # --- Apply JSON edits (with backups) ---
    for path, suffix in ((GAMES, ".before_dupres.json"), (CHANGES, ".before_dupres.json")):
        bak = path + suffix
        if not os.path.exists(bak):
            with open(path, "rb") as fi, open(bak, "wb") as fo:
                fo.write(fi.read())
            print(f"Backed up {path} -> {bak}")

    updated = {}
    for gid in clear_ids:
        e = games.get(gid)
        if not e:
            continue
        e["download_url"] = None
        e["file_size"] = 0
        updated[gid] = e
    removed = 0
    for gid in delete_ids:
        if gid in games:
            del games[gid]
            removed += 1

    # Record a new version delta so cached clients sync the removals/changes
    new_version = int(changes.get("version", 0)) + 1
    changes["version"] = new_version
    changes.setdefault("timeline", {})[str(new_version)] = {
        "timestamp": int(time.time()),
        "updated": updated,
        "deleted": delete_ids,
    }

    for path, data in ((GAMES, games), (CHANGES, changes)):
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    print(f"\nUpdated {GAMES}: removed {removed}, cleared link on {len(updated)}.")
    print(f"Bumped catalog version -> {new_version} (timeline delta recorded).")

    if not do_r2:
        print("\nJSON applied. R2 objects NOT deleted (no --delete-r2). Manifest saved for later.")
        return

    # --- Delete R2 objects (IRREVERSIBLE) ---
    n = _r2_batch_delete(file_keys + shot_keys)
    print(f"\nDeleted {n} objects from R2.")


if __name__ == "__main__":
    main()
