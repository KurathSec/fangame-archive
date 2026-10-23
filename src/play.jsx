// Playing games in the browser. The player itself is a separate page, /play/?id=<id>
// (public/play/, on gm-recomp); this file is the catalog's side of it:
//  - which games can be played (`playability`): GameMaker 8, GameMaker: Studio and
//    GameMaker: Studio 2 games hosted on the archive's own CDN, up to PLAY_MAX_BYTES;
//  - the drawer's Play row (`PlayRow`), with the mods to apply, stored where the player
//    reads them (localStorage `gmr.mods.fa-<id>`, gm-recomp's format);
//  - My Content › Playing (`usePlaying`, `PlayingGrid`; an Explorer in 'playing' mode):
//    the games played here (localStorage `fa.playing`, written by the player) and, when
//    signed in, those with saves in the account (/api/saves).

// (GameMaker: Studio 2 takes no mods: gm-recomp's mods read no GMS2 bytecode yet)
const PLAY_ENGINES = { 'GameMaker 8': 'gm8', 'GameMaker: Studio': 'gms', 'GameMaker: Studio 2': 'gms2' };
// The whole archive is unpacked in the browser's memory.
const PLAY_MAX_BYTES = 512 * 1024 * 1024;

/** {ok: true, kind: 'gm8'|'gms'|'gms2'} or {ok: false, reason: 'access'|'engine'|'link'|'host'|'size'}. */
function playability(game) {
  // only for whitelisted accounts (src/app.jsx PLAY_ACCESS); for the others nothing shows
  if (!window.PLAY_ACCESS) return { ok: false, reason: 'access' };
  const kind = game && PLAY_ENGINES[game.engine];
  if (!kind) return { ok: false, reason: 'engine' };
  if (!game.url || (game.flags && game.flags.broken)) return { ok: false, reason: 'link' };
  if (!(game.flags && game.flags.local)) return { ok: false, reason: 'host' };
  if (game.file_size > PLAY_MAX_BYTES) return { ok: false, reason: 'size' };
  return { ok: true, kind };
}

const playStore = {
  get(k, fallback) {
    try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? fallback : v; } catch (e) { return fallback; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }
};

/** The player page for `game`; leaves it what it needs to know (no catalog there). */
function playUrl(game) {
  return '/play/?id=' + game.id;
}
function handOff(game) {
  playStore.set('fa.play.' + game.id, { id: game.id, title: game.title, url: game.url, engine: game.engine, size: game.file_size });
  // Coming back (the player's ← Archive) finds the Explorer as it was left (src/explorer.jsx).
  try { sessionStorage.setItem('archive_back', '1'); } catch (e) {}
}

// ── Mods ────────────────────────────────────────────────────────────────────
// gm-recomp's mods (crates/gmmod) that work without anything else to run; `engines`
// limits a mod or an option to GameMaker 8 ('gm8') or GameMaker: Studio ('gms'). A
// Studio game compiled with YYC takes only Debug mode: the player leaves the others out.
const PLAY_MODS = [
  { id: 'debug', engines: ['gms'], options: [{ key: 'noDeath', type: 'bool', def: false }] },
  { id: 'GodMode', engines: ['gm8', 'gms'], options: [] },
  { id: 'CrimsonKid', engines: ['gm8', 'gms'], options: [{ key: 'BowImageSpeed', type: 'number', def: 0.2, step: 0.05 }] },
  { id: 'DotKid', engines: ['gm8', 'gms'], options: [{ key: 'ShowOutline', type: 'bool', def: true }] },
  { id: 'DbgHelper', engines: ['gm8', 'gms'], options: [
    { key: 'InputLagPatch', type: 'bool', def: true, engines: ['gm8'] },
    { key: 'JoystickPatch', type: 'bool', def: true, engines: ['gm8'] },
    { key: 'SchedulerPatch', type: 'bool', def: true, engines: ['gm8'] },
    { key: 'MemoryPatch', type: 'bool', def: true, engines: ['gm8'] },
    { key: 'DirectPlayPatch', type: 'bool', def: true, engines: ['gm8'] },
    { key: 'SetSleepMargin', type: 'bool', def: true, engines: ['gms'] },
    { key: 'SleepMargin', type: 'number', def: 1, step: 1, engines: ['gms'] }
  ] }
];

