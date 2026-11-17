"""Cover screenshots for browser-playable games that have none, captured in the player.

A game the archive can play in the browser (src/play.jsx `playability`: GameMaker 8,
Studio or Studio 2, hosted on file.fangame-archive.com, up to 512 MB) and that has no
screenshots is run in the browser player (play_capture.mjs: the gm-recomp bundle at
public/play/gmr, in headless Chrome). One of its first screens is uploaded to the
screenshots bucket as ratings/screenshots/<id>_cover.png and stamped on the game as its
only screenshot (by "auto-capture", like the covers of data/cover_screenshots.json).

The CI pipeline calls sweep() from scrape_and_migrate_new_games.py before the timeline
delta, so the covers reach cached clients incrementally. Newest games go first, within a
time budget. Attempts are kept in data/play_cover_state.json, which sync_db_r2.py syncs
to R2. A game that gave no usable frame is tried again only with another player version,
and at most MAX_ATTEMPTS times.

Frames: 100 and 250 (the title, usually), then Shift is tapped at frame 300 (a volume
check or a "press Shift" screen moves on) and frames 450 and 600 are taken. The cover is
the most colourful usable frame from before the tap, else from after it. A frame is
unusable when it is nearly one colour, nearly empty, or a common engine's volume-check
screen (GENERIC_SCREENS).

Local use (no upload, nothing stamped; frames and covers under --out):
  python pipelines/play_covers.py --ids 21371,21375 --out temp/play_covers
  python pipelines/play_covers.py --new 20 --out temp/play_covers   # the 20 newest candidates
"""
import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

import requests

REPO_ROOT = Path(__file__).resolve().parent.parent
GAMES_PATH = REPO_ROOT / "data" / "games.json"
STATE_PATH = REPO_ROOT / "data" / "play_cover_state.json"
STATE_R2_KEY = "Database/play_cover_state.json"  # keep in sync with sync_db_r2.DB_FILES
BUNDLE = REPO_ROOT / "public" / "play" / "gmr"
CAPTURE = Path(__file__).resolve().parent / "play_capture.mjs"

PUBLIC_DOMAIN = "https://file.fangame-archive.com"
GAMES_BUCKET = "fangame-files"
SHOTS_BUCKET = "fangame-screenshots"
PLAY_ENGINES = {"GameMaker 8", "GameMaker: Studio", "GameMaker: Studio 2"}
PLAY_MAX_BYTES = 512 * 1024 * 1024
MAX_ATTEMPTS = 3

FRAMES = [100, 250, 450, 600]
KEY_FRAME = 300
KEYS = f"{KEY_FRAME}:ShiftLeft"
CAPTURE_LIMIT_MS = 150_000

# 32x24 average hashes of volume-check screens many games share (three common engines);
# a dark frame within GENERIC_DISTANCE bits of one is not a cover.
GENERIC_SCREENS = [
    "ffdc03fffffc03fffffe7fff6ffe3ebf",
    "ff00007fffff80ffffff807f803e0000000000000000000000000000000000000000000000000000"
    "00000000000000000000000000000",
    "7e000000fe0000000000000000000000000000000000000000000000000000000000000000000000"
    "00000000000000000000000000000000000000000000000000000000000000000000000000000000"
    "00000000000007feffffffffffffffff",
]
GENERIC_DISTANCE = 24


# ── state ──────────────────────────────────────────────────────────────────────
def load_state(path=None):
    try:
        with open(path or STATE_PATH, encoding="utf-8") as f:
            state = json.load(f)
        return state if isinstance(state, dict) else {}
    except Exception:
        return {}


def save_state(state, path=None):
    path = Path(path or STATE_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)
    os.replace(tmp, path)


def r2_state_exists(r2_client):
    """True/False, or None when R2 cannot tell (network error)."""
    try:
        r2_client.head_object(Bucket=GAMES_BUCKET, Key=STATE_R2_KEY)
        return True
    except Exception as exc:
        resp = getattr(exc, "response", None)
        if isinstance(resp, dict):
            code = str(resp.get("Error", {}).get("Code", ""))
            status = resp.get("ResponseMetadata", {}).get("HTTPStatusCode")
            if code in ("404", "NoSuchKey", "NotFound") or status == 404:
                return False
        return None


