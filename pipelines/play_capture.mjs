// Captures the first screens of one game in the browser player (gm-recomp, the bundle at
// public/play/gmr), the way /play/ runs it: imports the archive with the bundle's own
// importer (import/webimport.wasm, plus the system DLLs it asks for from system32/),
// serves the bundle and the imported game on 127.0.0.1 with cross-origin isolation, opens
// a page that plays it in headless Chrome, and keeps the frames the player captures.
// Used by pipelines/play_covers.py (one process per game); usable alone:
//
//   node pipelines/play_capture.mjs --bundle public/play/gmr --archive Game/123.zip --out out/123
//     [--frames 100,250,450,600] [--keys 300:ShiftLeft] [--limit-ms 150000]
//
// Writes <out>/frame-NNNNN.png and prints one JSON line:
//   {import: 'ok'|<error>, entry, engine, size: [w, h], frames: [n...], done, logs, ms}
// `done` is the player's end status if the game stopped. Exit status 0, or 2 when the
// import failed.
//
//   node pipelines/play_capture.mjs --bundle public/play/gmr --probe
// checks the browser instead: `done` is the JSON {isolated, webgl2, renderer, error} of a
// page that makes a WebGL 2 context (what the player needs besides cross-origin isolation).
//
// Chrome: $PLAY_CAPTURE_CHROME (a command, words split on spaces, e.g. "flatpak run
// com.google.Chrome"), else google-chrome, google-chrome-stable, chromium or
// chromium-browser on PATH; $PLAY_CAPTURE_CHROME_ARGS adds arguments (CI: --no-sandbox);
// its profile goes under $PLAY_CAPTURE_PROFILE_ROOT (default: the system temp folder).
// Without a GPU, WebGL runs on SwiftShader (--enable-unsafe-swiftshader).
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, statSync, createReadStream, mkdtempSync } from 'node:fs';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const bundle = resolve(opt('bundle', 'public/play/gmr'));
const archive = opt('archive');
const out = opt('out');
const frames = opt('frames', '100,250,450,600').split(',').filter(Boolean).map(Number);
// key taps after a frame: <frame>:<KeyboardEvent.code>, held for 4 frames (a volume check
// or a "press Shift" screen moves on to the title)
const keys = opt('keys', '300:ShiftLeft').split(',').filter(Boolean).map((k) => k.split(':'));
const limitMs = Number(opt('limit-ms', 150000));
const probe = argv.includes('--probe');
if (!probe && (!archive || !out)) {
  console.error('usage: play_capture.mjs --bundle <dir> --archive <file> --out <dir>');
  process.exit(64);
}
const t0 = Date.now();
const result = { import: null, entry: null, engine: null, size: null, frames: [], done: null, logs: [], ms: 0 };
const finish = (code) => {
  result.ms = Date.now() - t0;
  result.logs = result.logs.slice(-30);
  console.log(JSON.stringify(result));
  process.exit(code);
};

// ---- import (as gm-recomp web/src/import.mjs does in the browser) --------------------------
const game = new Map(); // path -> Buffer
let manifest;
if (!probe) try {
  const mod = await WebAssembly.compile(readFileSync(join(bundle, 'import/webimport.wasm')));
  const imports = {};
  for (const imp of WebAssembly.Module.imports(mod)) {
    imports[imp.module] ??= {};
    imports[imp.module][imp.name] = () => 0;
  }
  const x = (await WebAssembly.instantiate(mod, imports)).exports;
  const mem = () => new Uint8Array(x.memory.buffer);
  const put = (u8) => {
    const p = x.alloc(u8.length);
    mem().set(u8, p);
    return [p, u8.length];
  };
  const text = () => new TextDecoder().decode(mem().slice(x.out_ptr(), x.out_ptr() + x.out_len()));
  const [ap, al] = put(readFileSync(archive));
  const [np, nl] = put(new TextEncoder().encode(basename(archive)));
  const failed = x.import_zip(ap, al, np, nl);
  x.dealloc(ap, al);
  x.dealloc(np, nl);
  if (failed) throw new Error(text());
  const tried = new Set();
  for (;;) {
    x.needs();
    const want = JSON.parse(text()).filter((n) => !tried.has(n));
    if (!want.length) break;
    for (const dll of want) {
      tried.add(dll);
      const p = join(bundle, 'system32', dll);
      if (!existsSync(p)) continue;
      const [pp, pl] = put(new TextEncoder().encode(`C/Windows/system32/${dll}`));
      const [dp, dl] = put(readFileSync(p));
      x.add_file(pp, pl, dp, dl);
      x.dealloc(pp, pl);
      x.dealloc(dp, dl);
    }
  }
  x.manifest();
  manifest = JSON.parse(text());
  if (!manifest.entry) throw new Error('no game exe in the archive');
  for (let i = 0; i < x.file_count(); i++) {
    x.file_path(i);
    const path = text();
    const p = x.file_ptr(i);
    game.set(path, Buffer.from(mem().subarray(p, p + x.file_len(i))));
  }
  x.finish();
  result.import = 'ok';
  result.entry = manifest.entry;
  result.engine = manifest.engine ?? null;
} catch (e) {
  result.import = String(e?.message ?? e).slice(0, 300);
  finish(2);
}

