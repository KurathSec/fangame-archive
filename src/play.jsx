// Playing games in the browser. The player itself is a separate page, /play/?id=<id>
// (public/play/, on gm-recomp); this file is the catalog's side of it:
//  - which games can be played (`playability`): GameMaker 8 and GameMaker: Studio games
//    hosted on the archive's own CDN, up to PLAY_MAX_BYTES;
//  - the drawer's Play row (`PlayRow`), with the mods to apply, stored where the player
//    reads them (localStorage `gmr.mods.fa-<id>`, gm-recomp's format);
//  - My Content › Playing (`usePlaying`, `PlayingGrid`; an Explorer in 'playing' mode):
//    the games played here (localStorage `fa.playing`, written by the player) and, when
//    signed in, those with saves in the account (/api/saves).

const PLAY_ENGINES = { 'GameMaker 8': 'gm8', 'GameMaker: Studio': 'gms' };
// The whole archive is unpacked in the browser's memory.
const PLAY_MAX_BYTES = 512 * 1024 * 1024;

/** {ok: true, kind: 'gm8'|'gms'} or {ok: false, reason: 'engine'|'link'|'host'|'size'}. */
function playability(game) {
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
  return (
    <section className="drawer-sec play-sec">
      <div className="play-row">
        <a className="launch-btn play-btn" href={playUrl(game)} onClick={() => handOff(game)}>
          {playIcons.play} {window.t('play.button')}
        </a>
        <button className={'roll-again-btn play-mods-btn' + (open ? ' open' : '') + (onCount ? ' active' : '')}
                onClick={() => setOpen(!open)} aria-expanded={open}>
          {playIcons.mods} {window.t('play.mods')}{onCount ? ' · ' + onCount : ''}
        </button>
      </div>
      {open && <PlayMods game={game} kind={p.kind} choices={choices} setChoices={setChoices} />}
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

// the sidebar's icon for My Content › Playing
window.ic2 = Object.assign(window.ic2 || {}, { play: playIcons.play });

Object.assign(window, { playability, PlayRow, PlayingGrid, usePlaying });
