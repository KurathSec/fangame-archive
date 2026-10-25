"""Batch cover-screenshot capture for catalog games that have none.

For each addressable game (R2-hosted download, runnable engine, no screenshots
yet) a worker: downloads the archive, extracts it and locates the main .exe
(reusing engine_recognition.py), runs it headless under Wine inside an Xvfb
display and a network-less bwrap sandbox, waits past the loader/splash for the
real game window, captures the best frame, uploads it to R2 via the logged-in
wrangler, records it in data/cover_screenshots.json, and deletes everything.

Nothing here needs R2 credentials: game files are fetched from the public
download_url, and the capture is pushed with `wrangler r2 object put`. State is
resumable (success/failed/deferred) exactly like engine_recognition's sweep.

The GM8 (and similar) loader problem: the first thing on screen is a loading
bar, not the game. We defeat it by capturing several frames spread over time
and picking the LAST one that is both "settled" (barely differs from the frame
before it — so not a mid-animation loading bar) and visually complex (not black
or a plain bar). See pick_best_frame().

Prereqs on PATH (Fedora): wine, Xvfb, xdotool, unar (RAR), upx, bwrap, 7z,
ImageMagick (import/identify/compare), plus npx/wrangler for uploads. Build the
template WINEPREFIX once with `--setup`.

Usage:
  python pipelines/capture_cover_screenshots.py --setup          # build template prefix
  python pipelines/capture_cover_screenshots.py --engine "GameMaker 8" --max-games 80   # pilot
  python pipelines/capture_cover_screenshots.py --max-games 500  # scale (denylist-only)
  python pipelines/capture_cover_screenshots.py --no-upload      # capture locally, don't push
  --concurrency N  --max-seconds S  --max-file-mb M  --warmup SEC  --keep  --no-sandbox
"""
import argparse
import datetime as dt
import json
import os
import queue
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from pathlib import Path

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import engine_recognition as ER

REPO_ROOT = Path(__file__).resolve().parent.parent
# Local-only resume state (this machine never runs in CI) -> temp/, gitignored.
STATE_PATH = REPO_ROOT / "temp" / "cover_screenshot_state.json"
# Committed artifact the CI backfill reads.
ARTIFACT_PATH = REPO_ROOT / "data" / "cover_screenshots.json"
GAMES_PATH = REPO_ROOT / "data" / "games.json"
SHOTS_DIR = REPO_ROOT / "ratings" / "screenshots"
TEMPLATE_PREFIX = REPO_ROOT / "temp" / "wine_template"  # built by --setup, copied per run
WORK_ROOT = REPO_ROOT / "temp" / "cover_capture"

PUBLIC_DOMAIN = "https://file.fangame-archive.com"
SHOTS_BUCKET = "fangame-screenshots"
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}

# Engines we never try to run. Everything else is attempted (user's choice).
ENGINE_DENYLIST = {"Android", "Flash"}
DEBUG = False

# Machine/tooling faults -> deferred (retried next run); game faults -> failed.
DEFERRABLE_ERRORS = {
    "missing_7z", "missing_upx", "missing_wine", "missing_xvfb", "missing_unar",
    "download_failed", "xvfb_failed", "capture_timeout", "quality_low",
}

# ── thread-safe state + artifact ────────────────────────────────────────────
_lock = threading.Lock()


def load_json(path, default):
    p = Path(path)
    if not p.exists():
        return default
    try:
        with p.open(encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def save_json_atomic(path, data):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, p)


def record(state, artifact, gid, status, error="", image_path=None):
    with _lock:
        state[str(gid)] = {"status": status, "error": error, "ts": int(time.time())}
        if image_path:
            artifact[str(gid)] = {"id": 0, "image_path": image_path, "by": "auto-capture"}
        save_json_atomic(STATE_PATH, state)
        save_json_atomic(ARTIFACT_PATH, artifact)


# ── candidate selection ─────────────────────────────────────────────────────
def r2_key_from_url(url):
    if not url or not url.startswith(PUBLIC_DOMAIN):
        return None
    return urllib.parse.unquote(url[len(PUBLIC_DOMAIN):].lstrip("/"))


