// App shell — wires tweaks, view router, drawer state.

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "dark": false,
  "density": "comfortable",
  "defaultView": "list"
}/*EDITMODE-END*/;

function App() {
  const [tweaks, setTweak] = window.useTweaks(TWEAK_DEFAULTS);
  const [view, setView] = React.useState('explorer');
  const [activeGame, setActiveGame] = React.useState(null);
  const [toasts, setToasts] = React.useState([]);

  const [auth, setAuth] = React.useState('out');
  const [identity, setIdentity] = React.useState(null);

  React.useEffect(() => {
    window.setView = setView;
    return () => {
      if (window.setView === setView) {
        window.setView = null;
      }
    };
  }, []);

  React.useEffect(() => {
    if (typeof Clerk === 'undefined') return;

    const syncUser = async () => {
      if (Clerk.user) {
        const localId = window.getClerkIdentity();
        setIdentity(localId);
        try {
          const token = await Clerk.session.getToken();
          const res = await fetch('/api/me', {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          if (res.ok) {
            const data = await res.json();
            if (data.user) {
              setAuth(data.user.role === 'admin' ? 'admin' : 'user');
              setIdentity({
                nick: data.user.display_name,
                color: localId.color,
                initial: data.user.display_name[0].toUpperCase(),
                avatar_url: data.user.avatar_url
              });
            }
          }
        } catch (e) {
          console.error("Failed to sync D1 user profile:", e);
          setAuth('user');
        }
      } else {
        setAuth('out');
        setIdentity(null);
      }
    };

    syncUser();
    const unsubscribe = Clerk.addListener(() => { syncUser(); });
    return () => { if (unsubscribe) unsubscribe(); };
  }, []);

  const handleLogout = async () => {
    if (window.Clerk) {
      await Clerk.signOut();
      window.pushToast('Signed out', '', 'success');
      if (view === 'mycontent') setView('explorer');
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
  const openGame = (g, rolled = false) => {
    setActiveGame(g);
    setIsRoll(rolled);
  };
  const closeDrawer = () => {
    setActiveGame(null);
    setIsRoll(false);
  };

  return (
    <div className={`app${sidebarOpen ? ' sidebar-mobile-open' : ''}`}>
      {sidebarOpen && <div className="sidebar-scrim-mobile" onClick={() => setSidebarOpen(false)} />}
      <window.Sidebar view={view} onView={(v) => { setView(v); setSidebarOpen(false); if (v !== 'explorer') setActiveGame(null); }}
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
        {view === 'submit'      && <window.SubmitGameView auth={auth} identity={identity} />}
        {view === 'mycontent'   && <window.MyContentView auth={auth} identity={identity} />}
        {activeGame && view === 'explorer' && <window.Drawer game={activeGame} isRoll={isRoll} onClose={closeDrawer} auth={auth} identity={identity} />}
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
  const [statusText, setStatusText] = React.useState('Initializing stream fetch...');
  const [loadedBytes, setLoadedBytes] = React.useState(0);
  const [totalBytes, setTotalBytes] = React.useState(32011780 + 2332521);

  React.useEffect(() => {
    async function loadData() {
      try {
        setStatusText('Initializing authentication...');
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
            
            // Dynamically decode Clerk publishable key to extract the Frontend API domain
            let frontendApi = '';
            try {
              const parts = window.CLERK_PUBLISHABLE_KEY.split('_');
              if (parts.length >= 3) {
                const decoded = atob(parts[2]);
                frontendApi = decoded.endsWith('$') ? decoded.slice(0, -1) : decoded;
              }
            } catch (e) {
              console.error("Failed to decode publishable key:", e);
            }

            script.src = frontendApi
              ? `https://${frontendApi}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`
              : "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js";
            
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
              await window.Clerk.load({
                publishableKey: window.CLERK_PUBLISHABLE_KEY
              });
            }
          }
        } catch (authErr) {
          console.warn("Clerk auth failed to load, proceeding without auth:", authErr);
        }

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
          setStatusText('Loading database from local cache...');
          gamesDb = cachedResult.data.gamesDb;
          profilesDb = cachedResult.data.profilesDb;
          fromCache = true;
        } else if (cachedResult && localVersion && latestVersion) {
          // Local cache is older, try incremental updates
          try {
            setStatusText('Checking for incremental updates...');
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
                setStatusText('Applying incremental database updates...');
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
                
                setStatusText('Saving updated database to local cache...');
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
          let parts = ['data/games_part_1.json', 'data/games_part_2.json', 'data/games_part_3.json'];
        if (window.location.pathname.includes('/src/')) {
          parts = ['../data/games_part_1.json', '../data/games_part_2.json', '../data/games_part_3.json'];
        }
        
        gamesDb = {};
        let loadedGames = 0;
        
        const cacheBuster = window.DATABASE_VERSION ? `?v=${window.DATABASE_VERSION}` : '';
        
        for (let i = 0; i < parts.length; i++) {
          setStatusText(`Fetching games database part ${i + 1} of 3...`);
          const partRes = await fetch(parts[i] + cacheBuster);
          if (!partRes.ok) throw new Error(`HTTP ${partRes.status} fetching games database part ${i + 1}`);
          
          const reader = partRes.body.getReader();
          const chunks = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loadedGames += value.length;
            setLoadedBytes(loadedGames);
          }
          
          setStatusText(`Parsing games database part ${i + 1} of 3...`);
          let partLoaded = 0;
          for (const c of chunks) partLoaded += c.length;
          const partBytes = new Uint8Array(partLoaded);
          let pos = 0;
          for (const c of chunks) {
            partBytes.set(c, pos);
            pos += c.length;
          }
          const partDb = JSON.parse(new TextDecoder().decode(partBytes));
          Object.assign(gamesDb, partDb);
        }
        
        let profilesUrl = 'data/profiles.json';
        if (window.location.pathname.includes('/src/')) {
          profilesUrl = '../data/profiles.json';
        }
        
        // Profiles fetch will use cacheBuster inside app.jsx
        // Let's modify profilesRes fetch call later in app.jsx
        // Actually, we can do it inside this script.
        

          setStatusText('Fetching profiles database...');
          const profilesRes = await fetch(profilesUrl + cacheBuster);
          if (!profilesRes.ok) throw new Error(`HTTP ${profilesRes.status} fetching profiles database`);
          
          const profilesReader = profilesRes.body.getReader();
          let loadedProfiles = 0;
          const profilesChunks = [];
          while (true) {
            const { done, value } = await profilesReader.read();
            if (done) break;
            profilesChunks.push(value);
            loadedProfiles += value.length;
            setLoadedBytes(loadedGames + loadedProfiles);
          }

          setStatusText('Parsing profiles database...');
          const profilesBytes = new Uint8Array(loadedProfiles);
          let pos = 0;
          for (const chunk of profilesChunks) {
            profilesBytes.set(chunk, pos);
            pos += chunk.length;
          }
          profilesDb = JSON.parse(new TextDecoder().decode(profilesBytes));

          if (latestVersion) {
            try {
              setStatusText('Saving database to local cache...');
              await cacheData(latestVersion, { gamesDb, profilesDb });
            } catch (cacheErr) {
              console.warn('Failed to cache data:', cacheErr);
            }
          }
        }

        setStatusText('Preprocessing database schemas...');
        
        const GAMES = [];
        const REVIEWS = {};
        const SCREENSHOTS = {};
        const TAGS_COUNT = {};
        let totalR2Size = 0;

        for (const [idStr, rawGame] of Object.entries(gamesDb)) {
          const id = parseInt(idStr, 10);
          const gameTagsSet = new Set();
          const gameReviews = [];
          
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
              
              gameReviews.push({
                user: r.author || 'Anonymous',
                date: r.date || '',
                rating: (r.rating !== null && r.rating !== undefined && r.rating !== 'na') ? Number(r.rating) : null,
                diff: (r.difficulty !== null && r.difficulty !== undefined && r.difficulty !== 'na') ? Number(r.difficulty) : null,
                liked: r.likes || 0,
                body: r.text || '',
                tags: (r.tags || []).map(t => t.trim().toLowerCase()).filter(Boolean)
              });
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
          
          const savedCurationStr = localStorage.getItem(`archive_game_${id}`);
          let curation = { status: 'unplayed', personal: 0, notes: '' };
          if (savedCurationStr) {
            try {
              curation = JSON.parse(savedCurationStr);
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
          REVIEWS[id] = gameReviews;
          SCREENSHOTS[id] = gameScreenshots;
          if (gameObj.flags.local) {
            totalR2Size += gameObj.file_size;
          }
        }

        const TAGS = Object.entries(TAGS_COUNT)
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count);

        const needleGameIds = GAMES.filter(g => g.tags.includes('needle')).slice(0, 6).map(g => g.id);
        const avoidanceGameIds = GAMES.filter(g => g.tags.includes('avoidance')).slice(0, 5).map(g => g.id);
        const adventureGameIds = GAMES.filter(g => g.tags.includes('adventure')).slice(0, 4).map(g => g.id);
        const bossGameIds = GAMES.filter(g => g.tags.includes('boss')).slice(0, 4).map(g => g.id);

        const COLLECTIONS = [
          {
            id: 'c1',
            name: 'Practice Needle Maps',
            color: 'oklch(0.65 0.13 152)',
            desc: 'Forgiving needle for warm-ups. Saves every 3-5 screens.',
            games: needleGameIds,
            notes: needleGameIds.reduce((acc, id) => { acc[id] = 'Check screen layout for S' + (id % 100); return acc; }, {})
          },
          {
            id: 'c2',
            name: 'Avoidance Only',
            color: 'oklch(0.65 0.13 30)',
            desc: 'For practice runs of pattern-style avoidances.',
            games: avoidanceGameIds,
            notes: {}
          },
          {
            id: 'c3',
            name: 'Adventure Quest',
            color: 'oklch(0.7 0.12 70)',
            desc: 'Excellent adventure fangames with great exploration.',
            games: adventureGameIds,
            notes: {}
          },
          {
            id: 'c4',
            name: 'Boss Showdowns',
            color: 'oklch(0.65 0.13 30)',
            desc: 'Intense boss fights and combat compilations.',
            games: bossGameIds,
            notes: {}
          }
        ];

        const MISSING_ASSETS = GAMES.filter(g => g.flags.missing).slice(0, 30).map(g => ({
          id: g.id,
          title: g.title,
          missing: g.id % 2 === 0 ? 'zip' : 'screenshots',
          size: g.id % 2 === 0 ? '~ 12 MB' : '~ 1.5 MB',
          source: g.creator_url !== '#' ? g.creator_url : 'dl-mirror.example',
          age: (g.id % 10 + 1) + 'd'
        }));

        const DEAD_URLS = GAMES.filter(g => g.flags.broken).slice(0, 30).map(g => ({
          id: g.id,
          title: g.title,
          url: g.url || 'https://delicious-fruit.com/ratings/game_details.php?id=' + g.id,
          code: g.id % 3 === 0 ? 'HTTP 404' : (g.id % 3 === 1 ? 'DNS_FAIL' : 'HTTP 503'),
          checked: '2026-05-22'
        }));

        const ORPHANED = [
          { path: 'ratings/screenshots/old_unused_shot.png', size: '1.2 MB', modified: '2025-11-04' },
          { path: 'ratings/screenshots/test_capture.png', size: '440 KB', modified: '2026-04-12' },
          { path: 'downloads/partial_download_tmp.zip', size: '32.1 MB', modified: '2026-05-18' }
        ];

        const CRAWLER_LOG = [
          { t: '14:02:11', tag: 'info', msg: 'crawler.exe v0.7.3 ready' },
          { t: '14:02:11', tag: 'info', msg: 'reading config from ./archive.toml' },
          { t: '14:02:12', tag: 'info', msg: 'connecting to <accent>delicious-fruit-mirror.local</accent>...' },
          { t: '14:02:13', tag: 'ok',   msg: 'handshake complete · 14873 known game IDs' },
          { t: '14:02:14', tag: 'info', msg: 'fetching index.json (<num>35.4 MB</num>)' },
          { t: '14:02:16', tag: 'ok',   msg: 'index parsed · <num>+3</num> new · <num>17</num> updated · <num>14853</num> unchanged' },
          { t: '14:02:17', tag: 'info', msg: 'enqueued screenshot jobs (<num>43</num>)' },
          { t: '14:02:19', tag: 'ok',   msg: 'GET /img/10458/10458_00001e0b.png · <num>240 KB</num>' },
          { t: '14:02:21', tag: 'ok',   msg: 'GET /img/10458/10458_00001e0a.png · <num>180 KB</num>' },
          { t: '14:02:23', tag: 'warn', msg: 'HTTP 503 from defunct-host — marking URL dead' },
          { t: '14:02:24', tag: 'ok',   msg: 'GET /img/11598/spike-cathedral.png · <num>312 KB</num>' },
          { t: '14:02:26', tag: 'info', msg: 'reviews: paging /api/reviews?since=2026-05-21' },
          { t: '14:02:28', tag: 'ok',   msg: '<num>+34</num> reviews ingested' },
          { t: '14:02:30', tag: 'info', msg: 'writing db deltas (<num>52</num> ops)' },
          { t: '14:02:31', tag: 'ok',   msg: 'commit · games.json (<num>35.4 MB</num>) saved' },
          { t: '14:02:31', tag: 'info', msg: 'next sync scheduled in 6h' },
        ];

        const R2_STORAGE_SIZE = (totalR2Size / (1024 * 1024 * 1024)).toFixed(2) + " GB";
        window.DATA = { TAGS, GAMES, REVIEWS, SCREENSHOTS, COLLECTIONS, MISSING_ASSETS, DEAD_URLS, ORPHANED, CRAWLER_LOG, STORAGE_SIZE: R2_STORAGE_SIZE };
        
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
