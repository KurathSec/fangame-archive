"""One-time harvest of per-game release dates from Delicious Fruit.

DF stores a release date per game but exposes it NOWHERE directly — not on
game_details.php, not in the full list. The only window into it is the
advanced search's "Released between" filter:

    full.php?advanced=1&from=YYYY-MM-DD&to=YYYY-MM-DD&title=&author=&s=&tags=

which returns ALL matching games in one un-paginated table (verified: a
whole-year window returned 1117 rows in a single response, and the plain full
list serves ~21k rows in one page).

WINDOW SEMANTICS (empirically calibrated 2026-07-22, enforced by the
bootstrap probes below): DF evaluates `released IN (from 00:00, to 00:00]` —
the `from` bound is EXCLUSIVE, the `to` bound INCLUSIVE, and games are stored
at midnight of their release day. Consequences:
  * `from==to` is always empty (the interval contains no instants);
  * the games released ON day D are exactly `query(from=D-1, to=D)`;
  * adjacent day windows are disjoint and their union covers the month.
All windows in this script are therefore expressed as day ranges and issued
as `query(first_day - 1, last_day)`. Dates are recovered by containment:
query months, then days inside non-empty months; a game's date is the
single-day window that contains it.

Reliability contract (per the user's explicit requirement): a failed request
is NEVER treated as "no games in that window". Every window's outcome is
recorded in the state file as done (possibly with 0 games) or failed; a rerun
retries exactly the failed and never-attempted windows, and --finalize
refuses to write the artifact while failures remain (--force overrides with a
loud INCOMPLETE banner). Empty-vs-error discrimination: a 200 response counts
as a real (possibly empty) DF page only if it carries the site footer marker;
anything else (Cloudflare error page, truncated body) is a retryable failure.

The run is resumable: state checkpoints to temp/release_dates_harvest_state.json
(atomic tmp+os.replace) every few windows; Ctrl-C and rerun to continue.

Integrity checks:
  * Bootstrap probes each invocation: window-bound inclusivity (a year equals
    its two disjoint halves), a pre-2007 probe (extends the month range back
    if DF has older dates), and a future-window probe (logged, never emitted).
  * Per month: the union of its day results must cover the month query's ids.
    Missing ids requeue that month's days once (assignments cleared first);
    a second mismatch marks the month bad and blocks --finalize. Extra ids in
    day results (games added to DF mid-run) are logged, not errors.
  * A df_id seen in two different day windows keeps its first date and is
    logged under conflicts; any conflict at finalize is a red flag.

Early exit: once a month's day-union equals its month set, the remaining days
of that month are skipped (saves ~1/3 of the ~7k requests).

Usage:
  python pipelines/harvest_release_dates.py                # harvest / resume
  python pipelines/harvest_release_dates.py --finalize     # write data/release_dates.json
  python pipelines/harvest_release_dates.py --probe FROM TO  # classify one window (debug)
  --delay 1.2   base seconds between requests (plus 0-0.3 jitter)
  --force       finalize despite failed/mismatched windows

Standalone on purpose: plain requests + regex; no imports from the scraper
(its module top-level pulls mega/boto3/config credentials).
"""
import argparse
import calendar
import datetime as dt
import json
import os
import random
import re
import sys
import time

import requests

sys.stdout.reconfigure(encoding="utf-8")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_PATH = os.path.join(REPO_ROOT, "temp", "release_dates_harvest_state.json")
ARTIFACT_PATH = os.path.join(REPO_ROOT, "data", "release_dates.json")

SEARCH_URL = "https://delicious-fruit.com/ratings/full.php"
LIVE_MAP_URL = "https://file.fangame-archive.com/Database/seq_to_orig_map.json"
LIVE_GAMES_URL = "https://file.fangame-archive.com/Database/games.json"
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}

# Present on every genuine DF page (results AND zero-result pages); its absence
# on a 200 means an error/interstitial page -> retryable failure, never empty.
PAGE_MARKER = "Delicious-Fruit"
GAME_LINK_RE = re.compile(r"game_details\.php\?id=(\d+)")