def build_candidates(games, state, engine_filter, max_file_mb):
    out = []
    for gid, g in games.items():
        if g.get("screenshots"):
            continue
        url = g.get("download_url") or ""
        if PUBLIC_DOMAIN not in url:
            continue
        engine = g.get("engine") or ""
        if engine in ENGINE_DENYLIST:
            continue
        if engine_filter is not None and engine != engine_filter:
            continue
        prev = state.get(str(gid))
        if prev and prev.get("status") == "failed":
            continue  # settled; success/deferred are retried
        if prev and prev.get("status") == "success":
            continue
        size_mb = (g.get("file_size") or 0) / (1024 * 1024)
        if size_mb and size_mb > max_file_mb:
            continue
        out.append((int(gid), g, url))
    out.sort(key=lambda t: -t[0])  # newest first
    return out


# ── download / extract ──────────────────────────────────────────────────────
def download(url, dest, max_file_mb):
    try:
        with requests.get(url, headers=HEADERS, stream=True, timeout=60) as r:
            r.raise_for_status()
            cap = max_file_mb * 1024 * 1024
            total = 0
            with open(dest, "wb") as f:
                for chunk in r.iter_content(1024 * 256):
                    if not chunk:
                        continue
                    total += len(chunk)
                    if total > cap:
                        return False, "download_failed"  # bigger than declared; bail
                    f.write(chunk)
        return (total > 0), ("" if total else "download_failed")
    except Exception as e:
        return False, "download_failed"


def unar_extract(source, work_dir):
    """RAR fallback: Fedora's 7z can't decode RAR. unar handles it."""
    if not shutil.which("unar"):
        return False, "missing_unar"
    try:
        res = subprocess.run(["unar", "-force-overwrite", "-o", str(work_dir), str(source)],
                             stdin=subprocess.DEVNULL, capture_output=True, timeout=180)
        return res.returncode == 0, ("" if res.returncode == 0 else "extract_failed")
    except subprocess.TimeoutExpired:
        return False, "extract_timeout"


def pick_main_exe(work_dir):
    """More permissive than engine_recognition's exe finder, which bails on
    multi-exe trees. Prefer a GameMaker/Unity/Godot data-adjacent exe, else the
    largest non-uninstaller exe."""
    exes = ER.find_exes(work_dir)
    if not exes:
        return None
    if len(exes) == 1:
        return exes[0]
    # sinchi loader takes precedence (engine_recognition unwraps it later)
    sinchi = [e for e in exes if ER.is_sinchi_loader_exe(e)]
    if len(sinchi) == 1:
        return sinchi[0]
    # exe sitting next to data.win / *_Data / *.pck / *.dat is the real game
    def has_engine_siblings(exe):
        if ER.find_adjacent_data_win(exe):
            return True
        for sib in exe.parent.iterdir():
            n = sib.name.lower()
            if n.endswith(("_data",)) and sib.is_dir():
                return True
            if n.endswith((".pck", ".dat")) and sib.is_file():
                return True
        return False
    real = [e for e in exes if e.name.lower() != "uninstall.exe"]
    engine_exes = [e for e in real if has_engine_siblings(e)]
    pool = engine_exes or real or exes
    return max(pool, key=lambda e: e.stat().st_size)


def prepare_exe(source, work_dir):
    """Return (exe_path, error). Reuses engine_recognition, adds RAR + permissive pick."""
    prepared = ER.prepare_game_exe(source, work_dir)
    if prepared.path and not prepared.error:
        return prepared.path, ""
    # RAR (or anything 7z choked on) -> unar, then our own picker.
    try:
        magic = Path(source).open("rb").read(8)
    except Exception:
        magic = b""
    if magic[:4] == b"Rar!":
        ER.clear_working_dir(Path(work_dir))
        ok, err = unar_extract(source, work_dir)
        if not ok:
            return None, err
    exe = pick_main_exe(work_dir)
    if exe is None:
        return None, prepared.error or "no_exe"
    # honor sinchi unwrap for the chosen exe
    unwrapped = ER.extract_sinchi_loader_exe_if_needed(exe, Path(work_dir))
    return (unwrapped.path or exe), ""


