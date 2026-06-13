# Sync scraped reviews into the D1 `comments` table so they are visible in the drawer.
#
# Scraped reviews live in temp/reviews_scraped.json (which feeds rating averages via
# games.json). The detail drawer, however, reads review *text* from D1 via /api/comments.
# This bridges the gap: it inserts each written (non-empty-text) review as
#   source='imported', status='approved'
# mapped from its Delicious Fruit id to the sequential catalog id. De-duplication is
# handled by the UNIQUE (game_id, user, content) index via INSERT OR IGNORE, so the
# script is idempotent and never touches native (user-submitted) rows.
#
# Usage:
#   py pipelines/sync_reviews_to_d1.py                       # dry-run on temp/reviews_scraped.json
#   py pipelines/sync_reviews_to_d1.py apply                 # backfill the whole file into D1
#   py pipelines/sync_reviews_to_d1.py SOME.json apply       # sync a specific (delta) file
#
# CI/auth: uses `npx wrangler d1 execute --remote`, so the environment needs a
# Cloudflare API token with D1 edit permission (the same one used for `pages deploy`).

import json
import os
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

DB_NAME = "fangame-comments"
REVIEWS_JSON = "temp/reviews_scraped.json"
SEQ_MAP_PATH = "database/seq_to_orig_map.json"
TEMP_SQL = "temp/_sync_reviews_d1_batch.sql"
BATCH_SIZE = 2000


def _sql_str(s):
    return "'" + str(s if s is not None else "").replace("'", "''") + "'"


def _sql_num(v):
    if v in (None, "", "na"):
        return "NULL"
    try:
        float(v)
        return str(v)
    except (TypeError, ValueError):
        return "NULL"


def build_statements(reviews, orig_to_seq):
    """Build INSERT OR IGNORE statements for written reviews that map to a catalog id."""
    stmts = []
    skipped_no_text = skipped_unmapped = 0
    for r in reviews:
        text = (r.get("text") or "").strip()
        if not text:
            skipped_no_text += 1
            continue
        seq_id = orig_to_seq.get(str(r.get("game_id")))
        if seq_id is None:
            skipped_unmapped += 1
            continue
        likes = r.get("likes") or 0
        try:
            likes = int(likes)
        except (TypeError, ValueError):
            likes = 0
        tags = json.dumps(r.get("tags") or [])
        stmts.append(
            "INSERT OR IGNORE INTO comments "
            "(game_id, user, user_id, rating, difficulty, likes, date, content, tags, source, status, created_ts) "
            f"VALUES ({int(seq_id)}, {_sql_str(r.get('author'))}, NULL, "
            f"{_sql_num(r.get('rating'))}, {_sql_num(r.get('difficulty'))}, {likes}, "
            f"{_sql_str(r.get('date'))}, {_sql_str(text)}, {_sql_str(tags)}, "
            "'imported', 'approved', NULL);"
        )
    return stmts, skipped_no_text, skipped_unmapped


def run_batches(stmts):
    """Execute the statements against remote D1 in batches via wrangler."""
    total = 0
    for i in range(0, len(stmts), BATCH_SIZE):
        batch = stmts[i:i + BATCH_SIZE]
        with open(TEMP_SQL, "w", encoding="utf-8") as f:
            f.write("\n".join(batch))
        print(f"  Executing batch {i // BATCH_SIZE + 1} ({len(batch)} rows)...")
        res = subprocess.run(
            ["npx", "wrangler", "d1", "execute", DB_NAME, "--remote", f"--file={TEMP_SQL}"],
            shell=True,
        )
        if res.returncode != 0:
            print(f"  [ERROR] wrangler batch failed (exit {res.returncode}). Aborting.")
            break
        total += len(batch)
    if os.path.exists(TEMP_SQL):
        os.remove(TEMP_SQL)
    return total


def sync_reviews_to_d1(reviews, apply=False):
    """Importable entry point: sync the given review list into D1. Returns rows attempted."""
    with open(SEQ_MAP_PATH, encoding="utf-8") as f:
        seq_map = json.load(f)
    orig_to_seq = {}
    for seq_id, val in seq_map.items():
        if isinstance(val, list) and val:
            orig_to_seq[str(val[0])] = seq_id

    stmts, no_text, unmapped = build_statements(reviews, orig_to_seq)
    print(f"  written reviews to sync (INSERT OR IGNORE): {len(stmts)}")
    print(f"  skipped — no text (rating-only): {no_text}")
    print(f"  skipped — game id not mapped   : {unmapped}")
    if not apply or not stmts:
        return len(stmts)
    done = run_batches(stmts)
    print(f"  attempted {done} inserts (existing rows ignored by the unique index).")
    return done


def main():
    args = [a for a in sys.argv[1:]]
    apply = "apply" in args
    path = next((a for a in args if a != "apply"), REVIEWS_JSON)

    with open(path, encoding="utf-8") as f:
        reviews = json.load(f)
    print(f"=== sync_reviews_to_d1 on {path} ({len(reviews)} entries) | mode={'APPLY' if apply else 'dry-run'} ===")
    sync_reviews_to_d1(reviews, apply=apply)
    if not apply:
        print("\nDry-run only. Re-run with 'apply' to write into D1.")


if __name__ == "__main__":
    main()
