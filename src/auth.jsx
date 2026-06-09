// Authentication & Turnstile integrations using Clerk and Cloudflare Turnstile.
// Reuses the styling classes and layout from mockup.

// Extra icons for user controls
const ic2 = {
  user:     <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="5.5" r="2.6"/><path d="M3 13.2a5 5 0 0 1 10 0"/></svg>,
  login:    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M9 2.5h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9M9.5 8H3m0 0 2.5-2.5M3 8l2.5 2.5"/></svg>,
  logout:   <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M7 2.5H4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3M10.5 8H6m4.5 0L8 5.5M10.5 8 8 10.5"/></svg>,
  upload:   <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M8 10.5V3m0 0L5 6m3-3 3 3M3 12.5h10"/></svg>,
  inbox:    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2.5 9.5 4 4h8l1.5 5.5M2.5 9.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2M2.5 9.5H6l.8 1.3h2.4L10 9.5h3.5"/></svg>,
  gear:     <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="8" r="2"/><path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6"/></svg>,
  shield:   <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M8 1.8 3 3.6v4.2c0 3 2.1 5 5 6.4 2.9-1.4 5-3.4 5-6.4V3.6L8 1.8z"/><path d="m6 8 1.5 1.5L10.5 6"/></svg>,
  lock:     <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>,
  ban:      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="8" r="5.5"/><path d="m4.2 4.2 7.6 7.6"/></svg>,
  mute:     <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M8 3 5 5.5H3v5h2L8 13V3z"/><path d="M11 6.5 14 9.5M14 6.5 11 9.5"/></svg>,
  users:    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="6" cy="5.5" r="2.2"/><path d="M2.3 12.5a3.7 3.7 0 0 1 7.4 0M10.5 4a2 2 0 0 1 0 3.8M11 12.5a3.7 3.7 0 0 0-1.3-2.8"/></svg>,
  list2:    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8"/><circle cx="2.7" cy="4.5" r=".9" fill="currentColor"/><circle cx="2.7" cy="8" r=".9" fill="currentColor"/><circle cx="2.7" cy="11.5" r=".9" fill="currentColor"/></svg>,
  gauge:    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2.6 11.5a6 6 0 1 1 10.8 0"/><path d="M8 8.5 10.5 6"/><circle cx="8" cy="8.5" r=".9" fill="currentColor"/></svg>,
  trash:    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M3 4.5h10M6 4.5V3.2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.3M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8"/></svg>,
  empty:    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M2.5 9.5H6l.8 1.3h2.4L10 9.5h3.5" strokeWidth="1.3"/></svg>,
};

const AVATAR_COLORS = [
  'oklch(0.62 0.16 25)', 'oklch(0.62 0.15 50)', 'oklch(0.60 0.14 145)',
  'oklch(0.58 0.15 200)', 'oklch(0.56 0.16 265)', 'oklch(0.58 0.17 310)',
  'oklch(0.60 0.15 95)', 'oklch(0.58 0.15 170)',
];

// Resolves a stable visual identity claim (initial, color, name) from Clerk's session
function getClerkIdentity() {
  if (typeof Clerk === 'undefined' || !Clerk.user) return null;
  const user = Clerk.user;

  let name = user.username;
  if (!name) {
    name = [user.firstName, user.lastName].filter(Boolean).join(' ');
  }
  if (!name && user.primaryEmailAddress) {
    name = user.primaryEmailAddress.emailAddress.split('@')[0];
  }
  if (!name) {
    name = 'Member';
  }

  // Derive stable avatar background color from name string
  const charSum = name.split('').reduce((sum, c) => sum + c.charCodeAt(0), 0);
  const color = AVATAR_COLORS[charSum % AVATAR_COLORS.length];
  const initial = name[0].toUpperCase();

  return {
    nick: name,
    color,
    initial,
    avatar_url: user.imageUrl
  };
}

