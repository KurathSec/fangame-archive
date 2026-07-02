"""Engine recognition for the Fangame Archive catalog (Linux/CI port).

Detects the game engine of a fangame from its distributed archive/exe and maps
it to the clean, user-facing engine names introduced in v2026.009 (the same
names `backfill_engine.py` wrote from the operator's local recognition CSV).

This is a faithful port of the detection core of the operator's local Windows
tool (`recognize_fangame_archive.py`), adapted for the CI sync pipeline:

  * Linux tooling: `7zz`/`7z`/`7za` and `upx` are resolved from PATH (installed
    via apt in `.github/workflows/deploy.yml`). Byte-content searches use pure
    Python streaming instead of ripgrep, so no `rg` dependency.
  * Simplified where it cannot change the resulting *engine name*:
      - GMS is split into GMS1/GMS2 from the data.win GEN8 major version (plus
        GMS2-only chunk markers); the fine-grained 2022.x/2023.x refinements of
        the local tool are irrelevant to the engine label.
      - Delphi sub-versioning (GM5.3/6/7/8) is dropped: every Delphi-compiled
        game maps to "GameMaker 8" exactly like the one-time backfill did.
  * Case-insensitive filesystem probes (data.win, *_Data, Games/) because CI
    runs on a case-sensitive filesystem.

Used by `scrape_and_migrate_new_games.py` in two places:
  1. Inline: a freshly downloaded new game is recognized while its file is
     still local (zero extra bandwidth), before the temp file is deleted.
  2. Backlog sweep: a bounded number of R2-hosted catalog games still missing
     `engine` are downloaded and recognized each run. Attempts are recorded in
     `data/engine_recognition_state.json` (synced to R2 as
     `Database/engine_recognition_state.json` by `sync_db_r2.py`) so a game is
     never re-downloaded after a definitive success/failure.

CLI (manual use):
  python pipelines/engine_recognition.py --file <path>      # recognize one file
  python pipelines/engine_recognition.py --seed-state       # seed state from games.json
  python pipelines/engine_recognition.py --sweep [--max N]  # manual backlog sweep
"""
import argparse
import json
import os
import shutil
import stat
import struct
import subprocess
import sys
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path

# ── Tooling ──────────────────────────────────────────────────────────────────
SEVEN_ZIP = shutil.which("7zz") or shutil.which("7z") or shutil.which("7za")
UPX = shutil.which("upx")

# ── Limits (mirroring the local tool) ────────────────────────────────────────
UPX_SCAN_BYTES = 4096
CABINET_SCAN_BYTES = 4096
HTML5_BINARY_SCAN_BYTES = 128 * 1024 * 1024
HTML5_TEXT_SCAN_BYTES = 16 * 1024 * 1024
EXTRACT_TIMEOUT_SECONDS = 120
LIST_TIMEOUT_SECONDS = 30
MAX_NESTED_ARCHIVE_DEPTH = 2
STREAM_CHUNK_BYTES = 8 * 1024 * 1024

# GMS2-only data.win chunk names: any of these forces the GMS2 label even if
# the GEN8 version field is a stale 1.x (defensive; normally GEN8 major is 2).
GMS2_CHUNK_MARKERS = ("UILR", "PSEM", "FEAT", "FEDS", "SEQN", "TGIN")

# ── Engine name mapping (single source of truth; backfill_engine imports it) ─
# Raw detector signature (main_version) -> clean, user-facing engine name.
ENGINE_MAP = {
    "Delphi":              "GameMaker 8",       # classic GM 8.0/8.1 (Delphi-compiled)
    "GameMakerEarly":      "GameMaker 8",       # GM6/7-era, negligible count
    "project":             "GameMaker 8",       # .gmk/.gm81 source projects (8.x era)
    "GMS1":                "GameMaker: Studio",
    "GMS2":                "GameMaker: Studio 2",
    "MMF2":                "Multimedia Fusion 2",
    "ConstructClassic":    "Construct",
    "Construct/NW.js":     "Construct",
    "Godot":               "Godot",
    "Unity":               "Unity",
    "Flash":               "Flash",
    "GDevelop/Electron":   "GDevelop",
    "Scratch/Electron":    "Scratch",
    "RPG Maker MV/NW.js":  "RPG Maker MV",
    "Android":             "Android",
    "ciw":                 "CIW",
}


def map_engine(main_version):
    """Map a raw detector signature to a clean engine name.

    Unknown/empty signatures fall back to the raw string so nothing is silently
    dropped; blanks yield None (treated as unknown by the UI)."""
    mv = (main_version or "").strip()
    if not mv:
        return None
    return ENGINE_MAP.get(mv, mv)


# ── Paths / state ────────────────────────────────────────────────────────────
REPO_ROOT = Path(__file__).resolve().parent.parent
STATE_PATH = REPO_ROOT / "data" / "engine_recognition_state.json"
STATE_R2_KEY = "Database/engine_recognition_state.json"  # keep in sync with sync_db_r2.DB_FILES
GAMES_PATH = REPO_ROOT / "data" / "games.json"
PUBLIC_DOMAIN = "https://file.fangame-archive.com"
BUCKET_NAME = "fangame-files"
# The operator's local Windows scan covered catalog ids 1..21068 (v2026.009
# backfill). Ids at or below this without an engine already failed a scan with
# full local tooling, so the CI sweep must not re-download them.
LOCAL_SCAN_MAX_ID = 21068


def r2_state_exists(r2_client):
    """Whether the attempt-state object exists in R2: True/False, or None when
    it cannot be determined (network error). Used to distinguish a genuine
    first run (seed) from a transient download failure (do NOT seed, or the
    later upload would wipe the real attempt history)."""
    try:
        r2_client.head_object(Bucket=BUCKET_NAME, Key=STATE_R2_KEY)
        return True
    except Exception as exc:
        resp = getattr(exc, "response", None)
        if isinstance(resp, dict):
            code = str(resp.get("Error", {}).get("Code", ""))
            status = resp.get("ResponseMetadata", {}).get("HTTPStatusCode")
            if code in ("404", "NoSuchKey", "NotFound") or status == 404:
                return False
        return None