const modKey = (id) => 'gmr.mods.fa-' + id;

function PlayMods({ game, kind, choices, setChoices }) {
  const mods = PLAY_MODS.filter((m) => m.engines.includes(kind));
  const update = (next) => {
    setChoices(next);
    playStore.set(modKey(game.id), next);
  };
  const toggle = (m) => {
    const cur = choices[m.id] || {};
    update({ ...choices, [m.id]: { ...cur, on: !cur.on } });
  };
  const setOption = (m, o, value) => {
    const cur = choices[m.id] || {};
    update({ ...choices, [m.id]: { ...cur, config: { ...(cur.config || {}), [o.key]: value } } });
  };
  return (
    <div className="play-mods">
      <div className="play-mods-about">{window.t('play.mods_about')}</div>
      {mods.map((m) => {
        const c = choices[m.id] || {};
        const opts = m.options.filter((o) => !o.engines || o.engines.includes(kind));
        return (
          <div key={m.id} className={'play-mod' + (c.on ? ' on' : '')}>
            <label className="play-mod-head">
              <input type="checkbox" checked={!!c.on} onChange={() => toggle(m)} />
              <span className="play-mod-name">{window.t('play.mod.' + m.id)}</span>
            </label>
            <div className="play-mod-about">{window.t('play.mod.' + m.id + '.about')}</div>
            {c.on && opts.length > 0 && (
              <div className="play-mod-opts">
                {opts.map((o) => {
                  const v = c.config && c.config[o.key] !== undefined ? c.config[o.key] : o.def;
                  return o.type === 'bool' ? (
                    <label key={o.key} className="play-opt">
                      <input type="checkbox" checked={!!v} onChange={(e) => setOption(m, o, e.target.checked)} />
                      <span>{window.t('play.opt.' + o.key)}</span>
                    </label>
                  ) : (
                    <label key={o.key} className="play-opt">
                      <span>{window.t('play.opt.' + o.key)}</span>
                      <input type="number" step={o.step} value={v}
                             onChange={(e) => setOption(m, o, e.target.value === '' ? o.def : Number(e.target.value))} />
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const playIcons = {
  play: <svg viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 2.8v10.4c0 .5.5.8.9.5l8-5.2c.4-.2.4-.8 0-1L5.4 2.3c-.4-.3-.9 0-.9.5z"/></svg>,
  mods: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M2.5 4h6M11.5 4h2M2.5 12h2M7.5 12h6M2.5 8h9M14 8h-.5"/><circle cx="10" cy="4" r="1.5"/><circle cx="6" cy="12" r="1.5"/><circle cx="12.5" cy="8" r="1.5" fill="none"/></svg>
};

/** The drawer's row under Download: Play in browser, and the mods beside it. */
function PlayRow({ game }) {
  const p = playability(game);
  const [open, setOpen] = React.useState(false);
  const [choices, setChoices] = React.useState(() => playStore.get(modKey(game.id), {}));
  React.useEffect(() => {
    setChoices(playStore.get(modKey(game.id), {}));
    setOpen(false);
  }, [game.id]);

  if (p.reason === 'access') return null;
  if (!p.ok) {
    return (
      <section className="drawer-sec play-sec">
        <button className="launch-btn play-btn" disabled title={window.t('play.why.' + p.reason)}>
          {playIcons.play} {window.t('play.unavailable')}
        </button>
        <div className="play-why">{window.t('play.why.' + p.reason)}</div>
      </section>
    );
  }
  const onCount = PLAY_MODS.filter((m) => m.engines.includes(p.kind) && choices[m.id] && choices[m.id].on).length;
  // (none for GameMaker: Studio 2 yet)
  const hasMods = PLAY_MODS.some((m) => m.engines.includes(p.kind));
  return (
    <section className="drawer-sec play-sec">
      <div className="play-row">
        <a className="launch-btn play-btn" href={playUrl(game)} onClick={() => handOff(game)}>
          {playIcons.play} {window.t('play.button')}
        </a>
        {hasMods && (
          <button className={'roll-again-btn play-mods-btn' + (open ? ' open' : '') + (onCount ? ' active' : '')}
                  onClick={() => setOpen(!open)} aria-expanded={open}>
            {playIcons.mods} {window.t('play.mods')}{onCount ? ' · ' + onCount : ''}
          </button>
        )}
      </div>
      {open && hasMods && <PlayMods game={game} kind={p.kind} choices={choices} setChoices={setChoices} />}
    </section>
  );
}

// ── Playing ─────────────────────────────────────────────────────────────────

async function authHeaders() {
  try {
    if (typeof Clerk !== 'undefined' && Clerk.session) {
      const token = await Clerk.session.getToken();
      if (token) return { Authorization: 'Bearer ' + token };
    }
  } catch (e) {}
  return null;
}

/** The games being played, newest first: [{id, at, account}]. */
function usePlaying(auth) {
  const read = () => ({ local: playStore.get('fa.playing', []), hidden: playStore.get('fa.playing.hidden', []) });
  const [state, setState] = React.useState(read);
  const [account, setAccount] = React.useState([]);
  React.useEffect(() => {
    const refresh = () => setState(read());
    window.addEventListener('storage', refresh);
    window.addEventListener('playing:changed', refresh);
    window.addEventListener('pageshow', refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('playing:changed', refresh);
      window.removeEventListener('pageshow', refresh);
    };
  }, []);
  React.useEffect(() => {
    if (auth === 'out') { setAccount([]); return; }
    let live = true;
    (async () => {
      const headers = await authHeaders();
      if (!headers) return;
      try {
        const r = await fetch('/api/saves', { headers });
        const data = await r.json();
        if (live && data && data.success) setAccount(data.saves.map((s) => ({ id: s.game_id, at: s.updated_at })));
      } catch (e) {}
    })();
    return () => { live = false; };
  }, [auth]);
  return React.useMemo(() => {
    const byId = new Map();
    for (const e of state.local) if (e && e.id) byId.set(e.id, { id: e.id, at: e.at || 0, account: false });
    for (const e of account) {
      const cur = byId.get(e.id);
      byId.set(e.id, { id: e.id, at: Math.max(e.at, cur ? cur.at : 0), account: true });
    }
    const hidden = new Set(state.hidden);
    return [...byId.values()].filter((e) => !hidden.has(e.id)).sort((a, b) => b.at - a.at);
  }, [state, account]);
}

function hidePlaying(id) {
  const hidden = playStore.get('fa.playing.hidden', []);
  if (!hidden.includes(id)) playStore.set('fa.playing.hidden', hidden.concat(id));
  window.dispatchEvent(new Event('playing:changed'));
}

function playedWhen(at) {
  if (!at) return '';
  const s = (Date.now() - at) / 1000;
  let rtf;
  try { rtf = new Intl.RelativeTimeFormat(window.CURRENT_LANGUAGE || 'en', { numeric: 'auto' }); } catch (e) { return ''; }
  if (s < 3600) return rtf.format(-Math.max(1, Math.round(s / 60)), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  if (s < 86400 * 30) return rtf.format(-Math.round(s / 86400), 'day');
  return rtf.format(-Math.round(s / (86400 * 30)), 'month');
}

/** My Content › Playing (an Explorer in 'playing' mode lays it out and filters it): the
 *  games being played as cards with the site's screenshot (title only without one). */
function PlayingGrid({ games, playedAt, total, activeId, onOpenGame }) {
  if (total === 0) {
    return (
      <div className="playing-empty">
        <div className="playing-empty-icon">{playIcons.play}</div>
        <div>{window.t('play.playing_empty')}</div>
        <button className="playing-show" onClick={() => {
          // Browse Games mounts with the playable filter on (see its flags initialiser)
          window.__pendingPlayableFilter = true;
          if (window.setView) window.setView('explorer');
        }}>{window.t('play.show_playable')}</button>
      </div>
    );
  }
  if (games.length === 0) return <div className="playing-empty"><div>{window.t('no_games_found')}</div></div>;
  return (
    <div className="playing-grid">
      {games.map((g) => {
        const shot = (window.DATA.SCREENSHOTS[g.id] || [])[0];
        return (
          <div key={g.id} className={'playing-card' + (g.id === activeId ? ' active' : '')} role="button" tabIndex={0}
               onClick={() => onOpenGame(g)}
               onKeyDown={(ev) => { if (ev.key === 'Enter') onOpenGame(g); }}>
            {shot && <img className="playing-shot" src={getShotUrl(shot.image_path)} alt="" loading="lazy" />}
            <div className="playing-meta">
              <span className="playing-title">{g.title}</span>
              <span className="playing-creator">{g.creator}</span>
              <span className="playing-when">{playedWhen(playedAt.get(g.id))}</span>
            </div>
            <div className="playing-actions">
              <a className="playing-play" href={playUrl(g)} title={window.t('play.button')}
                 onClick={(ev) => { ev.stopPropagation(); handOff(g); }}>{playIcons.play}</a>
              <button className="playing-x" title={window.t('play.remove')}
                      onClick={(ev) => { ev.stopPropagation(); hidePlaying(g.id); }}>{window.ic.x}</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** A small Play button beside a game's name (collection cards); nothing when it cannot run. */
function PlayButton({ game }) {
  if (!playability(game).ok) return null;
  return (
    <a className="card-play" href={playUrl(game)} title={window.t('play.button')} aria-label={window.t('play.button')}
       onClick={(ev) => { ev.stopPropagation(); handOff(game); }}>{playIcons.play}</a>
  );
}

// ── Local games ─────────────────────────────────────────────────────────────
// The games the player keeps in this browser: gm-recomp's IndexedDB `gmrecomp` (its
// web/src/saves.mjs), store `games` keyed by slug (`fa-<id>` here), with the translation
// profile under the same key in `profiles`. Sizes come from localStorage `fa.local`
// ({id: {bytes, at}}), which the player writes when it stores a game: reading a game's
// record for its size would load all of its files.

function idbDone(req) {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}

function openPlayerDb() {
  // no version: the player's (it creates the stores); a missing database has none
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('gmrecomp');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** The ids of the games stored in this browser. */
async function listLocalGames() {
  const db = await openPlayerDb();
  try {
    if (!db.objectStoreNames.contains('games')) return [];
    const keys = await idbDone(db.transaction('games').objectStore('games').getAllKeys());
    return keys.filter((k) => typeof k === 'string' && k.startsWith('fa-')).map((k) => Number(k.slice(3))).filter((n) => Number.isFinite(n));
  } finally {
    db.close();
  }
}

/** Deletes games' files and translation profiles from this browser (their saves stay). */
async function deleteLocalGames(ids) {
  const db = await openPlayerDb();
  try {
    const stores = ['games', 'profiles'].filter((n) => db.objectStoreNames.contains(n));
    if (stores.length) {
      const tx = db.transaction(stores, 'readwrite');
      for (const id of ids) for (const n of stores) tx.objectStore(n).delete('fa-' + id);
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
    }
  } finally {
    db.close();
  }
  const meta = playStore.get('fa.local', {});
  for (const id of ids) delete meta[id];
  playStore.set('fa.local', meta);
  window.dispatchEvent(new Event('fa-local-changed'));
}

/** The stored games' ids (null while reading), kept current as the player stores or this page deletes. */
function useLocalGames() {
  const [ids, setIds] = React.useState(null);
  React.useEffect(() => {
    let live = true;
    const read = () => listLocalGames().then((v) => live && setIds(v)).catch(() => live && setIds([]));
    read();
    const onStorage = (ev) => { if (!ev.key || ev.key === 'fa.local') read(); };
    window.addEventListener('fa-local-changed', read);
    window.addEventListener('focus', read);
    window.addEventListener('storage', onStorage);
    return () => {
      live = false;
      window.removeEventListener('fa-local-changed', read);
      window.removeEventListener('focus', read);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return ids;
}

function formatBytes(n) {
  if (!(n > 0)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i >= 2 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
}

/** Library › Local games: the games stored in this browser, to delete one by one or all. */
function LocalGamesView({ onOpenGame }) {
  const ids = useLocalGames();
  const [estimate, setEstimate] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(setEstimate).catch(() => {});
  }, [ids && ids.length]);
  const meta = playStore.get('fa.local', {});
  const byId = React.useMemo(() => {
    const m = new Map();
    (window.DATA.GAMES || []).forEach((g) => m.set(g.id, g));
    return m;
  }, []);
  const rows = (ids || [])
    .map((id) => ({ id, game: byId.get(id), bytes: meta[id] && meta[id].bytes, at: meta[id] && meta[id].at }))
    .sort((a, b) => (b.at || 0) - (a.at || 0));
  const remove = async (list) => {
    setBusy(true);
    try {
      await deleteLocalGames(list);
      window.pushToast && window.pushToast(window.t('play.local_deleted'), '', 'success');
    } catch (e) {
      window.pushToast && window.pushToast(String(e && e.message || e), '', 'error');
    }
    setBusy(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>
      <div className="topbar">
        <button className="iconbtn mobile-menu-btn" onClick={() => window.toggleSidebar && window.toggleSidebar()} title={window.t('close_menu_title')}>{window.ic.menu}</button>
        <span className="crumb"><b>{window.t('library')}</b><span>/</span>{window.t('play.local_games')}</span>
      </div>
      <div className="collview">
        <div className="collview-inner">
          <div className="coll-head">
            <h1 className="coll-title">
              <span className="coll-title-star">{window.ic.hdd}</span>
              {window.t('play.local_games')}
              {rows.length > 0 && <span className="coll-count tnum">{rows.length}</span>}
            </h1>
            <p className="coll-sub">{window.t('play.local_sub')}</p>
            {estimate && estimate.usage > 0 && (
              <p className="local-usage">{window.t('play.local_used', { used: formatBytes(estimate.usage), quota: formatBytes(estimate.quota) })}</p>
            )}
          </div>
          {ids === null ? null : rows.length === 0 ? (
            <div className="playing-empty">
              <div className="playing-empty-icon">{window.ic.hdd}</div>
              <div>{window.t('play.local_empty')}</div>
            </div>
          ) : (
            <>
              <div className="local-tools">
                <button className="local-del-all" disabled={busy}
                        onClick={() => { if (window.confirm(window.t('play.local_confirm_all'))) remove(rows.map((r) => r.id)); }}>
                  {window.ic.x} {window.t('play.local_delete_all')}
                </button>
              </div>
              <div className="local-list">
                {rows.map(({ id, game, bytes, at }) => {
                  const shot = game && (window.DATA.SCREENSHOTS[id] || [])[0];
                  return (
                    <div key={id} className="local-row">
                      <button className="local-main" onClick={() => game && onOpenGame && onOpenGame(game)} disabled={!game}>
                        {shot ? <img className="local-shot" src={getShotUrl(shot.image_path)} alt="" loading="lazy" /> : <span className="local-shot local-shot-empty">{window.ic.hdd}</span>}
                        <span className="local-meta">
                          <span className="local-title">{game ? game.title : '#' + id}</span>
                          <span className="local-sub">{[game && game.creator, at && playedWhen(at)].filter(Boolean).join(' · ')}</span>
                        </span>
                      </button>
                      <span className="local-size tnum" title={window.t('play.local_size')}>{formatBytes(bytes)}</span>
                      {game && playability(game).ok && (
                        <a className="playing-play" href={playUrl(game)} title={window.t('play.button')} onClick={() => handOff(game)}>{playIcons.play}</a>
                      )}
                      <button className="local-del" disabled={busy} title={window.t('play.local_delete')} onClick={() => remove([id])}>
                        {window.ic.x} <span>{window.t('play.local_delete')}</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// the sidebar's icon for My Content › Playing
window.ic2 = Object.assign(window.ic2 || {}, { play: playIcons.play });

Object.assign(window, { playability, PlayRow, PlayingGrid, usePlaying, PlayButton, LocalGamesView, useLocalGames });
