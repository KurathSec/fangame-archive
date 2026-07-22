"""Apply harvested release dates to the catalog (idempotent; CI-safe).

Reads the committed artifact `data/release_dates.json` (produced by
harvest_release_dates.py from Delicious Fruit's "Released between" search)
and stamps `release_date` ("YYYY-MM-DD", omitted when unknown) onto games:

  Pass 1  DF-mapped games      <- artifact date for their DF id
  Pass 2  WIKI-mapped games    <- their wiki entry's created_at, only when the
          entry was created organically after the 2019-11-14 bulk import
          (older entries all carry the import timestamp — not a release date)
  Pass 3  everything else      <- wiki title+creator exact match (same import
          guard). HIGH date-semantics risk (a late wiki entry documenting an
          old game yields a plausible wrong date), so it is opt-in via
          --title-match and stays OFF in CI; run it manually as a dry-run and
          eyeball the list first.

Existing dates are never overwritten (first-writer-wins everywhere).

Like backfill_engine.py, a mass change cannot ride the incremental timeline
(a per-game delta for ~15k games would blow the <10 MB recent_changes budget),
so on any assignment we bump `recent_changes.version` WITHOUT a timeline
entry: stale clients full-reload once and pick the field up from the served
chunks. Zero assignments -> exit 0 with no bump, which makes this safe as a
permanent CI step (it runs right after the R2 download and before the merge,
so the master sync's old_games snapshot already contains the dates and the
scrape's delta stays small).

Usage:
  python pipelines/backfill_release_dates.py                    # dry-run
  python pipelines/backfill_release_dates.py --apply            # write + bump
  python pipelines/backfill_release_dates.py --apply --ci       # CI mode (no backup file)
  python pipelines/backfill_release_dates.py --title-match      # include pass 3 (dry-run it first!)
  --no-bump   write games.json but leave recent_changes.version alone
"""
import argparse
import datetime as dt
import json
import os
import re
import shutil
import sys

import requests

sys.stdout.reconfigure(encoding="utf-8")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARTIFACT = os.path.join(REPO_ROOT, "data", "release_dates.json")
GAMES = os.path.join(REPO_ROOT, "data", "games.json")
SEQ_MAP = os.path.join(REPO_ROOT, "database", "seq_to_orig_map.json")
RECENT_CHANGES = os.path.join(REPO_ROOT, "data", "recent_changes.json")

WIKI_API = "https://api.iwannawiki.com/api/v1/games"
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
# Entries created before this are the 2019-11-14 bulk import (created_at is
# the import moment, not a release date). Strictly-greater comparison.
WIKI_IMPORT_CUTOFF = "2019-11-21"


