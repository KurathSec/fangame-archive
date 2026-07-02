// Cloud-synced game collections — favorites / bookmarks.
// Supports REST operations with Clerk authentication headers and fallback mock storage.

(function() {

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
      const ids = favMockRead();
      if (!ids.includes(gameId)) ids.unshift(gameId);
      favMockWrite(ids);
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
      favMockWrite(favMockRead().filter((x) => x !== gameId));
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
          {auth !== 'out' && <CollectionsManager auth={auth} onOpenGame={onOpenGame} />}
          {auth !== 'out' && (
            <div className="cmgr-head" style={{ marginTop: 20 }}>
              <h2 className="cmgr-title">{window.ic.star} {t('main_saves', 'Main saves')}{count != null && count > 0 ? ' · ' + count : ''}</h2>
            </div>
          )}
          {body}
        </div>
      </div>
    </div>
  );
}

// ══ Collections v2 ══════════════════════════════════════════════════════════
// Named lists + one level of folders, multi-membership, link sharing, and a
// moderated public library. `user_favorites` (above) stays the untouched "main"
// bucket; everything below is additive.

const COL_PRESETS = ['My Favorites', 'Recommended', 'To Play', 'Needle', 'Avoidance', 'Gimmick', 'Beginner Friendly', 'Hall of Fame'];
const COL_LIMITS = { NAME: 60, DESC: 300, TOP_LEVEL: 20, SUBS: 5, ITEMS: 1000 };

function isShareableUnlisted(name, desc) {
  const okName = !name || COL_PRESETS.includes(name);
  return okName && !desc;
}
function broadcastCollections() {
  window.dispatchEvent(new CustomEvent('collections:changed'));
}

const CollectionsAPI = {
  base() { return window.FAVORITES_API_BASE || ''; },
  async getHeaders(json) {
    const headers = {};
    if (json) headers['Content-Type'] = 'application/json';
    if (typeof Clerk !== 'undefined' && Clerk.session) {
      const token = await Clerk.session.getToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  },
  async _req(path, opts) {
    const res = await fetch((this.base() || '') + path, opts || {});
    if (!res.ok) {
      let msg;
      try { msg = (await res.json()).error; } catch (e) {}
      throw new Error(msg || (((opts && opts.method) || 'GET') + ' ' + path + ' -> ' + res.status));
    }
    return res.status === 204 ? null : res.json();
  },
  async listTree() { const h = await this.getHeaders(); const d = await this._req('/api/collections', { headers: h }); return (d && d.collections) || []; },
  async create(payload) { const h = await this.getHeaders(true); const d = await this._req('/api/collections', { method: 'POST', headers: h, body: JSON.stringify(payload) }); broadcastCollections(); return d; },
  async update(id, patch) { const h = await this.getHeaders(true); const d = await this._req('/api/collections/' + id, { method: 'PATCH', headers: h, body: JSON.stringify(patch) }); broadcastCollections(); return d; },
  async remove(id) { const h = await this.getHeaders(); const d = await this._req('/api/collections/' + id, { method: 'DELETE', headers: h }); broadcastCollections(); return d; },
  async detail(id) { const h = await this.getHeaders(); return this._req('/api/collections/' + id, { headers: h }); },
  async membership(gameId) { const h = await this.getHeaders(); return this._req('/api/collections/membership?gameId=' + gameId, { headers: h }); },
  async addItem(id, gameId) { const h = await this.getHeaders(true); const d = await this._req('/api/collections/' + id + '/items', { method: 'POST', headers: h, body: JSON.stringify({ gameId }) }); broadcastCollections(); return d; },
  async removeItem(id, gameId) { const h = await this.getHeaders(); const d = await this._req('/api/collections/' + id + '/items/' + gameId, { method: 'DELETE', headers: h }); broadcastCollections(); return d; },
  async setVisibility(id, mode, turnstileToken, showOwner) { const h = await this.getHeaders(true); const d = await this._req('/api/collections/' + id + '/visibility', { method: 'POST', headers: h, body: JSON.stringify({ mode, turnstileToken, showOwner }) }); broadcastCollections(); return d; },
  async publicList(page) { return this._req('/api/collections/public?page=' + (page || 1)); },
  async shared(token) { return this._req('/api/collections/shared/' + encodeURIComponent(token)); },
};

// ── Hooks ────────────────────────────────────────────────────────────────────
function useCollections(auth) {
  const [collections, setCollections] = React.useState(null); // null = loading
  const [error, setError] = React.useState(false);
  const load = React.useCallback(() => {
    if (auth === 'out') { setCollections([]); setError(false); return; }
    setError(false);
    CollectionsAPI.listTree().then((c) => setCollections(c)).catch(() => { setError(true); setCollections([]); });
  }, [auth]);
  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => {
    const onChange = () => load();
    window.addEventListener('collections:changed', onChange);
    return () => window.removeEventListener('collections:changed', onChange);
  }, [load]);
  return { collections, error, reload: load };
}