def load_state(path=STATE_PATH):
    path = Path(path)
    if not path.exists():
        return {}
    try:
        with path.open(encoding="utf-8") as f:
            state = json.load(f)
        return state if isinstance(state, dict) else {}
    except Exception:
        return {}


def save_state(state, path=STATE_PATH):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)
    os.replace(tmp, path)


# Failures caused by the machine, not the game: recorded as "deferred" (retried
# on a later run, e.g. once CI has the tools) instead of a permanent "failed".
ENVIRONMENT_ERRORS = {"missing_7z", "missing_upx"}


def record_attempt(state, game_id, result, source):
    status = result.get("status", "failed")
    if status == "failed" and result.get("error") in ENVIRONMENT_ERRORS:
        status = "deferred"
    state[str(game_id)] = {
        "status": status,
        "engine": result.get("engine") or "",
        "main_version": result.get("main_version", ""),
        "error": result.get("error", ""),
        "source": source,
        "ts": int(time.time()),
    }


# ── Filesystem helpers ───────────────────────────────────────────────────────
def _force_writable(path):
    try:
        os.chmod(path, stat.S_IWRITE | stat.S_IREAD | stat.S_IEXEC)
    except OSError:
        pass


def clear_working_dir(working_dir):
    working_dir = Path(working_dir)
    working_dir.mkdir(parents=True, exist_ok=True)
    for item in list(working_dir.iterdir()):
        if item.is_dir() and not item.is_symlink():
            shutil.rmtree(item, ignore_errors=True)
            if item.exists():
                # Archives sometimes extract dirs without +x; fix and retry once.
                for root, dirs, files in os.walk(item):
                    for name in dirs + files:
                        _force_writable(os.path.join(root, name))
                _force_writable(item)
                shutil.rmtree(item, ignore_errors=True)
        else:
            try:
                item.unlink()
            except OSError:
                _force_writable(item)
                try:
                    item.unlink()
                except OSError:
                    pass


def remove_tree_if_exists(path):
    path = Path(path)
    if not path.exists():
        return
    clear_working_dir(path)
    try:
        path.rmdir()
    except OSError:
        shutil.rmtree(path, ignore_errors=True)


def find_unique_file(path):
    files = [item for item in Path(path).iterdir() if item.is_file()]
    return files[0] if len(files) == 1 else None


def find_exes(path):
    return sorted(
        item for item in Path(path).rglob("*")
        if item.is_file() and item.suffix.lower() == ".exe"
    )


def find_adjacent_data_win(exe_path):
    for item in Path(exe_path).parent.iterdir():
        if item.is_file() and item.name.lower() == "data.win":
            return item
    return None


def find_exes_with_adjacent_data_win(path):
    return [
        exe
        for exe in find_exes(path)
        if exe.name.lower() != "uninstall.exe" and find_adjacent_data_win(exe) is not None
    ]


def ci_child(parent, name):
    """Case-insensitive lookup of a direct child of `parent`."""
    parent = Path(parent)
    if not parent.is_dir():
        return None
    lowered = name.lower()
    for item in parent.iterdir():
        if item.name.lower() == lowered:
            return item
    return None


# ── Byte-content searching (pure Python, replaces ripgrep) ───────────────────
def find_tokens(path, tokens, limit=None, lower=False):
    """Stream a file and return the subset of `tokens` (bytes) found in it.

    Reads at most `limit` bytes when given. `lower=True` lowercases both the
    data and the tokens (ASCII), matching the local tool's case-insensitive
    HTML5-evidence checks; otherwise matching is case-sensitive like rg -F."""
    tokens = [t.lower() if lower else t for t in tokens]
    pending = set(tokens)
    if not pending:
        return set()
    overlap = max(len(t) for t in pending) - 1
    found = set()
    read_total = 0
    tail = b""
    try:
        with Path(path).open("rb") as f:
            while pending:
                to_read = STREAM_CHUNK_BYTES
                if limit is not None:
                    if read_total >= limit:
                        break
                    to_read = min(to_read, limit - read_total)
                chunk = f.read(to_read)
                if not chunk:
                    break
                read_total += len(chunk)
                buf = tail + (chunk.lower() if lower else chunk)
                for t in list(pending):
                    if t in buf:
                        found.add(t)
                        pending.discard(t)
                tail = buf[-overlap:] if overlap > 0 else b""
    except OSError:
        return found
    return found


def file_contains_any(path, tokens, limit=None, lower=False):
    return bool(find_tokens(path, tokens, limit=limit, lower=lower))


def file_contains_all(path, tokens, limit=None, lower=False):
    return len(find_tokens(path, tokens, limit=limit, lower=lower)) == len(set(
        t.lower() if lower else t for t in tokens
    ))


def read_limited_lower(path, byte_count):
    with Path(path).open("rb") as f:
        return f.read(byte_count).lower()


def contains_all(data, tokens):
    return all(token.lower() in data for token in tokens)


def contains_any(data, tokens):
    return any(token.lower() in data for token in tokens)


