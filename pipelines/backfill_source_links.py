"""Stamp each game's upstream provenance (`source`) into the catalog.

`database/seq_to_orig_map.json` has always recorded which upstream entry a
catalog id was ingested from — a numeric Delicious Fruit game id, or "WIKI-<id>"
for an IWanna Wiki entry — but that mapping never reached games.json, so neither
the site nor the public API could link a game back to where it came from.

This writes it onto the game record as the FIRST entry of the game's `source`
list (see pipelines/source_links.py for the shape and the merge rules):

    "source": [{"type": "df", "id": "17718"}]

Only the type and id are stored; the page URL is derived at the edges
(functions/api/_lib/catalog.js and the drawer in src/components.jsx), so the
30 MB catalog does not carry ~15k redundant URL strings. Wiki cross-links added
by backfill_wiki_links.py sit alongside and are never clobbered here.

Locally-submitted games ("SUBMISSION-*") have no upstream page and are skipped.

Like backfill_release_dates.py, the one-time mass stamp cannot ride the
incremental timeline (a per-game delta for ~15k games would blow the <10 MB
recent_changes budget), so on any assignment we bump `recent_changes.version`
WITHOUT a timeline entry: stale clients full-reload once and pick the field up
from the served chunks. Zero assignments -> exit 0 with no bump, which is what
makes this safe as a permanent CI step: after the first run, new games get their
`source` stamped inline by scrape_and_migrate_new_games.py (so it rides the
normal delta) and this script is a no-op safety net for remappings.

Usage:
  python pipelines/backfill_source_links.py                # dry-run
  python pipelines/backfill_source_links.py --apply        # write + bump
  python pipelines/backfill_source_links.py --apply --ci   # CI mode (no backup file)
  --no-bump   write games.json but leave recent_changes.version alone
"""
import argparse
import json
import os
import shutil
import sys

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import source_links

sys.stdout.reconfigure(encoding="utf-8")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAMES = os.path.join(REPO_ROOT, "data", "games.json")
SEQ_MAP = os.path.join(REPO_ROOT, "database", "seq_to_orig_map.json")
RECENT_CHANGES = os.path.join(REPO_ROOT, "data", "recent_changes.json")


def stamp_sources(games, seq_map):
    """Write the ingest origin onto every mapped game. Returns (added, corrected)."""
    added = 0
    corrected = 0
    for seq_id, val in seq_map.items():
        game = games.get(str(seq_id))
        if game is None:
            continue  # tombstone: mapped upstream id whose catalog entry was removed
        src = source_links.source_from_mapping(val)
        if src is None:
            continue
        had_origin = any(s["type"] == src["type"]
                         for s in source_links.normalize_sources(game.get("source")))
        if source_links.merge_source(game, src, primary=True):
            if had_origin:
                corrected += 1
            else:
                added += 1
    return added, corrected


def main():
    ap = argparse.ArgumentParser(description="Backfill upstream source links into games.json")
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry-run)")
    ap.add_argument("--ci", action="store_true", help="CI mode: skip the local backup copy")
    ap.add_argument("--no-bump", action="store_true", help="do not bump recent_changes.version")
    args = ap.parse_args()

    for path in (GAMES, SEQ_MAP):
        if not os.path.exists(path):
            print(f"Required file not found ({path}) — nothing to do.")
            return

    with open(GAMES, encoding="utf-8") as f:
        games = json.load(f)
    with open(SEQ_MAP, encoding="utf-8") as f:
        seq_map = json.load(f)

    already = sum(1 for g in games.values()
                  if any(s["type"] != source_links.WIKI
                         for s in source_links.normalize_sources(g.get("source"))))
    added, corrected = stamp_sources(games, seq_map)
    assigned = added + corrected

    by_type = {}
    for g in games.values():
        srcs = source_links.normalize_sources(g.get("source"))
        for key in ([s["type"] for s in srcs] or ["none"]):
            by_type[key] = by_type.get(key, 0) + 1

    print(f"catalog games      : {len(games)}")
    print(f"mappings           : {len(seq_map)}")
    print(f"already sourced    : {already}")
    print(f"newly stamped      : {added}")
    print(f"corrected (remap)  : {corrected}")
    for k in sorted(by_type):
        print(f"  source={k:<5}     : {by_type[k]}")

    if not args.apply:
        print("\nDRY-RUN — no files written. Re-run with --apply to write.")
        return
    if assigned == 0:
        print("\nNothing to assign — no-op (no write, no version bump).")
        return

    if not args.ci:
        backup = GAMES + ".before_source_links.json"
        if not os.path.exists(backup):
            shutil.copy(GAMES, backup)
            print(f"Backed up games.json -> {backup}")
    tmp = GAMES + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(games, f, ensure_ascii=False)
    os.replace(tmp, GAMES)
    print(f"Wrote source into {assigned} games in {GAMES}")

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
    # stale clients full-reload once and pick up `source` from the chunks.
    with open(RECENT_CHANGES, "w", encoding="utf-8") as f:
        json.dump(rc, f, ensure_ascii=False, indent=2)
    print(f"Bumped recent_changes.version {old_v} -> {rc['version']} "
          f"(no timeline entry; forces a one-time full-reload).")


if __name__ == "__main__":
    main()
