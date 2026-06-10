// Cloud-synced game collections — favorites / bookmarks.
// Supports REST operations with Clerk authentication headers and fallback mock storage.

// Local translation wrapper helper
const t = function(key, fallback) {
  if (window.t) {
    const resolved = window.t(key);
    if (resolved !== key) return resolved;
  }
  return fallback !== undefined ? fallback : key;
};

// Local copy of the screenshot URL resolver to keep collections.jsx self-contained.
function favShotUrl(path) {
  if (!path) return '';
  const base = window.SCREENSHOT_BASE_URL || '';
  if (base) {
    const cleanBase = base.endsWith('/') ? base : base + '/';
    return cleanBase + path.replace(/\\/g, '/');
  }
  return path;
}

// ── Favorites REST client ───────────────────────────────────────────────────
const FAV_STORE_KEY = 'archive_favorites';
const FAV_NET_DELAY = 380; // simulated latency for the mock transport

function favWait(ms) { return new Promise((r) => setTimeout(r, ms)); }
function favMockRead() {
  try { return JSON.parse(localStorage.getItem(FAV_STORE_KEY)) || []; } catch (e) { return []; }
}
function favMockWrite(ids) {
  try { localStorage.setItem(FAV_STORE_KEY, JSON.stringify(ids)); } catch (e) {}
  // Broadcast so every mounted button / the collections grid stay in sync.
  window.dispatchEvent(new CustomEvent('favorites:changed', { detail: ids.slice() }));
}

const FavoritesAPI = {
  base() { return window.FAVORITES_API_BASE || ''; },

  async getHeaders() {
    const headers = {};
    if (typeof Clerk !== 'undefined' && Clerk.session) {
      const token = await Clerk.session.getToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }
    return headers;
  },

  // GET /api/favorites -> number[]
  async list() {
    const base = this.base();
    const headers = await this.getHeaders();
    if (base || headers['Authorization']) {
      const res = await fetch((base || '') + '/api/favorites', { headers });
      if (!res.ok) throw new Error('GET /api/favorites -> ' + res.status);
      const data = await res.json();
      return Array.isArray(data) ? data : (data.ids || []);
    }
    await favWait(FAV_NET_DELAY);
    return favMockRead();
  },

  // POST /api/favorites { gameId }
  async add(gameId) {
    const base = this.base();
    const headers = await this.getHeaders();
    if (base || headers['Authorization']) {
      const res = await fetch((base || '') + '/api/favorites', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers
        },
        body: JSON.stringify({ gameId }),
      });
      if (!res.ok) throw new Error('POST /api/favorites -> ' + res.status);
      favMockWrite([...favMockRead().filter((x) => x !== gameId)]); // keep local mirror fresh
      return;
    }
    await favWait(FAV_NET_DELAY);
    const ids = favMockRead();
    if (!ids.includes(gameId)) ids.unshift(gameId);
    favMockWrite(ids);
  },

  // DELETE /api/favorites/:gameId
  async remove(gameId) {
    const base = this.base();
    const headers = await this.getHeaders();
    if (base || headers['Authorization']) {
      const res = await fetch((base || '') + '/api/favorites/' + gameId, {
        method: 'DELETE',
        headers
      });
      if (!res.ok) throw new Error('DELETE /api/favorites -> ' + res.status);
      return;
    }
    await favWait(FAV_NET_DELAY);
    favMockWrite(favMockRead().filter((x) => x !== gameId));
  },
};

// ── Hook: live list of favorite ids ─────────────────────────────────────────
function useFavorites(auth) {
  const [ids, setIds] = React.useState(null); // null = loading
  const [error, setError] = React.useState(false);

  const load = React.useCallback(() => {
    if (auth === 'out') { setIds([]); setError(false); return; }
    setError(false);
    setIds(null);
    FavoritesAPI.list().then(setIds).catch(() => { setError(true); setIds([]); });
  }, [auth]);

  React.useEffect(() => { load(); }, [load]);

  React.useEffect(() => {
    const onChange = (e) => setIds(e.detail.slice());
    window.addEventListener('favorites:changed', onChange);
    return () => window.removeEventListener('favorites:changed', onChange);
  }, []);

  return { ids, error, reload: load };
}

