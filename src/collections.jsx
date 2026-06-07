// Personal Collections / playlists view.

function CollectionsView({ tweaks, setTweak }) {
  const [activeId, setActiveId] = React.useState(window.DATA.COLLECTIONS[0].id);
  const [order, setOrder] = React.useState({});
  const [dragIdx, setDragIdx] = React.useState(null);
  const [overIdx, setOverIdx] = React.useState(null);

  const col = window.DATA.COLLECTIONS.find((c) => c.id === activeId);
  const localOrder = order[col.id] || col.games;
  const games = localOrder.map((gid) => window.DATA.GAMES.find((g) => g.id === gid)).filter(Boolean);

  const onDragStart = (i) => () => setDragIdx(i);
  const onDragOver = (i) => (e) => { e.preventDefault(); setOverIdx(i); };
  const onDrop = (i) => (e) => {
    e.preventDefault();
    if (dragIdx == null || dragIdx === i) { setDragIdx(null); setOverIdx(null); return; }
    const next = [...localOrder];
    const [moved] = next.splice(dragIdx, 1);
    next.splice(i, 0, moved);
    setOrder({ ...order, [col.id]: next });
    setDragIdx(null); setOverIdx(null);
  };
  const onDragEnd = () => { setDragIdx(null); setOverIdx(null); };

  return (
    <>
      <div className="topbar">
        <button className="iconbtn mobile-menu-btn" onClick={() => window.toggleSidebar && window.toggleSidebar()} title="Toggle menu">
          {window.ic.menu}
        </button>
        <span className="crumb"><b>Collections</b><span>/</span>{col.name}</span>
        <div className="tb-spacer" />
        <button className="iconbtn" title="Toggle theme" onClick={() => setTweak('dark', !tweaks.dark)}>
          {tweaks.dark ? window.ic.sun : window.ic.moon}
        </button>
      </div>
      <div className="col-layout">
        <aside className="col-list">
          <h4>My Collections <span className="add">+ new</span></h4>
          {window.DATA.COLLECTIONS.map((c) => (
            <div key={c.id} className={'col-item' + (c.id === activeId ? ' on' : '')} onClick={() => setActiveId(c.id)}>
              <span className="col-swatch" style={{ background: c.color }} />
              <span className="col-name">{c.name}</span>
              <span className="col-count">{c.games.length}</span>
            </div>
          ))}
          <div style={{ marginTop: 12, padding: '8px 10px', fontSize: 11, color: 'var(--muted)', lineHeight: 1.55 }}>
            <div className="mono" style={{ marginBottom: 4, color: 'var(--text-soft)' }}>~/.archive/collections.json</div>
            Collections export to a portable JSON file you can share or sync across machines.
          </div>
        </aside>

        <main className="col-work">
          <header className="col-hd">
            <span className="swatch-lg" style={{ background: col.color }} />
            <div>
              <h2>{col.name}</h2>
              <p>{col.desc}</p>
            </div>
            <div className="actions">
              <button className="btn-secondary">Share config</button>
              <button className="btn-primary">{window.ic.plus} Add games</button>
            </div>
          </header>

          <div className="col-table">
            <div className="col-row hd">
              <span></span>
              <span></span>
              <span>#</span>
              <span>Game</span>
              <span>Note</span>
              <span></span>
            </div>
            {games.map((g, i) => (
              <div
                key={g.id}
                className={'col-row' + (dragIdx === i ? ' dragging' : '') + (overIdx === i && dragIdx != null && dragIdx !== i ? ' dragover' : '')}
                draggable
                onDragStart={onDragStart(i)}
                onDragOver={onDragOver(i)}
                onDrop={onDrop(i)}
                onDragEnd={onDragEnd}
              >
                <span className="grip">{window.ic.drag}</span>
                <label className="check" style={{ padding: 0, margin: 0 }}><span className="box" /></label>
                <span className="num">{String(i + 1).padStart(2, '0')}</span>
                <div>
                  <div className="gtitle">{g.title}</div>
                  <div className="gcreator">by {g.creator} · <span className="mono">★ {g.rating !== null ? g.rating.toFixed(1) : 'N/A'}</span> · <span className="mono">diff {g.difficulty !== null ? g.difficulty : 'N/A'}</span></div>
                </div>
                <input className="note" defaultValue={col.notes[g.id] || ''} placeholder="Add a note..." />
                <button className="small-btn" style={{ width: 26, padding: 0, display: 'grid', placeItems: 'center' }}>{window.ic.x}</button>
              </div>
            ))}
            {!games.length && (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)' }}>No games in this collection yet.</div>
            )}
          </div>

          <div style={{ marginTop: 14, display: 'flex', gap: 8, fontSize: 12, color: 'var(--muted)' }}>
            <span className="mono">{games.length} games</span>
            <span>·</span>
            <span className="mono">{games.reduce((s, g) => s + g.hours, 0).toFixed(1)}h logged</span>
            <span>·</span>
            <span className="mono">avg diff {(() => {
              const ratedGames = games.filter(g => g.difficulty !== null);
              return ratedGames.length ? Math.round(ratedGames.reduce((s, g) => s + g.difficulty, 0) / ratedGames.length) : '—';
            })()}</span>
          </div>
        </main>
      </div>
    </>
  );
}

Object.assign(window, { CollectionsView });