def valid_date(s):
    if not isinstance(s, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        return False
    try:
        d = dt.date.fromisoformat(s)
    except ValueError:
        return False
    return dt.date(2000, 1, 1) <= d <= dt.date.today()


def normalize_str(s):
    if not s:
        return ""
    return re.sub(r"\s+", " ", s.lower().strip())


def fetch_wiki_catalog():
    """All wiki game entries, or None on any failure (never partial)."""
    out = []
    page = 1
    while True:
        try:
            res = requests.get(WIKI_API, params={"per_page": 5000, "page": page},
                               headers=HEADERS, timeout=60)
            res.raise_for_status()
            games = res.json().get("games", [])
        except Exception as e:
            print(f"[WARNING] wiki catalog fetch failed on page {page}: {e}")
            return None
        if not games:
            return out
        out.extend(games)
        page += 1


def wiki_date(entry):
    """created_at as a date string, or None when it's just the bulk import."""
    created = str(entry.get("created_at") or "")[:10]
    if valid_date(created) and created > WIKI_IMPORT_CUTOFF:
        return created
    return None


def main():
    ap = argparse.ArgumentParser(description="Backfill release_date into games.json")
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry-run)")
    ap.add_argument("--ci", action="store_true", help="CI mode: skip the local backup copy")
    ap.add_argument("--no-bump", action="store_true", help="do not bump recent_changes.version")
    ap.add_argument("--title-match", action="store_true",
                    help="enable pass 3 (wiki title+creator match for unmapped games)")
    args = ap.parse_args()

    if not os.path.exists(ARTIFACT):
        print(f"release_dates artifact not found ({ARTIFACT}) — nothing to do.")
        return
    with open(ARTIFACT, encoding="utf-8") as f:
        artifact = json.load(f)
    df_dates = artifact.get("dates", {})
    with open(GAMES, encoding="utf-8") as f:
        games = json.load(f)
    with open(SEQ_MAP, encoding="utf-8") as f:
        seq_map = json.load(f)

    already = sum(1 for g in games.values() if g.get("release_date"))

    # Pass 0: reviewed per-seq dates baked into the artifact (one-time wiki
    # title-match results, human-checked before commit — see `seq_source`).
    # Keyed by catalog id directly, so it needs no mapping.
    p0 = 0
    for seq_id, d in (artifact.get("seq") or {}).items():
        if seq_id in games and not games[seq_id].get("release_date") and valid_date(d):
            games[seq_id]["release_date"] = d
            p0 += 1

    # Pass 1: DF-mapped games from the artifact.
    p1 = 0
    for seq_id, val in seq_map.items():
        if seq_id not in games or games[seq_id].get("release_date"):
            continue
        orig = str(val[0]) if isinstance(val, list) and val else ""
        if orig.isdigit() and valid_date(df_dates.get(orig)):
            games[seq_id]["release_date"] = df_dates[orig]
            p1 += 1

    # Pass 2: WIKI-mapped games from their own wiki entry's created_at.
    p2 = 0
    wiki_targets = {}
    for seq_id, val in seq_map.items():
        if seq_id not in games or games[seq_id].get("release_date"):
            continue
        orig = str(val[0]) if isinstance(val, list) and val else ""
        if orig.startswith("WIKI-"):
            wiki_targets[orig.replace("WIKI-", "")] = seq_id

    wiki_catalog = None
    if wiki_targets or args.title_match:
        wiki_catalog = fetch_wiki_catalog()
        if wiki_catalog is None:
            print("[WARNING] wiki unavailable — skipping passes 2-3 this run (retried next run).")

    if wiki_catalog is not None and wiki_targets:
        by_wid = {str(e.get("id")): e for e in wiki_catalog}
        for wid, seq_id in wiki_targets.items():
            entry = by_wid.get(wid)
            d = wiki_date(entry) if entry else None
            if d:
                games[seq_id]["release_date"] = d
                p2 += 1
                print(f"  [P2] seq {seq_id} '{games[seq_id].get('title')}' <- wiki created_at {d}")

    # Pass 3 (opt-in): title+creator exact match for everything still dateless.
    p3 = 0
    if args.title_match and wiki_catalog is not None:
        index = {}
        for e in wiki_catalog:
            key = (normalize_str(e.get("name")), normalize_str(e.get("creator")))
            if key[0] and key[1]:
                index.setdefault(key, []).append(e)
        for seq_id, g in games.items():
            if g.get("release_date"):
                continue
            creator = normalize_str((g.get("creator") or {}).get("name"))
            key = (normalize_str(g.get("title")), creator)
            if not key[0] or creator in ("", "unknown"):
                continue
            cands = index.get(key, [])
            if len(cands) != 1:
                continue
            d = wiki_date(cands[0])
            if d:
                g["release_date"] = d
                p3 += 1
                print(f"  [P3] seq {seq_id} '{g.get('title')}' by '{creator}' <- wiki {d}")

    assigned = p0 + p1 + p2 + p3
    print(f"\ncatalog games        : {len(games)}")
    print(f"already dated        : {already}")
    print(f"pass 0 (reviewed seq): {p0}")
    print(f"pass 1 (DF artifact) : {p1}")
    print(f"pass 2 (wiki mapped) : {p2}")
    print(f"pass 3 (title match) : {p3}{'' if args.title_match else '  (disabled)'}")
    print(f"still dateless       : {sum(1 for g in games.values() if not g.get('release_date'))}")

    if not args.apply:
        print("\nDRY-RUN — no files written. Re-run with --apply to write.")
        return
    if assigned == 0:
        print("\nNothing to assign — no-op (no write, no version bump).")
        return

    if not args.ci:
        backup = GAMES + ".before_release_date.json"
        if not os.path.exists(backup):
            shutil.copy(GAMES, backup)
            print(f"Backed up games.json -> {backup}")
    tmp = GAMES + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(games, f, ensure_ascii=False)
    os.replace(tmp, GAMES)
    print(f"Wrote release_date into {assigned} games in {GAMES}")

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
    # stale clients full-reload once and pick up release_date from the chunks.
    with open(RECENT_CHANGES, "w", encoding="utf-8") as f:
        json.dump(rc, f, ensure_ascii=False, indent=2)
    print(f"Bumped recent_changes.version {old_v} -> {rc['version']} "
          f"(no timeline entry; forces a one-time full-reload).")


if __name__ == "__main__":
    main()