DEFAULT_START = "2007-01"  # IWBTG era; the pre-range probe extends this back
PRE_RANGE = ("1970-01-01", "2006-12-31")
EXTENDED_START = "1990-01"


class WindowError(Exception):
    pass


def fetch_window(date_from, date_to, delay):
    """Raw query: df_ids with release timestamp in (date_from 00:00, date_to 00:00].

    Prefer fetch_days(), which speaks in inclusive day ranges. Raises
    WindowError after all retries; never silently returns empty for a failed
    request.
    """
    params = {
        "advanced": "1", "from": date_from, "to": date_to,
        "title": "", "author": "", "s": "", "tags": "",
    }
    last_err = None
    for attempt, backoff in enumerate([2, 5, 15, 60]):
        time.sleep(delay + random.uniform(0, 0.3))
        try:
            res = requests.get(SEARCH_URL, params=params, headers=HEADERS, timeout=30)
            if res.status_code != 200:
                raise WindowError(f"HTTP {res.status_code}")
            body = res.text
            if PAGE_MARKER not in body:
                raise WindowError("200 without DF page marker (error/interstitial page)")
            return set(GAME_LINK_RE.findall(body))
        except (requests.RequestException, WindowError) as e:
            last_err = e
            time.sleep(backoff)
    raise WindowError(f"window {date_from}..{date_to} failed after retries: {last_err}")


def fetch_days(first_day, last_day, delay):
    """df_ids of games released on the days first_day..last_day INCLUSIVE.

    Wraps the raw (from, to] query as query(first_day - 1, last_day), per the
    calibrated window semantics.
    """
    if isinstance(first_day, str):
        first_day = dt.date.fromisoformat(first_day)
    if isinstance(last_day, str):
        last_day = dt.date.fromisoformat(last_day)
    return fetch_window((first_day - dt.timedelta(days=1)).isoformat(),
                        last_day.isoformat(), delay)


# ── State ────────────────────────────────────────────────────────────────────

def blank_state():
    return {
        "months": {},     # "YYYY-MM" -> {"status": "done", "ids": [...]} | {"status": "failed", "error": s} | {"status": "mismatch"}
        "days": {},       # "YYYY-MM-DD" -> {"status": "done", "ids": [...]} | {"status": "failed", "error": s}
        "dates": {},      # df_id -> "YYYY-MM-DD"
        "conflicts": [],  # {"df_id", "kept", "also"}
        "month_requeued": {},  # "YYYY-MM" -> times the day pass was cleared
        "extended_range": False,
    }


def load_state():
    if os.path.exists(STATE_PATH):
        with open(STATE_PATH, encoding="utf-8") as f:
            return json.load(f)
    return blank_state()


def save_state(state):
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)
    os.replace(tmp, STATE_PATH)


# ── Bootstrap probes ─────────────────────────────────────────────────────────

def bootstrap_probes(state, delay):
    print("Bootstrap probes...")
    # Day-range partition check under the calibrated (from, to] semantics: a
    # year must equal its two disjoint halves. This failing means DF changed
    # its boundary behaviour and every window in this run would be wrong.
    year = fetch_days("2015-01-01", "2015-12-31", delay)
    h1 = fetch_days("2015-01-01", "2015-06-30", delay)
    h2 = fetch_days("2015-07-01", "2015-12-31", delay)
    if not (year == (h1 | h2) and not (h1 & h2)):
        sys.exit(f"[ABORT] Partition probe failed: year={len(year)} h1={len(h1)} "
                 f"h2={len(h2)} overlap={len(h1 & h2)} union={len(h1 | h2)} — "
                 "window semantics differ from the calibrated (from, to] model; harvest unsafe.")
    # The two 2015-07-01-midnight games that exposed the original off-by-one
    # must sit exactly in July's first day.
    jul1 = fetch_days("2015-07-01", "2015-07-01", delay)
    if not ({"15111", "15112"} <= jul1):
        sys.exit("[ABORT] Boundary probe failed: known 2015-07-01 games (15111, 15112) "
                 "not returned by their single-day window — semantics drifted.")
    print(f"  partition OK (2015: {len(year)} games = {len(h1)}+{len(h2)}, disjoint; "
          f"boundary day check passed)")

    pre = fetch_days(*PRE_RANGE, delay)
    if pre and not state.get("extended_range"):
        print(f"  [NOTE] {len(pre)} game(s) dated before 2007 — extending month range back to {EXTENDED_START}.")
        state["extended_range"] = True
    elif pre:
        print(f"  pre-2007 probe: {len(pre)} game(s), range already extended")
    else:
        print("  pre-2007 probe: empty")

    today = dt.date.today()
    future = fetch_days((today + dt.timedelta(days=1)).isoformat(),
                        (today + dt.timedelta(days=5 * 365)).isoformat(), delay)
    if future:
        print(f"  [NOTE] {len(future)} game(s) carry FUTURE release dates on DF: "
              f"{sorted(future)[:10]}{'...' if len(future) > 10 else ''} — they are never emitted.")
    else:
        print("  future probe: empty")


