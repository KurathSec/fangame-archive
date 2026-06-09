

// Prepend remote base URL for screenshots if hosted on Cloudflare R2 / S3

function getShotUrl(path) {

  if (!path) return "";

  const base = window.SCREENSHOT_BASE_URL || "";

  if (base) {

    const cleanBase = base.endsWith("/") ? base : base + "/";

    return cleanBase + path.replace(/\\/g, "/");

  }

  return path;

}

// Shared components: icons, sidebar, drawer, lightbox, toasts.



function formatSize(bytes) {

  if (!bytes) return "—";

  if (bytes < 1024) return bytes + " B";

  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";

  return (bytes / (1024 * 1024)).toFixed(1) + " MB";

}



// ── Icons (line, 16px viewBox) ──────────────────────────────────────────────

const ic = {

  archive: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2 4h12v3H2zM3 7v6h10V7M6 9.5h4"/></svg>,

  grid:    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/></svg>,

  list:    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/><circle cx="5" cy="4" r=".7" fill="currentColor"/><circle cx="5" cy="8" r=".7" fill="currentColor"/><circle cx="5" cy="12" r=".7" fill="currentColor"/></svg>,

  health:  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2 9h3l1.5-4 3 8L11 9h3"/></svg>,

  folder:  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2 4.5C2 3.7 2.7 3 3.5 3h2.6c.5 0 .9.2 1.2.6L8 4.5h4.5c.8 0 1.5.7 1.5 1.5v6c0 .8-.7 1.5-1.5 1.5h-9C2.7 13.5 2 12.8 2 12V4.5z"/></svg>,

  terminal:<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 6l2 2-2 2M8.5 10.5h3"/></svg>,

  search:  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>,

  x:       <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="m4 4 8 8M12 4l-8 8"/></svg>,

  star:    <svg viewBox="0 0 16 16" fill="currentColor"><path d="m8 1.5 2 4.4 4.8.5-3.6 3.3 1 4.8L8 12l-4.2 2.5 1-4.8L1.2 6.4 6 5.9z"/></svg>,

  flame:   <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5c.4 2 2 2.8 2 5 0 1-.5 1.7-1 2 0-1-.5-1.6-1-2-2 1-3 3-3 5 0 2 1.5 3.5 3 3.5s3-1.5 3-3.5c0-3-3-5-3-10z"/></svg>,

  sun:     <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M3.5 12.5l1.3-1.3M11.2 4.8l1.3-1.3"/></svg>,

  moon:    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M13 9.5A5 5 0 0 1 6.5 3a5 5 0 1 0 6.5 6.5z"/></svg>,

  download:<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M8 2v8m0 0L5 7m3 3 3-3M3 12.5h10"/></svg>,

  play:    <svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 3v10l9-5z"/></svg>,

  broken:  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M7 6 5 4 3 6l2 2M9 10l2 2 2-2-2-2M6.5 6.5l3 3"/></svg>,

  check:   <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="m3 8 3.5 3.5L13 5"/></svg>,

  cam:     <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2" y="4.5" width="12" height="8.5" rx="1.5"/><path d="M6 4.5 7 3h2l1 1.5"/><circle cx="8" cy="9" r="2"/></svg>,

  hdd:     <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2" y="4" width="12" height="8" rx="1.5"/><circle cx="11.5" cy="8" r=".8" fill="currentColor"/></svg>,

  trophy:  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M4 3h8v3a4 4 0 1 1-8 0V3z"/><path d="M3 3.5h1M12 3.5h1M6 11h4M5.5 13.5h5"/></svg>,

  drag:    <svg viewBox="0 0 16 16" fill="currentColor"><circle cx="6" cy="4" r="1"/><circle cx="10" cy="4" r="1"/><circle cx="6" cy="8" r="1"/><circle cx="10" cy="8" r="1"/><circle cx="6" cy="12" r="1"/><circle cx="10" cy="12" r="1"/></svg>,

  plus:    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M8 3v10M3 8h10"/></svg>,

  chevron: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="m6 4 4 4-4 4"/></svg>,

  arrow_l: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="m10 4-4 4 4 4"/></svg>,

  arrow_r: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="m6 4 4 4-4 4"/></svg>,

  ext:     <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M6 3h7v7M13 3 6 10M3 6v7h7"/></svg>,

  refresh: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M13.5 7a5.5 5.5 0 1 0-1.4 4.6"/><path d="M13.5 3.5v3.7h-3.7"/></svg>,

  menu:    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>,

  heart:   <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M8 13.5s-5-2.8-5-6.5a2.5 2.5 0 0 1 4.5-1.5L8 6.2l.5-.7A2.5 2.5 0 0 1 13 7c0 3.7-5 6.5-5 6.5z"/></svg>,

  dice:    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/><circle cx="5.5" cy="5.5" r="1" fill="currentColor"/><circle cx="10.5" cy="10.5" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="10.5" cy="5.5" r="1" fill="currentColor"/><circle cx="5.5" cy="10.5" r="1" fill="currentColor"/></svg>,

  bulb:    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M5.5 11.5h5M6.5 13h3M8 2.5a4.5 4.5 0 0 1 4.5 4.5c0 1.6-.8 3-2.1 3.8-.4.3-.4.8-.4 1.2H6c0-.4 0-.9-.4-1.2A4.5 4.5 0 0 1 8 2.5z"/></svg>,

  link:    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M4.75 7.5a3.25 3.25 0 0 1 5.54-2.3l1.2 1.2a3.25 3.25 0 0 1-4.6 4.6l-.6-.6M11.25 8.5a3.25 3.25 0 0 1-5.54 2.3l-1.2-1.2a3.25 3.25 0 0 1 4.6-4.6l.6.6"/></svg>,

  warning: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M8 2l6 11H2L8 2zM8 5.5v4M8 11.5h.01"/></svg>,

  checkCircle: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="8" r="6"/><path d="m5.5 8 2 2 3.5-4"/></svg>,

  mail:    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="m2 5 6 3.5 6-3.5"/></svg>,
  log:     <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M8 4.7V8l2.4 1.4"/><path d="M2.6 8a5.4 5.4 0 1 0 1.7-3.9M2.4 3v2.4h2.4"/></svg>,
};