# ── Xvfb + sandboxed wine ───────────────────────────────────────────────────
def start_xvfb(display_num, geom="1280x960x24"):
    sock = Path(f"/tmp/.X11-unix/X{display_num}")
    lock = Path(f"/tmp/.X{display_num}-lock")
    # Clear a stale lock/socket from a previously killed Xvfb on this display.
    if not sock.exists() and lock.exists():
        try:
            lock.unlink()
        except OSError:
            pass
    errlog = WORK_ROOT / f"xvfb_{display_num}.log"
    errlog.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen(
        ["Xvfb", f":{display_num}", "-screen", "0", geom, "-nolisten", "tcp", "-ac"],
        stdout=subprocess.DEVNULL, stderr=open(errlog, "w"),
    )
    for _ in range(80):
        if sock.exists():
            return proc
        if proc.poll() is not None:
            tail = ""
            try:
                tail = errlog.read_text()[-300:]
            except Exception:
                pass
            print(f"[xvfb :{display_num}] exited early: {tail}", flush=True)
            return None
        time.sleep(0.1)
    return proc if sock.exists() else None


def wine_command(exe_path, prefix_home, display_num, use_sandbox):
    env_wine = {
        "HOME": str(prefix_home),
        "WINEPREFIX": str(prefix_home / ".wine"),
        "DISPLAY": f":{display_num}",
        "WINEDEBUG": "fixme-all,err+all" if DEBUG else "-all",
        "WINEDLLOVERRIDES": "mscoree,mshtml=",  # skip mono/gecko install prompts
    }
    exe = Path(exe_path)
    if not use_sandbox:
        return ["wine", str(exe)], {**os.environ, **env_wine}, str(exe.parent)
    # bwrap: no network, isolated fs; X socket + system libs are read-only bound.
    cmd = [
        "bwrap",
        "--ro-bind", "/usr", "/usr",
        "--ro-bind", "/etc", "/etc",
        "--symlink", "usr/lib", "/lib",
        "--symlink", "usr/lib64", "/lib64",
        "--symlink", "usr/bin", "/bin",
        "--symlink", "usr/sbin", "/sbin",
        "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
        "--ro-bind", "/tmp/.X11-unix", "/tmp/.X11-unix",
        "--bind", str(prefix_home), str(prefix_home),
        "--bind", str(exe.parent), str(exe.parent),
        "--chdir", str(exe.parent),  # GM games load bundled files relative to cwd
        "--unshare-net", "--unshare-pid", "--die-with-parent", "--new-session",
    ]
    for k, v in env_wine.items():
        cmd += ["--setenv", k, v]
    # Run the exe by basename now that cwd is its directory.
    cmd += ["wine", exe.name]
    return cmd, os.environ.copy(), str(exe.parent)