# ── Harvest phases ───────────────────────────────────────────────────────────

def month_range(state):
    start = EXTENDED_START if state.get("extended_range") else DEFAULT_START
    y, m = map(int, start.split("-"))
    today = dt.date.today()
    months = []
    while (y, m) <= (today.year, today.month):
        months.append(f"{y:04d}-{m:02d}")
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return months


def month_bounds(month):
    y, m = map(int, month.split("-"))
    last = calendar.monthrange(y, m)[1]
    return f"{month}-01", f"{month}-{last:02d}", last


def phase_months(state, delay):
    months = month_range(state)
    todo = [m for m in months if state["months"].get(m, {}).get("status") != "done"]
    print(f"\nPhase M: {len(todo)} of {len(months)} month windows to query...")
    since_ckpt = 0
    for month in todo:
        first, last, _ = month_bounds(month)
        try:
            ids = fetch_days(first, last, delay)
            state["months"][month] = {"status": "done", "ids": sorted(ids)}
            print(f"  {month}: {len(ids)} game(s)")
        except WindowError as e:
            state["months"][month] = {"status": "failed", "error": str(e)}
            print(f"  [FAILED] {month}: {e} — recorded for retry, NOT treated as empty")
        since_ckpt += 1
        if since_ckpt >= 5:
            save_state(state)
            since_ckpt = 0
    save_state(state)


def clear_month_days(state, month, month_ids):
    """Requeue a mismatched month: drop its day states and their assignments."""
    for d in list(state["days"]):
        if d.startswith(month + "-"):
            del state["days"][d]
    month_set = set(month_ids)
    state["dates"] = {df: d for df, d in state["dates"].items()
                      if not (d.startswith(month + "-") and df in month_set)}