// ── Avatar Component ────────────────────────────────────────────────────────
function Avatar({ identity, size = 26, className = '' }) {
  if (identity && identity.avatar_url) {
    return (
      <img
        src={identity.avatar_url}
        className={'avatar ' + className}
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          objectFit: 'cover',
          border: '1px solid rgba(255,255,255,0.06)'
        }}
        onError={(e) => {
          // Fallback to text avatar if image loading fails
          e.target.style.display = 'none';
        }}
      />
    );
  }

  const color = identity?.color || 'var(--border)';
  const initial = identity?.initial || '?';
  return (
    <span
      className={'avatar ' + className}
      style={{
        background: color,
        width: size,
        height: size,
        fontSize: size * 0.46,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        fontWeight: 600,
        borderRadius: '50%'
      }}
    >
      {initial}
    </span>
  );
}

// ── Toast dispatcher ─────────────────────────────────────────────────────────
function pushToast(title, sub, kind) {
  if (window.__pushToast) {
    window.__pushToast({ title, sub: sub || '', kind: kind || 'success' });
  }
}

// ── Sidebar Account Block ────────────────────────────────────────────────────
function AccountBlock({ auth, identity, onOpenLogin, onLogout, onView }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  if (auth === 'out') {
    return (
      <div className="acct">
        <button className="acct-login" onClick={async (e) => {
          const btn = e.currentTarget;
          if (typeof Clerk === 'undefined' || !Clerk.loaded) {
            // Disable button and show loading text
            btn.disabled = true;
            const originalHTML = btn.innerHTML;
            btn.innerHTML = '<span>Loading Auth...</span>';
            
            const loadClerkScript = () => {
              return new Promise((resolve) => {
                if (typeof window.Clerk !== 'undefined') {
                  resolve(true);
                  return;
                }
                const script = document.createElement('script');
                script.src = "https://cdn.clerk.com/clerk.js";
                script.setAttribute('data-clerk-publishable-key', window.CLERK_PUBLISHABLE_KEY);
                script.crossOrigin = "anonymous";
                script.async = true;
                script.onload = () => resolve(true);
                script.onerror = () => resolve(false);
                document.head.appendChild(script);
                
                // Allow up to 5 seconds for user click load
                setTimeout(() => resolve(false), 5000);
              });
            };
            
            const loaded = await loadClerkScript();
            if (loaded && typeof window.Clerk !== 'undefined') {
              if (!window.Clerk.loaded) {
                try {
                  await window.Clerk.load({
                    publishableKey: window.CLERK_PUBLISHABLE_KEY
                  });
                } catch (err) {
                  alert("Failed to initialize authentication: " + err.message);
                  btn.disabled = false;
                  btn.innerHTML = originalHTML;
                  return;
                }
              }
            } else {
              alert("Authentication service (Clerk) failed to load. If you use an ad-blocker or script blocker, please disable it for this site and refresh.");
              btn.disabled = false;
              btn.innerHTML = originalHTML;
              return;
            }
            btn.disabled = false;
            btn.innerHTML = originalHTML;
          }
          
          if (typeof Clerk !== 'undefined' && typeof Clerk.openSignIn === 'function') {
            Clerk.openSignIn();
          }
        }}>
          {ic2.login}<span>Login</span>
        </button>
      </div>
    );
  }

  const isAdmin = auth === 'admin';
  return (
    <div className="acct" ref={ref}>
      {open && (
        <div className="acct-menu">
          <div className="acct-menu-head">
            <Avatar identity={identity} size={30} />
            <div style={{ minWidth: 0 }}>
              <div className="nick">{identity.nick}</div>
              <div className="sub">{isAdmin ? 'Administrator' : 'Member'}</div>
            </div>
          </div>
          <button className="acct-menu-item" onClick={() => { setOpen(false); onView('mycontent'); }}>
            {ic2.inbox}<span>My Content</span>
          </button>
          <button className="acct-menu-item" onClick={() => { setOpen(false); typeof Clerk !== 'undefined' && Clerk.openUserProfile(); }}>
            {ic2.gear}<span>Account</span>
          </button>
          {isAdmin && (
            <a className="acct-menu-item" href={window.ADMIN_URL || 'admin.html'} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)}>
              {ic2.shield}<span>Admin Dashboard</span>
              <span className="ext-hint">{window.ic.ext}</span>
            </a>
          )}
          <div className="acct-menu-sep" />
          <button className="acct-menu-item danger" onClick={() => { setOpen(false); onLogout(); }}>
            {ic2.logout}<span>Log Out</span>
          </button>
        </div>
      )}
      <button className={'acct-user' + (open ? ' open' : '')} onClick={() => setOpen((o) => !o)}>
        <Avatar identity={identity} size={26} />
        <div style={{ minWidth: 0 }}>
          <div className="nick">{identity.nick}</div>
          <div className="role">{isAdmin ? 'Administrator' : 'Member'}</div>
        </div>
        <span className="chev">{window.ic.chevron}</span>
      </button>
    </div>
  );
}

