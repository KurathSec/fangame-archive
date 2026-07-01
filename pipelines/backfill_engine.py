"""One-time backfill: attach an `engine` field to catalog games from the
recognition CSV (`fangame_archive_recognition.csv`).

The recognition CSV `id` column is the sequential catalog id (verified: titles
align with games.json). Its `main_version` column is the raw engine signature
the detector emitted; we map that to a small set of clean, user-facing engine
names (English proper nouns, kept untranslated in the UI).

Because this touches ~16k games at once, a per-game timeline delta is
impractical (it would blow the <10 MB recent_changes budget and be pruned
anyway). Instead we bump `recent_changes.version` WITHOUT adding a matching
`timeline[<new>]` entry: the client's incremental check requires every version
in (local, latest] to exist in the timeline, so a missing entry cleanly forces
stale clients to full-reload once and pick up `engine` from the served chunks
(games_part_*.json already carry every non-`reviews` field). See §5.2 / §7.

Usage:
  python pipelines/backfill_engine.py                 # dry-run (prints stats)
  python pipelines/backfill_engine.py --apply         # write games.json + bump version
  python pipelines/backfill_engine.py --apply --no-bump   # write but leave version alone

  --csv PATH    recognition CSV (default: ~/Downloads/fangame_archive_recognition.csv)
  --games PATH  catalog file    (default: data/games.json)

Idempotent: re-running just re-writes the same engine values.
"""
import argparse
import csv
import json
import os
import shutil
import sys
from collections import Counter

# Raw detector signature (recognition.csv `main_version`) -> clean engine name.
# GameMaker is split by generation (most useful distinction for this community);
# the long tail each keeps its own name. Values are English proper nouns.
ENGINE_MAP = {
    "Delphi":              "GameMaker 8",       # classic GM 8.0/8.1 (Delphi-compiled)
    "GameMakerEarly":      "GameMaker 8",       # GM6/7-era, negligible count
    "project":             "GameMaker 8",       # .gmk/.gm81 source projects (8.x era)
    "GMS1":                "GameMaker: Studio",
    "GMS2":                "GameMaker: Studio 2",
    "MMF2":                "Multimedia Fusion 2",
    "ConstructClassic":    "Construct",
    "Construct/NW.js":     "Construct",
    "Godot":               "Godot",
    "Unity":               "Unity",
    "Flash":               "Flash",
    "GDevelop/Electron":   "GDevelop",
    "Scratch/Electron":    "Scratch",
    "RPG Maker MV/NW.js":  "RPG Maker MV",
    "Android":             "Android",
    "ciw":                 "CIW",
}

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_CSV = os.path.expanduser("~/Downloads/fangame_archive_recognition.csv")
DEFAULT_GAMES = os.path.join(REPO_ROOT, "data", "games.json")
RECENT_CHANGES = os.path.join(REPO_ROOT, "data", "recent_changes.json")


def map_engine(main_version):
    """Map a raw detector signature to a clean engine name.

    Unknown/empty signatures fall back to the raw string so nothing is silently
    dropped; blanks yield None (treated as unknown by the UI)."""
    mv = (main_version or "").strip()
    if not mv:
        return None
    return ENGINE_MAP.get(mv, mv)


def load_recognition(csv_path):
    """Return {catalog_id(str): engine_name} from the recognition CSV."""
    id_to_engine = {}
    raw_counter = Counter()
    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            gid = (row.get("id") or "").strip()
            if not gid:
                continue
            engine = map_engine(row.get("main_version"))
            raw_counter[row.get("main_version") or ""] += 1
            if engine:
                id_to_engine[gid] = engine
    return id_to_engine, raw_counter


def main():
    ap = argparse.ArgumentParser(description="Backfill engine field into games.json")
    ap.add_argument("--csv", default=DEFAULT_CSV)
    ap.add_argument("--games", default=DEFAULT_GAMES)
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry-run)")
    ap.add_argument("--no-bump", action="store_true", help="do not bump recent_changes.version")
    args = ap.parse_args()

    if not os.path.exists(args.csv):
        sys.exit(f"recognition CSV not found: {args.csv}")
    if not os.path.exists(args.games):
        sys.exit(f"games.json not found: {args.games}")

    id_to_engine, raw_counter = load_recognition(args.csv)
    with open(args.games, encoding="utf-8") as f:
        games = json.load(f)

    matched = sum(1 for gid in id_to_engine if gid in games)
    csv_only = sum(1 for gid in id_to_engine if gid not in games)
    engine_dist = Counter(
        eng for gid, eng in id_to_engine.items() if gid in games
    )
    catalog_unknown = sum(1 for gid in games if gid not in id_to_engine)

    print(f"recognition rows      : {sum(raw_counter.values())}")
    print(f"catalog games (total) : {len(games)}")
    print(f"matched (will set)    : {matched}")
    print(f"in CSV, not in catalog: {csv_only}")
    print(f"catalog w/o engine    : {catalog_unknown}  (shown as Unknown)")
    print()
    print("Resulting engine distribution (matched games):")
    for eng, n in engine_dist.most_common():
        print(f"  {eng:<22} {n:>6}")
    print()
    # Surface any raw signature not in our explicit map (would pass through raw).
    unmapped = [mv for mv in raw_counter if mv and mv not in ENGINE_MAP]
    if unmapped:
        print("Raw signatures passed through unmapped (verify these):")
        for mv in unmapped:
            print(f"  {mv!r} -> {map_engine(mv)!r}  ({raw_counter[mv]})")
        print()

    if not args.apply:
        print("DRY-RUN — no files written. Re-run with --apply to write.")
        return

    # --- write games.json (backup first) ---
    backup = args.games + ".before_engine.json"
    if not os.path.exists(backup):
        shutil.copy(args.games, backup)
        print(f"Backed up games.json -> {backup}")
    for gid, engine in id_to_engine.items():
        if gid in games:
            games[gid]["engine"] = engine
    with open(args.games, "w", encoding="utf-8") as f:
        json.dump(games, f, ensure_ascii=False)
    print(f"Wrote engine into {matched} games in {args.games}")

    # --- bump version so stale clients full-reload (§5.2) ---
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
    # stale clients full-reload once and pick up `engine` from the chunks.
    with open(RECENT_CHANGES, "w", encoding="utf-8") as f:
        json.dump(rc, f, ensure_ascii=False, indent=2)
    print(f"Bumped recent_changes.version {old_v} -> {rc['version']} "
          f"(no timeline entry; forces a one-time full-reload).")


if __name__ == "__main__":
    main()