def phase_days(state, delay):
    months_done = [(m, e["ids"]) for m, e in sorted(state["months"].items())
                   if e.get("status") == "done" and e.get("ids")]
    print(f"\nPhase D: day windows inside {len(months_done)} non-empty months...")
    since_ckpt = 0
    for month, month_ids in months_done:
        month_set = set(month_ids)
        first, last, ndays = month_bounds(month)
        # Skip months whose ids are all dated already (fully processed or
        # early-exited on a previous run).
        day_keys = [f"{month}-{i:02d}" for i in range(1, ndays + 1)]
        if month_set <= set(state["dates"]) and \
                not any(state["days"].get(d, {}).get("status") == "failed" for d in day_keys):
            continue

        union = set()
        for d in day_keys:
            entry = state["days"].get(d)
            if entry and entry.get("status") == "done":
                union |= set(entry["ids"])
                continue
            if union >= month_set:
                # Every id from the month query is dated — remaining days can
                # only contain games added to DF mid-run; the CI sweep will
                # date those. Mark skipped days done-empty-by-inference? No:
                # leave them unattempted (absent) so a --thorough rerun could
                # still probe them; just stop querying.
                break
            try:
                ids = fetch_days(d, d, delay)
                state["days"][d] = {"status": "done", "ids": sorted(ids)}
                union |= ids
                for df in ids:
                    prev = state["dates"].get(df)
                    if prev is None:
                        state["dates"][df] = d
                    elif prev != d:
                        state["conflicts"].append({"df_id": df, "kept": prev, "also": d})
                        print(f"  [CONFLICT] df {df}: kept {prev}, also seen {d}")
                if ids:
                    print(f"  {d}: {len(ids)}")
            except WindowError as e:
                state["days"][d] = {"status": "failed", "error": str(e)}
                print(f"  [FAILED] {d}: {e} — recorded for retry, NOT treated as empty")
            since_ckpt += 1
            if since_ckpt >= 10:
                save_state(state)
                since_ckpt = 0

        # Cross-check (only when no day in the month is in failed state —
        # failures already block finalize and will be retried first).
        month_failed = any(state["days"].get(d, {}).get("status") == "failed" for d in day_keys)
        if not month_failed:
            missing = month_set - union
            extra = union - month_set
            if extra:
                print(f"  [DRIFT] {month}: {len(extra)} id(s) in day results but not the month "
                      f"query (added to DF mid-run) — kept.")
            if missing:
                times = state["month_requeued"].get(month, 0)
                if times < 1:
                    print(f"  [MISMATCH] {month}: {len(missing)} id(s) in month query missing from "
                          f"day union — clearing this month's days and requeuing once.")
                    clear_month_days(state, month, month_ids)
                    state["month_requeued"][month] = times + 1
                    save_state(state)
                else:
                    print(f"  [MISMATCH-FATAL] {month}: still missing {sorted(missing)[:10]} after "
                          f"requeue — marked bad; finalize will refuse.")
                    state["months"][month]["status"] = "mismatch"
    save_state(state)


# ── Reporting / finalize ─────────────────────────────────────────────────────

def outstanding(state):
    failed_m = [m for m, e in state["months"].items() if e.get("status") == "failed"]
    bad_m = [m for m, e in state["months"].items() if e.get("status") == "mismatch"]
    failed_d = [d for d, e in state["days"].items() if e.get("status") == "failed"]
    missing_m = [m for m in month_range(state) if m not in state["months"]]
    # A done month whose ids aren't all dated yet = day pass incomplete
    # (interrupted run). Early-exit always leaves month ids fully dated, so
    # this only fires on genuine interruptions.
    dated = set(state["dates"])
    incomplete_m = [m for m, e in state["months"].items()
                    if e.get("status") == "done" and e.get("ids")
                    and not set(e["ids"]) <= dated and m not in bad_m]
    return failed_m, bad_m, failed_d, missing_m, incomplete_m


def print_status(state):
    failed_m, bad_m, failed_d, missing_m, incomplete_m = outstanding(state)
    print(f"\nState: {len(state['dates'])} games dated | "
          f"{sum(1 for e in state['months'].values() if e.get('status') == 'done')} months done | "
          f"{len(failed_m)} month-failures | {len(failed_d)} day-failures | "
          f"{len(bad_m)} mismatched months | {len(missing_m)} months unattempted | "
          f"{len(incomplete_m)} months day-incomplete | {len(state['conflicts'])} conflicts")
    if failed_m:
        print(f"  failed months: {sorted(failed_m)}")
    if failed_d:
        print(f"  failed days: {sorted(failed_d)[:20]}{'...' if len(failed_d) > 20 else ''}")
    if bad_m:
        print(f"  mismatched months: {sorted(bad_m)}")
    if incomplete_m:
        print(f"  day-incomplete months: {sorted(incomplete_m)}")


def valid_date(s):
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", s or ""):
        return False
    try:
        d = dt.date.fromisoformat(s)
    except ValueError:
        return False
    return dt.date(2000, 1, 1) <= d <= dt.date.today()


