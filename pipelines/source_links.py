"""Upstream provenance helpers — the `source` field on a catalog game.

A game's `source` is a **list** of the upstream entries that describe it, the
ingest origin first:

    "source": [{"type": "df", "id": "17718"}, {"type": "wiki", "id": "9145"}]

Two producers write into it, and both go through this module so the shape and
the matching rules stay in one place:

* the **ingest origin**, projected from `database/seq_to_orig_map.json`
  (`backfill_source_links.py`, plus an inline stamp in the scraper);
* the **IWanna Wiki cross-link** for games ingested from Delicious Fruit, found
  by matching titles against the wiki's public catalog API
  (`backfill_wiki_links.py`, plus an inline pass in the scraper for new games).

Only type+id are stored; the page URL is derived at the edges
(`functions/api/_lib/catalog.js`, `src/components.jsx`).

**Wiki matching rules** (deliberately conservative — a wrong link sends a reader
to a different game's page):

1. The normalized title must be unique **on both sides** — exactly one wiki
   entry and exactly one catalog game carry it. This is the load-bearing check:
   fangame titles are long and idiosyncratic, so an exact collision between two
   distinct games is rare, and the double-uniqueness requirement drops the ones
   that do collide instead of guessing.
2. A wiki id already used by any catalog game is never reused (1:1).
3. The creator acts as a **veto**, not as evidence. Delicious Fruit stores
   slug-ish names (`lee_ho-seong`) where the wiki stores display names
   (`Lee Ho-Seong`), so comparison drops every separator and punctuation mark;
   the wiki's collaborator lists are split apart first. A match is rejected only
   when both sides name a creator and they genuinely disagree
   (`I wanna be the Achievement`: ours 久羽, wiki lily).
"""
import re
from collections import Counter, defaultdict

DF = "df"
WIKI = "wiki"

# Keep letters/digits and the CJK/kana/hangul blocks; drop spaces, underscores,
# hyphens, dots and the rest so `lee_ho-seong` == `Lee Ho-Seong`.
_KEY_STRIP = re.compile(r"[^0-9a-z぀-ヿ㐀-䶿一-鿿가-힯]+")
_CREATOR_SPLIT = re.compile(r"[,，、/&+]|\sand\s")
# Below this length a substring creator match is coincidence, not evidence.
_MIN_SUBSTRING = 3


def norm_title(s):
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def creator_key(s):
    return _KEY_STRIP.sub("", (s or "").lower())


def split_creators(s):
    return {k for k in (creator_key(p) for p in _CREATOR_SPLIT.split(s or "")) if k}


def game_creator(game):
    c = game.get("creator")
    if isinstance(c, dict):
        return c.get("name") or ""
    return c or ""


# ── `source` list shape ─────────────────────────────────────────────────────

def normalize_sources(value):
    """Any historical shape (missing / single dict / list) -> a clean list."""
    if not value:
        return []
    items = value if isinstance(value, list) else [value]
    out = []
    seen = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        t = str(item.get("type") or "").strip()
        i = str(item.get("id") or "").strip()
        if not t or not i or (t, i) in seen:
            continue
        seen.add((t, i))
        out.append({"type": t, "id": i})
    return out


def merge_source(game, entry, primary=False):
    """Add `entry` to game["source"]. Returns True when the record changed.

    `primary=True` marks the ingest origin: it replaces any other entry of the
    same type and is moved to the front, so a re-mapped game follows seq_map.
    """
    if not entry:
        return False
    entry = {"type": str(entry["type"]), "id": str(entry["id"])}
    current = normalize_sources(game.get("source"))
    if primary:
        rest = [s for s in current if s["type"] != entry["type"]]
        updated = [entry] + rest
    elif any(s["type"] == entry["type"] for s in current):
        return False  # a link of this kind is already recorded
    else:
        updated = current + [entry]
    if updated == current and "source" in game:
        return False
    game["source"] = updated
    return True


def source_from_mapping(val):
    """A seq_to_orig_map value -> the ingest-origin entry, or None.

    `SUBMISSION-*` (and anything unrecognized) has no public upstream page.
    """
    orig = ""
    if isinstance(val, list) and val:
        orig = str(val[0]).strip()
    elif isinstance(val, str):
        orig = val.strip()
    if not orig:
        return None
    if orig.isdigit():
        return {"type": DF, "id": orig}
    if orig.startswith("WIKI-"):
        wid = orig[len("WIKI-"):].strip()
        return {"type": WIKI, "id": wid} if wid else None
    return None


def wiki_ids_in_use(games):
    return {s["id"] for g in games.values()
            for s in normalize_sources(g.get("source")) if s["type"] == WIKI}


# ── Wiki cross-linking ──────────────────────────────────────────────────────

def match_wiki_links(games, wiki_games, only_seq_ids=None):
    """{seq_id: wiki_id} for catalog games that have no wiki link yet.

    `only_seq_ids` restricts which games may be assigned (used by the scraper to
    look at freshly ingested games only); the uniqueness checks still run over
    the whole catalog, because that is what makes a title unambiguous.
    """
    stats = Counter()
    by_wiki_title = defaultdict(list)
    for e in wiki_games:
        by_wiki_title[norm_title(e.get("name"))].append(e)
    by_game_title = defaultdict(list)
    for seq_id, g in games.items():
        by_game_title[norm_title(g.get("title"))].append(seq_id)

    taken = wiki_ids_in_use(games)
    out = {}
    for title, seq_ids in by_game_title.items():
        if not title:
            continue
        entries = by_wiki_title.get(title)
        if not entries:
            stats["no_wiki_entry"] += 1
            continue
        if len(entries) > 1 or len(seq_ids) > 1:
            stats["ambiguous_title"] += 1
            continue
        seq_id, entry = seq_ids[0], entries[0]
        wiki_id = str(entry.get("id") or "").strip()
        if not wiki_id:
            continue
        if any(s["type"] == WIKI for s in normalize_sources(games[seq_id].get("source"))):
            stats["already_linked"] += 1
            continue
        if wiki_id in taken:
            stats["wiki_id_taken"] += 1
            continue
        if only_seq_ids is not None and seq_id not in only_seq_ids:
            stats["out_of_scope"] += 1
            continue

        ours = creator_key(game_creator(games[seq_id]))
        theirs = split_creators(entry.get("creator"))
        whole = creator_key(entry.get("creator"))
        if not ours or ours == "unknown" or not theirs:
            stats["accept_creator_unknown"] += 1
        elif ours == whole or ours in theirs:
            stats["accept_creator_exact"] += 1
        elif any((ours in t or t in ours) and min(len(ours), len(t)) >= _MIN_SUBSTRING
                 for t in theirs):
            stats["accept_creator_variant"] += 1
        else:
            stats["reject_creator_conflict"] += 1
            continue

        out[seq_id] = wiki_id
        taken.add(wiki_id)
    return out, stats
