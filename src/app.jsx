// App shell — wires tweaks, view router, drawer state.

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "dark": false,
  "density": "comfortable",
  "defaultView": "list"
}/*EDITMODE-END*/;

function App() {
  const [tweaks, setTweak] = window.useTweaks(TWEAK_DEFAULTS);
  const [view, setView] = React.useState(() => {
    // A deep link (?game=<id>) always opens inside the catalog.
    try {
      if (new URLSearchParams(window.location.search).get('game')) return 'explorer';
    } catch (e) {}
    return sessionStorage.getItem('archive_view') || 'explorer';
  });
  const [activeGame, setActiveGame] = React.useState(() => {
    // Deep link takes priority: a shared/bookmarked ?game=<id> URL opens
    // straight into that game's drawer.
    try {
      const urlId = new URLSearchParams(window.location.search).get('game');
      if (urlId && window.DATA && window.DATA.GAMES) {
        const g = window.DATA.GAMES.find(x => String(x.id) === String(urlId));
        if (g) return g;
      }
    } catch (e) {}
    const saved = sessionStorage.getItem('archive_active_game');
    if (saved) {
      try {
        const game = JSON.parse(saved);
        if (window.DATA && window.DATA.GAMES) {
          return window.DATA.GAMES.find(g => g.id === game.id) || game;
        }
        return game;
      } catch (e) {}
    }
    return null;
  });
  const [toasts, setToasts] = React.useState([]);

  React.useEffect(() => {
    sessionStorage.setItem('archive_view', view);
  }, [view]);

  React.useEffect(() => {
    if (activeGame) {
      sessionStorage.setItem('archive_active_game', JSON.stringify({ id: activeGame.id }));
    } else {
      sessionStorage.removeItem('archive_active_game');
    }
  }, [activeGame]);

  // Optimistic auth state: render the last-known identity instantly on load so the
  // sidebar doesn't flash "logged out" for the few seconds Clerk takes to resolve
  // the session. Reconciled against Clerk / /api/me once they finish loading.
  const [auth, setAuth] = React.useState(() => {
    try {
      const cached = JSON.parse(localStorage.getItem('archive_auth_cache') || 'null');
      return cached && cached.auth ? cached.auth : 'out';
    } catch (e) { return 'out'; }
  });
  const [identity, setIdentity] = React.useState(() => {
    try {
      const cached = JSON.parse(localStorage.getItem('archive_auth_cache') || 'null');
      return cached && cached.identity ? cached.identity : null;
    } catch (e) { return null; }
  });

  React.useEffect(() => {
    window.setView = setView;
    return () => {
      if (window.setView === setView) {
        window.setView = null;
      }
    };
  }, []);

  React.useEffect(() => {
    let active = true;
    let unsubscribe = null;

    const initClerkSync = () => {
      const syncUser = async () => {
        if (!active) return;
        if (Clerk.user) {
          const localId = window.getClerkIdentity();
          setIdentity(localId);
          // Trust Clerk's client session for the basic logged-in state so the UI flips
          // immediately even if /api/me can't verify (e.g. backend env keys misconfigured).
          // /api/me below only upgrades role (admin) and D1 display name when it succeeds.
          if (active) setAuth('user');
          try {
            const token = await Clerk.session.getToken();
            const res = await fetch('/api/me', {
              headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok && active) {
              const data = await res.json();
              if (data.user) {
                const resolvedAuth = data.user.role === 'admin' ? 'admin' : 'user';
                const resolvedIdentity = {
                  nick: data.user.display_name,
                  color: localId.color,
                  initial: data.user.display_name[0].toUpperCase(),
                  avatar_url: data.user.avatar_url
                };
                setAuth(resolvedAuth);
                setIdentity(resolvedIdentity);
                try {
                  localStorage.setItem('archive_auth_cache', JSON.stringify({ auth: resolvedAuth, identity: resolvedIdentity }));
                } catch (e) {}
              }
            }
          } catch (e) {
            console.error("Failed to sync D1 user profile:", e);
            if (active) setAuth('user');
          }
        } else {
          setAuth('out');
          setIdentity(null);
          try { localStorage.removeItem('archive_auth_cache'); } catch (e) {}
          if (active) {
            setView(current => {
              if (current === 'collections') return 'explorer';
              return current;
            });
          }
        }
      };

      syncUser();
      unsubscribe = Clerk.addListener(() => { syncUser(); });
    };

    if (typeof Clerk === 'undefined' || !Clerk.loaded) {
      const interval = setInterval(() => {
        if (typeof Clerk !== 'undefined' && Clerk.loaded) {
          clearInterval(interval);
          if (active) initClerkSync();
        }
      }, 100);
      return () => {
        active = false;
        clearInterval(interval);
        if (unsubscribe) unsubscribe();
      };
    }

    initClerkSync();
    return () => {
      active = false;
      if (unsubscribe) unsubscribe();
    };
  }, []);

  const handleLogout = async () => {
    if (window.Clerk) {
      await Clerk.signOut();
      window.pushToast('Signed out', '', 'success');
      if (view === 'mycontent' || view === 'collections' || view === 'submit') {
        setView('explorer');
      }
    }
  };

  const handleOpenLogin = () => {
    if (typeof window.Clerk !== 'undefined' && window.Clerk.loaded) {
      window.Clerk.openSignIn();
    } else {
      const btn = document.querySelector('.acct-block button');
      if (btn) btn.click();
    }
  };

  React.useEffect(() => {
    window.__pushToast = (t) => {
      const id = Date.now() + Math.random();
      setToasts((prev) => [...prev, { id, ...t }]);
      setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 3600);
    };
    return () => { window.__pushToast = null; };
  }, []);

  // Apply theme + density to document root so CSS variables swap.
  React.useEffect(() => {
    document.documentElement.dataset.theme = tweaks.dark ? 'dark' : 'light';
    document.documentElement.dataset.density = tweaks.density === 'compact' ? 'compact' : 'comfortable';
  }, [tweaks.dark, tweaks.density]);

  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  React.useEffect(() => {
    window.toggleSidebar = () => setSidebarOpen((prev) => !prev);
    window.closeSidebar = () => setSidebarOpen(false);
  }, []);

  const [isRoll, setIsRoll] = React.useState(false);

  // Reflect the open game into the URL (?game=<id>) via the History API — no
  // reload, so each game gets a shareable link while keeping SPA speed.
  // Opening pushes a history entry (Back closes the drawer); closing/leaving
  // replaces it (Back returns to the prior page rather than re-opening).
  const syncGameUrl = (game, { replace = false } = {}) => {
    try {
      const url = new URL(window.location.href);
      if (game) url.searchParams.set('game', String(game.id));
      else url.searchParams.delete('game');
      const state = { game: game ? game.id : null };
      if (replace) window.history.replaceState(state, '', url);
      else window.history.pushState(state, '', url);
    } catch (e) {}
  };

  const openGame = (g, rolled = false) => {
    setActiveGame(g);
    setIsRoll(rolled);
    syncGameUrl(g);
  };
  const closeDrawer = () => {
    setActiveGame(null);
    setIsRoll(false);
    syncGameUrl(null, { replace: true });
  };

  // Browser Back/Forward: re-sync the drawer to the URL's ?game param. This only
  // reads the URL (no pushState), so it never loops with syncGameUrl above.
  React.useEffect(() => {
    const onPop = () => {
      let id = null;
      try { id = new URLSearchParams(window.location.search).get('game'); } catch (e) {}
      if (id && window.DATA && window.DATA.GAMES) {
        const g = window.DATA.GAMES.find(x => String(x.id) === String(id));
        if (g) {
          setActiveGame(g);
          setIsRoll(false);
          setView(v => (v === 'explorer' || v === 'collections') ? v : 'explorer');
          return;
        }
      }
      setActiveGame(null);
      setIsRoll(false);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return (
    <div className={`app${sidebarOpen ? ' sidebar-mobile-open' : ''}`}>
      {sidebarOpen && <div className="sidebar-scrim-mobile" onClick={() => setSidebarOpen(false)} />}
      <window.Sidebar view={view} onView={(v) => { setView(v); setSidebarOpen(false); if (v !== 'explorer' && v !== 'collections') { setActiveGame(null); syncGameUrl(null, { replace: true }); } }}
                     tweaks={tweaks} setTweak={setTweak}
                     gameCount={window.DATA.GAMES.length}
                     storageSize={window.DATA.STORAGE_SIZE}
                     auth={auth} identity={identity} onLogout={handleLogout} />
      <main className="main">
        {view === 'explorer'    && <window.Explorer    tweaks={tweaks} setTweak={setTweak} onOpenGame={openGame} activeId={activeGame?.id} />}
        {view === 'donation'    && <window.DonationView gameCount={window.DATA.GAMES.length} storageSize={window.DATA.STORAGE_SIZE} />}
        {view === 'links'       && <window.LinksView />}
        {view === 'updates'     && <window.UpdateLogView />}
        {view === 'contact'     && <window.ContactView />}
        {view === 'submit'      && <window.SubmitGameView auth={auth} identity={identity} onOpenLogin={handleOpenLogin} />}
        {view === 'mycontent'   && <window.MyContentView auth={auth} identity={identity} onOpenLogin={handleOpenLogin} />}
        {view === 'collections' && <window.CollectionsView auth={auth} onOpenGame={openGame} onView={setView} onOpenLogin={handleOpenLogin} />}
        {activeGame && (view === 'explorer' || view === 'collections') && <window.Drawer game={activeGame} isRoll={isRoll} onClose={closeDrawer} auth={auth} identity={identity} />}
      </main>

      <window.Toasts items={toasts} />

      <window.TweaksPanel title="Tweaks">
        <window.TweakSection label="Theme" />
        <window.TweakToggle label="Dark mode" value={tweaks.dark} onChange={(v) => setTweak('dark', v)} />
        <window.TweakSection label="Layout" />
        <window.TweakRadio label="Density" value={tweaks.density}
                           options={['compact', 'comfortable']}
                           onChange={(v) => setTweak('density', v)} />
      </window.TweaksPanel>
    </div>
  );
}

function DatabaseLoader({ error, statusText, loadedBytes, totalBytes }) {
  const pct = totalBytes ? Math.min(100, Math.round((loadedBytes / totalBytes) * 100)) : 0;
  const loadedMB = (loadedBytes / (1024 * 1024)).toFixed(1);
  const totalMB = (totalBytes / (1024 * 1024)).toFixed(1);
  
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '100vw',
      height: '100vh',
      background: 'radial-gradient(circle at center, #111827 0%, #030712 100%)',
      color: '#fafaf9',
      fontFamily: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    }}>
      <div style={{
        width: '400px',
        padding: '36px',
        background: 'rgba(17, 24, 39, 0.75)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: '16px',
        boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.5)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        textAlign: 'center'
      }}>
        <div style={{
          color: 'oklch(0.72 0.15 152)',
          width: '52px',
          height: '52px',
          margin: '0 auto 20px',
          animation: 'pulse 2s infinite ease-in-out'
        }}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.5 4.5 8 2l5.5 2.5M2.5 4.5v7L8 14l5.5-2.5v-7M2.5 4.5 8 7l5.5-2.5M8 7v7" />
          </svg>
        </div>
        <h2 style={{
          fontSize: '22px',
          fontWeight: 700,
          marginBottom: '6px',
          letterSpacing: '-0.02em',
          background: 'linear-gradient(135deg, #ffffff 0%, #a1a1aa 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          margin: '10px 0'
        }}>Fangame Archive</h2>
        <p style={{
          fontSize: '13px',
          color: '#9ca3af',
          margin: '5px 0 25px'
        }}>Loading local archive databases...</p>
        
        {error ? (
          <div style={{ color: '#ef4444', fontSize: '13px', lineHeight: '1.5' }}>
            <div style={{ fontWeight: 'bold', marginBottom: '12px' }}>Error: {error}</div>
            <div style={{
              color: '#a1a1aa',
              fontSize: '11.5px',
              textAlign: 'left',
              background: 'rgba(0,0,0,0.25)',
              padding: '12px',
              borderRadius: '8px',
              border: '1px solid rgba(255,255,255,0.06)'
            }}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" style={{ width: 14, height: 14, display: 'inline-block', verticalAlign: 'text-bottom', marginRight: 6, color: 'oklch(0.75 0.14 109)' }}><path d="M5.5 11.5h5M6.5 13h3M8 2.5a4.5 4.5 0 0 1 4.5 4.5c0 1.6-.8 3-2.1 3.8-.4.3-.4.8-.4 1.2H6c0-.4 0-.9-.4-1.2A4.5 4.5 0 0 1 8 2.5z"/></svg> <b>Tip:</b> If opening this file directly via <code>file:///</code>, browser CORS blocks database files. 
              Please run the server with <code>py dev_server.py</code> and open <a href="http://localhost:8000/" style={{ color: 'oklch(0.72 0.15 152)', textDecoration: 'underline' }}>http://localhost:8000/</a> in your browser.
            </div>
          </div>
        ) : (
          <>
            <div style={{
              width: '100%',
              height: '6px',
              background: 'rgba(255, 255, 255, 0.06)',
              borderRadius: '99px',
              overflow: 'hidden',
              marginBottom: '12px'
            }}>
              <div style={{
                height: '100%',
                background: 'linear-gradient(90deg, oklch(0.56 0.13 152) 0%, oklch(0.72 0.15 152) 100%)',
                borderRadius: '99px',
                width: `${pct}%`,
                transition: 'width 0.1s ease',
                boxShadow: '0 0 12px rgba(52, 211, 153, 0.3)'
              }} />
            </div>
            
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: '11px',
              fontFamily: "'Geist Mono', ui-monospace, monospace",
              color: '#6b7280',
              marginBottom: '20px'
            }}>
              <span>{loadedMB} MB / {totalMB} MB</span>
              <span>{pct}%</span>
            </div>
            
            <div style={{
              fontSize: '12px',
              color: '#d4d4d4',
              fontStyle: 'italic',
              height: '18px',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}>{statusText}</div>
          </>
        )}
      </div>
      <style>{`
        @keyframes pulse {
          0%, 100% {
            transform: scale(1);
            filter: drop-shadow(0 0 2px rgba(52, 211, 153, 0.2));
          }
          50% {
            transform: scale(1.06);
            filter: drop-shadow(0 0 12px rgba(52, 211, 153, 0.6));
          }
        }
      `}</style>
    </div>
  );
}