// ── Shared UI status states: Skeleton / Empty / Error ──────────────────────
function SkeletonList({ rows = 3 }) {
  return (
    <div>
      {Array.from({ length: rows }).map((_, i) => (
        <div className="skel-row" key={i}>
          <div className="skel" style={{ width: 30, height: 30, borderRadius: 7, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div className="skel" style={{ width: '46%', height: 12, marginBottom: 8 }} />
            <div className="skel" style={{ width: '72%', height: 10 }} />
          </div>
          <div className="skel" style={{ width: 64, height: 20, borderRadius: 999 }} />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ icon, title, sub }) {
  return (
    <div className="state-box">
      <div className="sx-ic">{icon || ic2.empty}</div>
      <h4>{title}</h4>
      {sub && <p>{sub}</p>}
    </div>
  );
}

function ErrorState({ title, sub, onRetry }) {
  return (
    <div className="state-box">
      <div className="sx-ic" style={{ color: 'oklch(0.62 0.16 25)' }}>{window.ic.warning}</div>
      <h4>{title || 'Something went wrong'}</h4>
      {sub && <p>{sub}</p>}
      {onRetry && <button className="doc-btn" style={{ marginTop: 12 }} onClick={onRetry}>{window.ic.refresh} Retry</button>}
    </div>
  );
}

// ── Cloudflare Turnstile Wrapper ────────────────────────────────────────────
function Turnstile({ verified, onVerify }) {
  const containerRef = React.useRef(null);
  const widgetIdRef = React.useRef(null);

  React.useEffect(() => {
    let mounted = true;

    const renderWidget = () => {
      if (!containerRef.current || !window.turnstile) return;

      if (widgetIdRef.current !== null) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch (e) {}
      }

      try {
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: window.TURNSTILE_SITE_KEY || "1x00000000000000000000AA", // Local dev testing key fallback
          callback: (token) => {
            if (mounted) {
              onVerify(token);
            }
          },
          "expired-callback": () => {
            if (mounted) onVerify(null);
          },
          "error-callback": () => {
            if (mounted) onVerify(null);
          }
        });
      } catch (err) {
        console.error("Turnstile rendering error:", err);
      }
    };

    const checkLoaded = () => {
      if (window.turnstile) {
        renderWidget();
      } else {
        setTimeout(checkLoaded, 100);
      }
    };
    checkLoaded();

    return () => {
      mounted = false;
      if (widgetIdRef.current !== null && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch (e) {}
      }
    };
  }, [onVerify]);

  return (
    <div style={{ minHeight: '65px', display: 'flex', alignItems: 'center' }}>
      <div ref={containerRef} id="cf-turnstile-container" />
    </div>
  );
}

function Spinner({ light }) {
  return (
    <span
      className="cl-spin"
      style={{
        width: 14,
        height: 14,
        borderRadius: '50%',
        display: 'inline-block',
        border: '2px solid ' + (light ? 'rgba(255,255,255,.4)' : 'var(--border-strong)'),
        borderTopColor: light ? '#fff' : 'var(--accent)',
        animation: 'ts-spin .7s linear infinite'
      }}
    />
  );
}

// Merge icons and helpers globally
Object.assign(window.ic, ic2);
Object.assign(window, {
  ic2,
  AVATAR_COLORS,
  getClerkIdentity,
  Avatar,
  pushToast,
  AccountBlock,
  SkeletonList,
  EmptyState,
  ErrorState,
  Turnstile,
  Spinner
});