// Brand mark — slightly animated "archive" glyph

function BrandMark() {

  return (

    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">

      <path d="M2.5 4.5 8 2l5.5 2.5M2.5 4.5v7L8 14l5.5-2.5v-7M2.5 4.5 8 7l5.5-2.5M8 7v7" />

    </svg>

  );

}



// ── Sidebar ─────────────────────────────────────────────────────────────────

function Sidebar({ view, onView, tweaks, setTweak, gameCount, storageSize, auth, identity, onLogout }) {
  const NAV = [
    { k: 'explorer',    label: 'Browse Games',      icon: ic.archive,  count: gameCount },
    { k: 'submit',      label: 'Submit a Game',     icon: window.ic2.upload, count: null },
    { k: 'mycontent',   label: 'My Content',        icon: window.ic2.inbox,  count: null },
    { k: 'donation',    label: 'Donation & Support', icon: ic.heart,    count: null },
    { k: 'links',       label: 'Community Links',   icon: ic.ext,      count: null },
    { k: 'updates',     label: 'Update Log',        icon: ic.log,      count: null },
    { k: 'contact',     label: 'About & Contact',   icon: ic.mail,     count: null }
  ];

  return (
    <aside className="sb">
      <div className="sb-brand">
        <div className="sb-logo"><BrandMark /></div>
        <div style={{ flex: 1 }}>
          <div className="sb-brand-name">Archive</div>
          <div className="sb-brand-sub mono">fangame library</div>
        </div>
        <button className="sb-mobile-close" onClick={() => window.closeSidebar && window.closeSidebar()} title="Close menu">
          {ic.x}
        </button>
      </div>

      <div>
        <div className="sb-section-label">Library</div>
        <nav className="sb-nav">
          {NAV.map((n) => (
            <button key={n.k} className={'sb-item' + (view === n.k ? ' active' : '')} onClick={() => onView(n.k)}>
              {n.icon}
              <span>{n.label}</span>
              {n.count != null && <span className="sb-item-count tnum">{n.count}</span>}
            </button>
          ))}
        </nav>
      </div>

      <div className="sb-foot">
        <window.AccountBlock auth={auth} identity={identity} onLogout={onLogout} onView={onView} />
        <div className="sb-stat" style={{ marginTop: '10px' }}><span><span className="sb-pulse" />Storage</span><b className="mono">{storageSize || "619.87 GB"}</b></div>
        <div className="sb-stat"><span>Archived</span><b className="mono">{gameCount.toLocaleString()}</b></div>
        <div className="sb-stat"><span>Sync Status</span><b className="mono" style={{ color: 'oklch(0.72 0.15 152)' }}>Online</b></div>
        <div style={{ padding: '10px 0 0 0', borderTop: '1px solid var(--border)', marginTop: '10px', fontSize: '9.5px', color: 'var(--muted)', letterSpacing: '0.01em', lineHeight: '1.45' }}>
          Fangame Archive © Kureist 2026<br/>
          Developer & Designer
        </div>
      </div>
    </aside>
  );
}



