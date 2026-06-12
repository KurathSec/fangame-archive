# One-time / repeatable de-duplication of temp/reviews_scraped.json.
#
# Removes duplicate scraped reviews while preserving the data that feeds rating
# averages. A written comment is identified by (game_id, author, user_id, text);
# a named rating-only entry by (game_id, author, user_id, rating, difficulty).
# Anonymous rating-only entries are kept as-is (distinct anonymous ratings must
# still count toward avg_rating / rating_count).
#
# Usage:
#   py pipelines/dedupe_reviews.py          # dry-run: report only, no writes
#   py pipelines/dedupe_reviews.py apply     # back up + rewrite reviews_scraped.json

import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

SRC = "temp/reviews_scraped.json"
BACKUP = "temp/reviews_scraped.backup.json"


def review_key(r):
    text = (r.get("text") or "").strip()
    author = (r.get("author") or "").strip().lower()
    if text:
        return ("c", r.get("game_id"), author, r.get("user_id"), text)
    if author != "anonymous":
        return ("nr", r.get("game_id"), author, r.get("user_id"), r.get("rating"), r.get("difficulty"))
    tags = tuple(sorted(r.get("tags", []))) if r.get("tags") else ()
    return ("ar", r.get("game_id"), r.get("rating"), r.get("difficulty"), r.get("date"), tags)


def has_date(r):
    return bool(str(r.get("date", "") or "").strip())


def is_better(a, b):
    # Prefer the row that has a date; tie-break on higher likes.
    if has_date(a) != has_date(b):
        return has_date(a)
    return (a.get("likes") or 0) > (b.get("likes") or 0)


def has_rating(r):
    v = r.get("rating")
    return v not in (None, "", "na")


def main():
    apply = len(sys.argv) > 1 and sys.argv[1] == "apply"

    with open(SRC, encoding="utf-8") as f:
        data = json.load(f)

    best = {}  # key -> index of the best representative row
    for i, r in enumerate(data):
        k = review_key(r)
        if k not in best or is_better(r, data[best[k]]):
            best[k] = i

    keep = set(best.values())
    cleaned = [r for i, r in enumerate(data) if i in keep]

    removed = len(data) - len(cleaned)
    removed_with_rating = sum(
        1 for i, r in enumerate(data) if i not in keep and has_rating(r)
    )

    print(f"total entries     : {len(data)}")
    print(f"kept              : {len(cleaned)}")
    print(f"removed (dupes)   : {removed}")
    print(f"  of which carried a numeric rating (affects averages): {removed_with_rating}")

    if not apply:
        print("\nDry-run only. Re-run with 'apply' to back up and rewrite the file.")
        return

    if not os.path.exists(BACKUP):
        with open(SRC, "rb") as fi, open(BACKUP, "wb") as fo:
            fo.write(fi.read())
        print(f"\nBacked up original -> {BACKUP}")
    else:
        print(f"\nBackup already exists at {BACKUP} (left untouched).")

    tmp = SRC + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cleaned, f, ensure_ascii=False, indent=2)
    os.replace(tmp, SRC)
    print(f"Rewrote {SRC} with {len(cleaned)} entries.")


if __name__ == "__main__":
    main()
