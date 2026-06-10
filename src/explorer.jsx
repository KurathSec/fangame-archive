// Explorer view — search + filters + cards grid / list.

function DualRange({ min, max, step, value, onChange, format }) {
  // Two-handle slider rendered manually so we can show the colored fill range.
  const trackRef = React.useRef(null);
  const dragRef = React.useRef(null);
  const range = max - min;
  const [lo, hi] = value;
  const loPct = ((lo - min) / range) * 100;
  const hiPct = ((hi - min) / range) * 100;

  const [localLo, setLocalLo] = React.useState(String(lo));
  const [localHi, setLocalHi] = React.useState(String(hi));

  React.useEffect(() => {
    setLocalLo(String(lo));
  }, [lo]);

  React.useEffect(() => {
    setLocalHi(String(hi));
  }, [hi]);

  const onDown = (which) => (e) => {
    e.preventDefault();
    dragRef.current = which;
    const onMove = (ev) => {
      if (!trackRef.current) return;
      const r = trackRef.current.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      let v = min + pct * range;
      v = Math.round(v / step) * step;
      v = Number(v.toFixed(((String(step).split('.')[1] || '').length)));
      if (dragRef.current === 'lo') onChange([Math.min(v, hi), hi]);
      else onChange([lo, Math.max(v, lo)]);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const handleInputChange = (which, valStr) => {
    if (which === 'lo') {
      setLocalLo(valStr);
      const val = parseFloat(valStr);
      if (!isNaN(val)) {
        const clamped = Math.max(min, Math.min(hi, val));
        onChange([clamped, hi]);
      }
    } else {
      setLocalHi(valStr);
      const val = parseFloat(valStr);
      if (!isNaN(val)) {
        const clamped = Math.max(lo, Math.min(max, val));
        onChange([lo, clamped]);
      }
    }
  };

  const handleBlur = (which) => {
    if (which === 'lo') {
      setLocalLo(String(lo));
    } else {
      setLocalHi(String(hi));
    }
  };

  return (
    <>
      <div className="range" ref={trackRef}>
        <div className="range-track" />
        <div className="range-fill" style={{ left: loPct + '%', right: (100 - hiPct) + '%' }} />
        <div className="range-handle" style={{ left: loPct + '%' }} onPointerDown={onDown('lo')} />
        <div className="range-handle" style={{ left: hiPct + '%' }} onPointerDown={onDown('hi')} />
      </div>
      <div className="range-labels" style={{ alignItems: 'center' }}>
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={localLo}
          onChange={(e) => handleInputChange('lo', e.target.value)}
          onBlur={() => handleBlur('lo')}
          className="range-input"
        />
        <span className="range-separator">to</span>
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={localHi}
          onChange={(e) => handleInputChange('hi', e.target.value)}
          onBlur={() => handleBlur('hi')}
          className="range-input"
        />
      </div>
    </>
  );
}

function Card({ game, active, onClick }) {
  return (
    <div className={'card' + (active ? ' active' : '')} onClick={onClick}>
      <div className="card-thumb">
        <div className="card-thumb-grid" />
        <div className="card-thumb-glyph">{game.title[0]}</div>
        <div className="card-thumb-id mono">#{game.id}</div>
        <div className="card-thumb-badges">
          {game.flags.local  && <span className="bdg local" title="Archived locally">{window.ic.hdd}</span>}
          {game.flags.shots  && <span className="bdg shots" title="Screenshots downloaded">{window.ic.cam}</span>}
          {game.flags.perf   && <span className="bdg perf"  title="Perfected / Deathless">{window.ic.trophy}</span>}
          {game.flags.broken && <span className="bdg broken" title="Link broken">{window.ic.broken}</span>}
        </div>
      </div>
      <div className="card-body">
        <div className="card-title">{game.title}</div>
        <div className="card-creator">by <a href="#" onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (window.setCreatorSearch) {
            window.setCreatorSearch(game.creator);
          }
        }}>{game.creator}</a></div>
        <div className="card-metrics">
          <span className="metric rating">{window.ic.star}<span className="tnum">{game.rating !== null ? game.rating.toFixed(1) : 'N/A'}</span></span>
          <span className="metric diff">{window.ic.flame}<span className="tnum">{game.difficulty !== null ? game.difficulty : 'N/A'}</span></span>
          <span style={{ marginLeft: 'auto', opacity: 0.55 }}>{game.reviews} rev</span>
        </div>
      </div>
    </div>
  );
}

