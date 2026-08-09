"""Cross-link catalog games to their IWanna Wiki entry.

`seq_to_orig_map` records only the site a game was *ingested* from, so a game
that came in via Delicious Fruit had no wiki link even when the wiki documents
it too. The wiki's public catalog API exposes an id per entry, which is enough
to match the two catalogs on title and add a second `source` entry:

    "source": [{"type": "df", "id": "17718"}, {"type": "wiki", "id": "9145"}]

Matching rules live in pipelines/source_links.py — deliberately conservative
(unique title on BOTH sides, 1:1 on wiki ids, creator used only as a veto),
because a wrong link points a reader at a different game's page.

Two modes:

  --refresh-artifact   dev machine. Fetches the whole wiki catalog, matches, and
                       writes the committed artifact data/wiki_links.json. Never
                       touches games.json. A partial fetch aborts rather than
                       producing a thinner mapping: with entries missing, a title
                       that is really ambiguous can look unique and mismatch.

  (default) --apply    CI. Applies the committed artifact offline — no network,
                       deterministic, and it re-checks that the wiki id is not
                       already used by another game before assigning.

The one-time mass application cannot ride the incremental timeline (a per-game
delta for ~12k games would blow the <10 MB recent_changes budget), so on any
assignment we bump `recent_changes.version` WITHOUT a timeline entry: stale
clients full-reload once. Zero assignments -> exit 0 with no bump, which makes
it safe as a permanent CI step. Newly ingested games are matched inline by
scrape_and_migrate_new_games.py (riding the normal delta), so in steady state
this script assigns nothing.

Usage:
  python pipelines/backfill_wiki_links.py --refresh-artifact   # regenerate data/wiki_links.json
  python pipelines/backfill_wiki_links.py                      # dry-run the artifact
  python pipelines/backfill_wiki_links.py --apply              # write + bump
  python pipelines/backfill_wiki_links.py --apply --ci         # CI mode (no backup file)
  --no-bump   write games.json but leave recent_changes.version alone
"""
import argparse
import json
import os
import shutil
import sys

import requests

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import source_links

sys.stdout.reconfigure(encoding="utf-8")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAMES = os.path.join(REPO_ROOT, "data", "games.json")
ARTIFACT = os.path.join(REPO_ROOT, "data", "wiki_links.json")
RECENT_CHANGES = os.path.join(REPO_ROOT, "data", "recent_changes.json")

WIKI_API = "https://api.iwannawiki.com/api/v1/games"
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
PER_PAGE = 5000


def fetch_wiki_catalog():
    """Every wiki entry, or None on any failure — never a partial catalog.

    A truncated catalog is worse than none here: a title whose duplicate went
    missing looks unique and would be matched to the wrong entry.
    """
    out = []
    page = 1
    expected = None
    while True:
        try:
            res = requests.get(WIKI_API, params={"per_page": PER_PAGE, "page": page},
                               headers=HEADERS, timeout=60)
            res.raise_for_status()
            body = res.json()
        except Exception as e:
            print(f"[ERROR] wiki catalog fetch failed on page {page}: {e}")
            return None
        if expected is None:
            expected = body.get("total_count")
        games = body.get("games", [])
        if not games:
            break
        out.extend(games)
        print(f"  page {page}: {len(games)} entries (total {len(out)})")
        page += 1
    if expected is not None and len(out) != expected:
        print(f"[ERROR] wiki catalog incomplete: got {len(out)}, API reports {expected}.")
        return None
    return out


def refresh_artifact():
    with open(GAMES, encoding="utf-8") as f:
        games = json.load(f)
    print(f"Fetching the IWanna Wiki catalog ({WIKI_API})...")
    wiki = fetch_wiki_catalog()
    if wiki is None:
        print("Aborted — artifact left untouched (rerun when the wiki responds).")
        return 1
    print(f"Wiki entries: {len(wiki)} | catalog games: {len(games)}")

    links, stats = source_links.match_wiki_links(games, wiki)
    for k, v in stats.most_common():
        print(f"  {k:26} {v}")
    print(f"\nmatched: {len(links)}")

    artifact = {
        "wiki_catalog_size": len(wiki),
        "catalog_size": len(games),
        "links": {str(k): str(v) for k, v in sorted(links.items(), key=lambda kv: int(kv[0]))},
    }
    tmp = ARTIFACT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(artifact, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, ARTIFACT)
    print(f"Wrote {ARTIFACT} ({os.path.getsize(ARTIFACT) / 1024:.0f} KB)")
    return 0


