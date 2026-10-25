"""Apply auto-captured cover screenshots to the catalog (idempotent; CI-safe).

Reads the committed artifact `data/cover_screenshots.json` (produced by
capture_cover_screenshots.py) and stamps a single-element `screenshots` array
onto every game that still has NONE. The image itself is already in R2
(uploaded from the capture machine via wrangler), so the later
sync_screenshots_to_r2.py sees it as present and never tries to re-fetch it
from delicious-fruit.

First-writer-wins: a game that already has screenshots (real DF ones, or a
previously applied cover) is never touched.

Like backfill_release_dates.py / backfill_engine.py, a mass change can't ride
the incremental timeline (thousands of fat records would blow the <10 MB
recent_changes budget), so on any assignment we bump `recent_changes.version`
WITHOUT a timeline entry -> stale clients full-reload once and pick the field
up from the served chunks. Zero assignments -> exit 0 with no bump, so it is
safe as a permanent CI step.

Usage:
  python pipelines/backfill_cover_screenshots.py            # dry-run
  python pipelines/backfill_cover_screenshots.py --apply    # write + bump
  python pipelines/backfill_cover_screenshots.py --apply --ci   # CI mode (no backup file)
  --no-bump   write games.json but leave recent_changes.version alone
"""
import argparse
import json
import os
import shutil
import sys

sys.stdout.reconfigure(encoding="utf-8")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARTIFACT = os.path.join(REPO_ROOT, "data", "cover_screenshots.json")
GAMES = os.path.join(REPO_ROOT, "data", "games.json")
RECENT_CHANGES = os.path.join(REPO_ROOT, "data", "recent_changes.json")


def valid_entry(e):
    return (isinstance(e, dict) and isinstance(e.get("image_path"), str)
            and e["image_path"].startswith("ratings/screenshots/"))


def main():
    ap = argparse.ArgumentParser(description="Backfill auto cover screenshots into games.json")
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry-run)")
    ap.add_argument("--ci", action="store_true", help="CI mode: skip the local backup copy")
    ap.add_argument("--no-bump", action="store_true", help="do not bump recent_changes.version")
    args = ap.parse_args()

    if not os.path.exists(ARTIFACT):
        print(f"cover-screenshots artifact not found ({ARTIFACT}) — nothing to do.")
        return
    with open(ARTIFACT, encoding="utf-8") as f:
        covers = json.load(f)
    with open(GAMES, encoding="utf-8") as f:
        games = json.load(f)

    already = sum(1 for g in games.values() if g.get("screenshots"))
    assigned = 0
    for seq_id, entry in covers.items():
        g = games.get(seq_id)
        if g is None or g.get("screenshots") or not valid_entry(entry):
            continue
        g["screenshots"] = [{
            "id": entry.get("id", 0),
            "image_path": entry["image_path"],
            "by": entry.get("by", "auto-capture"),
        }]
        assigned += 1

    print(f"catalog games        : {len(games)}")
    print(f"already had shots    : {already}")
    print(f"covers in artifact   : {len(covers)}")
    print(f"assigned this run    : {assigned}")
    print(f"still shot-less      : {sum(1 for g in games.values() if not g.get('screenshots'))}")

    if not args.apply:
        print("\nDRY-RUN — no files written. Re-run with --apply to write.")
        return
    if assigned == 0:
        print("\nNothing to assign — no-op (no write, no version bump).")
        return

    if not args.ci:
        backup = GAMES + ".before_covers.json"
        if not os.path.exists(backup):
            shutil.copy(GAMES, backup)
            print(f"Backed up games.json -> {backup}")
    tmp = GAMES + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(games, f, ensure_ascii=False)
    os.replace(tmp, GAMES)
    print(f"Wrote cover screenshots into {assigned} games in {GAMES}")

    if args.no_bump:
        print("Skipped version bump (--no-bump).")
        return
    if os.path.exists(RECENT_CHANGES):
        with open(RECENT_CHANGES, encoding="utf-8") as f:
            rc = json.load(f)
    else:
        rc = {"version": 1, "timeline": {}}
    old_v = rc.get("version", 1)
    rc["version"] = old_v + 1
    # Intentionally NO timeline[new] entry -> incremental bridge breaks ->
    # stale clients full-reload once and pick up the covers from the chunks.
    with open(RECENT_CHANGES, "w", encoding="utf-8") as f:
        json.dump(rc, f, ensure_ascii=False, indent=2)
    print(f"Bumped recent_changes.version {old_v} -> {rc['version']} "
          f"(no timeline entry; forces a one-time full-reload).")


if __name__ == "__main__":
    main()