function formatSize(bytes) {
  if (!bytes) return "—";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function ListRow({ game, active, onClick }) {
  return (
    <div className={'list-row' + (active ? ' active' : '')} onClick={onClick}>
      <span className="list-id">#{game.id}</span>
      <span className="list-title">{game.title}</span>
      <span className="list-creator">
        <a href="#" onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (window.setCreatorSearch) {
            window.setCreatorSearch(game.creator);
          }
        }} className="list-creator-link">{game.creator}</a>
      </span>
      <span className="list-num list-rating">{game.rating !== null ? game.rating.toFixed(1) : 'N/A'}</span>
      <span className="list-num list-diff">{game.difficulty !== null ? game.difficulty : 'N/A'}</span>
      <span className="list-num list-size">{formatSize(game.file_size)}</span>
      <span className="list-badges">
        {game.flags.local  && <span className="bdg local">{window.ic.hdd}</span>}
        {game.flags.shots  && <span className="bdg shots">{window.ic.cam}</span>}
        {game.flags.perf   && <span className="bdg perf">{window.ic.trophy}</span>}
        {game.flags.broken && <span className="bdg broken">{window.ic.broken}</span>}
      </span>
    </div>
  );
}

function getPageNumbers(current, total) {
  const pages = [];
  const maxButtons = 7;
  if (total <= maxButtons) {
    for (let i = 1; i <= total; i++) pages.push(i);
  } else {
    if (current <= 4) {
      for (let i = 1; i <= 5; i++) pages.push(i);
      pages.push('...');
      pages.push(total);
    } else if (current >= total - 3) {
      pages.push(1);
      pages.push('...');
      for (let i = total - 4; i <= total; i++) pages.push(i);
    } else {
      pages.push(1);
      pages.push('...');
      pages.push(current - 1);
      pages.push(current);
      pages.push(current + 1);
      pages.push('...');
      pages.push(total);
    }
  }
  return pages;
}