# ── capture + quality ───────────────────────────────────────────────────────
def xdotool_top_window(display_num):
    """The largest visible client window on the display, or None."""
    env = {**os.environ, "DISPLAY": f":{display_num}"}
    try:
        out = subprocess.run(["xdotool", "search", "--onlyvisible", "--name", ""],
                             env=env, capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return None
    best, best_area = None, 0
    for wid in out.split():
        try:
            g = subprocess.run(["xdotool", "getwindowgeometry", "--shell", wid],
                               env=env, capture_output=True, text=True, timeout=5).stdout
            d = dict(l.split("=", 1) for l in g.strip().splitlines() if "=" in l)
            w, h = int(d.get("WIDTH", 0)), int(d.get("HEIGHT", 0))
            if w * h > best_area and w >= 120 and h >= 90:
                best, best_area = (wid, w, h), w * h
        except Exception:
            continue
    return best


def grab(display_num, wid, out_png):
    env = {**os.environ, "DISPLAY": f":{display_num}"}
    try:
        r = subprocess.run(["import", "-window", wid, "-silent", str(out_png)],
                           env=env, capture_output=True, timeout=20)
        return r.returncode == 0 and Path(out_png).exists()
    except Exception:
        return False


def complexity(png):
    """Unique-color count; a black screen / plain loading bar scores very low."""
    try:
        out = subprocess.run(["identify", "-format", "%k", str(png)],
                             capture_output=True, text=True, timeout=15).stdout.strip()
        return int(out)
    except Exception:
        return 0


def frame_diff(a, b):
    """Normalized RMSE between two frames (0=identical). Loading animations are
    high-diff between consecutive frames; a settled title screen is near 0."""
    try:
        r = subprocess.run(["compare", "-metric", "RMSE", str(a), str(b), "null:"],
                           capture_output=True, text=True, timeout=20)
        txt = (r.stderr or r.stdout).strip()
        # format: "1234.5 (0.0188)"
        if "(" in txt:
            return float(txt.split("(")[1].split(")")[0])
    except Exception:
        pass
    return 1.0


MIN_COLORS = 400        # below this = black/near-uniform/plain bar
SETTLED_DIFF = 0.02     # consecutive-frame RMSE under this = not mid-animation


def pick_best_frame(frames):
    """frames: list of (png_path, colors). Prefer the LAST settled+complex
    frame (skips loaders); fall back to the most complex late frame."""
    scored = [(p, c) for p, c in frames if c >= MIN_COLORS]
    if not scored:
        return None
    # settled = differs little from the previous captured frame
    for i in range(len(frames) - 1, 0, -1):
        p, c = frames[i]
        if c >= MIN_COLORS and frame_diff(frames[i - 1][0], p) <= SETTLED_DIFF:
            return p
    return max(scored, key=lambda t: t[1])[0]


def capture_game(exe_path, prefix_home, display_num, work_dir, warmup, use_sandbox, log):
    """Launch, wait past the loader, capture the best frame. Returns
    (png_path | None, error)."""
    cmd, env, cwd = wine_command(exe_path, prefix_home, display_num, use_sandbox)
    wine_log = open(Path(work_dir) / "wine.log", "w")
    proc = subprocess.Popen(cmd, env=env, cwd=cwd, stdout=wine_log,
                            stderr=subprocess.STDOUT, start_new_session=True)
    try:
        # wait for a window to appear (up to warmup+8s)
        deadline = time.time() + warmup + 8
        top = None
        while time.time() < deadline:
            top = xdotool_top_window(display_num)
            if top:
                break
            if proc.poll() is not None:
                return None, "crash_no_window"
            time.sleep(1)
        if not top:
            return None, "no_window"

        if DEBUG:
            log(f"    [dbg] window appeared: {top}; sleeping warmup {warmup}s")
        time.sleep(warmup)  # let the loader run / the first room render

        # Capture several frames spread over ~12s and pick the best.
        frames = []
        for i in range(6):
            top = xdotool_top_window(display_num) or top
            wid = top[0]
            png = Path(work_dir) / f"frame_{i}.png"
            got = grab(display_num, wid, png)
            if got:
                frames.append((png, complexity(png)))
            if DEBUG:
                alive = proc.poll() is None
                log(f"    [dbg] frame {i}: win={top} grab={got} "
                    f"colors={complexity(png) if got else '-'} wine_alive={alive}")
            if proc.poll() is not None and frames:
                break
            time.sleep(2)
        if not frames:
            return None, "capture_failed"
        best = pick_best_frame(frames)
        if best is None:
            return None, "quality_low"
        return best, ""
    finally:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            pass
        # tear down wine inside the same prefix
        try:
            subprocess.run(["wineserver", "-k"],
                           env={**os.environ, "WINEPREFIX": str(prefix_home / ".wine")},
                           timeout=20, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass


# ── upload ──────────────────────────────────────────────────────────────────
def wrangler_upload(png, key, log):
    try:
        r = subprocess.run(
            ["npx", "wrangler", "r2", "object", "put", f"{SHOTS_BUCKET}/{key}",
             "--file", str(png), "--content-type", "image/png", "--remote"],
            capture_output=True, text=True, timeout=180)
        if r.returncode != 0:
            log(f"    wrangler failed: {(r.stderr or r.stdout)[:200]}")
            return False
        return True
    except Exception as e:
        log(f"    wrangler error: {e}")
        return False


# ── worker ──────────────────────────────────────────────────────────────────
def process_one(gid, game, url, display_num, args, state, artifact, log):
    work_dir = WORK_ROOT / f"w{display_num}"     # extraction target (prepare_game_exe clears this)
    dl_dir = WORK_ROOT / f"dl{display_num}"       # archive lives here, OUTSIDE work_dir
    prefix_home = WORK_ROOT / f"prefix_{display_num}"
    # fresh copy of the template prefix so games can't pollute a shared one
    if prefix_home.exists():
        shutil.rmtree(prefix_home, ignore_errors=True)
    shutil.copytree(TEMPLATE_PREFIX, prefix_home, symlinks=True)
    ER.clear_working_dir(work_dir)
    ER.clear_working_dir(dl_dir)

    key = r2_key_from_url(url)
    ext = os.path.splitext(key or url.split("?")[0])[1].lower() or ".zip"
    src = dl_dir / f"game{ext}"
    try:
        ok, err = download(url, src, args.max_file_mb)
        if not ok:
            record(state, artifact, gid, "deferred" if err in DEFERRABLE_ERRORS else "failed", err)
            log(f"  [{gid}] download: {err}")
            return
        exe, err = prepare_exe(src, work_dir)
        try:
            src.unlink()  # free the archive; extracted tree remains
        except Exception:
            pass
        if exe is None:
            status = "deferred" if err in DEFERRABLE_ERRORS else "failed"
            record(state, artifact, gid, status, err)
            log(f"  [{gid}] extract: {err}")
            return

        png, err = capture_game(exe, prefix_home, display_num, work_dir,
                                args.warmup, not args.no_sandbox, log)
        if png is None and err == "quality_low":
            # one retry with a longer warmup before giving up
            png, err = capture_game(exe, prefix_home, display_num, work_dir,
                                    args.warmup + 10, not args.no_sandbox, log)
        if png is None:
            status = "deferred" if err in DEFERRABLE_ERRORS else "failed"
            record(state, artifact, gid, status, err)
            log(f"  [{gid}] capture: {err}")
            return

        final = SHOTS_DIR / f"{gid}_cover.png"
        SHOTS_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copy2(png, final)
        img_key = f"ratings/screenshots/{gid}_cover.png"
        if args.no_upload:
            record(state, artifact, gid, "success", "", img_key)
            log(f"  [{gid}] captured (local only) -> {final.name}")
        elif wrangler_upload(final, img_key, log):
            record(state, artifact, gid, "success", "", img_key)
            log(f"  [{gid}] OK -> {img_key}")
        else:
            record(state, artifact, gid, "deferred", "upload_failed")
            log(f"  [{gid}] upload deferred")
    except Exception as e:
        record(state, artifact, gid, "failed", f"exception:{e}")
        log(f"  [{gid}] exception: {e}")
    finally:
        if not args.keep:
            ER.clear_working_dir(work_dir)
            ER.clear_working_dir(dl_dir)
            shutil.rmtree(prefix_home, ignore_errors=True)


def setup_template(log):
    if not shutil.which("wine"):
        sys.exit("wine not on PATH — install it first.")
    if not shutil.which("Xvfb"):
        sys.exit("Xvfb not on PATH — install it first.")
    if TEMPLATE_PREFIX.exists():
        shutil.rmtree(TEMPLATE_PREFIX)
    TEMPLATE_PREFIX.mkdir(parents=True)
    disp = 99
    xvfb = start_xvfb(disp)
    if not xvfb:
        sys.exit("could not start Xvfb for setup")
    try:
        log("Booting template WINEPREFIX (first wineboot can take a minute)...")
        env = {**os.environ, "HOME": str(TEMPLATE_PREFIX),
               "WINEPREFIX": str(TEMPLATE_PREFIX / ".wine"),
               "DISPLAY": f":{disp}", "WINEDEBUG": "-all",
               "WINEDLLOVERRIDES": "mscoree,mshtml="}
        subprocess.run(["wine", "wineboot", "-i"], env=env, timeout=300,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["wineserver", "-w"], env=env, timeout=120)
        log(f"Template prefix ready at {TEMPLATE_PREFIX}")
    finally:
        xvfb.terminate()


def main():
    ap = argparse.ArgumentParser(description="Capture cover screenshots for games with none")
    ap.add_argument("--setup", action="store_true", help="build the template WINEPREFIX and exit")
    ap.add_argument("--engine", default=None, help="only this engine (pilot, e.g. 'GameMaker 8')")
    ap.add_argument("--max-games", type=int, default=50)
    ap.add_argument("--max-seconds", type=int, default=0, help="0 = no wall-clock cap")
    ap.add_argument("--max-file-mb", type=int, default=600)
    ap.add_argument("--concurrency", type=int, default=2)
    ap.add_argument("--warmup", type=int, default=10, help="seconds to wait past window before capture")
    ap.add_argument("--no-upload", action="store_true", help="capture locally, don't push to R2")
    ap.add_argument("--no-sandbox", action="store_true", help="run wine without bwrap (debug)")
    ap.add_argument("--keep", action="store_true", help="don't delete work dirs (debug)")
    ap.add_argument("--debug", action="store_true", help="verbose wine + window-poll tracing")
    args = ap.parse_args()

    global DEBUG
    DEBUG = args.debug

    def log(m):
        print(m, flush=True)

    if args.setup:
        setup_template(log)
        return

    for tool in ("wine", "Xvfb", "xdotool", "import", "identify"):
        if not shutil.which(tool):
            sys.exit(f"required tool not on PATH: {tool}")
    if not TEMPLATE_PREFIX.exists():
        sys.exit(f"template prefix missing — run with --setup first ({TEMPLATE_PREFIX})")

    games = load_json(GAMES_PATH, {})
    state = load_json(STATE_PATH, {})
    artifact = load_json(ARTIFACT_PATH, {})
    cands = build_candidates(games, state, args.engine, args.max_file_mb)[: args.max_games]
    log(f"{len(cands)} candidate(s) to capture "
        f"(engine={args.engine or 'all-runnable'}, concurrency={args.concurrency})")
    if not cands:
        return

    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    displays = queue.Queue()
    for i in range(args.concurrency):
        displays.put(90 + i)
    xvfbs = {}
    deadline = time.time() + args.max_seconds if args.max_seconds else None
    stop = threading.Event()

    def worker(gid, game, url):
        if stop.is_set():
            return
        disp = displays.get()
        try:
            if disp not in xvfbs or xvfbs[disp].poll() is not None:
                xvfbs[disp] = start_xvfb(disp)
            if not xvfbs.get(disp):
                record(state, artifact, gid, "deferred", "xvfb_failed")
                return
            process_one(gid, game, url, disp, args, state, artifact, log)
        finally:
            displays.put(disp)

    from concurrent.futures import ThreadPoolExecutor
    try:
        with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
            futs = []
            for gid, game, url in cands:
                if deadline and time.time() >= deadline:
                    log("wall-clock cap reached; stopping submission.")
                    break
                futs.append(ex.submit(worker, gid, game, url))
            for f in futs:
                f.result()
    finally:
        for p in xvfbs.values():
            try:
                p.terminate()
            except Exception:
                pass

    done = sum(1 for v in state.values() if v.get("status") == "success")
    log(f"\nTotals: {done} captured overall | "
        f"this run statuses: {json.dumps(_run_status_counts(state, cands))}")


def _run_status_counts(state, cands):
    from collections import Counter
    ids = {str(gid) for gid, _, _ in cands}
    c = Counter(state[i]["status"] for i in ids if i in state)
    return dict(c)


if __name__ == "__main__":
    main()
