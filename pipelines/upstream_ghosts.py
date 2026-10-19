"""Retire catalog entries whose Delicious Fruit listing was deleted upstream.

DF sometimes lists the same game more than once — a creator submits it twice,
and the extra entries are removed a few days later. The scraper ingests every
DF id it sees and never revisits one, so each removed listing lingered as a
"ghost" beside the surviving copy (21195 and 21196 next to 21210, all three
"I wanna play with 3x2 Bastards" by Nessid).

A ghost is a game whose every source is a DF id that is missing from a
complete live DF list AND answers 404 on its details page, while another entry
with the same normalized title and creator is still backed upstream (a live DF
id, any non-DF source, or no source at all). What happens to it depends on
what its file adds:

  * nothing — no link, an external link while a survivor has a link, or an R2
    link whose object is gone                    -> delete the ghost
  * the identical R2 file (same size and ETag)   -> delete the ghost + object
  * the only working R2 file                     -> server-side copy it to the
                                                    survivor, then delete the
                                                    ghost + object
  * a different working R2 file (another build)  -> keep both, log for review
  * the only link, and it is external            -> keep both, log for review

Deleting a ghost leaves its seq_map entry in place, which the scraper treats
as a tombstone, so the DF id is never re-added. An R2 object that any other
game still references is never deleted.
"""
import hashlib
import os
import time
import unicodedata
import urllib.parse

PUBLIC_DOMAIN = "https://file.fangame-archive.com"
BUCKET = "fangame-files"
GAME_EXTS = (".zip", ".rar", ".7z", ".exe", ".tar", ".gz")
# Candidate part sizes for multipart ETags, boto3's 8 MiB default first. All are
# whole MiB, so 1 MiB reads never straddle a part boundary.
PART_SIZES = (8 << 20, 5 << 20, 16 << 20)
MAX_COMPARE_BYTES = 1 << 30


def _norm(s):
    return "".join(c for c in unicodedata.normalize("NFKC", s or "").casefold() if c.isalnum())


def r2_key(url):
    """Object key behind one of our R2 download URLs, else None (external/none)."""
    if not url or not url.startswith(PUBLIC_DOMAIN + "/"):
        return None
    return urllib.parse.unquote(urllib.parse.urlparse(url).path).lstrip("/") or None


def _sources(game):
    src = game.get("source") or []
    return [src] if isinstance(src, dict) else [s for s in src if isinstance(s, dict)]


def df_ids(game):
    return [str(s["id"]) for s in _sources(game) if s.get("type") == "df" and s.get("id")]


def _creator(game):
    c = game.get("creator")
    return c.get("name") if isinstance(c, dict) else c


def _stream_digests(r2, key, deadline=None):
    """(plain MD5, {part_size: multipart ETag}) of one object, read once.

    Raises TimeoutError past `deadline`, so one stalled read can't hold a run."""
    body = r2.get_object(Bucket=BUCKET, Key=key)["Body"]
    full = hashlib.md5()
    parts = {p: [] for p in PART_SIZES}
    cur = {p: hashlib.md5() for p in PART_SIZES}
    filled = dict.fromkeys(PART_SIZES, 0)
    buf = b""
    while True:
        if deadline is not None and time.time() > deadline:
            raise TimeoutError(f"reading {key} exceeded the sweep's time budget")
        data = body.read(1 << 20)
        if data:
            buf += data
        while len(buf) >= (1 << 20) or (not data and buf):
            chunk, buf = buf[:1 << 20], buf[1 << 20:]
            full.update(chunk)
            for p in PART_SIZES:
                cur[p].update(chunk)
                filled[p] += len(chunk)
                if filled[p] == p:
                    parts[p].append(cur[p].digest())
                    cur[p], filled[p] = hashlib.md5(), 0
        if not data:
            break
    etags = {}
    for p in PART_SIZES:
        digests = parts[p] + ([cur[p].digest()] if filled[p] else [])
        etags[p] = hashlib.md5(b"".join(digests)).hexdigest() + f"-{len(digests)}"
    return full.hexdigest(), etags