// ── Toasts ─────────────────────────────────────────────────────────────────

function Toasts({ items }) {

  return (

    <div className="toasts">

      {items.map((t) => (

        <div key={t.id} className="toast">

          <span className="dot" />

          <b>{t.title}</b>

          <span className="sub">{t.sub}</span>

        </div>

      ))}

    </div>

  );

}



// ── Lightbox ───────────────────────────────────────────────────────────────

function Lightbox({ shots, index, onClose, onPrev, onNext }) {

  React.useEffect(() => {

    const onKey = (e) => {

      if (e.key === 'Escape') onClose();

      else if (e.key === 'ArrowLeft') onPrev();

      else if (e.key === 'ArrowRight') onNext();

    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);

  }, [onClose, onPrev, onNext]);

  if (!shots) return null;

  const cur = shots[index];

  return (

    <div className="lbox" onClick={onClose}>

      <div className="lbox-inner" onClick={(e) => e.stopPropagation()}>

        <img src={getShotUrl(cur?.image_path)} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', zIndex: 1 }} />

        <button className="lbox-x" onClick={onClose}>{ic.x}</button>

        {shots.length > 1 && <>

          <button className="lbox-nav prev" onClick={onPrev}>{ic.arrow_l}</button>

          <button className="lbox-nav next" onClick={onNext}>{ic.arrow_r}</button>

        </>}

        <div className="lbox-cap mono">

          {index + 1} / {shots.length} · captured by {cur?.by} · esc to close · ←/→ to navigate

        </div>

      </div>

    </div>

  );

}



// Helper to parse simple markdown in review comments
function parseMarkdown(text) {
  if (!text) return "";
  
  // Safe HTML escaping
  let escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
    
  // Replace bold: **text** or __text__
  escaped = escaped.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  escaped = escaped.replace(/__(.*?)__/g, "<strong>$1</strong>");
  
  // Replace italic: *text* or _text_
  escaped = escaped.replace(/\*(.*?)\*/g, "<em>$1</em>");
  escaped = escaped.replace(/_(.*?)_/g, "<em>$1</em>");
  
  // Replace inline code: `code`
  escaped = escaped.replace(/`(.*?)`/g, "<code>$1</code>");
  
  // Replace links: [text](url)
  escaped = escaped.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  
  // Replace newlines: \n
  escaped = escaped.replace(/\n/g, "<br />");
  
  return <span dangerouslySetInnerHTML={{ __html: escaped }} />;
}

// Click-to-reveal Spoiler component
function Spoiler({ text }) {
  const [revealed, setRevealed] = React.useState(false);
  
  return (
    <span 
      className={`spoiler-text ${revealed ? 'revealed' : ''}`} 
      onClick={() => setRevealed(true)}
      title={revealed ? "" : "Click to reveal spoiler"}
    >
      {revealed ? parseMarkdown(text) : "Spoiler"}
    </span>
  );
}

// CommentBody component to render comment text supporting spoilers and simple markdown
function CommentBody({ text }) {
  if (!text) return null;
  
  const parts = text.split("||");
  return (
    <p className="review-body">
      {parts.map((part, idx) => {
        if (idx % 2 === 1) {
          // This is a spoiler
          return <Spoiler key={idx} text={part} />;
        } else {
          // This is normal text
          return <React.Fragment key={idx}>{parseMarkdown(part)}</React.Fragment>;
        }
      })}
    </p>
  );
}

// ── Drawer (Game Detail) ───────────────────────────────────────────────────