def apply_artifact(args):
    if not os.path.exists(ARTIFACT):
        print(f"wiki_links artifact not found ({ARTIFACT}) — nothing to do.")
        return 0
    with open(ARTIFACT, encoding="utf-8") as f:
        artifact = json.load(f)
    with open(GAMES, encoding="utf-8") as f:
        games = json.load(f)

    links = artifact.get("links") or {}
    taken = source_links.wiki_ids_in_use(games)
    assigned = 0
    skipped_taken = 0
    skipped_missing = 0
    for seq_id, wiki_id in links.items():
        game = games.get(str(seq_id))
        if game is None:
            skipped_missing += 1
            continue
        current = source_links.normalize_sources(game.get("source"))
        if any(s["type"] == source_links.WIKI for s in current):
            continue
        if str(wiki_id) in taken:
            skipped_taken += 1
            continue
        if source_links.merge_source(game, {"type": source_links.WIKI, "id": str(wiki_id)}):
            taken.add(str(wiki_id))
            assigned += 1

    linked = sum(1 for g in games.values()
                 if any(s["type"] == source_links.WIKI
                        for s in source_links.normalize_sources(g.get("source"))))
    both = sum(1 for g in games.values()
               if {s["type"] for s in source_links.normalize_sources(g.get("source"))}
               >= {source_links.DF, source_links.WIKI})
    print(f"catalog games        : {len(games)}")
    print(f"artifact links       : {len(links)}")
    print(f"assigned this run    : {assigned}")
    print(f"skipped (id in use)  : {skipped_taken}")
    print(f"skipped (no such id) : {skipped_missing}")
    print(f"games with a wiki link: {linked}  (of which DF+wiki: {both})")

    if not args.apply:
        print("\nDRY-RUN — no files written. Re-run with --apply to write.")
        return 0
    if assigned == 0:
        print("\nNothing to assign — no-op (no write, no version bump).")
        return 0

    if not args.ci:
        backup = GAMES + ".before_wiki_links.json"
        if not os.path.exists(backup):
            shutil.copy(GAMES, backup)
            print(f"Backed up games.json -> {backup}")
    tmp = GAMES + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(games, f, ensure_ascii=False)
    os.replace(tmp, GAMES)
    print(f"Wrote wiki links into {assigned} games in {GAMES}")

    if args.no_bump:
        print("Skipped version bump (--no-bump).")
        return 0
    if os.path.exists(RECENT_CHANGES):
        with open(RECENT_CHANGES, encoding="utf-8") as f:
            rc = json.load(f)
    else:
        rc = {"version": 1, "timeline": {}}
    old_v = rc.get("version", 1)
    rc["version"] = old_v + 1
    # Intentionally NO timeline[new] entry -> incremental bridge breaks ->
    # stale clients full-reload once and pick the links up from the chunks.
    with open(RECENT_CHANGES, "w", encoding="utf-8") as f:
        json.dump(rc, f, ensure_ascii=False, indent=2)
    print(f"Bumped recent_changes.version {old_v} -> {rc['version']} "
          f"(no timeline entry; forces a one-time full-reload).")
    return 0


def main():
    ap = argparse.ArgumentParser(description="Cross-link catalog games to their IWanna Wiki entry")
    ap.add_argument("--refresh-artifact", action="store_true",
                    help="fetch the wiki catalog and regenerate data/wiki_links.json")
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry-run)")
    ap.add_argument("--ci", action="store_true", help="CI mode: skip the local backup copy")
    ap.add_argument("--no-bump", action="store_true", help="do not bump recent_changes.version")
    args = ap.parse_args()

    if not os.path.exists(GAMES):
        print(f"Required file not found ({GAMES}) — nothing to do.")
        return 0
    if args.refresh_artifact:
        return refresh_artifact()
    return apply_artifact(args)


if __name__ == "__main__":
    sys.exit(main())