def same_file(r2, a_key, a, b_key, b, deadline=None):
    """Whether two objects hold identical bytes, given their (size, etag) heads.

    Equal ETags settle it; two plain-MD5 ETags that differ settle it the other
    way. The common mixed case — the same archive uploaded once in one PUT
    (ETag = MD5) and once in parts (ETag = MD5 of part MD5s + "-N") — is
    decided by streaming the single-PUT object and deriving its multipart
    ETag. Two differing multipart ETags stay "not proven equal".
    """
    if a[0] != b[0]:
        return False
    if a[1] == b[1]:
        return True
    a_mp, b_mp = "-" in a[1], "-" in b[1]
    if a_mp == b_mp or a[0] > MAX_COMPARE_BYTES:
        return False
    (plain_key, plain), multi = ((a_key, a), b) if b_mp else ((b_key, b), a)
    md5, etags = _stream_digests(r2, plain_key, deadline)
    return md5 == plain[1] and multi[1] in etags.values()


def find_ghosts(games, live_df_ids):
    """Ghost candidates as [(ghost_id, [survivor_ids])], oldest first.

    Pure: the caller must still confirm each ghost's DF entry is really gone,
    since a missing id may just be an incomplete list. Groups with an empty
    title or an unknown creator are skipped — a bare title is too weak a match.
    """
    groups = {}
    for gid, g in games.items():
        title = _norm(g.get("title"))
        creator = _norm(_creator(g))
        if title and creator and creator != "unknown":
            groups.setdefault((title, creator), []).append(gid)

    def backed(g):
        srcs = _sources(g)
        return not srcs or any(s.get("type") != "df" or str(s.get("id")) in live_df_ids for s in srcs)

    found = []
    for ids in groups.values():
        if len(ids) < 2:
            continue
        alive = [i for i in ids if backed(games[i])]
        if alive:
            found.extend((i, alive) for i in ids if i not in alive and df_ids(games[i]))
    return sorted(found, key=lambda item: int(item[0]))