function Drawer({ game, isRoll, onClose, auth, identity }) {

  const [openShot, setOpenShot] = React.useState(-1);

  const [comments, setComments] = React.useState([]);

  const [loadingComments, setLoadingComments] = React.useState(true);

  const [commentPage, setCommentPage] = React.useState(1);

  const shots = game ? (window.DATA.SCREENSHOTS[game.id] || []) : [];

  const loadComments = React.useCallback(async () => {
    if (!game) return;
    setLoadingComments(true);
    try {
      let headers = {};
      if (typeof Clerk !== 'undefined' && Clerk.session) {
        const token = await Clerk.session.getToken();
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
      }
      const res = await fetch(`/api/comments?game_id=${game.id}`, { headers });
      if (!res.ok) throw new Error("Failed to load comments.");
      const data = await res.json();
      setComments(data.comments || []);
    } catch (err) {
      console.error(err);
      setComments([]);
    } finally {
      setLoadingComments(false);
    }
  }, [game?.id]);

  React.useEffect(() => {

    if (game === null) return;

    setCommentPage(1);

    loadComments();

  }, [game?.id, loadComments]);



  if (game === null) return null;





  return (

    <>

      <div className="drawer-scrim on" onClick={onClose} />

      <aside className="drawer on">

        <header className="drawer-hd">

          <div className="drawer-thumb">

            <div className="card-thumb-grid" />

            <div className="card-thumb-glyph" style={{ fontSize: 22 }}>{game.title[0]}</div>

          </div>

          <div style={{ flex: 1, minWidth: 0 }}>

            <h2 className="drawer-title">{game.title}</h2>

            <div className="drawer-meta">

              by <a href="#" onClick={(e) => {
                e.preventDefault();
                if (window.setCreatorSearch) {
                  window.setCreatorSearch(game.creator);
                }
                onClose();
              }}>{game.creator}</a>

              {' · '}<span className="mono">{game.df_id}</span>

            </div>

            <div className="drawer-meta" style={{ marginTop: 2, fontSize: 11, opacity: 0.9 }}>

              <span className="mono" style={{ display: 'block', textOverflow: 'ellipsis', whiteSpace: 'nowrap', overflow: 'hidden' }}>{game.url}</span>

            </div>

          </div>

          <button className="drawer-close" onClick={onClose}>{ic.x}</button>

        </header>



        <div className="drawer-body">

          {/* Stats Metrics Grid */}

          <section className="drawer-sec" style={{ 

            display: 'grid', 

            gridTemplateColumns: 'repeat(3, 1fr)', 

            gap: '8px', 

            marginBottom: '12px' 

          }}>

            <div style={{

              background: 'rgba(255, 255, 255, 0.025)',

              border: '1px solid rgba(255, 255, 255, 0.05)',

              borderRadius: '8px',

              padding: '8px 6px',

              textAlign: 'center',

              display: 'flex',

              flexDirection: 'column',

              gap: '2px'

            }}>

              <span style={{ fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>Rating</span>

              <span style={{ fontSize: '13px', fontWeight: '700', fontFamily: 'var(--font-mono)' }}>

                {game.rating !== null ? `${game.rating.toFixed(1)}/10.0` : 'N/A'}

              </span>

              <span style={{ fontSize: '9px', color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>

                {game.reviews} {game.reviews === 1 ? 'review' : 'reviews'}

              </span>

            </div>

            

            <div style={{

              background: 'rgba(255, 255, 255, 0.025)',

              border: '1px solid rgba(255, 255, 255, 0.05)',

              borderRadius: '8px',

              padding: '8px 6px',

              textAlign: 'center',

              display: 'flex',

              flexDirection: 'column',

              gap: '2px'

            }}>

              <span style={{ fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>Difficulty</span>

              <span style={{ fontSize: '13px', fontWeight: '700', fontFamily: 'var(--font-mono)' }}>

                {game.difficulty !== null ? `${game.difficulty.toFixed(1)}/100.0` : 'N/A'}

              </span>

              <span style={{ fontSize: '9px', color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>

                {game.difficulty !== null ? 'Standard' : 'N/A'}

              </span>

            </div>

            

            <div style={{

              background: 'rgba(255, 255, 255, 0.025)',

              border: '1px solid rgba(255, 255, 255, 0.05)',

              borderRadius: '8px',

              padding: '8px 6px',

              textAlign: 'center',

              display: 'flex',

              flexDirection: 'column',

              gap: '2px'

            }}>

              <span style={{ fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>File Size</span>

              <span style={{ fontSize: '13px', fontWeight: '700', fontFamily: 'var(--font-mono)' }}>

                {game.file_size > 0 ? formatSize(game.file_size) : 'N/A'}

              </span>

              <span style={{ fontSize: '9px', color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>

                {game.file_size > 0 ? (game.flags?.local ? 'R2 CDN' : 'External') : 'N/A'}

              </span>

            </div>

          </section>



          <section className="drawer-sec" style={{ display: 'flex', gap: '8px' }}>

            <button

              className="launch-btn"

              style={{ flex: 1 }}

              disabled={!game.url || game.flags?.broken}

              onClick={() => {

                if (game.url && !game.flags?.broken) {

                  window.open(game.url, '_blank', 'noopener,noreferrer');

                }

              }}

            >

              {(!game.url || game.flags?.broken) ? (

                <>{ic.x} Not Available</>

              ) : (

                <>{ic.download} Download</>

              )}

            </button>



            {isRoll && window.rollRandomGame && (

              <button

                className="roll-again-btn"

                onClick={() => window.rollRandomGame()}

                title="Roll another random game from current filters"

                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}

              >

                {ic.dice} Roll Again

              </button>

            )}

          </section>



          {game.tags && game.tags.length > 0 && (

            <section className="drawer-sec">

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>

                {game.tags.map((t) => <span key={t} className="tag" style={{ height: 22, cursor: 'default' }}>{t}</span>)}

              </div>

            </section>

          )}

          {game.desc && (
            <section className="drawer-sec">
              <div style={{
                fontSize: '12.5px',
                lineHeight: '1.6',
                color: 'var(--text-soft)',
                background: 'var(--panel-2)',
                border: '1px solid var(--border)',
                padding: '12px 14px',
                borderRadius: '8px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word'
              }}>
                {game.desc}
              </div>
            </section>
          )}







          <section className="drawer-sec">

            <h5>Screenshots <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 4 }}>({shots.length})</span></h5>

            {shots.length > 0 ? (

              <div className="gallery">

                {shots.map((s, i) => (

                  <div key={i} className="shot" onClick={() => setOpenShot(i)}>

                    <img src={getShotUrl(s.image_path)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />

                    <span className="cap">by {s.by}</span>

                  </div>

                ))}

              </div>

            ) : <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>No screenshots captured.</p>}

          </section>



          <section className="drawer-sec">

            <h5>Community Reviews <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 4 }}>({loadingComments ? '...' : comments.length})</span></h5>

            {loadingComments ? (

              <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>Loading reviews...</p>

            ) : (

              <>

                {comments.length === 0 && <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>No reviews mirrored yet.</p>}

                {comments.slice((commentPage - 1) * 5, commentPage * 5).map((r, i) => (

                  <div key={i} className={`review${r.status === 'pending' ? ' own' : ''}`}>

                    <div className="review-hd">

                      <b><a href="#">{r.user}</a></b>

                      {r.status === 'pending' && <span className="badge-mini own">Pending Review</span>}

                      {r.source === 'imported' && <span className="badge-mini imported">Imported</span>}

                      {r.rating !== null && r.rating !== undefined && r.rating !== 'na' ? <span className="mono">rating {r.rating}/10</span> : <span className="mono" style={{ color: 'var(--muted)' }}>rating N/A</span>}

                      {r.diff !== null && r.diff !== undefined && r.diff !== 'na' ? <span style={{ color: 'var(--muted)' }}>diff {r.diff}</span> : <span style={{ color: 'var(--muted)' }}>diff N/A</span>}

                      <span style={{ color: 'var(--muted)' }}>· ♡ {r.liked}</span>

                      <span className="date">{r.date}</span>

                    </div>

                    <CommentBody text={r.body} />

                    <div className="review-foot">

                      {r.tags.map((t) => <span key={t} className="tag-mini">{t}</span>)}

                    </div>

                  </div>

                ))}

                

                {Math.ceil(comments.length / 5) > 1 && (

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '16px', gap: '8px' }}>

                    <button 

                      disabled={commentPage === 1}

                      onClick={() => setCommentPage(prev => Math.max(prev - 1, 1))}

                      style={{

                        background: 'rgba(255, 255, 255, 0.03)',

                        border: '1px solid rgba(255, 255, 255, 0.08)',

                        borderRadius: '6px',

                        color: commentPage === 1 ? 'var(--muted)' : 'var(--text)',

                        padding: '6px 12px',

                        fontSize: '11px',

                        cursor: commentPage === 1 ? 'not-allowed' : 'pointer',

                        transition: 'all 0.15s ease',

                        outline: 'none'

                      }}

                    >

                      Previous

                    </button>

                    <span style={{ fontSize: '11px', color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>

                      Page {commentPage} of {Math.ceil(comments.length / 5)}

                    </span>

                    <button 

                      disabled={commentPage === Math.ceil(comments.length / 5)}

                      onClick={() => setCommentPage(prev => Math.min(prev + 1, Math.ceil(comments.length / 5)))}

                      style={{

                        background: 'rgba(255, 255, 255, 0.03)',

                        border: '1px solid rgba(255, 255, 255, 0.08)',

                        borderRadius: '6px',

                        color: commentPage === Math.ceil(comments.length / 5) ? 'var(--muted)' : 'var(--text)',

                        padding: '6px 12px',

                        fontSize: '11px',

                        cursor: commentPage === Math.ceil(comments.length / 5) ? 'not-allowed' : 'pointer',

                        transition: 'all 0.15s ease',

                        outline: 'none'

                      }}

                    >

                      Next

                    </button>

                  </div>

                )}

              </>

            )}

          </section>

          <section className="drawer-sec" style={{ padding: 0 }}>
            <window.CommentEditor
              auth={auth}
              identity={identity}
              gameId={game.id}
              onOpenLogin={() => typeof Clerk !== 'undefined' && Clerk.openSignIn()}
              onPosted={loadComments}
            />
          </section>

        </div>

      </aside>



      {openShot >= 0 && (

        <Lightbox shots={shots} index={openShot}

          onClose={() => setOpenShot(-1)}

          onPrev={() => setOpenShot((openShot - 1 + shots.length) % shots.length)}

          onNext={() => setOpenShot((openShot + 1) % shots.length)} />

      )}

    </>

  );

}





// ── Shared copy icon (Donation) ─────────────────────────────────────────────

const copyIc = (

  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">

    <rect x="2.5" y="4.5" width="7" height="9" rx="1.5" />

    <path d="M6.5 2.5h5A1.5 1.5 0 0 1 13 4v7" />

  </svg>

);



// ── Donation & Support — Notion-style wallet table ──────────────────────────

function DonationView({ gameCount, storageSize }) {

  const [copied, setCopied] = React.useState(null);



  const wallets = [

    { coin: 'AFD',  label: 'Afdian — Support the creator',        addr: 'https://ifdian.net/a/kureist',                      color: '#946ce6', isLink: true },

    { coin: 'BTC',  label: 'Bitcoin',                             addr: 'bc1qdrkrrqrtquuwrwug4ps0djws47yndsc6k4mxdj',         color: '#f7931a' },

    { coin: 'ETH',  label: 'Ethereum · ERC-20',                   addr: '0xe1F7768210Dd93F635553b2ba3F1B897ef7B795C',         color: '#627eea' },

    { coin: 'USDT', label: 'Tether USD · ERC-20',                 addr: '0xe1F7768210Dd93F635553b2ba3F1B897ef7B795C',         color: '#26a17b' },

    { coin: 'USDC', label: 'USD Coin · ERC-20',                   addr: '0xe1F7768210Dd93F635553b2ba3F1B897ef7B795C',         color: '#2775ca' }

  ];



  const handleCopy = (addr, coin) => {

    navigator.clipboard.writeText(addr);

    setCopied(coin);

    setTimeout(() => setCopied(null), 2000);

  };



  return (

    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>

      <div className="topbar">

        <button className="iconbtn mobile-menu-btn" onClick={() => window.toggleSidebar && window.toggleSidebar()} title="Toggle menu">

          {window.ic.menu}

        </button>

        <span className="crumb"><b>Library</b><span>/</span>Donation &amp; Support</span>

      </div>



      <div className="docview">

        <div className="doc">

          <div className="doc-head">

            <h1 className="doc-title"><span className="doc-title-ic">{ic.heart}</span>Donation &amp; Support</h1>

            <p className="doc-sub">

              A community-driven archive of {gameCount ? gameCount.toLocaleString() : "17,000"}+ fangames and {storageSize || "618 GB"} of crawled content. Sponsorships go

              directly toward server hosting, bandwidth, and CDN distribution — thank you for keeping the archive alive.

            </p>

          </div>



          <div className="doc-section">

            <div className="doc-section-label">Wallets &amp; sponsorship <span className="ct">{wallets.length}</span></div>

            <div className="ntable">

              {wallets.map((w) => (

                <div key={w.coin} className="ntable-row don-row">

                  <span className="coin-chip"><span className="dot" style={{ background: w.color }} />{w.coin}</span>

                  <div style={{ minWidth: 0 }}>

                    <div className="don-label">{w.label}</div>

                    <span className="don-addr">{w.addr}</span>

                  </div>

                  {w.isLink ? (

                    <a className="doc-btn accent" href={w.addr} target="_blank" rel="noopener noreferrer">

                      {ic.ext} Sponsor

                    </a>

                  ) : (

                    <button className={'doc-btn' + (copied === w.coin ? ' on' : '')} onClick={() => handleCopy(w.addr, w.coin)}>

                      {copied === w.coin ? <>{ic.check} Copied</> : <>{copyIc} Copy</>}

                    </button>

                  )}

                </div>

              ))}

            </div>

          </div>



          <div className="callout">

            <span className="callout-ic">{ic.bulb}</span>

            <div>

              <b>Security notice.</b> Double-check the wallet address and network before sending. ETH, USDT, and

              USDC addresses all use the ERC-20 network (Ethereum Mainnet).

            </div>

          </div>

        </div>

      </div>

    </div>

  );

}



// ── Community Links — Notion-style link rows ────────────────────────────────

function LinksView() {

  const links = [

    { name: 'Delicious Fruit',   desc: 'The historic flagship archive — the foundation of I Wanna cataloging and reviews for over a decade.', url: 'https://delicious-fruit.com/' },

    { name: 'I Wanna Wiki',      desc: 'A community-maintained encyclopedia of creator bios, detailed walkthroughs, and wiki listings.',        url: 'https://www.iwannawiki.com/' },

    { name: 'Dappermink Archive', desc: 'An exceptionally complete vault hosting hundreds of classic, modern, and obscure fangame binaries.',     url: 'https://archive.dappermink.me/home' }

  ];



  const hostOf = (u) => u.replace(/^https?:\/\//, '').replace(/\/.*$/, '');



  return (

    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>

      <div className="topbar">

        <button className="iconbtn mobile-menu-btn" onClick={() => window.toggleSidebar && window.toggleSidebar()} title="Toggle menu">

          {window.ic.menu}

        </button>

        <span className="crumb"><b>Library</b><span>/</span>Community Links</span>

      </div>



      <div className="docview">

        <div className="doc">

          <div className="doc-head">

            <h1 className="doc-title"><span className="doc-title-ic">{ic.link}</span>Community Links</h1>

            <p className="doc-sub">

              Portals to the archives, wikis, and community platforms that together form the backbone of the global

              I&nbsp;Wanna fangame legacy.

            </p>

          </div>



          <div className="doc-section">

            <div className="doc-section-label">Partner sites <span className="ct">{links.length}</span></div>

            <div className="ntable">

              {links.map((l) => (

                <a key={l.name} className="ntable-row link-row" href={l.url} target="_blank" rel="noopener noreferrer"

                   id={'link-' + l.name.toLowerCase().replace(/\s+/g, '-')}>

                  <span className="link-glyph">{l.name[0]}</span>

                  <div style={{ minWidth: 0 }}>

                    <div className="link-row-title">{l.name}<span className="link-row-host">{hostOf(l.url)}</span></div>

                    <div className="link-row-desc">{l.desc}</div>

                  </div>

                  <span className="link-row-arrow">{ic.ext}</span>

                </a>

              ))}

            </div>

          </div>

        </div>

      </div>

    </div>

  );

}



// ── About & Contact — Notion-style properties + tag groups ──────────────────

function ContactView() {

  const techStack = {

    frontend: [

      { name: 'React (Standalone)', url: 'https://react.dev/' },

      { name: 'ES6+ JavaScript', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript' },

      { name: 'Babel Standalone', url: 'https://babeljs.io/' },

      { name: 'Vanilla CSS3', url: 'https://developer.mozilla.org/en-US/docs/Web/CSS' },

      { name: 'SVG Vectors', url: 'https://developer.mozilla.org/en-US/docs/Web/SVG' }

    ],

    backend: [

      { name: 'Python 3', url: 'https://www.python.org/' },

      { name: 'Go (Golang)', url: 'https://go.dev/' },

      { name: 'Node.js', url: 'https://nodejs.org/' },

      { name: 'BeautifulSoup4', url: 'https://www.crummy.com/software/BeautifulSoup/bs4/doc/' },

      { name: 'Ripgrep', url: 'https://github.com/BurntSushi/ripgrep' }

    ],

    database: [

      { name: 'JSON Database (Chunked)', url: 'https://www.json.org/' },

      { name: 'IndexedDB (Client Cache)', url: 'https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API' },

      { name: 'Cloudflare R2', url: 'https://www.cloudflare.com/developer-platform/r2/' },

      { name: 'AWS S3 SDK', url: 'https://aws.amazon.com/s3/' }

    ],

    infrastructure: [

      { name: '7-Zip CLI', url: 'https://www.7-zip.org/' },

      { name: 'PowerShell / CMD', url: 'https://learn.microsoft.com/en-us/powershell/' }

    ]

  };



  const groups = [

    ['Frontend core', techStack.frontend],

    ['Backend & crawlers', techStack.backend],

    ['Database & cloud storage', techStack.database],

    ['Infrastructure & utilities', techStack.infrastructure]

  ];



  const contacts = [

    ['Discord', 'kureist'],

    ['Email', 'kurath0307@gmail.com'],

    ['QQ', '865903566']

  ];



  return (

    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>

      <div className="topbar">

        <button className="iconbtn mobile-menu-btn" onClick={() => window.toggleSidebar && window.toggleSidebar()} title="Toggle menu">

          {window.ic.menu}

        </button>

        <span className="crumb"><b>Library</b><span>/</span>About &amp; Contact</span>

      </div>



      <div className="docview">

        <div className="doc">

          <div className="doc-head">

            <h1 className="doc-title"><span className="doc-title-ic">{ic.mail}</span>About &amp; Contact</h1>

            <p className="doc-sub">

              Catalog credits, the technical stack that powers the archive, and where to reach the maintainer.

            </p>

          </div>



          <div className="doc-section">

            <div className="doc-section-label">Credits</div>

            <div className="ntable">

              <div className="ntable-row prop-row">

                <span className="prop-key">Creator</span>

                <span className="prop-val">kureist</span>

              </div>

              <div className="ntable-row prop-row">

                <span className="prop-key">Special thanks</span>

                <span className="prop-val">Chance, Dappermink, null, Algosith</span>

              </div>

            </div>

          </div>



          <div className="doc-section">

            <div className="doc-section-label">Technical stack</div>

            <div className="tag-group">

              {groups.map(([label, items]) => (

                <div key={label}>

                  <div className="tag-group-label">{label}</div>

                  <div className="tagrow">

                    {items.map((t) => (

                      <a key={t.name} className="tag" href={t.url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>{t.name}</a>

                    ))}

                  </div>

                </div>

              ))}

            </div>

          </div>



          <div className="doc-section">

            <div className="doc-section-label">Contact</div>

            <div className="ntable">

              {contacts.map(([k, v]) => (

                <div key={k} className="ntable-row prop-row">

                  <span className="prop-key">{k}</span>

                  <span className="prop-val mono-val">{v}</span>

                </div>

              ))}

            </div>

          </div>



          <div className="doc-foot">Fangame Archive · Developer &amp; Designer © Kureist 2026</div>

        </div>

      </div>

    </div>

  );

}

// ── Update Log — Notion-style changelog timeline ────────────────────────────
function UpdateLogView() {
  const [releases, setReleases] = React.useState([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let url = 'data/changelog.json';
    if (window.location.pathname.includes('/origin/')) {
      url = '../data/changelog.json';
    }
    const cacheBuster = window.APP_VERSION ? `?v=${window.APP_VERSION}` : '';
    fetch(url + cacheBuster)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        setReleases(data);
        setLoading(false);
      })
      .catch(err => {
        console.error("Failed to load changelog:", err);
        setReleases([]);
        setLoading(false);
      });
  }, []);

  const KIND = {
    Added:   'oklch(0.72 0.15 152)',
    Changed: 'oklch(0.66 0.13 248)',
    Fixed:   'oklch(0.75 0.14 70)',
    Removed: 'oklch(0.65 0.13 30)'
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>
        <div className="topbar">
          <button className="iconbtn mobile-menu-btn" onClick={() => window.toggleSidebar && window.toggleSidebar()} title="Toggle menu">
            {window.ic.menu}
          </button>
          <span className="crumb"><b>Library</b><span>/</span>Update Log</span>
        </div>
        <div className="docview">
          <div className="doc">
            <p style={{ fontSize: 13, color: 'var(--muted)' }}>Loading update log...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>
      <div className="topbar">
        <button className="iconbtn mobile-menu-btn" onClick={() => window.toggleSidebar && window.toggleSidebar()} title="Toggle menu">
          {window.ic.menu}
        </button>
        <span className="crumb"><b>Library</b><span>/</span>Update Log</span>
      </div>

      <div className="docview">
        <div className="doc">
          <div className="doc-head">
            <h1 className="doc-title"><span className="doc-title-ic">{ic.log}</span>Update Log</h1>
            <p className="doc-sub">
              A running record of database releases, new surfaces, and fixes shipped to the archive. The
              live database is currently on <b style={{ color: 'var(--text)', fontWeight: 600 }}>version {window.DATABASE_VERSION || '51'}</b>. The application version is <b style={{ color: 'var(--text)', fontWeight: 600 }}>version {window.APP_VERSION || '2026.002'}</b>.
            </p>
          </div>

          {releases.map((r) => (
            <div className="doc-section" key={r.ver}>
              <div className="log-ver">
                <span className="log-ver-num">{r.ver}</span>
                <span className="log-ver-note">{r.note}</span>
                <span className="log-ver-date mono">{r.date}</span>
              </div>
              <div className="ntable">
                {r.changes.map(([kind, text], i) => (
                  <div className="ntable-row log-row" key={i}>
                    <span className="coin-chip"><span className="dot" style={{ background: KIND[kind] }} />{kind}</span>
                    <div className="log-desc">{text}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}

          <div className="callout">
            <span className="callout-ic">{ic.refresh}</span>
            <div>
              <b>Auto-sync.</b> The crawler re-indexes mirrors every 6 hours. New entries land here once a
              database version is published — your local cache updates incrementally on next visit.
            </div>
          </div>

          <div className="doc-foot">Fangame Archive · Developer &amp; Designer © Kureist 2026</div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ic, Sidebar, Toasts, Lightbox, Drawer, BrandMark, DonationView, LinksView, ContactView, UpdateLogView });