# ── candidates ─────────────────────────────────────────────────────────────────
def playable(game):
    url = game.get("download_url") or ""
    return (game.get("engine") in PLAY_ENGINES and url.startswith(PUBLIC_DOMAIN + "/")
            and (game.get("file_size") or 0) <= PLAY_MAX_BYTES)


def candidates(games, state, player):
    """Seq ids to try, in order: never tried (newest first), then games to try again
    with this player (newest first)."""
    fresh, again = [], []
    for seq_id, g in games.items():
        if g.get("screenshots") or not playable(g):
            continue
        entry = state.get(seq_id)
        # (an "ok" game without screenshots lost its catalog write, or had them removed)
        if entry is None or entry.get("status") == "ok":
            fresh.append(seq_id)
        elif (entry.get("status") != "ok" and entry.get("player") != player
              and entry.get("attempts", 1) < MAX_ATTEMPTS):
            again.append(seq_id)
    key = lambda s: -int(s) if s.isdigit() else 0
    return sorted(fresh, key=key) + sorted(again, key=key)


# ── frames ─────────────────────────────────────────────────────────────────────
_generic = [int(h, 16) for h in GENERIC_SCREENS]


def measure(path):
    from PIL import Image, ImageFilter

    im = Image.open(path).convert("RGB")
    small = im.resize((160, 120))
    colours = small.getcolors(160 * 120)
    dominant = max(n for n, _ in colours) / (160 * 120)
    # distinct colours after coarse quantisation (noise and gradients count less)
    distinct = len({(r >> 4, g >> 4, b >> 4) for _, (r, g, b) in colours})
    grey = im.convert("L")
    g = grey.resize((320, 240))
    dark = sum(g.histogram()[:28]) / (320 * 240)
    # (without the border, where the filter sees an edge against nothing)
    edges = sum(g.filter(ImageFilter.FIND_EDGES).crop((2, 2, 318, 238)).histogram()[41:]) / (316 * 236)
    px = grey.resize((32, 24)).tobytes()
    mean = sum(px) / len(px)
    ahash = int("".join("1" if p > mean else "0" for p in px), 2)
    return {"distinct": distinct, "dominant": dominant, "dark": dark, "edges": edges, "ahash": ahash}


def usable(m):
    if m["dominant"] > 0.97 or m["edges"] < 0.0015:
        return False
    if m["dark"] > 0.85 and any(bin(m["ahash"] ^ h).count("1") <= GENERIC_DISTANCE for h in _generic):
        return False
    return True


def pick(frame_files):
    """frame_files: {frame number: png path}. The cover's frame number, or None."""
    measured = {}
    for n, p in frame_files.items():
        try:
            measured[n] = measure(p)
        except Exception:
            pass
    for group in ([n for n in measured if n < KEY_FRAME], [n for n in measured if n >= KEY_FRAME]):
        good = [n for n in group if usable(measured[n])]
        if good:
            # the most colourful; the later one of equals (settled, past a fade-in)
            return max(good, key=lambda n: (measured[n]["distinct"], n))
    return None


# ── one game ───────────────────────────────────────────────────────────────────
def chrome_available():
    if os.environ.get("PLAY_CAPTURE_CHROME"):
        return True
    return any(shutil.which(c) for c in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"))


def probe(bundle=None, work=None):
    """Whether this machine's Chrome can run the player: (ok, detail)."""
    bundle = bundle or BUNDLE
    env = dict(os.environ)
    if work is not None and "PLAY_CAPTURE_PROFILE_ROOT" not in env:
        Path(work).mkdir(parents=True, exist_ok=True)
        env["PLAY_CAPTURE_PROFILE_ROOT"] = str(work)
    try:
        r = subprocess.run(["node", str(CAPTURE), "--bundle", str(bundle), "--probe", "--limit-ms", "60000"],
                           capture_output=True, text=True, timeout=120, env=env)
        result = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception as e:
        return False, f"probe failed: {e}"[:300]
    try:
        page = json.loads(result.get("done") or "null")
    except ValueError:
        page = None
    if not isinstance(page, dict):
        return False, f"probe: {result.get('done')}"
    detail = f"isolated {page.get('isolated')}, WebGL 2 {page.get('webgl2')} ({page.get('renderer') or page.get('error') or '?'})"
    return bool(page.get("isolated") and page.get("webgl2")), detail


def download(game, dest, r2_client=None):
    url = game["download_url"]
    key = urllib.parse.unquote(url[len(PUBLIC_DOMAIN):].lstrip("/"))
    if r2_client is not None:
        r2_client.download_file(GAMES_BUCKET, key, str(dest))
        return
    with requests.get(url, stream=True, timeout=60, headers={"User-Agent": "fangame-archive-play-covers"}) as r:
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)


