// Crawler Sync Console.

function CrawlerView({ tweaks, setTweak }) {
  const [running, setRunning] = React.useState(true);
  const [progress, setProgress] = React.useState(72);
  const [cfg, setCfg] = React.useState({ meta: true, reviews: true, shots: true, optimize: false });
  const bodyRef = React.useRef(null);

  // Slow progress ticker while running.
  React.useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      setProgress((p) => (p >= 99 ? 99 : p + 0.4));
    }, 500);
    return () => clearInterval(id);
  }, [running]);

  React.useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, []);

  const phase = running
    ? (progress < 25 ? { label: 'Scanning Server',     sub: 'reading index manifest' }
      : progress < 55 ? { label: 'Fetching JSON',      sub: 'paging reviews API' }
      : progress < 85 ? { label: 'Downloading Screenshots', sub: '43 jobs queued' }
      :                  { label: 'Updating Database', sub: 'writing db deltas' })
    : { label: 'Idle', sub: 'last sync 2m ago' };

  const log = window.DATA.CRAWLER_LOG;

  const renderMsg = (msg) =>
    msg.split(/(<accent>.+?<\/accent>|<num>.+?<\/num>)/).map((part, i) => {
      const a = /^<accent>(.+?)<\/accent>$/.exec(part);
      const n = /^<num>(.+?)<\/num>$/.exec(part);
      if (a) return <span key={i} className="accent">{a[1]}</span>;
      if (n) return <span key={i} className="num">{n[1]}</span>;
      return <React.Fragment key={i}>{part}</React.Fragment>;
    });

  return (
    <>
      <div className="topbar">
        <button className="iconbtn mobile-menu-btn" onClick={() => window.toggleSidebar && window.toggleSidebar()} title="Toggle menu">
          {window.ic.menu}
        </button>
        <span className="crumb"><b>Crawler</b><span>/</span>Sync Console</span>
        <div className="tb-spacer" />
        <span className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
          go-crawler · v0.7.3 · pid 41827
        </span>
        <button className="iconbtn" title="Toggle theme" onClick={() => setTweak('dark', !tweaks.dark)}>
          {tweaks.dark ? window.ic.sun : window.ic.moon}
        </button>
      </div>

      <div className="crawl">
        <div className="crawl-hd">
          <div className={'crawl-state' + (running ? '' : ' idle')}>
            <span className="lite" />
            <div>
              <div className="label">{phase.label}</div>
              <div className="sub mono">{phase.sub}</div>
            </div>
          </div>
          <div className="crawl-progress">
            <div className="pbar"><i style={{ width: progress + '%' }} /></div>
            <div className="pbar-meta">
              <span>{Math.floor(progress)}% · 1,326 / 1,842 entries</span>
              <span>418 KB/s · ETA 02:14</span>
            </div>
          </div>
          <button className={'crawl-btn' + (running ? ' stop' : '')} onClick={() => setRunning(!running)}>
            {running ? <>{window.ic.x} Stop Sync</> : <>{window.ic.play} Start Sync</>}
          </button>
        </div>

        <div className="crawl-grid">
          <aside className="crawl-cfg">
            <h5>Sync Configuration</h5>
            <div className="checklist">
              {[
                ['meta',     'Parse metadata',     '1,842 entries'],
                ['reviews',  'Fetch reviews',      '+34 since last'],
                ['shots',    'Download screenshots','43 queued'],
                ['optimize', 'Optimize JSON DB',   'final pass'],
              ].map(([k, label, sub]) => (
                <label key={k} className={'check' + (cfg[k] ? ' on' : '')} onClick={() => setCfg({ ...cfg, [k]: !cfg[k] })}>
                  <span className="box" />
                  <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.3 }}>
                    <span>{label}</span>
                    <span className="mono" style={{ color: 'var(--muted)', fontSize: 10.5 }}>{sub}</span>
                  </div>
                </label>
              ))}
            </div>

            <h5 style={{ marginTop: 18 }}>Target</h5>
            <div style={{ fontSize: 12, fontFamily: "'Geist Mono', ui-monospace, monospace", lineHeight: 1.7, color: 'var(--text-soft)' }}>
              <div><span style={{ color: 'var(--muted)' }}>host  </span>delicious-fruit-mirror.local</div>
              <div><span style={{ color: 'var(--muted)' }}>since </span>2026-05-21T08:02</div>
              <div><span style={{ color: 'var(--muted)' }}>conc  </span>6 workers</div>
              <div><span style={{ color: 'var(--muted)' }}>store </span>./archive/</div>
            </div>

            <h5 style={{ marginTop: 18 }}>Session</h5>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 12px', fontSize: 11.5 }}>
              <span style={{ color: 'var(--muted)' }}>Pages crawled</span>     <span className="mono">128</span>
              <span style={{ color: 'var(--muted)' }}>Bytes received</span>    <span className="mono">38.4 MB</span>
              <span style={{ color: 'var(--muted)' }}>Errors</span>            <span className="mono" style={{ color: 'var(--badge-broken)' }}>1</span>
              <span style={{ color: 'var(--muted)' }}>Avg latency</span>       <span className="mono">142 ms</span>
            </div>
          </aside>

          <div className="terminal">
            <header className="terminal-hd">
              <div className="dots"><i /><i /><i /></div>
              <span className="ttl">crawler.exe — live</span>
              <span className="meta">streaming · go 1.22 · GOMAXPROCS=6</span>
            </header>
            <div className="terminal-body" ref={bodyRef}>
              {log.map((l, i) => (
                <div key={i} className="t-line">
                  <span className="t-time">{l.t}</span>
                  <span className={'t-tag ' + l.tag}>{l.tag.toUpperCase()}</span>
                  <span className="t-msg">{renderMsg(l.msg)}</span>
                </div>
              ))}
              <div className="t-line">
                <span className="t-time">{new Date().toTimeString().slice(0, 8)}</span>
                <span className="t-tag info">INFO</span>
                <span className="t-msg t-cursor">{running ? 'fetching /img/3617/title.png · ' : 'awaiting next scheduled sync · '}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

Object.assign(window, { CrawlerView });