def finalize(state, force):
    failed_m, bad_m, failed_d, missing_m, incomplete_m = outstanding(state)
    problems = len(failed_m) + len(bad_m) + len(failed_d) + len(missing_m) + len(incomplete_m)
    if problems and not force:
        print_status(state)
        sys.exit(f"\n[REFUSED] {problems} window problem(s) outstanding — rerun to retry them, "
                 "or --force to write an INCOMPLETE artifact anyway.")
    if problems:
        print(f"\n{'!' * 70}\n! INCOMPLETE HARVEST — {problems} window problem(s) overridden by --force\n{'!' * 70}")
    if state["conflicts"]:
        print(f"[WARNING] {len(state['conflicts'])} date conflict(s) recorded — first-seen kept; investigate:")
        for c in state["conflicts"][:10]:
            print(f"  df {c['df_id']}: kept {c['kept']}, also {c['also']}")

    dates = {df: d for df, d in state["dates"].items() if valid_date(d)}
    dropped = len(state["dates"]) - len(dates)
    if dropped:
        print(f"[WARNING] dropped {dropped} invalid/future date(s)")

    artifact = {
        "harvested_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "delicious-fruit advanced search (Released between)",
        "dates": dict(sorted(dates.items(), key=lambda kv: int(kv[0]))),
    }
    tmp = ARTIFACT_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(artifact, f, ensure_ascii=False, indent=1)
    os.replace(tmp, ARTIFACT_PATH)
    print(f"\nWrote {len(dates)} dates -> {ARTIFACT_PATH}")

    # Coverage report vs the LIVE catalog (best-effort; local copies are stale).
    try:
        seq_map = requests.get(LIVE_MAP_URL, headers=HEADERS, timeout=60).json()
        games = requests.get(LIVE_GAMES_URL, headers=HEADERS, timeout=120).json()
        df_mapped_live = {str(v[0]): s for s, v in seq_map.items()
                         if isinstance(v, list) and v and str(v[0]).isdigit() and s in games}
        covered = sum(1 for df in df_mapped_live if df in dates)
        print(f"Coverage: {covered}/{len(df_mapped_live)} DF-mapped live games "
              f"({100 * covered / max(1, len(df_mapped_live)):.1f}%) | catalog total {len(games)}")
        year_hist = {}
        for df in df_mapped_live:
            if df in dates:
                year_hist[dates[df][:4]] = year_hist.get(dates[df][:4], 0) + 1
        print("Per-year (mapped live games): " +
              ", ".join(f"{y}:{n}" for y, n in sorted(year_hist.items())))
    except Exception as e:
        print(f"[WARNING] coverage report skipped (live catalog fetch failed: {e})")


def main():
    ap = argparse.ArgumentParser(description="Harvest DF release dates via windowed advanced search")
    ap.add_argument("--delay", type=float, default=1.2, help="base seconds between requests")
    ap.add_argument("--finalize", action="store_true", help="write data/release_dates.json from state")
    ap.add_argument("--force", action="store_true", help="finalize despite outstanding failures")
    ap.add_argument("--probe", nargs=2, metavar=("FROM", "TO"), help="classify one window and exit")
    ap.add_argument("--status", action="store_true", help="print state summary and exit")
    args = ap.parse_args()

    state = load_state()

    if args.probe:
        ids = fetch_days(args.probe[0], args.probe[1], args.delay)
        print(f"days {args.probe[0]}..{args.probe[1]} (inclusive): {len(ids)} game(s)")
        print(sorted(ids, key=int)[:50])
        return
    if args.status:
        print_status(state)
        return
    if args.finalize:
        finalize(state, args.force)
        return

    bootstrap_probes(state, args.delay)
    save_state(state)
    phase_months(state, args.delay)
    phase_days(state, args.delay)
    print_status(state)
    failed_m, bad_m, failed_d, missing_m, incomplete_m = outstanding(state)
    if failed_m or failed_d or bad_m or missing_m or incomplete_m:
        print("\nRerun this script to retry the failed/incomplete windows, then --finalize.")
    else:
        print("\nHarvest complete — run with --finalize to write the artifact.")


if __name__ == "__main__":
    main()