def capture(seq_id, game, work, bundle=None, r2_client=None, log=print):
    """Runs the game and picks its cover. Returns (status, detail, cover path or None):
    status 'ok', 'nocover' (ran, no usable frame), 'failed' (did not import or run, or
    the capture hung or crashed), or 'deferred' (a problem of this machine or the
    network: try again next run)."""
    bundle = bundle or BUNDLE
    gdir = Path(work) / seq_id
    shutil.rmtree(gdir, ignore_errors=True)
    gdir.mkdir(parents=True)
    name = os.path.basename(urllib.parse.unquote(game["download_url"])) or f"{seq_id}.zip"
    archive = gdir / name
    try:
        download(game, archive, r2_client)
    except Exception as e:
        return "deferred", f"download: {e}"[:200], None
    frames_dir = gdir / "frames"
    profiles = gdir / "profile"
    profiles.mkdir()
    env = dict(os.environ)
    env.setdefault("PLAY_CAPTURE_PROFILE_ROOT", str(profiles))
    profile_root = env["PLAY_CAPTURE_PROFILE_ROOT"]
    cmd = ["node", str(CAPTURE), "--bundle", str(bundle), "--archive", str(archive), "--out", str(frames_dir),
           "--frames", ",".join(map(str, FRAMES)), "--keys", KEYS, "--limit-ms", str(CAPTURE_LIMIT_MS)]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
                            start_new_session=True)
    timed_out = False
    try:
        out, err = proc.communicate(timeout=CAPTURE_LIMIT_MS / 1000 + 120)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(proc.pid, signal.SIGKILL)
        out, err = proc.communicate()
    finally:
        # Chrome runs in its own process group (and a flatpak one outside ours)
        subprocess.run(["pkill", "-KILL", "-f", f"user-data-dir={profile_root}/play-capture-"], check=False)
        try:
            archive.unlink()
        except OSError:
            pass
    if timed_out:
        return "failed", "the capture did not finish (import or start hung)", None
    try:
        result = json.loads(out.strip().splitlines()[-1])
    except Exception:
        return "failed", f"the capture gave no result (exit {proc.returncode}): {(err or '').strip()[-200:]}", None
    if result.get("import") != "ok":
        return "failed", f"import: {result.get('import')}", None
    frame_files = {n: frames_dir / f"frame-{n:05d}.png" for n in result.get("frames", [])}
    detail = f"{len(frame_files)}/{len(FRAMES)} frames in {result.get('ms', 0) / 1000:.0f}s"
    if result.get("done") is not None:
        detail += f", ended: {result['done']}"
    if result.get("done") in ("no Chrome found", "Chrome exited") and not frame_files:
        return "deferred", detail, None
    if not frame_files:
        return "failed", detail, None
    best = pick(frame_files)
    if best is None:
        return "nocover", detail, None
    return "ok", f"{detail}, frame {best}", frame_files[best]