function useMembership(gameId, auth) {
  const [state, setState] = React.useState({ loading: true, collectionIds: [], main: false });
  const load = React.useCallback(() => {
    if (auth === 'out' || gameId == null) { setState({ loading: false, collectionIds: [], main: false }); return; }
    CollectionsAPI.membership(gameId)
      .then((r) => setState({ loading: false, collectionIds: r.collectionIds || [], main: !!r.main }))
      .catch(() => setState({ loading: false, collectionIds: [], main: false }));
  }, [gameId, auth]);
  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => {
    const onChange = () => load();
    window.addEventListener('collections:changed', onChange);
    window.addEventListener('favorites:changed', onChange);
    return () => { window.removeEventListener('collections:changed', onChange); window.removeEventListener('favorites:changed', onChange); };
  }, [load]);
  return { ...state, reload: load };
}

// Split a flat collection list into {folders:[{...,children:[]}], lists:[]} for top level.
function buildTree(collections) {
  const byId = {};
  (collections || []).forEach((c) => { byId[c.id] = { ...c, children: [] }; });
  const top = [];
  (collections || []).forEach((c) => {
    if (c.parent_id != null && byId[c.parent_id]) byId[c.parent_id].children.push(byId[c.id]);
    else if (c.parent_id == null) top.push(byId[c.id]);
  });
  return top;
}
function collectionLabel(c) {
  return c.name || t('collection_untitled', 'Untitled list');
}