# ── 7-Zip extraction ─────────────────────────────────────────────────────────
def run_7z_extract(source, output_dir):
    if not SEVEN_ZIP:
        return False, "missing_7z"

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        result = subprocess.run(
            [SEVEN_ZIP, "x", "-y", "-p", f"-o{output_dir}", str(source)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=EXTRACT_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return False, "extract_timeout"

    if result.returncode == 0:
        return True, ""
    output = (result.stdout + result.stderr).decode("utf-8", errors="ignore")
    if "Wrong password" in output or "Can not open encrypted archive" in output:
        return False, "extract_password_required"
    return False, "extract_failed"


def extract_zip_with_leading_junk_if_needed(source, working_dir):
    source = Path(source)
    with source.open("rb") as f:
        header = f.read(1024 * 1024)

    if header.startswith(b"PK\x03\x04"):
        return False, "extract_leading_junk_not_found"

    zip_offset = header.find(b"PK\x03\x04")
    if zip_offset <= 0:
        return False, "extract_leading_junk_not_found"

    repaired_zip = Path(working_dir) / "_repaired_leading_junk.zip"
    with source.open("rb") as src, repaired_zip.open("wb") as dst:
        src.seek(zip_offset)
        shutil.copyfileobj(src, dst)

    return run_7z_extract(repaired_zip, working_dir)


def list_archive_paths(source):
    if not SEVEN_ZIP:
        return []
    try:
        result = subprocess.run(
            [SEVEN_ZIP, "l", "-slt", str(source)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=LIST_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return []
    if result.returncode not in (0, 1):
        return []

    paths = []
    for raw_line in result.stdout.decode("utf-8", errors="ignore").splitlines():
        line = raw_line.strip()
        if line.startswith("Path = "):
            paths.append(line[len("Path = "):].replace("\\", "/").lower())
    return paths


def has_archive_path_token(source, tokens):
    paths = list_archive_paths(source)
    return any(any(token.lower() in path for token in tokens) for path in paths)


def is_supported_archive_source(source):
    source = Path(source)
    suffix = source.suffix.lower()
    if suffix in {".zip", ".rar", ".7z", ".1", ".2", ".lzh"}:
        return True

    try:
        with source.open("rb") as f:
            header = f.read(8)
    except OSError:
        return False
    return (
        header.startswith(b"PK\x03\x04")
        or header.startswith(b"Rar!\x1a\x07")
        or header.startswith(b"7z\xbc\xaf\x27\x1c")
    )


def find_supported_archives(path):
    return sorted(
        item
        for item in Path(path).rglob("*")
        if item.is_file()
        and item.name != "_repaired_leading_junk.zip"
        and is_supported_archive_source(item)
    )


def extract_nested_archive_if_no_exe(working_dir):
    working_dir = Path(working_dir)
    for _depth in range(MAX_NESTED_ARCHIVE_DEPTH):
        if find_exes(working_dir):
            return ""

        nested_archives = find_supported_archives(working_dir)
        if not nested_archives:
            return ""
        if len(nested_archives) != 1:
            return "nested_archive_count"

        nested_archive = nested_archives[0]
        nested_dir = nested_archive.parent / f"{nested_archive.stem}_nested_extract"
        if nested_dir.exists():
            remove_tree_if_exists(nested_dir)

        ok, error = run_7z_extract(nested_archive, nested_dir)
        if error == "extract_password_required":
            return error
        if not ok and not find_exes(nested_dir):
            return error

    return ""


# ── UPX ──────────────────────────────────────────────────────────────────────
def has_upx_signature(exe_path):
    try:
        with Path(exe_path).open("rb") as f:
            head = f.read(UPX_SCAN_BYTES)
    except OSError:
        return False
    return b"UPX" in head


def unpack_upx_if_needed(exe_path):
    if not has_upx_signature(exe_path):
        return exe_path, ""

    if not UPX:
        return None, "missing_upx"

    result = subprocess.run(
        [UPX, "-d", str(exe_path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if result.returncode != 0:
        return None, "upx_unpack_failed"

    return exe_path, ""


# ── PE parsing ───────────────────────────────────────────────────────────────
def read_pe_header(data):
    if len(data) < 0x40 or data[:2] != b"MZ":
        return None, None, "not_pe"

    pe_offset = struct.unpack_from("<I", data, 0x3C)[0]
    if pe_offset + 24 > len(data) or data[pe_offset:pe_offset + 4] != b"PE\0\0":
        return None, None, "bad_pe_header"

    file_header = pe_offset + 4
    timestamp = struct.unpack_from("<I", data, file_header + 4)[0]
    return pe_offset, timestamp, ""


def is_pe_file(exe_path):
    try:
        with Path(exe_path).open("rb") as f:
            head = f.read(0x40)
            if len(head) < 0x40 or head[:2] != b"MZ":
                return False, "not_pe"
            pe_offset = struct.unpack_from("<I", head, 0x3C)[0]
            f.seek(pe_offset)
            signature = f.read(24)
    except OSError:
        return False, "not_pe"
    if len(signature) < 24 or signature[:4] != b"PE\0\0":
        return False, "bad_pe_header"
    return True, ""


def get_pe_overlay_offset(data):
    pe_offset, _timestamp, error = read_pe_header(data)
    if error or pe_offset is None:
        return None

    file_header = pe_offset + 4
    number_of_sections = struct.unpack_from("<H", data, file_header + 2)[0]
    optional_header_size = struct.unpack_from("<H", data, file_header + 16)[0]
    section_table = file_header + 20 + optional_header_size
    overlay_offset = 0

    for index in range(number_of_sections):
        section = section_table + index * 40
        if section + 40 > len(data):
            return None
        raw_size = struct.unpack_from("<I", data, section + 16)[0]
        raw_pointer = struct.unpack_from("<I", data, section + 20)[0]
        overlay_offset = max(overlay_offset, raw_pointer + raw_size)

    if overlay_offset >= len(data):
        return None
    return overlay_offset


# ── Sinchi loader (Rust wrapper around a real game exe in the PE overlay) ────
@dataclass
class PreparedExe:
    path: "Path | None"
    error: str
    is_sinchi: bool = False


def read_sinchi_name(data, offset):
    if offset >= len(data):
        return None
    name_length = data[offset]
    next_offset = offset + 1 + name_length
    if name_length == 0 or next_offset > len(data):
        return None

    raw_name = data[offset + 1:next_offset]
    if any(byte < 0x20 or byte > 0x7E for byte in raw_name):
        return None
    return raw_name.decode("ascii"), next_offset


def extract_sinchi_loader_exe_if_needed(exe_path, working_dir):
    data = Path(exe_path).read_bytes()
    if b"src/runner.rs" not in data or b"LOCALAPPDATA" not in data:
        return PreparedExe(exe_path, "")

    overlay_offset = get_pe_overlay_offset(data)
    if overlay_offset is None:
        return PreparedExe(exe_path, "")

    root = read_sinchi_name(data, overlay_offset)
    if root is None:
        return PreparedExe(exe_path, "")

    cursor = root[1]
    while cursor < len(data):
        entry_name_result = read_sinchi_name(data, cursor)
        if entry_name_result is None:
            break

        entry_name, cursor = entry_name_result
        if cursor + 4 > len(data):
            break

        entry_size = struct.unpack_from("<I", data, cursor)[0]
        entry_data_offset = cursor + 4
        entry_data_end = entry_data_offset + entry_size
        if entry_data_end > len(data):
            break

        if entry_name.lower().endswith(".exe") and data[entry_data_offset:entry_data_offset + 2] == b"MZ":
            clear_working_dir(working_dir)
            inner_exe = Path(working_dir) / Path(entry_name).name
            inner_exe.write_bytes(data[entry_data_offset:entry_data_end])
            return PreparedExe(inner_exe, "", True)

        cursor = entry_data_end

    return PreparedExe(exe_path, "")


def is_sinchi_loader_exe(exe_path):
    data = Path(exe_path).read_bytes()
    if b"src/runner.rs" not in data or b"LOCALAPPDATA" not in data:
        return False
    overlay_offset = get_pe_overlay_offset(data)
    if overlay_offset is None:
        return False
    return read_sinchi_name(data, overlay_offset) is not None


# ── Embedded archive exe (installer/cabinet wrapping the real game) ──────────
def has_cabinet_signature(exe_path):
    try:
        with Path(exe_path).open("rb") as f:
            head = f.read(CABINET_SCAN_BYTES)
    except OSError:
        return False
    return b"CABINET" in head


def extract_embedded_archive_exe_if_needed(exe_path, working_dir):
    working_dir = Path(working_dir)
    has_cabinet = has_cabinet_signature(exe_path)

    extract_dir = working_dir.parent / f"{working_dir.name}_embedded_tmp"
    if extract_dir.exists():
        remove_tree_if_exists(extract_dir)

    ok, error = run_7z_extract(exe_path, extract_dir)
    if not ok:
        if extract_dir.exists():
            remove_tree_if_exists(extract_dir)
        if error == "extract_timeout":
            return None, error
        return (None, error) if has_cabinet else (exe_path, "")

    extracted_exes = find_exes(extract_dir)
    extracted_data_win = [
        item for item in extract_dir.rglob("*")
        if item.is_file() and item.name.lower() == "data.win"
    ]
    if not extracted_exes or not extracted_data_win:
        remove_tree_if_exists(extract_dir)
        return exe_path, ""

    clear_working_dir(working_dir)
    final_dir = working_dir / "embedded_archive"
    shutil.move(str(extract_dir), str(final_dir))

    final_exes = find_exes_with_adjacent_data_win(final_dir)
    if len(final_exes) != 1:
        return None, "embedded_archive_exe_count"
    return final_exes[0], ""


# ── Exe preparation pipeline ─────────────────────────────────────────────────
def prepare_exe_from_working_dir(working_dir):
    nested_error = extract_nested_archive_if_no_exe(working_dir)
    if nested_error:
        return PreparedExe(None, nested_error)

    exes = find_exes(working_dir)
    if len(exes) != 1:
        if not exes:
            return PreparedExe(None, "no_exe")
        sinchi_exes = [exe for exe in exes if is_sinchi_loader_exe(exe)]
        if len(sinchi_exes) != 1:
            return PreparedExe(None, "archive_exe_count")
        exes = sinchi_exes

    exe_path, error = extract_embedded_archive_exe_if_needed(exes[0], working_dir)
    if exe_path is None or error:
        return PreparedExe(exe_path, error)
    return extract_sinchi_loader_exe_if_needed(exe_path, working_dir)


def prepare_game_exe(source, working_dir):
    """Extract/copy a single downloaded game file and locate its main exe."""
    source = Path(source)
    working_dir = Path(working_dir)
    clear_working_dir(working_dir)

    suffix = source.suffix.lower()
    if is_supported_archive_source(source):
        ok, error = run_7z_extract(source, working_dir)
        if error == "extract_password_required":
            return PreparedExe(None, error)
        # Some archives are tolerated by tools like 360 Zip but make 7z return
        # a warning/error code. If the only exe was still extracted, keep going.
        exes = find_exes(working_dir)
        if not ok and not exes and suffix == ".zip":
            original_error = error
            ok, error = extract_zip_with_leading_junk_if_needed(source, working_dir)
            if error == "extract_leading_junk_not_found":
                error = original_error
            exes = find_exes(working_dir)
            if error == "extract_password_required":
                return PreparedExe(None, error)
        if not exes:
            nested_error = extract_nested_archive_if_no_exe(working_dir)
            if nested_error:
                return PreparedExe(None, nested_error)
            exes = find_exes(working_dir)
        if not ok and not exes:
            return PreparedExe(None, error)

        return prepare_exe_from_working_dir(working_dir)

    if suffix == ".exe":
        work_exe = working_dir / source.name
        shutil.copy2(source, work_exe)
        exe_path, error = extract_embedded_archive_exe_if_needed(work_exe, working_dir)
        if exe_path is None or error:
            return PreparedExe(exe_path, error)
        return extract_sinchi_loader_exe_if_needed(exe_path, working_dir)

    return PreparedExe(None, "unsupported_source_format")


# ── Engine detectors ─────────────────────────────────────────────────────────
def detect_main_version(exe_path):
    """First-stage split: ciw / Delphi (GM8-era) / GMS, via runtime strings."""
    found = find_tokens(exe_path, [
        b"VicklleallCloud I Wanna Runner",
        b"DelphiApplication",
        b"window_device",
    ])
    if b"VicklleallCloud I Wanna Runner" in found:
        return "ciw", ""
    if b"DelphiApplication" in found:
        return "Delphi", ""
    if b"window_device" in found:
        return "GMS", ""
    return "unknown", "main_version_unknown"


def detect_mmf2_version(exe_path):
    tokens = []
    for text in ("Multimedia Fusion Application Runtime", "Clickteam", "mmfs2.dll"):
        tokens.append(text.encode("ascii"))
        tokens.append(text.encode("utf-16le"))
    if file_contains_any(exe_path, tokens):
        return "MMF2", ""
    found = find_tokens(exe_path, [b".mfx", b".mfa"])
    if len(found) == 2:
        return "MMF2", ""
    return "", "main_version_unknown"


def detect_unity_version(exe_path):
    exe_path = Path(exe_path)
    data_dir = ci_child(exe_path.parent, f"{exe_path.stem}_Data")
    if data_dir is None or not data_dir.is_dir():
        return "", "main_version_unknown"

    managed = ci_child(data_dir, "Managed")
    mono = ci_child(data_dir, "Mono")
    strong_markers = [
        ci_child(managed, "UnityEngine.dll") if managed else None,
        ci_child(mono, "mono.dll") if mono else None,
        ci_child(data_dir, "mainData"),
        ci_child(data_dir, "resources.assets"),
    ]
    if any(marker is not None for marker in strong_markers):
        return "Unity", ""

    for item in data_dir.iterdir():
        name = item.name.lower()
        if name.startswith("sharedassets") and name.endswith(".assets"):
            return "Unity", ""

    return "", "main_version_unknown"


def iter_html5_evidence_files(exe_path):
    game_dir = Path(exe_path).parent
    evidence_names = {
        "app.asar",
        "package.nw",
        "package.json",
        "index.html",
        "script.js",
        "project.json",
        "data.js",
        "c2runtime.js",
        "c3runtime.js",
        "rpg_core.js",
        "rpg_managers.js",
        "plugins.js",
        "main.js",
        "license.gdevelop.txt",
    }
    evidence_files = []
    seen = set()
    for item in game_dir.rglob("*"):
        if not item.is_file():
            continue
        name = item.name.lower()
        if name not in evidence_names:
            continue
        if item in seen:
            continue
        seen.add(item)
        evidence_files.append(item)
    return evidence_files


def evidence_file_bytes(path):
    path = Path(path)
    size = path.stat().st_size
    limit = HTML5_BINARY_SCAN_BYTES if path.name.lower() in {"app.asar", "package.nw"} else HTML5_TEXT_SCAN_BYTES
    if size > limit:
        return b""
    return read_limited_lower(path, limit)


def detect_gdevelop_electron_version(exe_path):
    for evidence_file in iter_html5_evidence_files(exe_path):
        if evidence_file.name.lower() == "license.gdevelop.txt":
            return "GDevelop/Electron", ""
        data = evidence_file_bytes(evidence_file)
        if contains_any(data, [b"gdjs.runtimegame", b"gdevelop"]):
            return "GDevelop/Electron", ""

    if file_contains_any(exe_path, [b"gdjs.runtimegame", b"gdevelop"],
                         limit=HTML5_BINARY_SCAN_BYTES, lower=True):
        return "GDevelop/Electron", ""

    return "", "main_version_unknown"


def detect_rpgmaker_mv_version(exe_path):
    exe_path = Path(exe_path)
    for evidence_file in iter_html5_evidence_files(exe_path):
        name = evidence_file.name.lower()
        if name in {"rpg_core.js", "rpg_managers.js"}:
            return "RPG Maker MV/NW.js", ""
        data = evidence_file_bytes(evidence_file)
        if contains_any(data, [b"rpg maker", b"rpgmv", b".rpgmvp"]):
            return "RPG Maker MV/NW.js", ""

    package_nw = ci_child(exe_path.parent, "package.nw")
    if package_nw is not None and package_nw.is_file() and has_archive_path_token(
        package_nw, ["rpg_core.js", "rpg_managers.js", ".rpgmvp"]
    ):
        return "RPG Maker MV/NW.js", ""

    if file_contains_any(exe_path, [b"rpg maker", b"rpgmv", b".rpgmvp"],
                         limit=HTML5_BINARY_SCAN_BYTES, lower=True):
        return "RPG Maker MV/NW.js", ""

    return "", "main_version_unknown"


def detect_scratch_electron_version(exe_path):
    required_sets = [
        [b"window.scaffolding", b"scratch-vm"],
        [b"window.scaffolding", b"project_run_start", b"vm.greenflag"],
    ]
    for evidence_file in iter_html5_evidence_files(exe_path):
        data = evidence_file_bytes(evidence_file)
        if any(contains_all(data, required) for required in required_sets):
            return "Scratch/Electron", ""

    all_tokens = sorted({t for req in required_sets for t in req})
    found = find_tokens(exe_path, all_tokens, limit=HTML5_BINARY_SCAN_BYTES, lower=True)
    if any(all(t in found for t in required) for required in required_sets):
        return "Scratch/Electron", ""

    return "", "main_version_unknown"


def detect_construct_nwjs_version(exe_path):
    exe_path = Path(exe_path)
    construct_runtime_sets = [
        [b"c2runtime.js", b"scirra"],
        [b"c3runtime.js", b"construct"],
        [b"cr_getc2runtime", b"scirra"],
    ]
    for evidence_file in iter_html5_evidence_files(exe_path):
        name = evidence_file.name.lower()
        if name in {"c2runtime.js", "c3runtime.js"}:
            return "Construct/NW.js", ""
        data = evidence_file_bytes(evidence_file)
        if any(contains_all(data, required) for required in construct_runtime_sets):
            return "Construct/NW.js", ""

    package_nw = ci_child(exe_path.parent, "package.nw")
    if package_nw is not None and package_nw.is_file() and has_archive_path_token(
        package_nw, ["c2runtime.js", "c3runtime.js"]
    ):
        return "Construct/NW.js", ""

    all_tokens = sorted({t for req in construct_runtime_sets for t in req})
    found = find_tokens(exe_path, all_tokens, limit=HTML5_BINARY_SCAN_BYTES, lower=True)
    if any(all(t in found for t in required) for required in construct_runtime_sets):
        return "Construct/NW.js", ""

    return "", "main_version_unknown"


def detect_construct_classic_version(exe_path):
    required_tokens = [
        b"Construct Runtime",
        b"APPBLOCK",
        b"EVENTBLOCK",
        b"LEVELBLOCK",
        b"DLLBLOCK",
    ]
    found = find_tokens(exe_path, required_tokens + [b"ConstructRt", b"ConstructSDK.pdb", b"IMAGEBLOCK"])
    if all(token in found for token in required_tokens):
        return "ConstructClassic", ""
    if b"ConstructRt" in found and b"ConstructSDK.pdb" in found and b"IMAGEBLOCK" in found:
        return "ConstructClassic", ""
    return "", "main_version_unknown"


def detect_godot_version(exe_path):
    exe_path = Path(exe_path)
    for item in exe_path.parent.iterdir():
        if item.is_file() and item.suffix.lower() == ".pck":
            return "Godot", ""
    if file_contains_any(exe_path, [b"Godot Engine", b"GDScript", b"_godot"]):
        return "Godot", ""
    return "", "main_version_unknown"


def detect_flash_projector_version(exe_path):
    exe_path = Path(exe_path)
    for item in exe_path.parent.iterdir():
        if item.is_file() and item.suffix.lower() == ".swf":
            return "Flash", ""
    if file_contains_any(exe_path, [b"Shockwave Flash", b"Adobe Flash Player", b"Macromedia Flash"]):
        return "Flash", ""
    return "", "main_version_unknown"


def detect_gamemaker_early_version(exe_path):
    exe_path = Path(exe_path)
    found = find_tokens(exe_path, [
        b"AboutGameMaker1",
        b"Unexpected version vor IOdata",
        b"version 1.4",
    ])
    if len(found) != 3:
        return "", "main_version_unknown"

    games_dir = ci_child(exe_path.parent, "Games")
    if games_dir is None or not games_dir.is_dir():
        return "", "main_version_unknown"

    for game_subdir in games_dir.iterdir():
        if not game_subdir.is_dir():
            continue
        names = {item.name.lower() for item in game_subdir.iterdir() if item.is_file()}
        if {"objects", "rooms", "sounds", "iodata"} <= names:
            return "GM1.4", ""

    return "", "main_version_unknown"


# ── GMS data.win parsing (GMS1 vs GMS2 split) ────────────────────────────────
def read_u32(data, offset):
    if offset < 0 or offset + 4 > len(data):
        return None
    return struct.unpack_from("<I", data, offset)[0]


def parse_datawin_chunks(data):
    if len(data) < 8:
        return {}, "gms_datawin_too_small"
    if data[:4] != b"FORM":
        return {}, "gms_datawin_missing_form"

    form_length = read_u32(data, 4)
    if form_length is None:
        return {}, "gms_datawin_bad_form"

    chunks = {}
    cursor = 8
    end = min(len(data), 8 + form_length)
    while cursor + 8 <= end:
        raw_name = data[cursor:cursor + 4]
        try:
            name = raw_name.decode("ascii")
        except UnicodeDecodeError:
            return {}, "gms_datawin_bad_chunk_name"

        length = read_u32(data, cursor + 4)
        if length is None:
            return {}, "gms_datawin_bad_chunk_length"

        payload_offset = cursor + 8
        if payload_offset + length > len(data):
            return {}, "gms_datawin_chunk_out_of_bounds"

        chunks[name] = (payload_offset, length)
        cursor = payload_offset + length

    return chunks, ""


def read_gen8_major(data, gen8):
    gen8_offset, gen8_length = gen8
    if gen8_length < 60 or gen8_offset + 60 > len(data):
        return None
    return read_u32(data, gen8_offset + 44)


def detect_gms_generation_from_form_data(data):
    """Return ("GMS1"|"GMS2", "") or ("", error) from data.win FORM bytes.

    The engine label only needs the 1.x vs 2.x split: the GEN8 major version
    decides it, and any GMS2-only chunk marker forces GMS2 defensively."""
    chunks, error = parse_datawin_chunks(data)
    if error:
        return "", error

    gen8 = chunks.get("GEN8")
    if gen8 is None:
        return "", "gms_datawin_missing_gen8"

    major = read_gen8_major(data, gen8)
    if major is None:
        return "", "gms_datawin_bad_gen8_version"

    if major >= 2 or any(name in chunks for name in GMS2_CHUNK_MARKERS):
        return "GMS2", ""
    return "GMS1", ""


def detect_gms_embedded_generation(exe_path):
    data = Path(exe_path).read_bytes()
    hits = []
    cursor = 0

    while True:
        form_offset = data.find(b"FORM", cursor)
        if form_offset < 0:
            break

        generation, error = detect_gms_generation_from_form_data(data[form_offset:])
        if not error:
            hits.append(generation)

        cursor = form_offset + 1

    if not hits:
        return "", "gms_embedded_form_not_found"
    if len(hits) != 1:
        return "", "gms_embedded_form_multi_hit"

    return hits[0], ""


def detect_gms_generation(exe_path):
    data_win = find_adjacent_data_win(exe_path)
    if data_win is None:
        return detect_gms_embedded_generation(exe_path)
    return detect_gms_generation_from_form_data(data_win.read_bytes())


# ── Project / APK fallbacks ──────────────────────────────────────────────────
def detect_gamemaker_project(root_dirs):
    project_types = [
        ("gm81", lambda path: path.is_file() and path.suffix.lower() == ".gm81"),
        ("gmk", lambda path: path.is_file() and path.suffix.lower() == ".gmk"),
        ("gmz", lambda path: path.is_file() and path.suffix.lower() == ".gmz"),
        ("gmx", lambda path: path.is_dir() and path.suffix.lower() == ".gmx"),
    ]

    for version, matcher in project_types:
        for root_dir in root_dirs:
            root_dir = Path(root_dir)
            if not root_dir.exists():
                continue
            hits = sorted(item for item in root_dir.rglob("*") if matcher(item))
            if hits:
                return version
    return ""


def detect_apk_file(root_dirs):
    for root_dir in root_dirs:
        root_dir = Path(root_dir)
        if not root_dir.exists():
            continue
        hits = sorted(
            item for item in root_dir.rglob("*")
            if item.is_file() and item.suffix.lower() == ".apk"
        )
        if hits:
            return hits[0]
    return None


# ── Top-level recognition ────────────────────────────────────────────────────
def recognize_source_file(source, working_dir):
    """Recognize the engine of one downloaded game file.

    Returns a dict: {status: "success"|"failed", main_version, engine, error}.
    `working_dir` is used (and cleared) for extraction scratch space."""
    source = Path(source)
    working_dir = Path(working_dir)

    if source.suffix.lower() == ".apk":
        return {"status": "success", "main_version": "Android",
                "engine": map_engine("Android"), "error": ""}
    if source.suffix.lower() in {".gm81", ".gmk", ".gmz"}:
        return {"status": "success", "main_version": "project",
                "engine": map_engine("project"), "error": ""}

    prepared = prepare_game_exe(source, working_dir)
    exe_path = prepared.path
    error = prepared.error

    if exe_path is not None:
        exe_path, error = unpack_upx_if_needed(exe_path)

    main_version = ""
    if exe_path is not None and not error:
        ok, pe_error = is_pe_file(exe_path)
        if not ok:
            error = pe_error
    if exe_path is not None and not error:
        main_version, error = detect_main_version(exe_path)

    # Long-tail detectors, in the same priority order as the local tool.
    fallback_detectors = [
        ("MMF2", detect_mmf2_version),
        ("Unity", detect_unity_version),
        ("GDevelop/Electron", detect_gdevelop_electron_version),
        ("RPG Maker MV/NW.js", detect_rpgmaker_mv_version),
        ("Scratch/Electron", detect_scratch_electron_version),
        ("Construct/NW.js", detect_construct_nwjs_version),
        ("ConstructClassic", detect_construct_classic_version),
        ("Godot", detect_godot_version),
        ("Flash", detect_flash_projector_version),
        ("GameMakerEarly", detect_gamemaker_early_version),
    ]
    if exe_path is not None and main_version == "unknown" and error == "main_version_unknown":
        for name, detector in fallback_detectors:
            version, error = detector(exe_path)
            if version:
                main_version = name
                error = ""
                break
            if error != "main_version_unknown":
                break

    if exe_path is not None and main_version == "GMS":
        generation, error = detect_gms_generation(exe_path)
        if generation:
            main_version = generation  # "GMS1" | "GMS2"

    if main_version in ("", "unknown") and error:
        # No exe (or unusable exe): try GameMaker project / APK fallbacks.
        if error == "no_exe":
            project_version = detect_gamemaker_project([working_dir])
            if project_version:
                main_version = "project"
                error = ""
            elif detect_apk_file([working_dir]) is not None:
                main_version = "Android"
                error = ""

    recognized = main_version not in ("", "unknown", "GMS")
    engine = map_engine(main_version) if recognized else None

    return {
        "status": "success" if (recognized and engine and not error) else "failed",
        "main_version": main_version if recognized else (main_version or ""),
        "engine": engine if (recognized and not error) else None,
        "error": error,
    }


def recognize_for_catalog(source, work_root, game_id, log=print):
    """Inline-recognition helper for the scraper: never raises.

    Returns (engine_or_None, result_dict)."""
    working_dir = Path(work_root) / f"engine_detect_{game_id}"
    try:
        result = recognize_source_file(source, working_dir)
    except Exception as exc:  # recognition must never break ingestion
        result = {"status": "failed", "main_version": "", "engine": None,
                  "error": f"exception:{type(exc).__name__}"}
        log(f"  [ENGINE] Unexpected recognition error for ID {game_id}: {exc}")
    finally:
        try:
            remove_tree_if_exists(working_dir)
            embedded_tmp = Path(work_root) / f"engine_detect_{game_id}_embedded_tmp"
            remove_tree_if_exists(embedded_tmp)
        except Exception:
            pass
    return result.get("engine"), result


# ── Backlog sweep ────────────────────────────────────────────────────────────
def r2_key_from_download_url(url):
    if not url or not url.startswith(PUBLIC_DOMAIN):
        return None
    path = urllib.parse.urlparse(url).path
    return urllib.parse.unquote(path).lstrip("/") or None


def sweep_backlog(games, state, r2_client, work_root,
                  max_games=20, max_seconds=900, max_file_mb=1024, log=print):
    """Recognize a bounded batch of R2-hosted catalog games missing `engine`.

    Mutates `games` (sets game["engine"]) and `state` (records attempts).
    Returns the list of game ids whose engine was set."""
    deadline = time.time() + max_seconds
    max_bytes = max_file_mb * 1024 * 1024

    candidates = []
    for gid, game in games.items():
        if game.get("engine"):
            continue
        entry = state.get(str(gid))
        # Only a recorded hard failure blocks a retry. A "success" entry whose
        # game still lacks `engine` means the games.json carrying the label
        # never reached R2 (partial upload) — re-attempt so it self-heals;
        # "deferred" entries (transient/tooling errors) are retried by design.
        if entry and entry.get("status") == "failed":
            continue
        key = r2_key_from_download_url(game.get("download_url") or "")
        if not key:
            continue
        candidates.append((int(gid), key, game))
    # Newest games first: fresh ingests/submissions get engines fastest while
    # the historical backlog drains gradually.
    candidates.sort(key=lambda item: item[0], reverse=True)

    if not candidates:
        log("  [ENGINE] No backlog candidates (every R2-hosted game has an engine or a recorded attempt).")
        return []

    log(f"  [ENGINE] Backlog: {len(candidates)} candidate(s); attempting up to "
        f"{max_games} this run (time budget {max_seconds}s, file cap {max_file_mb} MB).")

    work_root = Path(work_root)
    work_root.mkdir(parents=True, exist_ok=True)
    updated_ids = []
    attempted = 0

    for gid, key, game in candidates:
        if attempted >= max_games:
            break
        if time.time() >= deadline:
            log("  [ENGINE] Time budget exhausted; remaining backlog continues next run.")
            break

        file_size = game.get("file_size") or 0
        if file_size > max_bytes:
            log(f"  [ENGINE] Skipping ID {gid} ('{game.get('title')}'): "
                f"{file_size / (1024*1024):.0f} MB exceeds the {max_file_mb} MB cap.")
            continue

        attempted += 1
        game_dir = work_root / f"engine_sweep_{gid}"
        clear_working_dir(game_dir)
        local_path = game_dir / os.path.basename(key)
        try:
            r2_client.download_file(BUCKET_NAME, key, str(local_path))
        except Exception as exc:
            log(f"  [ENGINE] Download failed for ID {gid} ({key}): {exc}")
            # "deferred" (not "failed") so a transient network/R2 error is
            # retried on a later run instead of blacklisting the game forever.
            record_attempt(state, gid, {"status": "deferred", "error": "download_failed"},
                           "ci-sweep")
            remove_tree_if_exists(game_dir)
            continue

        engine, result = recognize_for_catalog(local_path, game_dir, gid, log=log)
        record_attempt(state, gid, result, "ci-sweep")
        if engine:
            game["engine"] = engine
            updated_ids.append(gid)
            log(f"  [ENGINE] ID {gid} ('{game.get('title')}') -> {engine}")
        else:
            log(f"  [ENGINE] ID {gid} ('{game.get('title')}') recognition failed: "
                f"{result.get('error')}")
        remove_tree_if_exists(game_dir)

    log(f"  [ENGINE] Sweep done: {attempted} attempted, {len(updated_ids)} recognized.")
    return updated_ids


# ── CLI ──────────────────────────────────────────────────────────────────────
def build_seed_state(games, existing=None):
    """Build the initial attempt-state from the catalog.

    Games that already carry `engine` were recognized by the operator's local
    scan; games without one at id <= LOCAL_SCAN_MAX_ID already failed that scan
    with full local tooling, so the CI sweep should not retry them.

    Returns (state, seeded_success, seeded_failed)."""
    state = dict(existing or {})
    now = int(time.time())
    seeded_success = seeded_failed = 0
    for gid, game in games.items():
        if gid in state:
            continue
        engine = game.get("engine")
        if engine:
            state[gid] = {"status": "success", "engine": engine, "main_version": "",
                          "error": "", "source": "local-backfill", "ts": now}
            seeded_success += 1
        else:
            try:
                numeric_id = int(gid)
            except (TypeError, ValueError):
                continue
            if numeric_id <= LOCAL_SCAN_MAX_ID:
                state[gid] = {"status": "failed", "engine": "", "main_version": "",
                              "error": "local_scan_failed", "source": "local-backfill",
                              "ts": now}
                seeded_failed += 1
    return state, seeded_success, seeded_failed


def seed_state_from_catalog(games_path=GAMES_PATH, state_path=STATE_PATH):
    with open(games_path, encoding="utf-8") as f:
        games = json.load(f)
    state, seeded_success, seeded_failed = build_seed_state(games, load_state(state_path))
    save_state(state, state_path)
    print(f"Seeded {seeded_success} success + {seeded_failed} failed entries "
          f"({len(state)} total) -> {state_path}")


def _r2_client_from_config():
    import boto3
    from botocore.config import Config
    sys.path.append(os.path.dirname(os.path.abspath(__file__)))
    from config import CLOUDFLARE_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
    if not (CLOUDFLARE_ACCOUNT_ID and AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY):
        sys.exit("R2 credentials missing (env vars / .env); cannot sweep.")
    return boto3.client(
        "s3",
        endpoint_url=f"https://{CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=AWS_ACCESS_KEY_ID,
        aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
        config=Config(signature_version="s3v4"),
    )


def main():
    parser = argparse.ArgumentParser(description="Fangame engine recognition (CI port).")
    parser.add_argument("--file", type=Path, help="Recognize one local game file and print the result.")
    parser.add_argument("--seed-state", action="store_true",
                        help="Seed the attempt-state file from data/games.json.")
    parser.add_argument("--sweep", action="store_true",
                        help="Run a manual backlog sweep against R2 (needs credentials).")
    parser.add_argument("--max", type=int, default=20, help="Max games per sweep run.")
    parser.add_argument("--max-seconds", type=int, default=900, help="Sweep time budget.")
    parser.add_argument("--max-file-mb", type=int, default=1024, help="Per-file size cap.")
    args = parser.parse_args()

    if args.file:
        work_dir = Path("temp/engine_detect_cli")
        result = recognize_source_file(args.file, work_dir)
        remove_tree_if_exists(work_dir)
        remove_tree_if_exists(Path("temp") / "engine_detect_cli_embedded_tmp")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    if args.seed_state:
        seed_state_from_catalog()
        return

    if args.sweep:
        with open(GAMES_PATH, encoding="utf-8") as f:
            games = json.load(f)
        state = load_state()
        updated = sweep_backlog(games, state, _r2_client_from_config(), Path("temp"),
                                max_games=args.max, max_seconds=args.max_seconds,
                                max_file_mb=args.max_file_mb)
        save_state(state)
        if updated:
            with open(GAMES_PATH, "w", encoding="utf-8") as f:
                json.dump(games, f, ensure_ascii=False, indent=2)
            print(f"Updated engine for {len(updated)} game(s) in {GAMES_PATH}.")
            print("NOTE: games.json was modified locally; it must be rebased/uploaded "
                  "through the normal pipeline for clients to see it.")
        return

    parser.print_help()


if __name__ == "__main__":
    main()