# ── the CI sweep ───────────────────────────────────────────────────────────────
def sweep(games, r2_client, work, max_games=40, max_seconds=900, log=print):
    """Captures, uploads and stamps covers for up to max_games candidates within
    max_seconds. Returns the seq ids that got a cover."""
    version_file = BUNDLE / "VERSION"
    if not version_file.exists():
        log("Play covers skipped: no browser player bundle (public/play/gmr).")
        return []
    if not chrome_available():
        log("Play covers skipped: no Chrome to run the player in.")
        return []
    if not shutil.which("node"):
        log("Play covers skipped: no node.")
        return []
    if not STATE_PATH.exists() and r2_state_exists(r2_client) is not False:
        # a transient download failure must not restart the attempt history
        log("Play covers skipped: the attempt state is missing here but exists in R2 (or R2 cannot tell).")
        return []
    ok, detail = probe(work=Path(work) / "probe")
    if not ok:
        log(f"Play covers skipped: Chrome cannot run the player here ({detail}).")
        return []
    log(f"Play covers: Chrome {detail}.")
    player = version_file.read_text(encoding="utf-8").strip()
    state = load_state()
    todo = candidates(games, state, player)
    log(f"Play covers: {len(todo)} candidate(s), player {player}; up to {max_games} this run "
        f"(time budget {max_seconds}s).")
    deadline = time.time() + max_seconds
    done = []
    tried = 0
    blank = 0  # games in a row that imported but gave no frame at all
    for seq_id in todo:
        if tried >= max_games or time.time() >= deadline:
            break
        if blank >= 5:
            log("Play covers: stopping, 5 games in a row gave no frame (the browser may be failing).")
            break
        tried += 1
        game = games[seq_id]
        t = time.time()
        status, detail, cover = capture(seq_id, game, work, r2_client=r2_client, log=log)
        if status == "ok":
            key = f"ratings/screenshots/{seq_id}_cover.png"
            try:
                with open(cover, "rb") as f:
                    r2_client.put_object(Bucket=SHOTS_BUCKET, Key=key, Body=f.read(), ContentType="image/png")
            except Exception as e:
                status, detail = "deferred", f"upload: {e}"[:200]
            else:
                game["screenshots"] = [{"id": 0, "image_path": key, "by": "auto-capture"}]
                done.append(seq_id)
        shutil.rmtree(Path(work) / seq_id, ignore_errors=True)
        log(f"  [PLAY COVER] {seq_id} {game.get('title', '')[:60]!r}: {status} ({detail}; {time.time() - t:.0f}s)")
        blank = blank + 1 if status == "failed" and not detail.startswith("import:") else 0
        if status == "deferred":
            continue
        prev = state.get(seq_id, {})
        state[seq_id] = {"status": status, "detail": detail, "player": player,
                         "attempts": prev.get("attempts", 0) + 1, "ts": int(time.time())}
        save_state(state)
    log(f"Play covers: {len(done)} cover(s) from {tried} game(s) tried.")
    return done


# ── local runs ─────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="Capture cover screenshots in the browser player (local, no upload)")
    ap.add_argument("--ids", help="comma-separated seq ids")
    ap.add_argument("--new", type=int, help="the N newest candidates in data/games.json")
    ap.add_argument("--games", default=str(GAMES_PATH), help="catalog JSON (default data/games.json)")
    ap.add_argument("--bundle", default=str(BUNDLE))
    ap.add_argument("--out", default=str(REPO_ROOT / "temp" / "play_covers"))
    args = ap.parse_args()
    with open(args.games, encoding="utf-8") as f:
        games = json.load(f)
    if args.ids:
        ids = [s.strip() for s in args.ids.split(",") if s.strip()]
    elif args.new:
        ids = candidates(games, {}, None)[: args.new]
    else:
        ap.error("--ids or --new")
    out = Path(args.out)
    (out / "covers").mkdir(parents=True, exist_ok=True)
    results = {}
    for seq_id in ids:
        game = games.get(seq_id)
        if game is None or not playable(game):
            print(f"{seq_id}: not a browser-playable game")
            continue
        t = time.time()
        status, detail, cover = capture(seq_id, game, out / "work", bundle=Path(args.bundle))
        frames = out / "frames" / seq_id
        shutil.rmtree(frames, ignore_errors=True)
        if (out / "work" / seq_id / "frames").exists():
            shutil.move(str(out / "work" / seq_id / "frames"), str(frames))
        if cover is not None:
            shutil.copy(frames / Path(cover).name, out / "covers" / f"{seq_id}_cover.png")
        shutil.rmtree(out / "work" / seq_id, ignore_errors=True)
        results[seq_id] = {"status": status, "detail": detail}
        print(f"{seq_id} {game.get('title', '')[:50]!r}: {status} ({detail}; {time.time() - t:.0f}s)", flush=True)
        with open(out / "results.json", "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