// ── IndexedDB Cache Helpers ──────────────────────────────────────────────────
const DB_NAME = 'DeliciousArchiveDB';
const DB_VERSION = 1;
const STORE_NAME = 'cached_data';

function getCachedData() {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          resolve(null);
          return;
        }
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const getReq = store.get('archive_data');
        getReq.onsuccess = () => {
          resolve(getReq.result || null);
        };
        getReq.onerror = () => resolve(null);
      };
      request.onerror = () => resolve(null);
    } catch (err) {
      console.warn('IndexedDB is not supported or blocked:', err);
      resolve(null);
    }
  });
}

function cacheData(version, data) {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = (e) => {
        const db = e.target.result;
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        store.put({ version, data }, 'archive_data');
        transaction.oncomplete = () => resolve(true);
        transaction.onerror = () => resolve(false);
      };
      request.onerror = () => resolve(false);
    } catch (err) {
      resolve(false);
    }
  });
}

function RootApp() {
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [statusText, setStatusText] = React.useState(window.t ? window.t('init_db') : 'Initializing stream fetch...');
  const [loadedBytes, setLoadedBytes] = React.useState(0);
  const [totalBytes, setTotalBytes] = React.useState(32011780 + 2332521);
  const [lang, setLang] = React.useState(window.CURRENT_LANGUAGE || 'en');

  React.useEffect(() => {
    window.forceAppUpdate = () => setLang(window.CURRENT_LANGUAGE);
    return () => { delete window.forceAppUpdate; };
  }, []);

  React.useEffect(() => {
    async function loadData() {
      try {
        setStatusText(window.t ? window.t('init_db') : 'Initializing database...');
        const loadClerkScript = () => {
          return new Promise((resolve) => {
            if (typeof window.Clerk !== 'undefined') {
              resolve(true);
              return;
            }
            
            // Check if there is an existing script tag to prevent duplicate append
            const existingScript = document.querySelector('script[src*="clerk-js"]') || document.querySelector('script[src*="clerk.browser.js"]');
            if (existingScript) {
              const onScriptLoad = () => {
                cleanup();
                resolve(true);
              };
              const onScriptError = () => {
                cleanup();
                resolve(false);
              };
              const cleanup = () => {
                existingScript.removeEventListener('load', onScriptLoad);
                existingScript.removeEventListener('error', onScriptError);
              };
              existingScript.addEventListener('load', onScriptLoad);
              existingScript.addEventListener('error', onScriptError);
              
              if (typeof window.Clerk !== 'undefined') {
                cleanup();
                resolve(true);
              }
              
              setTimeout(() => {
                cleanup();
                resolve(false);
              }, 4000);
              return;
            }

            const script = document.createElement('script');
            script.src = window.CLERK_JS_URL || "/api/clerk-js";
            script.setAttribute('data-clerk-publishable-key', window.CLERK_PUBLISHABLE_KEY);
            script.crossOrigin = "anonymous";
            script.async = true;
            
            script.onload = () => resolve(true);
            script.onerror = () => {
              console.warn("Clerk script failed to load (blocked by ad-blocker or offline).");
              resolve(false);
            };
            document.head.appendChild(script);
            
            setTimeout(() => resolve(false), 4000);
          });
        };

        // Load Clerk asynchronously in background so it doesn't block cache checking
        (async () => {
          try {
            const clerkScriptLoaded = await loadClerkScript();
            if (clerkScriptLoaded && typeof window.Clerk !== 'undefined') {
              // If window.Clerk is the constructor class (function), instantiate it!
              if (typeof window.Clerk === 'function') {
                try {
                  const clerkInstance = new window.Clerk(window.CLERK_PUBLISHABLE_KEY);
                  window.Clerk = clerkInstance;
                } catch (err) {
                  console.error("Failed to construct Clerk instance:", err);
                }
              }
              
              if (typeof window.Clerk === 'object' && !window.Clerk.loaded) {
                // Memoize load() so app.jsx and the login button never call it concurrently.
                // A second concurrent load() in clerk-js v6 clobbers the UI component wiring,
                // causing "Clerk was not loaded with Ui components" on openSignIn().
                await (window.__clerkLoadPromise = window.__clerkLoadPromise || window.Clerk.load({
                  publishableKey: window.CLERK_PUBLISHABLE_KEY,
                  localization: {
                    formFieldLabel__firstName: window.t('clerk_nickname'),
                    formFieldPlaceholder__firstName: window.t('clerk_nickname_placeholder')
                  },
                  appearance: {
                    elements: {
                      formFieldRow__lastName: { display: 'none' }
                    }
                  }
                }));
              }
            }
          } catch (authErr) {
            console.warn("Clerk auth failed to load, proceeding without auth:", authErr);
          }
        })();

        if (window.DATA && window.DATA.GAMES && window.DATA.GAMES.length > 12) {
          setLoading(false);
          return;
        }

        let gamesDb = null;
        let profilesDb = null;
        let fromCache = false;

        const latestVersion = window.DATABASE_VERSION;
        const cachedResult = await getCachedData();
        const localVersion = cachedResult ? cachedResult.version : null;

        if (cachedResult && String(localVersion) === String(latestVersion)) {
          setStatusText(window.t('init_db'));
          gamesDb = cachedResult.data.gamesDb;
          profilesDb = cachedResult.data.profilesDb;
          fromCache = true;
        } else if (cachedResult && localVersion && latestVersion) {
          // Local cache is older, try incremental updates
          try {
            setStatusText(window.t('fetching_updates'));
            let changesUrl = 'data/recent_changes.json';
            if (window.location.pathname.includes('/src/')) {
              changesUrl = '../data/recent_changes.json';
            }
            
            const changesRes = await fetch(changesUrl + '?v=' + latestVersion);
            if (changesRes.ok) {
              const changesData = await changesRes.json();
              const timeline = changesData.timeline || {};
              
              // Validate if we can incrementally transition from localVersion to latestVersion
              let canIncremental = true;
              const localVerInt = parseInt(localVersion, 10);
              const latestVerInt = parseInt(latestVersion, 10);
              
              if (isNaN(localVerInt) || isNaN(latestVerInt) || localVerInt >= latestVerInt) {
                canIncremental = false;
              } else {
                for (let v = localVerInt + 1; v <= latestVerInt; v++) {
                  if (!timeline[String(v)]) {
                    canIncremental = false;
                    break;
                  }
                }
              }
              
              if (canIncremental) {
                setStatusText(window.t('merging_db'));
                gamesDb = cachedResult.data.gamesDb;
                profilesDb = cachedResult.data.profilesDb;
                
                for (let v = localVerInt + 1; v <= latestVerInt; v++) {
                  const delta = timeline[String(v)];
                  if (delta.updated) {
                    Object.assign(gamesDb, delta.updated);
                  }
                  if (delta.deleted) {
                    delta.deleted.forEach(gid => {
                      delete gamesDb[gid];
                    });
                  }
                }
                
                setStatusText(window.t('merging_db'));
                await cacheData(latestVersion, { gamesDb, profilesDb });
                fromCache = true;
                console.log(`Incremental sync complete: v${localVersion} -> v${latestVersion}`);
              }
            }
          } catch (err) {
            console.warn('Failed to perform incremental update, falling back to full download:', err);
          }
        }

        if (!fromCache) {
          setStatusText(window.t('fetching_updates'));
          let parts = ['data/games_part_1.json', 'data/games_part_2.json', 'data/games_part_3.json'];
          let profilesUrl = 'data/profiles.json';
          if (window.location.pathname.includes('/src/')) {
            parts = ['../data/games_part_1.json', '../data/games_part_2.json', '../data/games_part_3.json'];
            profilesUrl = '../data/profiles.json';
          }
          
          const cacheBuster = window.DATABASE_VERSION ? `?v=${window.DATABASE_VERSION}` : '';
          
          const fetchAndParse = async (url, label) => {
            const res = await fetch(url + cacheBuster);
            if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${label}`);
            return res.json();
          };

          const [part1, part2, part3, profiles] = await Promise.all([
            fetchAndParse(parts[0], 'part 1'),
            fetchAndParse(parts[1], 'part 2'),
            fetchAndParse(parts[2], 'part 3'),
            fetchAndParse(profilesUrl, 'profiles')
          ]);

          setStatusText(window.t('merging_db'));
          gamesDb = {};
          Object.assign(gamesDb, part1);
          Object.assign(gamesDb, part2);
          Object.assign(gamesDb, part3);
          profilesDb = profiles;

          if (latestVersion) {
            try {
              setStatusText(window.t('merging_db'));
              await cacheData(latestVersion, { gamesDb, profilesDb });
            } catch (cacheErr) {
              console.warn('Failed to cache data:', cacheErr);
            }
          }
        }

        setStatusText(window.t('merging_db'));
        
        const GAMES = [];
        const SCREENSHOTS = {};
        const TAGS_COUNT = {};
        let totalR2Size = 0;

        // Per-game curation is stored under `archive_game_<id>` keys. Enumerate the
        // present keys once instead of probing localStorage ~20k times per load
        // (almost all are absent). Behaviour is identical; only the probe count drops.
        const curationKeys = new Set();
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('archive_game_')) curationKeys.add(k);
          }
        } catch (e) {}

        for (const [idStr, rawGame] of Object.entries(gamesDb)) {
          const id = parseInt(idStr, 10);
          const gameTagsSet = new Set();

          if (rawGame.tags) {
            rawGame.tags.forEach(t => {
              if (t) {
                const cleanTag = t.trim().toLowerCase();
                if (cleanTag) {
                  gameTagsSet.add(cleanTag);
                  TAGS_COUNT[cleanTag] = (TAGS_COUNT[cleanTag] || 0) + 1;
                }
              }
            });
          }

          if (rawGame.reviews) {
            rawGame.reviews.forEach(r => {
              if (r.tags) {
                r.tags.forEach(t => {
                  if (t) {
                    const cleanTag = t.trim().toLowerCase();
                    if (cleanTag) {
                      gameTagsSet.add(cleanTag);
                      TAGS_COUNT[cleanTag] = (TAGS_COUNT[cleanTag] || 0) + 1;
                    }
                  }
                });
              }
              
              // Review text is served on demand from D1 via /api/comments; no in-memory
              // REVIEWS map is built (window.DATA.REVIEWS has no readers).
            });
          }
          
          const gameTags = Array.from(gameTagsSet);
          const gameScreenshots = [];
          if (rawGame.screenshots) {
            rawGame.screenshots.forEach(s => {
              gameScreenshots.push({
                id: s.id,
                image_path: s.image_path,
                by: s.by || 'Anonymous'
              });
            });
          }
          
          let curation = { status: 'unplayed', personal: 0, notes: '' };
          const curKey = `archive_game_${id}`;
          if (curationKeys.has(curKey)) {
            try {
              curation = JSON.parse(localStorage.getItem(curKey));
            } catch (e) {}
          }
          
          const hours = (curation.status === 'cleared' || curation.status === 'perfected') 
            ? ((id % 20) + 1.5) 
            : (curation.status === 'in_progress' ? ((id % 5) + 0.5) : 0.0);
            
          const hasShots = gameScreenshots.length > 0;
          const isBroken = !rawGame.download_url || rawGame.download_url.includes('defunct');
          const isMissing = !rawGame.download_url;
          
          const reviewsCount = rawGame.rating_count !== undefined && rawGame.rating_count !== null 
            ? Number(rawGame.rating_count) 
            : (Array.isArray(rawGame.reviews) ? rawGame.reviews.length : (typeof rawGame.reviews === 'number' ? rawGame.reviews : 0));

          let finalRating = null;
          if (rawGame.avg_rating !== undefined && rawGame.avg_rating !== null) {
            finalRating = Number(rawGame.avg_rating);
          } else if (rawGame.rating !== undefined && rawGame.rating !== null) {
            finalRating = Number(rawGame.rating);
          }

          let finalDifficulty = null;
          if (rawGame.avg_difficulty !== undefined && rawGame.avg_difficulty !== null) {
            finalDifficulty = Number(rawGame.avg_difficulty);
          } else if (rawGame.difficulty !== undefined && rawGame.difficulty !== null) {
            finalDifficulty = Number(rawGame.difficulty);
          }



          const gameObj = {
            id: id,
            title: rawGame.title || 'Untitled Game',
            creator: rawGame.creator ? (typeof rawGame.creator === 'object' ? (rawGame.creator.name || 'Unknown') : rawGame.creator) : 'Unknown',
            creator_url: rawGame.creator ? (typeof rawGame.creator === 'object' ? (rawGame.creator.url || '#') : '#') : '#',
            engine: rawGame.engine || null,
            rating: finalRating,
            difficulty: finalDifficulty,
            reviews: reviewsCount,
            file_size: rawGame.file_size !== undefined && rawGame.file_size !== null ? Number(rawGame.file_size) : 0,

            hours: hours,
            tags: gameTags,
            status: curation.status,
            personal: curation.personal,
            notes: curation.notes,
            flags: {
              local: !!rawGame.download_url && (rawGame.download_url.includes('file.fangame-archive.com') || rawGame.download_url.includes('r2.dev')),
              shots: hasShots,
              perf: curation.status === 'perfected',
              broken: isBroken,
              missing: isMissing
            },
            desc: '',
            url: rawGame.download_url || '',
            df_id: 'id-' + String(id).padStart(5, '0')
          };
          
          GAMES.push(gameObj);
          SCREENSHOTS[id] = gameScreenshots;
          if (gameObj.flags.local) {
            totalR2Size += gameObj.file_size;
          }
        }

        const TAGS = Object.entries(TAGS_COUNT)
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count);

        const R2_STORAGE_SIZE = (totalR2Size / (1024 * 1024 * 1024)).toFixed(2) + " GB";
        // REVIEWS/COLLECTIONS are empty stubs kept only for window.DATA shape-compatibility:
        // review text is fetched on demand from D1 via /api/comments, and no view reads
        // window.DATA.REVIEWS or window.DATA.COLLECTIONS. The former mock datasets
        // (MISSING_ASSETS / DEAD_URLS / ORPHANED / CRAWLER_LOG) had zero readers and each
        // ran a full-catalog scan per load, so they were removed.
        window.DATA = { TAGS, GAMES, SCREENSHOTS, STORAGE_SIZE: R2_STORAGE_SIZE, REVIEWS: {}, COLLECTIONS: [] };
        
        window.addEventListener('tweakchange', (e) => {
          const savedTweaks = JSON.parse(localStorage.getItem('archive_tweaks') || '{}');
          const updatedTweaks = { ...savedTweaks, ...e.detail };
          localStorage.setItem('archive_tweaks', JSON.stringify(updatedTweaks));
        });

        window.addEventListener('keydown', (e) => {
          if (e.key === 't' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
            const panel = document.querySelector('.twk-panel');
            window.postMessage({ type: panel ? '__deactivate_edit_mode' : '__activate_edit_mode' }, '*');
          }
        });

        setLoading(false);
      } catch (err) {
        console.error('Fatal initialization error:', err);
        setError(err.message);
      }
    }
    loadData();
  }, []);

  if (loading) {
    return <DatabaseLoader error={error} statusText={statusText} loadedBytes={loadedBytes} totalBytes={totalBytes} />;
  }

  return <App />;
}

Object.assign(window, { DatabaseLoader, RootApp });
ReactDOM.createRoot(document.getElementById('root')).render(<RootApp />);