// ── Favorite (bookmark) toggle button ───────────────────────────────────────
// variant: undefined (drawer, 40px square) | 'card' (corner pill on a FavCard)
function FavoriteButton({ gameId, auth, variant }) {
  const [fav, setFav] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [pop, setPop] = React.useState(false);
  const [ready, setReady] = React.useState(false);

  // Hydrate initial state from the API.
  React.useEffect(() => {
    let alive = true;
    setReady(false);
    FavoritesAPI.list()
      .then((list) => { if (alive) { setFav(list.includes(gameId)); setReady(true); } })
      .catch(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, [gameId]);

  // Stay in sync with changes triggered elsewhere.
  React.useEffect(() => {
    const onChange = (e) => setFav(e.detail.includes(gameId));
    window.addEventListener('favorites:changed', onChange);
    return () => window.removeEventListener('favorites:changed', onChange);
  }, [gameId]);

  if (auth === 'out') return null;

  const toggle = async (e) => {
    if (e) e.stopPropagation();
    if (busy || !ready) return;
    const next = !fav;
    setBusy(true);
    setFav(next); // optimistic
    if (next) { setPop(true); setTimeout(() => setPop(false), 420); }
    try {
      if (next) await FavoritesAPI.add(gameId);
      else await FavoritesAPI.remove(gameId);
      if (window.pushToast) {
        window.pushToast(
          next ? t('fav.added', 'Saved to My Collections') : t('fav.removed', 'Removed from My Collections'),
          '', next ? 'success' : 'warn');
      }
    } catch (err) {
      setFav(!next); // rollback on failure
      if (window.pushToast) {
        window.pushToast(t('fav.error', "Couldn't sync favorite"), t('fav.errorSub', 'Check your connection and try again'), 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  const label = fav ? t('fav.remove', 'Remove from My Collections') : t('fav.save', 'Save to My Collections');
  const cls = 'fav-btn'
    + (variant === 'card' ? ' fav-btn-card' : '')
    + (fav ? ' on' : '')
    + (pop ? ' pop' : '')
    + (busy ? ' busy' : '');

  return (
    <button className={cls} onClick={toggle} disabled={busy || !ready}
            aria-pressed={fav} title={label} aria-label={label}>
      <span className="fav-ic">
        {busy ? <window.Spinner /> : (fav ? window.ic.bookmarkFill : window.ic.bookmark)}
      </span>
    </button>
  );
}

// ── Visual card for a saved game ────────────────────────────────────────────
function FavCard({ game, auth, onOpen }) {
  const shots = (window.DATA.SCREENSHOTS && window.DATA.SCREENSHOTS[game.id]) || [];
  const shot = shots[0];
  return (
    <div className="fav-card" onClick={() => onOpen(game)}>
      <div className="fav-card-media">
        {shot ? (
          <img className="fav-card-img" src={favShotUrl(shot.image_path)} alt="" loading="lazy" />
        ) : (
          <div className="fav-card-fallback">
            <div className="card-thumb-grid" />
            <span className="fav-card-glyph">{game.title[0]}</span>
          </div>
        )}
        <span className="fav-card-id mono">#{game.id}</span>
        <div className="fav-card-badges">
          {game.flags.local  && <span className="bdg local"  title={t('flag.local','Archived locally')}>{window.ic.hdd}</span>}
          {game.flags.perf   && <span className="bdg perf"   title={t('flag.perf','Perfected / Deathless')}>{window.ic.trophy}</span>}
          {game.flags.broken && <span className="bdg broken" title={t('flag.broken','Link broken')}>{window.ic.broken}</span>}
        </div>
        <span className="fav-card-fav"><FavoriteButton gameId={game.id} auth={auth} variant="card" /></span>
      </div>
      <div className="fav-card-body">
        <div className="fav-card-title">{game.title}</div>
        <div className="fav-card-creator">{t('card.by', 'by')} {game.creator}</div>
        <div className="fav-card-metrics">
          <span className="metric rating">{window.ic.star}<span className="tnum">{game.rating ? game.rating.toFixed(1) : 'N/A'}</span></span>
          <span className="metric diff">{window.ic.flame}<span className="tnum">{game.difficulty !== null ? game.difficulty : 'N/A'}</span></span>
          <span style={{ marginLeft: 'auto', opacity: 0.55 }}>{game.reviews} {t('card.rev', 'rev')}</span>
        </div>
      </div>
    </div>
  );
}

function FavSkeletonCard() {
  return (
    <div className="fav-card skeleton">
      <div className="fav-card-media"><div className="skel" style={{ position: 'absolute', inset: 0 }} /></div>
      <div className="fav-card-body">
        <div className="skel" style={{ width: '72%', height: 13, marginBottom: 8 }} />
        <div className="skel" style={{ width: '46%', height: 10, marginBottom: 12 }} />
        <div className="skel" style={{ width: '60%', height: 10 }} />
      </div>
    </div>
  );
}

// ── Collections view ────────────────────────────────────────────────────────
function CollectionsView({ auth, onOpenGame, onView, onOpenLogin }) {
  const { ids, error, reload } = useFavorites(auth);

  const gamesById = React.useMemo(() => {
    const m = {};
    (window.DATA.GAMES || []).forEach((g) => { m[g.id] = g; });
    return m;
  }, []);
  const games = (ids || []).map((id) => gamesById[id]).filter(Boolean);
  const count = ids === null ? null : games.length;

  const header = (
    <div className="topbar">
      <button className="iconbtn mobile-menu-btn" onClick={() => window.toggleSidebar && window.toggleSidebar()} title={t('close_menu_title', 'Close menu')}>
        {window.ic.menu}
      </button>
      <span className="crumb"><b>{t('nav.library', 'Library')}</b><span>/</span>{t('nav.collections', 'My Collections')}</span>
    </div>
  );

  let body;
  if (auth === 'out') {
    body = (
      <window.LoginGate
        icon={window.ic.starOutline}
        title={t('fav.gate.title', 'Sign in to view your collection')}
        sub={t('fav.gate.sub', 'Your bookmarked games sync to the cloud and follow you to every device once you log in.')}
        onOpenLogin={onOpenLogin} />
    );
  } else if (ids === null) {
    body = <div className="fav-grid">{Array.from({ length: 8 }).map((_, i) => <FavSkeletonCard key={i} />)}</div>;
  } else if (error) {
    body = <window.ErrorState
             title={t('fav.error.title', "Couldn't load your collection")}
             sub={t('fav.error.sub', 'The favorites service did not respond. Please try again.')}
             onRetry={reload} />;
  } else if (games.length === 0) {
    body = (
      <div className="fav-empty">
        <div className="fav-empty-star">{window.ic.starOutline}</div>
        <h3>{t('fav.empty.title', 'No saved games yet')}</h3>
        <p>{t('fav.empty.body', 'Tap the bookmark on any game to add it here. Your collection syncs to the cloud across every device you sign in on.')}</p>
        <button className="fav-empty-cta" onClick={() => onView('explorer')}>
          {window.ic.archive} {t('fav.empty.cta', 'Browse Games')}
        </button>
      </div>
    );
  } else {
    body = (
      <div className="fav-grid">
        {games.map((g) => <FavCard key={g.id} game={g} auth={auth} onOpen={onOpenGame} />)}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>
      {header}
      <div className="collview">
        <div className="collview-inner">
          <div className="coll-head">
            <h1 className="coll-title">
              <span className="coll-title-star">{window.ic.star}</span>
              {t('nav.collections', 'My Collections')}
              {count != null && count > 0 && <span className="coll-count tnum">{count}</span>}
            </h1>
            <p className="coll-sub">
              {t('fav.subtitle', 'Your cloud-synced favorites. Bookmarked games appear here and stay in sync across all your devices.')}
            </p>
          </div>
          {body}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, {
  favShotUrl, FavoritesAPI, useFavorites, FavoriteButton, FavCard, CollectionsView,
});