def resolve(games, ghosts, r2, confirm_gone, log=print, engine_state=None,
            max_confirm=40, max_seconds=300):
    """Apply the rules above. Mutates `games` (and `engine_state` when given).

    Each ghost is first judged from the files alone (R2 HEADs, plus a byte
    comparison for same-size pairs); only one that would be deleted costs a DF
    request — `confirm_gone(df_id)` must return True solely on a definite 404.
    So the ghosts left for review cost two HEADs a run, not a slow DF fetch,
    and never use up the per-run budget of `max_confirm` confirmations.
    Returns {"deleted", "moved", "review", "skipped"}.
    """
    deadline = time.time() + max_seconds
    refs = {}
    for gid, g in games.items():
        k = r2_key(g.get("download_url"))
        if k:
            refs.setdefault(k, set()).add(gid)

    def head(key):
        """(size, etag), "missing", or None when the state is unknown (transient error)."""
        if not key:
            return "missing"
        try:
            h = r2.head_object(Bucket=BUCKET, Key=key)
            return (h.get("ContentLength") or 0, (h.get("ETag") or "").strip('"'))
        except Exception as e:
            code = str(getattr(e, "response", {}).get("Error", {}).get("Code", ""))
            return "missing" if code in ("404", "NoSuchKey", "NotFound") else None

    def decide(ghost, alive):
        """("delete", object_key|None, why) | ("move", survivor_id, ghost_head)
        | ("review", other_ids, why) | ("skip", why)."""
        survivors = [(sid, head(r2_key(games[sid].get("download_url")))) for sid in alive]
        if any(h is None for _, h in survivors):
            return ("skip", "survivor file state unknown")
        working = [(sid, h) for sid, h in survivors if isinstance(h, tuple)]
        linked = [sid for sid in alive if games[sid].get("download_url")]
        g_url = ghost.get("download_url") or ""
        g_key = r2_key(g_url)
        if not g_url:
            return ("delete", None, f"no link; kept #{alive[0]}")
        if not g_key:
            if linked:
                return ("delete", None, f"external link; #{linked[0]} has a link")
            return ("review", alive, "ghost holds the only (external) link")
        gh = head(g_key)
        if gh is None:
            return ("skip", "ghost file state unknown")
        if gh == "missing":
            return ("delete", None, f"its R2 object is gone; kept #{alive[0]}")
        if working:
            try:
                same = [sid for sid, h in working
                        if same_file(r2, g_key, gh, r2_key(games[sid].get("download_url")), h, deadline)]
            except Exception as e:
                return ("skip", f"file comparison failed: {e}")
            if same:
                return ("delete", g_key, f"identical file to #{same[0]}")
            return ("review", [sid for sid, _ in working], "a different build than the survivor's file")
        best = sorted(alive, key=lambda s: (-(games[s].get("rating_count") or 0), int(s)))[0]
        return ("move", best, gh)

    out = {"deleted": [], "moved": [], "review": [], "skipped": []}
    doomed_objects = []
    confirmed = 0

    def drop(gid, obj_key=None):
        del games[gid]
        if engine_state is not None:
            engine_state.pop(str(gid), None)
        if obj_key and not (refs.get(obj_key, set()) - {gid}):
            doomed_objects.append(obj_key)
        out["deleted"].append(gid)

    for gid, alive in ghosts:
        ghost = games.get(gid)
        alive = [s for s in alive if s in games]
        if ghost is None or not alive:
            continue
        if time.time() >= deadline:
            out["skipped"].append((gid, "time budget used up; next run"))
            continue
        decision = decide(ghost, alive)
        kind = decision[0]
        if kind == "review":
            out["review"].append((gid, decision[1], decision[2]))
            continue
        if kind == "skip":
            out["skipped"].append((gid, decision[1]))
            continue
        if confirmed >= max_confirm:
            out["skipped"].append((gid, "confirmation budget used up; next run"))
            continue
        confirmed += 1
        if not all(confirm_gone(d) for d in df_ids(ghost)):
            out["skipped"].append((gid, "DF entry not confirmed deleted"))
            continue
        title = ghost.get("title")

        if kind == "delete":
            drop(gid, decision[1])
            log(f"  [GHOST] Deleted #{gid} '{title}' ({decision[2]}).")
            continue

        # "move": the ghost holds the only working file — hand it to the survivor.
        sid, gh = decision[1], decision[2]
        g_key = r2_key(ghost.get("download_url"))
        ext = os.path.splitext(g_key)[1].lower()
        new_key = f"Game/{sid}{ext if ext in GAME_EXTS else '.zip'}"
        try:
            r2.copy_object(Bucket=BUCKET, Key=new_key, CopySource={"Bucket": BUCKET, "Key": g_key},
                           MetadataDirective="REPLACE", ContentType="application/octet-stream")
        except Exception as e:
            out["skipped"].append((gid, f"copy to #{sid} failed: {e}"))
            continue
        nh = head(new_key)
        if not (isinstance(nh, tuple) and nh[0] == gh[0]):
            out["skipped"].append((gid, f"copy to #{sid} did not verify"))
            continue
        survivor = games[sid]
        survivor["download_url"] = f"{PUBLIC_DOMAIN}/{new_key}"
        survivor["file_size"] = gh[0]
        refs.setdefault(new_key, set()).add(sid)
        if engine_state is not None:
            engine_state.pop(str(sid), None)  # a new file deserves a fresh recognition attempt
        out["moved"].append((gid, sid))
        drop(gid, g_key)
        log(f"  [GHOST] Moved the only file of #{gid} '{title}' to #{sid}, then deleted #{gid}.")

    for k in doomed_objects:
        try:
            r2.delete_object(Bucket=BUCKET, Key=k)
        except Exception as e:
            log(f"  [GHOST] Warning: could not delete R2 object {k}: {e}")
    for gid, others, why in out["review"]:
        log(f"  [GHOST] Needs review: #{gid} '{games[gid].get('title')}' vs #{', #'.join(others)} — {why}.")
    if out["skipped"]:
        log(f"  [GHOST] {len(out['skipped'])} ghost(s) deferred to a later run.")
    return out