// ---- the page ------------------------------------------------------------------------------
const PAGE = `<!doctype html><meta charset="utf-8"><title>capture</title>
<body style="margin:0;background:#000"><canvas id="screen" width="640" height="480"></canvas>
<script type="module">
const post = (p, b) => fetch(p, { method: 'POST', body: b }).catch(() => {});
addEventListener('error', (e) => post('log', 'page error: ' + e.message));
addEventListener('unhandledrejection', (e) => post('log', 'page: ' + (e.reason?.stack ?? e.reason)));
try {
  const cfg = await (await fetch('capture.json')).json();
  const { playGame } = await import('./src/player.mjs');
  playGame({
    game: 'game',
    canvas: document.getElementById('screen'),
    capture: cfg.frames,
    script: cfg.script,
    pacing: 'asap',
    persist: false,
    onLog: (line) => post('log', line),
    onSize: (w, h) => post('size', w + 'x' + h),
    onCapture: (frame, png) => post('capture/' + frame, png),
    onDone: (status) => post('done', String(status)),
    // a dialog the game opens: OK / Yes / Ignore, or the text it suggests
    onPrompt: ({ kind, def }) => Promise.resolve(kind === 'text' ? def ?? '' : ''),
  });
} catch (e) {
  post('done', 'page: ' + (e?.stack ?? e));
}
</script>`;
const config = JSON.stringify({
  frames,
  script: keys.flatMap(([f, code]) => [[Number(f), code, true, false], [Number(f) + 4, code, false, false]]),
});

const PROBE_PAGE = `<!doctype html><meta charset="utf-8"><title>probe</title>
<script type="module">
const r = { isolated: self.crossOriginIsolated, webgl2: false };
try {
  const gl = new OffscreenCanvas(16, 16).getContext('webgl2');
  r.webgl2 = !!gl;
  if (gl) {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    r.renderer = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
  }
} catch (e) {
  r.error = String(e);
}
fetch('done', { method: 'POST', body: JSON.stringify(r) });
</script>`;

// ---- the server ----------------------------------------------------------------------------
if (out) mkdirSync(out, { recursive: true });
const want = new Set(frames);
let wake = () => {};
const types = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm' };
const isolation = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-resource-policy': 'same-origin', 'cache-control': 'no-store' };
const body = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
};
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const send = (status, data, type = 'application/octet-stream') => res.writeHead(status, { ...isolation, 'content-type': type }).end(data);
  if (req.method === 'POST') {
    const data = await body(req);
    send(204);
    if (path.startsWith('/capture/')) {
      const n = Number(path.slice('/capture/'.length));
      if (Number.isInteger(n) && want.has(n)) {
        writeFileSync(join(out, `frame-${String(n).padStart(5, '0')}.png`), data);
        if (!result.frames.includes(n)) result.frames.push(n);
      }
    } else if (path === '/done') result.done = data.toString().slice(0, 400);
    else if (path === '/size') result.size = data.toString().split('x').map(Number);
    else if (path === '/log') result.logs.push(data.toString().slice(0, 300));
    wake();
    return;
  }
  if (path === '/capture.html') return send(200, probe ? PROBE_PAGE : PAGE, types['.html']);
  if (path === '/capture.json') return send(200, config, types['.json']);
  if (path === '/games/game/manifest.json') return send(200, JSON.stringify(manifest), types['.json']);
  if (path.startsWith('/games/game/files/')) {
    const f = game.get(path.slice('/games/game/files/'.length));
    return f ? send(200, f) : send(404, 'not found', 'text/plain');
  }
  const file = normalize(join(bundle, path));
  if (!file.startsWith(bundle + sep)) return send(404, 'not found', 'text/plain');
  try {
    if (!statSync(file).isFile()) throw new Error();
  } catch {
    return send(404, 'not found', 'text/plain');
  }
  res.writeHead(200, { ...isolation, 'content-type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/capture.html`;

// ---- the browser ---------------------------------------------------------------------------
const which = (name) => spawnSync('sh', ['-c', `command -v "${name}"`], { encoding: 'utf8' }).stdout.trim();
let command = (process.env.PLAY_CAPTURE_CHROME ?? '').split(' ').filter(Boolean);
if (!command.length) {
  const found = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map(which).find(Boolean);
  if (!found) {
    result.done = 'no Chrome found';
    finish(0);
  }
  command = [found];
}
const profile = mkdtempSync(join(process.env.PLAY_CAPTURE_PROFILE_ROOT ?? tmpdir(), 'play-capture-'));
const chrome = spawn(
  command[0],
  [
    ...command.slice(1),
    '--headless=new',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-swiftshader',
    '--window-size=1024,768',
    ...(process.env.PLAY_CAPTURE_CHROME_ARGS ?? '').split(' ').filter(Boolean),
    url,
  ],
  { stdio: 'ignore', detached: true },
);
let exited = false;
chrome.on('exit', () => {
  exited = true;
  wake();
});
chrome.on('error', (e) => {
  result.done ??= `Chrome did not start: ${e.message}`;
  exited = true;
  wake();
});
await new Promise((r) => {
  wake = () => (result.frames.length >= want.size || result.done !== null || exited) && r();
  setTimeout(r, limitMs);
});
if (exited && result.done === null) result.done = 'Chrome exited';
try {
  process.kill(-chrome.pid, 'SIGKILL');
} catch {}
await new Promise((r) => (exited ? r() : chrome.once('exit', r)));
// (a flatpak Chrome runs outside our process group)
spawnSync('pkill', ['-KILL', '-f', `user-data-dir=${profile}`]);
server.close();
rmSync(profile, { recursive: true, force: true });
result.frames.sort((a, b) => a - b);
finish(0);
