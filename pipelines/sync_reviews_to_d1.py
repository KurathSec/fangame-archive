# Sync scraped reviews into the D1 `comments` table so they are visible in the drawer.
#
# Scraped reviews live in temp/reviews_scraped.json (which feeds rating averages via
# games.json). The detail drawer, however, reads review *text* from D1 via /api/comments.
# This bridges the gap: it inserts each review that carries content (text, a rating, a
# difficulty, or tags — rating-only entries are kept, only fully-empty ones are skipped) as
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
import time

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


def _has_value(v):
    return v not in (None, "", "na")


def build_statements(reviews, orig_to_seq):
    """Build INSERT OR IGNORE statements for reviews that map to a catalog id and carry
    any content — text, a rating, a difficulty, or tags. Rating-only reviews (no text)
    are kept on purpose: they display rating/difficulty/tags. Only fully-empty entries
    are skipped."""
    stmts = []
    skipped_empty = skipped_unmapped = 0
    for r in reviews:
        text = (r.get("text") or "").strip()
        tags_list = r.get("tags") or []
        if not (text or _has_value(r.get("rating")) or _has_value(r.get("difficulty")) or tags_list):
            skipped_empty += 1
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
        tags = json.dumps(tags_list)
        author = r.get("author")
        named = bool(author) and str(author).strip().lower() != "anonymous"
        # A named user has one review per game: replace any existing imported row for
        # (game, user) so a re-scrape (e.g. a previously-truncated review now captured in
        # full) UPDATES it instead of inserting a duplicate. Anonymous rows have no stable
        # identity beyond content, so they stay content-deduped via the unique index.
        if named:
            stmts.append(
                f"DELETE FROM comments WHERE game_id={int(seq_id)} AND user={_sql_str(author)} AND source='imported';"
            )
        verb = "INSERT" if named else "INSERT OR IGNORE"
        stmts.append(
            f"{verb} INTO comments "
            "(game_id, user, user_id, rating, difficulty, likes, date, content, tags, source, status, created_ts) "
            f"VALUES ({int(seq_id)}, {_sql_str(author)}, NULL, "
            f"{_sql_num(r.get('rating'))}, {_sql_num(r.get('difficulty'))}, {likes}, "
            f"{_sql_str(r.get('date'))}, {_sql_str(text)}, {_sql_str(tags)}, "
            "'imported', 'approved', NULL);"
        )
    return stmts, skipped_empty, skipped_unmapped


def run_batches(stmts):
    """Execute the statements against remote D1 in batches via wrangler."""
    total = 0
    n_batches = (len(stmts) + BATCH_SIZE - 1) // BATCH_SIZE
    for i in range(0, len(stmts), BATCH_SIZE):
        batch = stmts[i:i + BATCH_SIZE]
        with open(TEMP_SQL, "w", encoding="utf-8") as f:
            f.write("\n".join(batch))
        bn = i // BATCH_SIZE + 1
        ok = False
        for attempt in range(1, 6):  # retry transient network failures (idempotent)
            tag = "" if attempt == 1 else f" [retry {attempt - 1}]"
            print(f"  Executing batch {bn}/{n_batches} ({len(batch)} rows){tag}...")
            # Pass a single command STRING with shell=True. A list with shell=True is broken
            # on POSIX (the CI runner): only the first item reaches the shell as the command
            # and the rest become the shell's own args, so `wrangler d1 execute` never runs —
            # the scrape looks successful but no reviews reach D1. (Matches the string form
            # used in merge_approved_submissions.py.)
            cmd = f'npx -y wrangler d1 execute {DB_NAME} --remote --file="{TEMP_SQL}"'
            res = subprocess.run(cmd, shell=True)
            if res.returncode == 0:
                ok = True
                break
            print(f"  batch {bn} failed (exit {res.returncode}); retrying in 5s...")
            time.sleep(5)
        if not ok:
            print(f"  [ERROR] batch {bn} failed after retries. Re-run the script to resume (idempotent).")
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

    stmts, empty, unmapped = build_statements(reviews, orig_to_seq)
    print(f"  SQL statements to run (named reviews use delete+insert): {len(stmts)}")
    print(f"  skipped — completely empty (no text/rating/difficulty/tags): {empty}")
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
