// Archive Health & Integrity dashboard.

function HealthView({ tweaks, setTweak }) {
  const [tab, setTab] = React.useState('missing');
  const [selected, setSelected] = React.useState(new Set());
  const [auditData, setAuditData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [cleaning, setCleaning] = React.useState(false);
  const [error, setError] = React.useState(null);

  const fetchAudit = async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/audit');
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const data = await res.json();
      setAuditData(data);
    } catch (e) {
      console.error("Audit error:", e);
      setError(e.message);
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  React.useEffect(() => {
    fetchAudit();
  }, []);

  const handleCleanup = async () => {
    if (!selected.size) return;
    setCleaning(true);
    try {
      const filesToDelete = Array.from(selected);
      const res = await fetch('/api/audit/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: filesToDelete })
      });
      if (!res.ok) throw new Error('Cleanup failed');
      const result = await res.json();
      setSelected(new Set());
      await fetchAudit(false);
    } catch (e) {
      alert("Cleanup failed: " + e.message);
    } finally {
      setCleaning(false);
    }
  };

  React.useEffect(() => { setSelected(new Set()); }, [tab]);

  const MISSING_ASSETS = auditData ? auditData.missing_assets : [];
  const DEAD_URLS = auditData ? auditData.dead_urls : [];
  const ORPHANED = auditData ? auditData.orphaned_files : [];
  
  const stats = auditData ? auditData.stats : {
    storage_used: 0,
    storage_total: 0,
    storage_pct: 0,
    storage_foot: "Loading storage stats...",
    sync_rate: 0,
    sync_complete: 0,
    sync_total: 0,
    sync_foot: "Loading sync stats...",
    verified_count: 0,
    expected_count: 0,
    verified_pct: 0,
    verified_foot: "Loading verification stats...",
    last_audit_date: "2026-05-23",
    last_audit_time: "Pending scan",
    orphaned_count: 0
  };

  const rows = tab === 'missing' ? MISSING_ASSETS : tab === 'dead' ? DEAD_URLS : ORPHANED;
  const keyOf = (r) => r.id || r.path;

  const toggle = (k) => {
    const n = new Set(selected); n.has(k) ? n.delete(k) : n.add(k); setSelected(n);
  };
  const toggleAll = () => {
    if (selected.size === rows.length) setSelected(new Set());
    else setSelected(new Set(rows.map(keyOf)));
  };

  const renderCardVal = (val, suffix = "") => {
    if (loading) return <div className="skeleton-line" style={{ width: '60%', height: 28, margin: '8px 0' }} />;
    return <div className="stat-val tnum">{val}<span className="unit">{suffix}</span></div>;
  };

  const renderCardBar = (width, isWarn = false) => {
    if (loading) return <div className="stat-bar"><div className="skeleton-pulse" style={{ width: '100%', height: '100%', borderRadius: 99 }} /></div>;
    return <div className="stat-bar"><i className={isWarn ? "warn" : ""} style={{ width: `${width}%` }} /></div>;
  };

  const renderCardFoot = (foot) => {
    if (loading) return <div className="skeleton-line" style={{ width: '80%', height: 12, marginTop: 6 }} />;
    return <div className="stat-foot">{foot}</div>;
  };

  const renderTableContent = () => {
    if (loading) {
      return Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="row" style={{ display: 'flex', alignItems: 'center', height: 48, padding: '0 16px', borderBottom: '1px solid var(--border)' }}>
          <div className="skeleton-box" style={{ width: 16, height: 16, marginRight: 16, flexShrink: 0 }} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="skeleton-line" style={{ width: '45%', height: 14 }} />
            <div className="skeleton-line" style={{ width: '30%', height: 10 }} />
          </div>
          <div className="skeleton-line" style={{ width: '20%', height: 14, marginRight: 24 }} />
          <div className="skeleton-line" style={{ width: '10%', height: 14, marginRight: 24 }} />
          <div className="skeleton-box" style={{ width: 60, height: 24 }} />
        </div>
      ));
    }

    if (error) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '64px 24px', color: 'var(--badge-broken)', textAlign: 'center' }}>
          <div style={{ color: 'var(--badge-broken)', display: 'inline-flex', width: 36, height: 36, marginBottom: 12 }}>{window.ic.warning}</div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Connection failed</div>
          <div className="mono" style={{ fontSize: 12, marginTop: 4, opacity: 0.8 }}>{error}</div>
          <button className="small-btn" style={{ marginTop: 16 }} onClick={() => fetchAudit(true)}>Retry Connection</button>
        </div>
      );
    }

    if (rows.length === 0) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '64px 24px', color: 'var(--muted)', textAlign: 'center' }}>
          <div style={{ color: 'oklch(0.72 0.15 152)', display: 'inline-flex', width: 36, height: 36, marginBottom: 12 }}>{window.ic.checkCircle}</div>
          <div style={{ fontWeight: 500, fontSize: 14, color: 'var(--fg)' }}>All clear! No issues found.</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>This segment of your archive is in pristine health.</div>
        </div>
      );
    }

    if (tab === 'missing') {
      return (
        <>
          <div className="row hd miss">
            <Checkbox checked={rows.length && selected.size === rows.length} onChange={toggleAll} />
            <span>Game</span><span>Missing</span><span>Source</span><span>Size</span><span></span>
          </div>
          {MISSING_ASSETS.map((r) => (
            <div key={r.id} className="row miss">
              <Checkbox checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
              <div>
                <div style={{ fontWeight: 500 }}>{r.title}</div>
                <div className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>#{r.id} · flagged {r.age} ago</div>
              </div>
              <span className={'bdg ' + (r.missing === 'zip' ? 'local' : r.missing === 'screenshots' ? 'shots' : 'broken')}
                    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 'auto', height: 20, padding: '0 8px', borderRadius: 4, fontSize: 10.5, gap: 4 }}>
                {r.missing}
              </span>
              {r.source.startsWith('http') ? (
                <a href={r.source} target="_blank" rel="noopener noreferrer" className="path" title={r.source} style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                  {r.source}
                </a>
              ) : (
                <span className="path" title={r.source}>{r.source}</span>
              )}
              <span className="mono" style={{ color: 'var(--muted)' }}>{r.size}</span>
              <button className="small-btn">Fetch</button>
            </div>
          ))}
        </>
      );
    }

    if (tab === 'dead') {
      return (
        <>
          <div className="row hd dead">
            <Checkbox checked={rows.length && selected.size === rows.length} onChange={toggleAll} />
            <span>Game</span><span>URL</span><span>Status</span><span></span>
          </div>
          {DEAD_URLS.map((r) => (
            <div key={r.id} className="row dead">
              <Checkbox checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
              <div>
                <div style={{ fontWeight: 500 }}>{r.title}</div>
                <div className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>#{r.id} · checked {r.checked}</div>
              </div>
              <a href={r.url} target="_blank" rel="noopener noreferrer" className="url-dead" title={r.url} style={{ textDecoration: 'line-through', color: 'var(--badge-broken)' }}>
                {r.url}
              </a>
              <span className="mono" style={{ color: 'var(--badge-broken)', fontSize: 11 }}>{r.code}</span>
              <button className="small-btn">Edit URL</button>
            </div>
          ))}
        </>
      );
    }

    if (tab === 'orph') {
      return (
        <>
          <div className="row hd orph">
            <Checkbox checked={rows.length && selected.size === rows.length} onChange={toggleAll} />
            <span>Local Path</span><span>Size</span><span>Modified</span><span></span>
          </div>
          {ORPHANED.map((r) => (
            <div key={r.path} className="row orph">
              <Checkbox checked={selected.has(r.path)} onChange={() => toggle(r.path)} />
              <span className="path" title={r.path}>{r.path}</span>
              <span className="mono" style={{ color: 'var(--muted)' }}>{r.size}</span>
              <span className="mono" style={{ color: 'var(--muted)' }}>{r.modified}</span>
              <button className="small-btn">Reveal</button>
            </div>
          ))}
        </>
      );
    }
  };

  return (
    <>
      <style>{`
        @keyframes pulse-opacity {
          0%, 100% { opacity: 0.6; }
          50% { opacity: 0.25; }
        }
        .skeleton-line {
          background: var(--border);
          border-radius: 4px;
          animation: pulse-opacity 1.5s infinite ease-in-out;
        }
        .skeleton-box {
          background: var(--border);
          border-radius: 4px;
          animation: pulse-opacity 1.5s infinite ease-in-out;
        }
        .skeleton-pulse {
          background: var(--border);
          animation: pulse-opacity 1.5s infinite ease-in-out;
        }
      `}</style>

      <div className="topbar">
        <button className="iconbtn mobile-menu-btn" onClick={() => window.toggleSidebar && window.toggleSidebar()} title="Toggle menu">
          {window.ic.menu}
        </button>
        <span className="crumb"><b>Archive Health</b><span>/</span>Audits</span>
        <div className="tb-spacer" />
        <button className="iconbtn" title="Re-run audit" onClick={() => fetchAudit(true)} disabled={loading}>
          {window.ic.refresh}
        </button>
        <button className="iconbtn" title="Toggle theme" onClick={() => setTweak('dark', !tweaks.dark)}>
          {tweaks.dark ? window.ic.sun : window.ic.moon}
        </button>
      </div>

      <div className="dash-wrap">
        <div className="stat-row">
          <div className="stat">
            <div className="stat-label">Local Storage</div>
            {renderCardVal(stats.storage_used, " GB")}
            {renderCardBar(stats.storage_pct)}
            {renderCardFoot(stats.storage_foot)}
          </div>
          <div className="stat">
            <div className="stat-label">Asset Sync Rate</div>
            {renderCardVal(stats.sync_rate, "%")}
            {renderCardBar(stats.sync_rate)}
            {renderCardFoot(stats.sync_foot)}
          </div>
          <div className="stat">
            <div className="stat-label">Screenshot Verification</div>
            {loading ? (
              renderCardVal("Loading...")
            ) : (
              <div className="stat-val tnum">
                {stats.verified_count.toLocaleString()}
                <span className="unit"> / {stats.expected_count.toLocaleString()}</span>
              </div>
            )}
            {renderCardBar(stats.verified_pct, stats.verified_pct < 100)}
            {renderCardFoot(stats.verified_foot)}
          </div>
          <div className="stat">
            <div className="stat-label">Last Audit</div>
            <div className="stat-val tnum" style={{ fontSize: 18 }}>
              {loading ? <div className="skeleton-line" style={{ width: '70%', height: 22, margin: '6px 0' }} /> : stats.last_audit_date}
            </div>
            <div className="stat-foot">
              {loading ? <div className="skeleton-line" style={{ width: '90%', height: 12, marginTop: 6 }} /> : stats.last_audit_time}
            </div>
          </div>
        </div>

        <div className="audit-tabs">
          <button className={tab === 'missing' ? 'on' : ''} onClick={() => setTab('missing')} disabled={loading && !auditData}>
            Missing Assets
            <span className="ct">{loading && !auditData ? "..." : (auditData ? auditData.missing_assets.length : 0)}</span>
          </button>
          <button className={tab === 'dead' ? 'on' : ''} onClick={() => setTab('dead')} disabled={loading && !auditData}>
            Dead URLs
            <span className="ct">{loading && !auditData ? "..." : (auditData ? auditData.dead_urls.length : 0)}</span>
          </button>
          <button className={tab === 'orph' ? 'on' : ''} onClick={() => setTab('orph')} disabled={loading && !auditData}>
            Orphaned Files
            <span className="ct">{loading && !auditData ? "..." : stats.orphaned_count}</span>
          </button>
        </div>

        <div className="audit-toolbar">
          <span className="mono" style={{ color: 'var(--muted)', fontSize: 11.5 }}>
            {selected.size} selected · {loading && !auditData ? "..." : rows.length} total shown
          </span>
          <div style={{ flex: 1 }} />
          {tab === 'missing' && (
            <button className="btn-primary" disabled={!selected.size || loading}>
              {window.ic.download} Download Selected Assets
            </button>
          )}
          {tab === 'dead' && (
            <button className="btn-primary" disabled={!selected.size || loading}>
              {window.ic.refresh} Re-verify Selected
            </button>
          )}
          {tab === 'orph' && (
            <button className="btn-primary" disabled={!selected.size || cleaning || loading} onClick={handleCleanup}>
              {cleaning ? "Cleaning..." : <>{window.ic.x} Safe Clean Up ({selected.size})</>}
            </button>
          )}
        </div>

        <div className="dtable">
          {renderTableContent()}
        </div>
      </div>
    </>
  );
}

function Checkbox({ checked, onChange }) {
  return (
    <label className={'check' + (checked ? ' on' : '')} style={{ padding: 0, margin: 0, width: 'auto' }} onClick={onChange}>
      <span className="box" />
    </label>
  );
}

Object.assign(window, { HealthView, Checkbox });