// ── Anchored popover (portal, escapes drawer overflow) ───────────────────────
function AnchoredPopover({ anchorRef, onClose, width, children }) {
  const popRef = React.useRef(null);
  const [pos, setPos] = React.useState(null);
  const w = width || 268;
  React.useLayoutEffect(() => {
    const place = () => {
      const el = anchorRef.current; if (!el) return;
      const r = el.getBoundingClientRect();
      let left = r.right - w; if (left < 8) left = 8;
      if (left + w > window.innerWidth - 8) left = window.innerWidth - 8 - w;
      let top = r.bottom + 6;
      setPos({ left, top });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchorRef, w]);
  React.useEffect(() => {
    const onDoc = (e) => {
      if (popRef.current && popRef.current.contains(e.target)) return;
      if (anchorRef.current && anchorRef.current.contains(e.target)) return;
      onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const id = setTimeout(() => document.addEventListener('mousedown', onDoc), 0);
    document.addEventListener('keydown', onKey);
    return () => { clearTimeout(id); document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [onClose, anchorRef]);
  if (!pos) return null;
  return ReactDOM.createPortal(
    <div ref={popRef} className="cm-pop" style={{ left: pos.left, top: pos.top, width: w }}>{children}</div>,
    document.body
  );
}

// ── Per-game "add to collections" manager (Save + remove-from-where) ─────────
function CollectionMenuButton({ gameId, auth }) {
  const anchorRef = React.useRef(null);
  const [open, setOpen] = React.useState(false);
  const [creating, setCreating] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const { collectionIds, main, reload } = useMembership(gameId, auth);
  const { collections } = useCollections(auth);
  if (auth === 'out') return null;

  const inSet = new Set(collectionIds || []);
  // Top-level leaves only; sub-lists are shown under their folder below.
  const lists = (collections || []).filter((c) => (c.child_count || 0) === 0 && c.parent_id == null);
  const folders = (collections || []).filter((c) => (c.child_count || 0) > 0 && c.parent_id == null);

  const toggleList = async (c) => {
    if (busy) return;
    setBusy(true);
    try {
      if (inSet.has(c.id)) await CollectionsAPI.removeItem(c.id, gameId);
      else await CollectionsAPI.addItem(c.id, gameId);
      reload();
    } catch (err) {
      if (window.pushToast) window.pushToast(t('collection_action_failed', "Couldn't update the collection"), err.message || '', 'error');
    } finally { setBusy(false); }
  };
  const toggleMain = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (main) await FavoritesAPI.remove(gameId);
      else await FavoritesAPI.add(gameId);
      reload();
    } catch (err) {
      if (window.pushToast) window.pushToast(t('collection_action_failed', "Couldn't update the collection"), err.message || '', 'error');
    } finally { setBusy(false); }
  };
  const createAndAdd = async () => {
    const name = creating.trim();
    if (busy) return;
    setBusy(true);
    try {
      const res = await CollectionsAPI.create({ name: name || null });
      if (res && res.id) await CollectionsAPI.addItem(res.id, gameId);
      setCreating('');
      reload();
      if (window.pushToast) window.pushToast(t('collection_created', 'Collection created'), '', 'success');
    } catch (err) {
      if (window.pushToast) window.pushToast(t('collection_create_failed', "Couldn't create the collection"), err.message || '', 'error');
    } finally { setBusy(false); }
  };

  const savedCount = (main ? 1 : 0) + inSet.size;
  const renderRow = (c, indent) => (
    <button key={c.id} className={'cm-row' + (inSet.has(c.id) ? ' on' : '')} style={indent ? { paddingLeft: 30 } : null} onClick={() => toggleList(c)} disabled={busy}>
      <span className="cm-check">{inSet.has(c.id) ? window.ic.check : null}</span>
      <span className="cm-row-name">{collectionLabel(c)}</span>
      <span className="cm-row-ct mono">{c.item_count || 0}</span>
    </button>
  );

  return (
    <React.Fragment>
      <button ref={anchorRef} className={'cm-btn' + (savedCount ? ' on' : '')} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
              title={t('add_to_collection', 'Add to collection')} aria-label={t('add_to_collection', 'Add to collection')}>
        {window.ic.plus}
      </button>
      {open && (
        <AnchoredPopover anchorRef={anchorRef} onClose={() => setOpen(false)}>
          <div className="cm-head">{t('save_to', 'Save to…')}</div>
          <div className="cm-list">
            <button className={'cm-row' + (main ? ' on' : '')} onClick={toggleMain} disabled={busy}>
              <span className="cm-check">{main ? window.ic.check : null}</span>
              <span className="cm-row-name">{t('nav.collections', 'My Collections')}</span>
              <span className="cm-row-ic">{window.ic.star}</span>
            </button>
            {lists.map((c) => renderRow(c, false))}
            {folders.map((f) => (
              <div key={f.id}>
                <div className="cm-folder">{window.ic.folder}<span>{collectionLabel(f)}</span></div>
                {(collections || []).filter((c) => c.parent_id === f.id).map((c) => renderRow(c, true))}
              </div>
            ))}
          </div>
          <div className="cm-new">
            <input value={creating} onChange={(e) => setCreating(e.target.value)} maxLength={COL_LIMITS.NAME}
                   placeholder={t('new_list_placeholder', 'New list name (optional)')}
                   onKeyDown={(e) => { if (e.key === 'Enter') createAndAdd(); }} />
            <button onClick={createAndAdd} disabled={busy}>{window.ic.plus}</button>
          </div>
        </AnchoredPopover>
      )}
    </React.Fragment>
  );
}

// ── Create / edit + share modal ──────────────────────────────────────────────
function CollectionEditModal({ collection, parentId, parentPublic, onClose, onSaved }) {
  const editing = !!collection;
  const deriveMode = (c) => {
    if (!c) return 'none';
    const n = c.name || '', d = c.description || '';
    if (d) return 'custom';
    if (!n) return 'none';
    return COL_PRESETS.includes(n) ? 'preset' : 'custom';
  };
  const [col, setCol] = React.useState(collection || null);
  const [mode, setMode] = React.useState(() => deriveMode(collection));
  const [name, setName] = React.useState(collection ? (collection.name || '') : '');
  const [desc, setDesc] = React.useState(collection ? (collection.description || '') : '');
  const [busy, setBusy] = React.useState(false);
  const [verified, setVerified] = React.useState(null);
  const [copied, setCopied] = React.useState(false);
  // Attribution: reflect the stored flag for anything that has been shared;
  // default ON for a not-yet-shared collection (applied on share/publish).
  const [showOwner, setShowOwner] = React.useState(() =>
    collection ? (collection.share_token ? !!collection.share_show_owner : true) : true);
  React.useEffect(() => { setCol(collection || null); }, [collection]);
  const vis = col ? col.visibility : 'private';
  const locked = vis === 'public'; // name/desc locked while public
  const isFolder = !!(col && (col.child_count || 0) > 0);
  const custom = !isShareableUnlisted(name.trim() || null, desc.trim() || null);
  const shareUrl = col && col.share_token ? (location.origin + '/?collection=' + col.share_token) : '';
  // The share link is live for unlisted, and for public once approved.
  const linkLive = vis === 'unlisted' || (vis === 'public' && col && col.moderation_status === 'approved');

  // None = no name/description; Preset = pick a preset name (no description);
  // Custom = free-text name + description. None/Preset stay link-shareable;
  // Custom must go through "Open to public" (reviewed).
  const changeMode = (m) => {
    setMode(m);
    if (m === 'none') { setName(''); setDesc(''); }
    else if (m === 'preset') { setDesc(''); if (!COL_PRESETS.includes(name)) setName(''); }
    // 'custom': keep whatever is typed
  };

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      let res;
      if (editing) res = await CollectionsAPI.update(col.id, { name: name.trim() || null, description: desc.trim() || null });
      else res = await CollectionsAPI.create({ name: name.trim() || null, description: desc.trim() || null, parentId: parentId || null });
      if (window.pushToast) {
        // A custom-text child of a public folder is held for review before it
        // shows on the public page — tell the owner that happened.
        if (res && res.pendingReview) window.pushToast(t('collection_created_pending', 'Saved — the custom name/description will show publicly after review'), '', 'success');
        else window.pushToast(editing ? t('collection_saved', 'Collection saved') : t('collection_created', 'Collection created'), '', 'success');
      }
      if (onSaved) onSaved();
      onClose();
    } catch (err) {
      if (window.pushToast) window.pushToast(t('collection_save_failed', "Couldn't save the collection"), err.message || '', 'error');
    } finally { setBusy(false); }
  };

  // Persist unsaved name/description before a share/publish transition, so the
  // value that gets gated (unlisted preset check) or locked (public) is the one
  // currently in the form, not a stale stored value.
  const persistIfDirty = async () => {
    if (!col || locked) return;
    const n = name.trim() || null, d = desc.trim() || null;
    if (n !== (col.name || null) || d !== (col.description || null)) {
      await CollectionsAPI.update(col.id, { name: n, description: d });
      setCol((c) => ({ ...c, name: n, description: d }));
    }
  };

  const applyVis = async (mode) => {
    if (busy || !col) return;
    setBusy(true);
    try {
      if (mode !== 'private') await persistIfDirty();
      const res = await CollectionsAPI.setVisibility(col.id, mode, verified, mode === 'private' ? undefined : showOwner);
      if (window.pushToast) {
        window.pushToast(
          mode === 'public' ? t('collection_submitted', 'Submitted for review') : mode === 'unlisted' ? t('collection_link_on', 'Share link enabled') : t('collection_made_private', 'Set to private'),
          '', 'success');
      }
      if (onSaved) onSaved();
      if (mode === 'unlisted') {
        // Keep the modal open so the freshly-issued link renders for copying.
        setCol((c) => ({ ...c, visibility: 'unlisted', share_token: (res && res.share_token) || (c && c.share_token) }));
      } else {
        onClose();
      }
    } catch (err) {
      if (window.pushToast) window.pushToast(t('collection_share_failed', "Couldn't change sharing"), err.message || '', 'error');
    } finally { setBusy(false); }
  };

  // Live toggle: for an already-shared collection persist immediately; for a
  // private one the choice rides along with the next share/publish call.
  const toggleShowOwner = async (e) => {
    const v = e.target.checked;
    setShowOwner(v);
    if (!col || vis === 'private') return;
    try {
      await CollectionsAPI.update(col.id, { showOwner: v });
      setCol((c) => (c ? { ...c, share_show_owner: v ? 1 : 0 } : c));
      if (onSaved) onSaved();
    } catch (err) {
      setShowOwner(!v);
      if (window.pushToast) window.pushToast(t('collection_save_failed', "Couldn't save the collection"), err.message || '', 'error');
    }
  };

  const copyLink = () => {
    if (!shareUrl) return;
    try { navigator.clipboard.writeText(shareUrl); } catch (e) {
      const ta = document.createElement('textarea'); ta.value = shareUrl; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e2) {} document.body.removeChild(ta);
    }
    setCopied(true); setTimeout(() => setCopied(false), 1600);
  };

  return ReactDOM.createPortal(
    <div className="col-scrim" onMouseDown={onClose}>
      <div className="col-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="col-modal-head">
          <h3>{editing ? t('edit_collection', 'Edit collection') : t('create_collection', 'Create collection')}</h3>
          <button className="col-modal-x" onClick={onClose}>{window.ic.x}</button>
        </div>

        {locked ? (
          <React.Fragment>
            <label className="col-field">
              <span className="col-field-label">{t('collection_name', 'Name')}</span>
              <div className="col-locked">{name || t('collection_untitled', 'Untitled list')}</div>
            </label>
            <label className="col-field">
              <span className="col-field-label">{t('collection_desc', 'Description')}</span>
              <div className="col-locked">{desc || '—'}</div>
            </label>
          </React.Fragment>
        ) : (
          <React.Fragment>
            <span className="col-field-label">{t('collection_naming', 'Naming')}</span>
            <div className="col-modeseg" role="tablist">
              {[['none', t('mode_none', 'None')], ['preset', t('mode_preset', 'Preset')], ['custom', t('mode_custom', 'Custom')]].map(([m, label]) => (
                <button key={m} type="button" className={'col-modeseg-btn' + (mode === m ? ' on' : '')} onClick={() => changeMode(m)}>{label}</button>
              ))}
            </div>

            <div className="col-modehelp">
              {mode === 'none' && t('mode_none_help', 'No name or description — shareable instantly by link, no review.')}
              {mode === 'preset' && t('mode_preset_help', 'Pick a ready-made name; no description — shareable instantly by link, no review.')}
              {mode === 'custom' && t('mode_custom_help', 'Write your own name and description. Sharing it requires “Open to public”, which is reviewed first.')}
              {mode === 'custom' && !editing && parentPublic && (
                <div className="col-modehelp-warn">{t('mode_custom_public_parent', 'The parent collection is public — a custom name/description will only appear there after review.')}</div>
              )}
            </div>

            {mode === 'preset' && (
              <label className="col-field">
                <span className="col-field-label">{t('collection_name', 'Name')}</span>
                <select value={COL_PRESETS.includes(name) ? name : ''} onChange={(e) => setName(e.target.value)}>
                  <option value="">{t('choose_preset', 'Choose a preset…')}</option>
                  {COL_PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
            )}

            {mode === 'custom' && (
              <React.Fragment>
                <label className="col-field">
                  <span className="col-field-label">{t('collection_name', 'Name')} <em>{t('optional', 'optional')}</em></span>
                  <input value={name} maxLength={COL_LIMITS.NAME} onChange={(e) => setName(e.target.value)} placeholder={t('collection_name_ph', 'Collection name')} />
                  <span className="col-count mono">{name.length}/{COL_LIMITS.NAME}</span>
                </label>
                <label className="col-field">
                  <span className="col-field-label">{t('collection_desc', 'Description')} <em>{t('optional', 'optional')}</em></span>
                  <textarea value={desc} maxLength={COL_LIMITS.DESC} rows={3} onChange={(e) => setDesc(e.target.value)} placeholder={t('collection_desc_ph', 'Describe this collection…')} />
                  <span className="col-count mono">{desc.length}/{COL_LIMITS.DESC}</span>
                </label>
              </React.Fragment>
            )}
          </React.Fragment>
        )}

        {!locked && (
          <div className="col-modal-actions">
            <button className="col-btn ghost" onClick={onClose} disabled={busy}>{t('cancel', 'Cancel')}</button>
            <button className="col-btn primary" onClick={save} disabled={busy}>{editing ? t('save', 'Save') : t('create', 'Create')}</button>
          </div>
        )}

        {editing && col && (
          <div className="col-share">
            <div className="col-share-title">{t('sharing', 'Sharing')}</div>

            <button className={'col-vis' + (vis === 'private' ? ' on' : '')} onClick={() => applyVis('private')} disabled={busy}>
              {window.ic2.lock}<span><b>{t('vis_private', 'Private')}</b><em>{t('vis_private_sub', 'Only you can see this.')}</em></span>
            </button>

            {!isFolder && (
              <button className={'col-vis' + (vis === 'unlisted' ? ' on' : '')} disabled={busy || custom}
                      onClick={() => applyVis('unlisted')} title={custom ? t('vis_unlisted_blocked', 'Remove the custom name/description to share by link') : ''}>
                {window.ic.link}<span><b>{t('vis_unlisted', 'Share by link')}</b><em>{custom ? t('vis_unlisted_blocked', 'Remove the custom name/description to share by link') : t('vis_unlisted_sub', 'Anyone with the link can view. Not listed anywhere.')}</em></span>
              </button>
            )}

            <div className={'col-vis static' + (vis === 'public' ? ' on' : '')}>
              {window.ic2.shield}<span><b>{t('vis_public', 'Open to public')}</b>
                <em>{vis === 'public' ? (
                  col.moderation_status === 'approved' ? t('vis_public_approved', 'Live in the public library.') :
                  col.moderation_status === 'rejected' ? (t('vis_public_rejected', 'Rejected: ') + (col.reject_reason || '')) :
                  t('vis_public_pending', 'Pending review.')
                ) : isFolder ? t('vis_public_folder_sub', 'Lists the folder and its sub-collections in the public library after review.')
                  : t('vis_public_sub', 'Listed in the public library after review.')}</em>
              </span>
            </div>

            {linkLive && shareUrl && (
              <div className="col-link-row">
                <input readOnly value={shareUrl} onFocus={(e) => e.target.select()} />
                <button onClick={copyLink}>{copied ? window.ic.check : window.ic.link}<span>{copied ? t('copied', 'Copied') : t('copy_link', 'Copy')}</span></button>
              </div>
            )}

            <label className="col-showowner">
              <input type="checkbox" checked={showOwner} onChange={toggleShowOwner} disabled={busy} />
              <span>{t('show_owner_label', 'Show my username on the shared page')}</span>
            </label>

            {vis !== 'public' && (
              <div className="col-publish">
                <window.Turnstile verified={verified} onVerify={setVerified} />
                <button className="col-btn primary" disabled={busy || !verified} onClick={() => applyVis('public')}>
                  {window.ic2.shield} {t('submit_for_review', 'Submit for public library')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

// Resolve game objects by id for the guest shared page (catalog may be absent).
function mapIndexGame(e) {
  const url = e.url || '';
  const local = url.includes('file.fangame-archive.com') || url.includes('r2.dev');
  return {
    id: e.id, title: e.title || 'Untitled', creator: e.creator || 'Unknown', creator_url: '#',
    rating: (e.rating === undefined ? null : e.rating), difficulty: (e.difficulty === undefined ? null : e.difficulty),
    reviews: e.rating_count || 0, file_size: e.file_size || 0, engine: null, tags: e.tags || [],
    url, df_id: 'id-' + String(e.id).padStart(5, '0'),
    flags: { local, shots: false, perf: false, broken: !url, missing: !url },
  };
}
async function resolveGamesByIds(ids) {
  const games = window.DATA && window.DATA.GAMES;
  const byId = {};
  if (games && games.length) games.forEach((g) => { byId[g.id] = g; });
  const out = [];
  for (const id of ids) {
    if (byId[id]) { out.push(byId[id]); continue; }
    try {
      const res = await fetch('/api/search?id=' + id);
      if (res.ok) { const d = await res.json(); if (d.results && d.results[0]) out.push(mapIndexGame(d.results[0])); }
    } catch (e) {}
  }
  return out;
}

// ── Shared read-only collection page (?collection=<token>) ───────────────────
function SharedCollectionView({ token, onOpenGame, onView }) {
  const [state, setState] = React.useState({ loading: true, error: false, col: null, games: [], sections: null });
  React.useEffect(() => {
    let alive = true;
    setState({ loading: true, error: false, col: null, games: [], sections: null });
    if (!window.DATA) window.DATA = { GAMES: [], SCREENSHOTS: {} };
    if (!window.DATA.SCREENSHOTS) window.DATA.SCREENSHOTS = {};
    CollectionsAPI.shared(token).then(async (d) => {
      if (!alive) return;
      const col = d.collection;
      if (col.children) {
        // Shared folder: one section per visible sub-collection.
        const sections = [];
        for (const ch of col.children) {
          const games = await resolveGamesByIds(ch.game_ids || []);
          (ch.game_ids || []).forEach((id) => { if (!window.DATA.SCREENSHOTS[id]) window.DATA.SCREENSHOTS[id] = []; });
          sections.push({ name: ch.name, description: ch.description, count: (ch.game_ids || []).length, games });
        }
        if (alive) setState({ loading: false, error: false, col, games: [], sections });
        return;
      }
      const games = await resolveGamesByIds(col.game_ids || []);
      (col.game_ids || []).forEach((id) => { if (!window.DATA.SCREENSHOTS[id]) window.DATA.SCREENSHOTS[id] = []; });
      if (alive) setState({ loading: false, error: false, col, games, sections: null });
    }).catch(() => { if (alive) setState({ loading: false, error: true, col: null, games: [], sections: null }); });
    return () => { alive = false; };
  }, [token]);

  const header = (
    <div className="topbar">
      <button className="iconbtn mobile-menu-btn" onClick={() => window.toggleSidebar && window.toggleSidebar()} title={t('menu', 'Menu')}>{window.ic.menu}</button>
      <span className="crumb"><b>{t('shared_collection', 'Shared collection')}</b></span>
    </div>
  );

  let body;
  if (state.loading) body = <div className="fav-grid">{Array.from({ length: 6 }).map((_, i) => <FavSkeletonCard key={i} />)}</div>;
  else if (state.error) body = <window.ErrorState title={t('shared_gone_title', 'Collection unavailable')} sub={t('shared_gone_sub', 'This shared collection no longer exists or is private.')} onRetry={() => onView && onView('explorer')} />;
  else {
    const totalGames = state.sections
      ? state.sections.reduce((n, s) => n + s.count, 0)
      : (state.col.game_ids ? state.col.game_ids.length : state.games.length);
    body = (
      <React.Fragment>
        <div className="coll-head">
          <h1 className="coll-title">{state.col.name || t('shared_collection', 'Shared collection')}</h1>
          {state.col.description && <p className="coll-sub">{state.col.description}</p>}
          <p className="coll-sub mono">{totalGames} {t('games_suffix', 'games')}{state.col.owner_name ? ' · ' + t('by_author', 'by') + ' ' + state.col.owner_name : ''}</p>
        </div>
        {state.sections ? state.sections.map((sec, i) => (
          <div key={i} className="colsec">
            <div className="colsec-head">
              <h2 className="colsec-title">{window.ic.bookmark}{sec.name || t('collection_untitled', 'Untitled list')}<span className="colsec-ct mono">{sec.count}</span></h2>
              {sec.description && <p className="coll-sub">{sec.description}</p>}
            </div>
            <div className="fav-grid">{sec.games.map((g) => <FavCard key={g.id} game={g} auth={'out'} onOpen={onOpenGame} />)}</div>
          </div>
        )) : (
          <div className="fav-grid">{state.games.map((g) => <FavCard key={g.id} game={g} auth={'out'} onOpen={onOpenGame} />)}</div>
        )}
      </React.Fragment>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>
      {header}
      <div className="collview"><div className="collview-inner">{body}</div></div>
    </div>
  );
}

// ── Public library ───────────────────────────────────────────────────────────
function PublicLibraryView({ auth, onView }) {
  const [state, setState] = React.useState({ loading: true, error: false, items: [], page: 1, hasMore: false });
  const load = React.useCallback((page) => {
    setState((s) => ({ ...s, loading: true, error: false }));
    CollectionsAPI.publicList(page).then((d) => {
      setState({ loading: false, error: false, items: d.collections || [], page: d.page || page, hasMore: !!d.hasMore });
    }).catch(() => setState((s) => ({ ...s, loading: false, error: true })));
  }, []);
  React.useEffect(() => { load(1); }, [load]);

  const open = (c) => { if (c.share_token) { window.history.pushState({}, '', '/?collection=' + c.share_token); window.dispatchEvent(new PopStateEvent('popstate')); } };

  const header = (
    <div className="topbar">
      <button className="iconbtn mobile-menu-btn" onClick={() => window.toggleSidebar && window.toggleSidebar()} title={t('menu', 'Menu')}>{window.ic.menu}</button>
      <span className="crumb"><b>{t('nav.library', 'Library')}</b><span>/</span>{t('nav.public_collections', 'Public Collections')}</span>
    </div>
  );

  let body;
  if (state.loading) body = <div className="publib-grid">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="publib-card skeleton"><div className="skel" style={{ height: 60 }} /></div>)}</div>;
  else if (state.error) body = <window.ErrorState title={t('publib_error', "Couldn't load public collections")} sub={t('publib_error_sub', 'Please try again.')} onRetry={() => load(state.page)} />;
  else if (!state.items.length) body = (
    <div className="fav-empty"><div className="fav-empty-star">{window.ic2.shield}</div><h3>{t('publib_empty', 'No public collections yet')}</h3><p>{t('publib_empty_sub', 'Approved public collections shared by the community will appear here.')}</p></div>
  );
  else body = (
    <React.Fragment>
      <div className="publib-grid">
        {state.items.map((c) => (
          <button key={c.id} className="publib-card" onClick={() => open(c)}>
            <div className="publib-card-name">{(c.child_count || 0) > 0 && window.ic.folder}{c.name || t('collection_untitled', 'Untitled list')}</div>
            {c.description && <div className="publib-card-desc">{c.description}</div>}
            <div className="publib-card-foot mono">{c.item_count || 0} {t('games_suffix', 'games')}{c.owner_name ? ' · ' + t('by_author', 'by') + ' ' + c.owner_name : ''}</div>
          </button>
        ))}
      </div>
      {(state.page > 1 || state.hasMore) && (
        <div className="publib-pager">
          <button disabled={state.page <= 1} onClick={() => load(state.page - 1)}>{window.ic.arrow_l}</button>
          <span className="mono">{state.page}</span>
          <button disabled={!state.hasMore} onClick={() => load(state.page + 1)}>{window.ic.arrow_r}</button>
        </div>
      )}
    </React.Fragment>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>
      {header}
      <div className="collview"><div className="collview-inner">
        <div className="coll-head"><h1 className="coll-title"><span className="coll-title-star">{window.ic2.shield}</span>{t('nav.public_collections', 'Public Collections')}</h1>
          <p className="coll-sub">{t('publib_sub', 'Community-shared game lists, reviewed before they appear here.')}</p></div>
        {body}
      </div></div>
    </div>
  );
}

// ── Manager panel on the "My Collections" page ──────────────────────────────
function CollectionsManager({ auth, onOpenGame }) {
  const { collections, error, reload } = useCollections(auth);
  const [selected, setSelected] = React.useState(null);
  const [modal, setModal] = React.useState(null); // {collection?} | {parentId?} | {}
  const [detail, setDetail] = React.useState({ loading: false, games: [], col: null });
  const tree = React.useMemo(() => buildTree(collections || []), [collections]);

  React.useEffect(() => {
    if (selected == null) { setDetail({ loading: false, games: [], col: null }); return; }
    let alive = true;
    setDetail({ loading: true, games: [], col: null });
    CollectionsAPI.detail(selected).then((d) => {
      if (!alive) return;
      const col = d.collection;
      const byId = {}; (window.DATA.GAMES || []).forEach((g) => { byId[g.id] = g; });
      const games = (col.game_ids || []).map((id) => byId[id]).filter(Boolean);
      setDetail({ loading: false, games, col });
    }).catch(() => { if (alive) setDetail({ loading: false, games: [], col: null }); });
    return () => { alive = false; };
  }, [selected, collections]);

  const del = async (c) => {
    if (!window.confirm(t('confirm_delete_collection', 'Delete this collection? This cannot be undone.'))) return;
    try { await CollectionsAPI.remove(c.id); if (selected === c.id) setSelected(null); }
    catch (err) { if (window.pushToast) window.pushToast(t('collection_delete_failed', "Couldn't delete"), err.message || '', 'error'); }
  };

  if (selected != null) {
    const col = detail.col;
    return (
      <div className="cmgr-detail">
        <div className="cmgr-detail-head">
          <button className="cmgr-back" onClick={() => setSelected(null)}>{window.ic.arrow_l} {t('back', 'Back')}</button>
          {col && (
            <div className="cmgr-detail-actions">
              <button onClick={() => setModal({ collection: col })}>{window.ic2.gear} {t('edit_share', 'Edit & share')}</button>
              <button className="danger" onClick={() => del(col)}>{window.ic.x} {t('delete', 'Delete')}</button>
            </div>
          )}
        </div>
        {col && <h2 className="cmgr-detail-title">{collectionLabel(col)}</h2>}
        {col && col.description && <p className="coll-sub">{col.description}</p>}
        {detail.loading ? <div className="fav-grid">{Array.from({ length: 4 }).map((_, i) => <FavSkeletonCard key={i} />)}</div>
          : detail.games.length ? <div className="fav-grid">{detail.games.map((g) => <FavCard key={g.id} game={g} auth={auth} onOpen={onOpenGame} />)}</div>
          : <div className="fav-empty"><h3>{t('list_empty', 'This list is empty')}</h3><p>{t('list_empty_sub', 'Add games from any game’s “add to collection” menu.')}</p></div>}
        {modal && <CollectionEditModal collection={modal.collection} parentId={modal.parentId} parentPublic={modal.parentPublic} onClose={() => setModal(null)} onSaved={reload} />}
      </div>
    );
  }

  return (
    <div className="cmgr">
      <div className="cmgr-head">
        <h2 className="cmgr-title">{t('your_collections', 'Your collections')}</h2>
        <button className="cmgr-new" onClick={() => setModal({})}>{window.ic.plus} {t('new_collection_cta', 'New collection')}</button>
      </div>
      {collections === null ? <div className="cmgr-list"><div className="skel" style={{ height: 44 }} /></div>
        : error ? <window.ErrorState title={t('collections_error', "Couldn't load collections")} onRetry={reload} />
        : !tree.length ? <div className="cmgr-empty">{t('no_collections', 'No collections yet. Create one to organize saved games into shareable lists.')}</div>
        : (
          <div className="cmgr-list">
            {tree.map((node) => (
              <div key={node.id} className="cmgr-node">
                <div className="cmgr-row">
                  <button className="cmgr-row-main" onClick={() => (node.child_count ? undefined : setSelected(node.id))} disabled={!!node.child_count}>
                    {node.child_count ? window.ic.folder : window.ic.bookmark}
                    <span className="cmgr-name">{collectionLabel(node)}</span>
                    {!node.child_count && <span className="cmgr-ct mono">{node.item_count || 0}</span>}
                    {node.visibility === 'public' && <span className="cmgr-badge pub">{t('vis_public_badge', 'Public')}</span>}
                    {node.visibility === 'public' && node.moderation_status === 'pending' && <span className="cmgr-badge pend">{t('badge_pending', 'Pending review')}</span>}
                    {node.visibility === 'public' && node.moderation_status === 'rejected' && <span className="cmgr-badge rej">{t('badge_rejected', 'Rejected')}</span>}
                    {node.visibility === 'unlisted' && <span className="cmgr-badge link">{window.ic.link}</span>}
                  </button>
                  <button className="cmgr-mini" onClick={() => setModal({ collection: node })} title={t('edit', 'Edit')}>{window.ic2.gear}</button>
                  {(node.child_count || 0) < COL_LIMITS.SUBS && (node.item_count || 0) === 0 && node.parent_id == null && (
                    <button className="cmgr-mini" onClick={() => setModal({ parentId: node.id, parentPublic: node.visibility === 'public' })} title={t('add_subcollection', 'Add sub-collection')}>{window.ic.plus}</button>
                  )}
                  <button className="cmgr-mini danger" onClick={() => del(node)} title={t('delete', 'Delete')}>{window.ic.x}</button>
                </div>
                {node.children && node.children.length > 0 && (
                  <div className="cmgr-children">
                    {node.children.map((ch) => (
                      <div key={ch.id} className="cmgr-row child">
                        <button className="cmgr-row-main" onClick={() => setSelected(ch.id)}>
                          {window.ic.bookmark}<span className="cmgr-name">{collectionLabel(ch)}</span><span className="cmgr-ct mono">{ch.item_count || 0}</span>
                          {ch.visibility === 'public' && <span className="cmgr-badge pub">{t('vis_public_badge', 'Public')}</span>}
                          {ch.moderation_status === 'pending' && <span className="cmgr-badge pend">{t('badge_pending', 'Pending review')}</span>}
                          {ch.moderation_status === 'rejected' && <span className="cmgr-badge rej">{t('badge_rejected', 'Rejected')}</span>}
                          {ch.visibility === 'unlisted' && <span className="cmgr-badge link">{window.ic.link}</span>}
                        </button>
                        <button className="cmgr-mini" onClick={() => setModal({ collection: ch })} title={t('edit', 'Edit')}>{window.ic2.gear}</button>
                        <button className="cmgr-mini danger" onClick={() => del(ch)} title={t('delete', 'Delete')}>{window.ic.x}</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      {modal && <CollectionEditModal collection={modal.collection} parentId={modal.parentId} parentPublic={modal.parentPublic} onClose={() => setModal(null)} onSaved={reload} />}
    </div>
  );
}

Object.assign(window, {
  favShotUrl, FavoritesAPI, useFavorites, FavoriteButton, FavCard, CollectionsView,
  CollectionsAPI, useCollections, useMembership, buildTree, CollectionMenuButton,
  CollectionEditModal, CollectionsManager, SharedCollectionView, PublicLibraryView,
});

})();