function Explorer({ tweaks, setTweak, onOpenGame, activeId }) {
  const [searchTitle, setSearchTitle]     = React.useState('');
  const [searchCreator, setSearchCreator] = React.useState('');
  const [rating, setRating]   = React.useState([0.0, 10.0]);
  const [diff,   setDiff]     = React.useState([0, 100]);
  const [tags,   setTags]     = React.useState(new Map());
  const [showAllTags, setShowAllTags] = React.useState(false);

  const [flags,  setFlags]    = React.useState({ local: false, shots: false, missing: false });
  const [sort,   setSort]     = React.useState('rating');
  const [desc,   setDesc]     = React.useState(true);
  const [page,   setPage]     = React.useState(1);
  const [tagSearch, setTagSearch] = React.useState('');

  const handleSortChange = (newSort) => {
    setSort(newSort);
    if (newSort === 'id' || newSort === 'title') {
      setDesc(false);
    } else {
      setDesc(true);
    }
  };
  const [filtersOpen, setFiltersOpen] = React.useState(false);

  const PAGE_SIZE = 100;
  const gridWrapRef = React.useRef(null);

  const view = 'list';

  const flagCounts = React.useMemo(() => {
    let local = 0, shots = 0, missing = 0;
    window.DATA.GAMES.forEach(g => {
      if (g.flags.local) local++;
      if (g.flags.shots) shots++;
      if (g.flags.missing) missing++;
    });
    return { local, shots, missing };
  }, []);

  const toggleTag = (t) => {
    const nextTags = new Map(tags);
    if (!nextTags.has(t)) {
      nextTags.set(t, 'or');
    } else if (nextTags.get(t) === 'or') {
      nextTags.set(t, 'and');
    } else if (nextTags.get(t) === 'and') {
      nextTags.set(t, 'not');
    } else {
      nextTags.delete(t);
    }
    setTags(nextTags);
  };

  const toggleFlag = (k) => setFlags((f) => ({ ...f, [k]: !f[k] }));

  const sortedFilteredTags = React.useMemo(() => {
    const q = tagSearch.trim().toLowerCase();
    const sortedAllTags = [...window.DATA.TAGS].sort((a, b) => b.count - a.count);
    
    if (q || showAllTags) {
      const selected = sortedAllTags.filter(t => tags.has(t.name));
      const unselected = sortedAllTags.filter(t => !tags.has(t.name) && (!q || t.name.toLowerCase().includes(q)));
      return [...selected, ...unselected];
    } else {
      const top15 = sortedAllTags.slice(0, 15);
      const extraSelected = sortedAllTags.filter(t => tags.has(t.name) && !top15.some(x => x.name === t.name));
      const combined = [...top15, ...extraSelected];
      
      const selected = combined.filter(t => tags.has(t.name));
      const unselected = combined.filter(t => !tags.has(t.name));
      return [...selected, ...unselected];
    }
  }, [tags, tagSearch, showAllTags]);

  const filtered = React.useMemo(() => {
    const qTitle = searchTitle.trim().toLowerCase();
    const qCreator = searchCreator.trim().toLowerCase();
    return window.DATA.GAMES.filter((g) => {
      if (qTitle && !g.title.toLowerCase().includes(qTitle)) return false;
      if (qCreator && !g.creator.toLowerCase().includes(qCreator)) return false;
      
      if (g.rating === null) {
        if (rating[0] > 0.0) return false;
      } else {
        if (g.rating < rating[0] || g.rating > rating[1]) return false;
      }

      if (g.difficulty === null) {
        if (diff[0] > 0) return false;
      } else {
        if (g.difficulty < diff[0] || g.difficulty > diff[1]) return false;
      }
      
      if (tags.size) {
        const orTags = [];
        const andTags = [];
        const notTags = [];
        tags.forEach((mode, tName) => {
          if (mode === 'or') orTags.push(tName);
          else if (mode === 'and') andTags.push(tName);
          else if (mode === 'not') notTags.push(tName);
        });
        
        if (orTags.length && !g.tags.some((t) => orTags.includes(t))) return false;
        if (andTags.length && !andTags.every((t) => g.tags.includes(t))) return false;
        if (notTags.length && g.tags.some((t) => notTags.includes(t))) return false;
      }
      
      if (flags.local     && !g.flags.local) return false;
      if (flags.shots     && !g.flags.shots) return false;
      if (flags.missing   && !g.flags.missing) return false;
      return true;
    }).sort((a, b) => {
      let comparison = 0;
      switch (sort) {
        case 'id':     comparison = a.id - b.id; break;
        case 'title':  comparison = a.title.localeCompare(b.title); break;
        case 'rating': {
          if (a.rating === null && b.rating === null) {
            comparison = 0;
          } else if (a.rating === null) {
            comparison = desc ? -1 : 1;
          } else if (b.rating === null) {
            comparison = desc ? 1 : -1;
          } else {
            comparison = a.rating - b.rating;
          }
          break;
        }
        case 'diff': {
          if (a.difficulty === null && b.difficulty === null) {
            comparison = 0;
          } else if (a.difficulty === null) {
            comparison = desc ? -1 : 1;
          } else if (b.difficulty === null) {
            comparison = desc ? 1 : -1;
          } else {
            comparison = a.difficulty - b.difficulty;
          }
          break;
        }
        case 'size':   comparison = (a.file_size || 0) - (b.file_size || 0); break;
        case 'rev':    comparison = (a.reviews || 0) - (b.reviews || 0); break;
        default:       comparison = 0;
      }
      return desc ? -comparison : comparison;
    });
  }, [searchTitle, searchCreator, rating, diff, tags, flags, sort, desc]);

  React.useEffect(() => {
    setPage(1);
  }, [searchTitle, searchCreator, rating, diff, tags, flags, sort, desc]);


  React.useEffect(() => {
    if (gridWrapRef.current) {
      gridWrapRef.current.scrollTop = 0;
    }
  }, [page]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1;

  const pagedItems = React.useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, page]);

  const rollRandom = () => {
    if (filtered.length === 0) return;
    const randomIndex = Math.floor(Math.random() * filtered.length);
    const randomGame = filtered[randomIndex];
    onOpenGame(randomGame, true);
  };

  React.useEffect(() => {
    window.rollRandomGame = rollRandom;
    return () => {
      if (window.rollRandomGame === rollRandom) {
        window.rollRandomGame = null;
      }
    };
  }, [filtered, onOpenGame]);

  React.useEffect(() => {
    window.setCreatorSearch = (creatorName) => {
      if (window.setView) {
        window.setView('explorer');
      }
      setSearchCreator(creatorName);
      setSearchTitle('');
      setPage(1);
    };
    return () => {
      if (window.setCreatorSearch) {
        window.setCreatorSearch = null;
      }
    };
  }, []);

  return (
    <>
      <div className="topbar">
        <button className="iconbtn mobile-menu-btn" onClick={() => window.toggleSidebar && window.toggleSidebar()} title="Toggle menu">
          {window.ic.menu}
        </button>
        <span className="crumb"><b>{window.t('library')}</b><span>/</span>{window.t('browse_games')}</span>
        <div className="search search-title-input" style={{ marginRight: '8px', maxWidth: '240px' }}>
          {React.cloneElement(window.ic.search, { className: 's-icon' })}
          <input value={searchTitle} onChange={(e) => setSearchTitle(e.target.value)} placeholder={window.t('search_title')} />
          {searchTitle ? <button className="search-clear" onClick={() => setSearchTitle('')}>{window.ic.x}</button> : null}
        </div>
        <div className="search search-creator-input" style={{ maxWidth: '240px' }}>
          {React.cloneElement(window.ic.search, { className: 's-icon' })}
          <input value={searchCreator} onChange={(e) => setSearchCreator(e.target.value)} placeholder={window.t('search_author')} />
          {searchCreator ? <button className="search-clear" onClick={() => setSearchCreator('')}>{window.ic.x}</button> : null}
        </div>

        <div className="tb-spacer" />
        {window.LanguageSelector && <window.LanguageSelector />}
        <button className="iconbtn" title={window.t('toggle_theme')} onClick={() => setTweak('dark', !tweaks.dark)}>
          {tweaks.dark ? window.ic.sun : window.ic.moon}
        </button>
      </div>

      <div className="toolbar">
        <span className="lbl">{window.t('sort_by')}</span>
        <div style={{ display: 'inline-flex', alignItems: 'center' }}>
          <select className="sel" value={sort} onChange={(e) => handleSortChange(e.target.value)}>
            <option value="id">{window.t('sort_id')}</option>
            <option value="title">{window.t('sort_title')}</option>
            <option value="rating">{window.t('sort_rating')}</option>
            <option value="diff">{window.t('sort_difficulty')}</option>
            <option value="size">{window.t('sort_size')}</option>
            <option value="rev">{window.t('sort_reviews')}</option>
          </select>
          <button 
            className="iconbtn sort-dir-btn" 
            onClick={() => setDesc(!desc)} 
            title={desc ? window.t('sort_descending') : window.t('sort_ascending')}
            style={{
              marginLeft: '6px',
              background: 'var(--panel-active)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              width: '32px',
              height: '32px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: 'var(--fg)',
              transition: 'all 0.15s ease',
              padding: 0
            }}
          >
            {desc ? (
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" style={{ width: '14px', height: '14px' }}>
                <path d="M4 3v10M4 13l-3-3M4 13l3-3M8 4h6M8 8h4M8 12h2" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" style={{ width: '14px', height: '14px' }}>
                <path d="M4 13V3M4 3L1 6M4 3l3 3M8 4h2M8 8h4M8 12h6" />
              </svg>
            )}
          </button>
        </div>

        <button
          className="btn-roll"
          onClick={rollRandom}
          disabled={filtered.length === 0}
          title={window.t('pick_random_title')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          {window.ic.dice} {window.t('roll_random')}
        </button>

        <button
          className={`iconbtn mobile-filter-btn${filtersOpen ? ' active' : ''}`}
          onClick={() => setFiltersOpen(!filtersOpen)}
          title={window.t('toggle_filters')}
        >
          {window.ic.list}
        </button>

        <div className="tb-spacer" />
        <span className="mono" style={{ color: 'var(--muted)', fontSize: 11.5 }}>
          {window.t('games_count', { filtered: filtered.length, total: window.DATA.GAMES.length })}
        </span>
      </div>

      <div className="content">
        {filtersOpen && <div className="filterpane-scrim-mobile" onClick={() => setFiltersOpen(false)} />}
        <aside className={`filterpane${filtersOpen ? ' mobile-open' : ''}`}>
          <div className="fp-section">
            <h4>{window.t('rating')} <span className="reset" onClick={() => setRating([0, 10])}>{window.t('reset')}</span></h4>
            <DualRange min={0} max={10} step={0.1} value={rating} onChange={setRating} format={(v) => v.toFixed(1)} />
          </div>
          <div className="fp-section">
            <h4>{window.t('difficulty')} <span className="reset" onClick={() => setDiff([0, 100])}>{window.t('reset')}</span></h4>
            <DualRange min={0} max={100} step={1} value={diff} onChange={setDiff} format={(v) => String(v)} />
          </div>
          <div className="fp-section">
            <h4>
              <span>{window.t('tags_count', { count: tags.size })}</span>
              {showAllTags && (
                <span className="shrink-btn" onClick={() => setShowAllTags(false)} style={{ cursor: 'pointer', color: 'var(--accent)', textTransform: 'none', fontWeight: 400, fontSize: '11px' }}>
                  {window.t('shrink')}
                </span>
              )}
              <span className="reset" onClick={() => { setTags(new Map()); setTagSearch(''); setShowAllTags(false); }}>
                {window.t('reset')}
              </span>
            </h4>

            <div className="tag-search">
              <input
                value={tagSearch}
                onChange={(e) => setTagSearch(e.target.value)}
                placeholder={window.t('search_tags')}
                className="tag-search-input"
              />
              {tagSearch && (
                <button className="tag-search-clear" onClick={() => setTagSearch('')}>
                  {window.ic.x}
                </button>
              )}
            </div>
            <div style={{ fontSize: '10.5px', color: 'var(--muted)', marginTop: '4px', marginBottom: '8px', paddingLeft: '2px' }}>
              {window.t('tag_instruction')}
            </div>

            <div className="tag-cloud">
              {sortedFilteredTags.map((t) => {
                const mode = tags.get(t.name);
                let tagClass = 'tag';
                let prefix = '';
                if (mode === 'or') {
                  tagClass += ' tag-or on';
                } else if (mode === 'and') {
                  tagClass += ' tag-and on';
                  prefix = '+ ';
                } else if (mode === 'not') {
                  tagClass += ' tag-not on';
                  prefix = '- ';
                }
                return (
                  <span key={t.name} className={tagClass} onClick={() => toggleTag(t.name)}>
                    {prefix}{t.name}<span className="ct">{t.count.toLocaleString()}</span>
                  </span>
                );
              })}
              {!tagSearch.trim() && !showAllTags && window.DATA.TAGS.length > sortedFilteredTags.length && (
                <span
                  className="tag tag-show-all"
                  onClick={() => setShowAllTags(true)}
                  style={{
                    cursor: 'pointer',
                    background: 'var(--panel-active)',
                    border: '1px dashed var(--accent)',
                    color: 'var(--accent)'
                  }}
                >
                  {window.t('show_all_dots')}
                </span>
              )}
            </div>

          </div>
          <div className="fp-section">
            <h4>{window.t('archive_flags')}</h4>
            <div className="checklist">
              {[
                ['local',     window.t('archived_locally'),       flagCounts.local.toLocaleString()],
                ['shots',     window.t('has_screenshots'),        flagCounts.shots.toLocaleString()],
                ['missing',   window.t('missing_assets_flag'),         flagCounts.missing.toLocaleString()],
              ].map(([k, label, ct]) => (
                <label key={k} className={'check' + (flags[k] ? ' on' : '')} onClick={() => toggleFlag(k)}>
                  <span className="box" />
                  <span>{label}</span>
                  <span className="ct mono">{ct}</span>
                </label>
              ))}
            </div>
          </div>
        </aside>

        <div className="grid-wrap" ref={gridWrapRef}>
          {view === 'grid' ? (
            <div className="grid">
              {pagedItems.map((g) => <Card key={g.id} game={g} active={g.id === activeId} onClick={() => onOpenGame(g)} />)}
            </div>
          ) : (
            <div className="list">
              <div className="list-head">
                <span className="list-id">{window.t('sort_id')}</span>
                <span className="list-title">{window.t('sort_title')}</span>
                <span className="list-creator">{window.t('creator_header')}</span>
                <span className="list-num list-rating">{window.t('rating')}</span>
                <span className="list-num list-diff">{window.t('difficulty')}</span>
                <span className="list-num list-size">{window.t('size_header')}</span>
                <span className="list-badges">{window.t('archive_header')}</span>
              </div>
              {pagedItems.map((g) => <ListRow key={g.id} game={g} active={g.id === activeId} onClick={() => onOpenGame(g)} />)}
            </div>
          )}

          {totalPages > 1 && (
            <div className="pagination">
              <button
                className="pg-btn"
                disabled={page === 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                title={window.t('prev_page')}
              >
                {window.ic.arrow_l}
              </button>
              {getPageNumbers(page, totalPages).map((p, idx) =>
                p === '...' ? (
                  <span key={`dots-${idx}`} className="pg-dots">
                    ...
                  </span>
                ) : (
                  <button
                    key={p}
                    className={`pg-btn${p === page ? ' active' : ''}`}
                    onClick={() => setPage(p)}
                  >
                    {p}
                  </button>
                )
              )}
              <button
                className="pg-btn"
                disabled={page === totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                title={window.t('next_page')}
              >
                {window.ic.arrow_r}
              </button>

              <div className="pg-jump" style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: '12px' }}>
                <span style={{ fontSize: '11px', color: 'var(--muted)' }}>{window.t('go_to')}</span>
                <input
                  type="text"
                  placeholder={page}
                  style={{
                    width: '36px',
                    height: '24px',
                    padding: '0 4px',
                    textAlign: 'center',
                    background: 'var(--panel)',
                    border: '1px solid var(--border)',
                    borderRadius: '5px',
                    color: 'var(--fg)',
                    fontFamily: 'var(--font-sans)',
                    fontSize: '11.5px',
                    outline: 'none',
                    transition: 'border-color 0.15s ease'
                  }}
                  onFocus={(e) => { e.target.style.borderColor = 'var(--accent)'; }}
                  onBlur={(e) => { e.target.style.borderColor = 'var(--border)'; }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const val = parseInt(e.target.value, 10);
                      if (!isNaN(val) && val >= 1 && val <= totalPages) {
                        setPage(val);
                        e.target.value = '';
                      } else {
                        e.target.style.borderColor = 'var(--badge-broken)';
                        setTimeout(() => {
                           e.target.style.borderColor = 'var(--border)';
                        }, 1000);
                      }
                    }
                  }}
                />
                <span style={{ fontSize: '11px', color: 'var(--muted)' }}>{window.t('page_jump_of', { total: totalPages })}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

Object.assign(window, { Explorer, DualRange, Card, ListRow });
