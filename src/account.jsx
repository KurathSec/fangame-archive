// Account views — game submission form, My Content (submissions + comments),
// and the in-drawer comment editor. Mock data persists to localStorage.

// ── Mock data store ──────────────────────────────────────────────────────────
function seedMyData(identity) {
  const G = (window.DATA && window.DATA.GAMES) || [];
  const pick = (i) => G[(i * 137) % Math.max(G.length, 1)] || { title: 'Untitled', id: 0 };

  let subs = null, cmts = null;
  try { subs = JSON.parse(localStorage.getItem('archive_my_submissions')); } catch (e) {}
  try { cmts = JSON.parse(localStorage.getItem('archive_my_comments')); } catch (e) {}

  if (!subs) {
    subs = [
      { id: 's1', title: 'Spike Cathedral Remix', author: identity.nick, url: 'https://example.com/spike-cathedral.zip',
        tags: ['needle', 'remix'], status: 'approved', time: '2026-06-02 14:21' },
      { id: 's2', title: 'Avoidance of the Lost Moon', author: identity.nick, url: 'https://files.example.org/lostmoon.exe',
        tags: ['avoidance', 'boss'], status: 'pending', time: '2026-06-06 09:48' },
      { id: 's3', title: 'I Wanna Be The Placeholder', author: identity.nick, url: 'http://deadlink.invalid/game',
        tags: ['adventure'], status: 'rejected', time: '2026-05-28 22:03',
        reason: 'The external URL returned HTTP 404 during verification. Please re-upload to a working host and resubmit.' },
    ];
    try { localStorage.setItem('archive_my_submissions', JSON.stringify(subs)); } catch (e) {}
  }
  if (!cmts) {
    cmts = [
      { id: 'c1', game: pick(3).title, snippet: 'Brilliant save placement — the second half ramps up perfectly. Cleared in about 4 hours.',
        rating: 8, status: 'approved', time: '2026-06-04 18:30' },
      { id: 'c2', game: pick(7).title, snippet: 'The final boss pattern feels unfair on the third phase, but otherwise a solid map.',
        rating: 6, status: 'pending', time: '2026-06-07 11:12' },
      { id: 'c3', game: pick(11).title, snippet: 'spam comment removed',
        rating: 0, status: 'rejected', time: '2026-05-30 03:44',
        reason: 'Comment flagged as low-effort / off-topic by a moderator.' },
    ];
    try { localStorage.setItem('archive_my_comments', JSON.stringify(cmts)); } catch (e) {}
  }
  return { subs, cmts };
}

function addSubmission(sub) {
  let subs = [];
  try { subs = JSON.parse(localStorage.getItem('archive_my_submissions')) || []; } catch (e) {}
  subs.unshift(sub);
  try { localStorage.setItem('archive_my_submissions', JSON.stringify(subs)); } catch (e) {}
}

// ── Daily quota helper ───────────────────────────────────────────────────────
function getQuota(key, max) {
  const today = new Date().toISOString().slice(0, 10);
  let rec = { date: today, used: 0 };
  try {
    const saved = JSON.parse(localStorage.getItem('archive_quota_' + key));
    if (saved && saved.date === today) rec = saved;
  } catch (e) {}
  return { used: rec.used, left: Math.max(0, max - rec.used), max };
}
function consumeQuota(key, max) {
  const today = new Date().toISOString().slice(0, 10);
  const q = getQuota(key, max);
  const next = { date: today, used: q.used + 1 };
  try { localStorage.setItem('archive_quota_' + key, JSON.stringify(next)); } catch (e) {}
}

const TopBar = ({ crumb }) => (
  <div className="topbar">
    <button className="iconbtn mobile-menu-btn" onClick={() => window.toggleSidebar && window.toggleSidebar()} title="Toggle menu">
      {window.ic.menu}
    </button>
    <span className="crumb"><b>Library</b><span>/</span>{crumb}</span>
  </div>
);

// ── Login gate (shown when logged out) ──────────────────────────────────────
function LoginGate({ icon, title, sub, onOpenLogin }) {
  return (
    <div className="login-gate">
      <div className="lg-ic">{icon || window.ic2.lock}</div>
      <h3>{title}</h3>
      <p>{sub}</p>
      <button className="doc-btn accent" onClick={onOpenLogin}>{window.ic2.login} Login to continue</button>
    </div>
  );
}

// ── Game Submission form ────────────────────────────────────────────────────
function SubmitGameView({ auth, identity, onOpenLogin }) {
  const POPULAR = React.useMemo(() => ((window.DATA && window.DATA.TAGS) || []).slice(0, 16).map((t) => t.name), []);
  const [form, setForm] = React.useState({ name: '', url: '', desc: '' });
  const [authors, setAuthors] = React.useState([identity?.nick || '']);
  const [tags, setTags] = React.useState([]);
  const [custom, setCustom] = React.useState('');
  const [shots, setShots] = React.useState(['']);
  const [verified, setVerified] = React.useState(false);
  const [touched, setTouched] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [done, setDone] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (identity?.nick) {
      setAuthors((as) => {
        const next = [...as];
        if (next[0] === '' || next[0] === identity.nick) {
          next[0] = identity.nick;
        }
        return next;
      });
    }
  }, [identity]);

  const quota = getQuota('submit', 5);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const urlValid = !form.url || /^https?:\/\/.+\..+/.test(form.url.trim());
  const nameValid = form.name.trim().length >= 2;
  const authorValid = authors.some((a) => a.trim().length >= 1);

  const toggleTag = (t) => {
    if (!tags.includes(t) && tags.length >= 10) {
      window.pushToast('Limit reached', 'You can select at most 10 tags.', 'warn');
      return;
    }
    setTags((cur) => cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]);
  };

  const addCustom = () => {
    const t = custom.trim().toLowerCase().replace(/\s+/g, '-');
    if (!t) return;
    if (t.length > 20) {
      window.pushToast('Tag too long', 'Tags must be 20 characters or less.', 'warn');
      return;
    }
    if (tags.length >= 10) {
      window.pushToast('Limit reached', 'You can select at most 10 tags.', 'warn');
      return;
    }
    if (!tags.includes(t)) setTags((cur) => [...cur, t]);
    setCustom('');
  };

  const customTags = tags.filter((t) => !POPULAR.includes(t));
  const setAuthor = (i, v) => setAuthors((as) => as.map((x, j) => j === i ? v : x));
  const setShot = (i, v) => setShots((s) => s.map((x, j) => j === i ? v : x));

  const submit = async () => {
    setTouched(true);
    setErr('');
    if (!nameValid) { setErr('Game name is required (min 2 characters).'); return; }
    if (!authorValid) { setErr('At least one creator/author name is required.'); return; }
    if (!form.url.trim() || !urlValid) { setErr('A valid external URL (http/https) is required.'); return; }
    if (!verified) { setErr('Please complete the verification challenge.'); return; }
    if (quota.left <= 0) { setErr('Daily submission limit reached (5/5). Try again tomorrow.'); window.pushToast('Limit reached', 'You have used all 5 submissions today', 'warn'); return; }

    setSubmitting(true);
    try {
      let headers = {
        'Content-Type': 'application/json'
      };
      if (typeof Clerk !== 'undefined' && Clerk.session) {
        const token = await Clerk.session.getToken();
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
      }

      const res = await fetch('/api/submissions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: form.name.trim(),
          author_name: authors.filter(Boolean).map(a => a.trim()).join(', '),
          external_url: form.url.trim(),
          tags: tags,
          description: form.desc.trim() || null,
          screenshots: shots.filter(Boolean).map(s => s.trim()),
          turnstile_token: verified
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP error ${res.status}`);
      }

      consumeQuota('submit', 5);
      window.pushToast('Submission received', form.name.trim() + ' is pending review', 'success');
      setDone(true);
    } catch (e) {
      setErr(e.message || 'Failed to submit game.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>
      <TopBar crumb="Submit a Game" />
      <div className="docview">
        <div className="doc" style={{ maxWidth: 680 }}>
          <div className="doc-head">
            <h1 className="doc-title"><span className="doc-title-ic">{window.ic2.upload}</span>Submit a Game</h1>
            <p className="doc-sub">
              Found a fangame missing from the archive? Submit it for review. Approved entries are crawled,
              mirrored, and added to the public catalog.
            </p>
          </div>

          {auth === 'out' ? (
            <LoginGate title="Login required" sub="You need an account to submit games to the archive. Submissions are tied to your profile and subject to a daily limit." onOpenLogin={onOpenLogin} />
          ) : done ? (
            <div className="submit-banner">
              <div className="sb-ic">{window.ic.check}</div>
              <div>
                <h3>Submission submitted, pending review</h3>
                <p>Thanks! <b>{form.name.trim()}</b> is now in the moderation queue. You can track its status under <b>My Content → My Submissions</b>. Most submissions are reviewed within 48 hours.</p>
                <div className="sb-actions">
                  <button className="doc-btn" onClick={() => { setForm({ name: '', url: '', desc: '' }); setAuthors([identity?.nick || '']); setTags([]); setShots(['']); setVerified(false); setTouched(false); setDone(false); }}>
                    {window.ic.plus} Submit another
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="form-card">
              <div className="form-card-body">
                <div className="field">
                  <label className="field-label">Game Name <span className="req">*</span></label>
                  <input className={'field-input' + (touched && !nameValid ? ' invalid' : '')} value={form.name}
                         placeholder="e.g. I Wanna Be The Guy" onChange={(e) => set('name', e.target.value)} />
                  {touched && !nameValid && <span className="field-err">{window.ic.warning} Enter at least 2 characters</span>}
                </div>

                <div className="field">
                  <label className="field-label">Author Name(s) <span className="req">*</span></label>
                  {authors.map((a, i) => (
                    <div className="shot-link-row" key={i} style={{ marginBottom: i < authors.length - 1 ? 8 : 0 }}>
                      <input className={'field-input' + (touched && !a.trim() ? ' invalid' : '')} value={a} placeholder={i === 0 ? "Original creator" : "Co-creator / Collaborator"}
                             onChange={(e) => setAuthor(i, e.target.value)} />
                      {authors.length > 1 && (
                        <button className="icon-x-btn" type="button" title="Remove" onClick={() => setAuthors((as) => as.filter((_, j) => j !== i))}>{window.ic.x}</button>
                      )}
                    </div>
                  ))}
                  {authors.length < 5 && (
                    <button className="chip-add" type="button" style={{ marginTop: 8 }} onClick={() => setAuthors((as) => [...as, ''])}>{window.ic.plus} Add another author</button>
                  )}
                  {touched && !authorValid && <span className="field-err">{window.ic.warning} Enter at least one creator name</span>}
                </div>

                <div className="field">
                  <label className="field-label">External URL <span className="req">*</span></label>
                  <input className={'field-input mono' + (touched && !urlValid ? ' invalid' : '')} value={form.url}
                         placeholder="https://host.example.com/game.zip" onChange={(e) => set('url', e.target.value)} />
                  {touched && !urlValid
                    ? <span className="field-err">{window.ic.warning} Must start with http:// or https:// and be a valid URL</span>
                    : <span className="field-help">Direct download or game page. Dead links are auto-detected during review.</span>}
                </div>

                <div className="field">
                  <label className="field-label">Tags <span className="opt">optional</span></label>
                  <div className="chip-picker">
                    {POPULAR.map((t) => (
                      <button key={t} type="button" className={'tag' + (tags.includes(t) ? ' on' : '')} onClick={() => toggleTag(t)}>{t}</button>
                    ))}
                    {customTags.map((t) => (
                      <span key={t} className="tag on custom">{t}
                        <button className="tag-x" type="button" title="Remove" onClick={() => toggleTag(t)}>{window.ic.x}</button>
                      </span>
                    ))}
                    <span className="tag-input-wrap">
                      <input className="tag-input" value={custom} placeholder="add tag…" maxLength={20}
                             onChange={(e) => setCustom(e.target.value)}
                             onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } }} />
                      <button className="tag-input-add" type="button" title="Add tag" disabled={!custom.trim()} onClick={addCustom}>{window.ic.plus}</button>
                    </span>
                  </div>
                  <span className="field-help">{tags.length}/10 selected — pick all that apply (max 10 tags, 20 chars per tag).</span>
                </div>

                <div className="field">
                  <label className="field-label">Description <span className="opt">optional</span><span className="field-counter">{form.desc.length}/500</span></label>
                  <textarea className="field-textarea" value={form.desc} maxLength={500} rows={4}
                            placeholder="Briefly describe the game — genre, length, notable features…"
                            onChange={(e) => set('desc', e.target.value)} />
                </div>

                <div className="field">
                  <label className="field-label">Screenshot Links <span className="opt">optional</span></label>
                  {shots.map((s, i) => (
                    <div className="shot-link-row" key={i}>
                      <input className="field-input mono" value={s} placeholder="https://i.example.com/shot.png"
                             onChange={(e) => setShot(i, e.target.value)} />
                      {shots.length > 1 && (
                        <button className="icon-x-btn" type="button" title="Remove" onClick={() => setShots((ss) => ss.filter((_, j) => j !== i))}>{window.ic.x}</button>
                      )}
                    </div>
                  ))}
                  {shots.length < 5 && (
                    <button className="chip-add" type="button" style={{ marginTop: 8 }} onClick={() => setShots((s) => [...s, ''])}>{window.ic.plus} Add another link</button>
                  )}
                </div>

                <div className="field">
                  <label className="field-label">Verification <span className="req">*</span></label>
                  <window.Turnstile verified={verified} onVerify={setVerified} />
                </div>
              </div>

              {err && <div className="form-err-banner" style={{ marginBottom: 16 }}>{window.ic.warning} {err}</div>}

              <div className="form-foot">
                <button className="btn-submit" onClick={submit} disabled={quota.left <= 0 || submitting}>
                  {submitting ? <window.Spinner light={true} /> : window.ic2.upload} <span>Submit for review</span>
                </button>
                <span className={'quota' + (quota.left <= 1 ? ' low' : '')}>
                  Remaining today: <b>{quota.left}/{quota.max}</b>
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── My Content ──────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const map = { approved: 'Approved', pending: 'Pending', rejected: 'Rejected' };
  return <span className={'st-badge ' + status}><span className="d" />{map[status] || status}</span>;
}

function RecordRow({ rec, kind }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="rec-row">
      <div className="rec-top">
        <div className="rec-main">
          {kind === 'sub' ? (
            <>
              <div className="rec-title">{rec.title}</div>
              <div className="rec-snippet"><span className="on-game">by {rec.author} · </span><span className="mono" style={{ fontSize: 11.5 }}>{rec.url}</span></div>
            </>
          ) : (
            <>
              <div className="rec-snippet">“{rec.snippet}”</div>
              <div className="rec-snippet on-game" style={{ marginTop: 4 }}>on {rec.game}{rec.rating ? ' · rated ' + rec.rating + '/10' : ''}</div>
            </>
          )}
          <div className="rec-time">{window.ic.log} {rec.time}
            {kind === 'sub' && rec.tags && rec.tags.length > 0 && <span>· {rec.tags.join(', ')}</span>}
          </div>
          {rec.status === 'rejected' && rec.reason && (
            <>
              <button className={'rec-expand' + (open ? ' open' : '')} onClick={() => setOpen((o) => !o)}>
                {window.ic.chevron} {open ? 'Hide' : 'View'} reason for rejection
              </button>
              {open && <div className="rec-reason"><b>Rejected:</b> {rec.reason}</div>}
            </>
          )}
        </div>
        <StatusBadge status={rec.status} />
      </div>
    </div>
  );
}

function MyContentView({ auth, identity, onOpenLogin }) {
  const [tab, setTab] = React.useState('subs');
  const [phase, setPhase] = React.useState('loading'); // loading | ready | error
  const [data, setData] = React.useState({ subs: [], cmts: [] });

  const load = React.useCallback(async () => {
    setPhase('loading');
    try {
      let headers = {};
      if (typeof Clerk !== 'undefined' && Clerk.session) {
        const token = await Clerk.session.getToken();
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
      }

      const [subsRes, cmtsRes] = await Promise.all([
        fetch('/api/me/submissions', { headers }),
        fetch('/api/me/comments', { headers })
      ]);

      if (!subsRes.ok || !cmtsRes.ok) {
        throw new Error("Failed to load user contributions.");
      }

      const [subsData, cmtsData] = await Promise.all([
        subsRes.json(),
        cmtsRes.json()
      ]);

      const mappedComments = (cmtsData.comments || []).map(c => {
        const game = window.DATA && window.DATA.GAMES && window.DATA.GAMES.find(g => g.id === c.game_id);
        return {
          id: c.id,
          game: game ? game.title : `Game #${c.game_id}`,
          snippet: c.snippet,
          rating: c.rating,
          status: c.status,
          time: c.time
        };
      });

      setData({
        subs: subsData.submissions || [],
        cmts: mappedComments
      });
      setPhase('ready');
    } catch (e) {
      console.error(e);
      setPhase('error');
    }
  }, [identity]);

  React.useEffect(() => { if (auth !== 'out') load(); }, [auth, load]);

  const rows = tab === 'subs' ? data.subs : data.cmts;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>
      <TopBar crumb="My Content" />
      <div className="docview">
        <div className="doc" style={{ maxWidth: 680 }}>
          <div className="doc-head">
            <h1 className="doc-title"><span className="doc-title-ic">{window.ic2.inbox}</span>My Content</h1>
            <p className="doc-sub">Track the status of everything you've contributed — submitted games and posted reviews.</p>
          </div>

          {auth === 'out' ? (
            <LoginGate icon={window.ic2.inbox} title="Sign in to view your content" sub="Your submissions and comments live here once you're logged in." onOpenLogin={onOpenLogin} />
          ) : (
            <>
              <div className="mc-tabs">
                <button className={'mc-tab' + (tab === 'subs' ? ' on' : '')} onClick={() => setTab('subs')}>
                  {window.ic2.upload} My Submissions {phase === 'ready' && <span className="ct">{data.subs.length}</span>}
                </button>
                <button className={'mc-tab' + (tab === 'cmts' ? ' on' : '')} onClick={() => setTab('cmts')}>
                  {window.ic.mail} My Comments {phase === 'ready' && <span className="ct">{data.cmts.length}</span>}
                </button>
              </div>

              {phase === 'loading' && <window.SkeletonList rows={3} />}
              {phase === 'error' && <window.ErrorState sub="Couldn't load your content. Check your connection and try again." onRetry={load} />}
              {phase === 'ready' && rows.length === 0 && (
                <window.EmptyState
                  icon={tab === 'subs' ? window.ic2.upload : window.ic.mail}
                  title={tab === 'subs' ? 'No submissions yet' : 'No comments yet'}
                  sub={tab === 'subs' ? 'Games you submit for review will appear here.' : 'Reviews you post on game pages will appear here.'} />
              )}
              {phase === 'ready' && rows.map((r) => <RecordRow key={r.id} rec={r} kind={tab === 'subs' ? 'sub' : 'cmt'} />)}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Draggable slider ─────────────────────────────────────────────────────────
function DragSlider({ value, min, max, step, onChange, accent, glow, format, ticks }) {
  const trackRef = React.useRef(null);
  const [drag, setDrag] = React.useState(false);
  const pct = ((value - min) / (max - min)) * 100;

  const valueFromX = (clientX) => {
    const el = trackRef.current;
    if (!el) return value;
    const r = el.getBoundingClientRect();
    let t = (clientX - r.left) / r.width;
    t = Math.max(0, Math.min(1, t));
    let v = min + t * (max - min);
    v = Math.round(v / step) * step;
    v = Math.max(min, Math.min(max, v));
    // clean float noise
    return parseFloat(v.toFixed(2));
  };

  const onDown = (e) => {
    e.preventDefault();
    setDrag(true);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
    onChange(valueFromX(e.clientX));
  };
  const onMove = (e) => { if (drag) onChange(valueFromX(e.clientX)); };
  const onUp = (e) => { setDrag(false); try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) {} };
  const onKey = (e) => {
    const big = (max - min) / 20;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { onChange(parseFloat(Math.min(max, value + step).toFixed(2))); e.preventDefault(); }
    if (e.key === 'ArrowLeft'  || e.key === 'ArrowDown') { onChange(parseFloat(Math.max(min, value - step).toFixed(2))); e.preventDefault(); }
    if (e.key === 'PageUp')   { onChange(parseFloat(Math.min(max, value + big).toFixed(2))); e.preventDefault(); }
    if (e.key === 'PageDown') { onChange(parseFloat(Math.max(min, value - big).toFixed(2))); e.preventDefault(); }
  };

  return (
    <div className={'rng-track' + (drag ? ' drag' : '')} ref={trackRef} role="slider" tabIndex={0}
         aria-valuemin={min} aria-valuemax={max} aria-valuenow={value}
         style={{ '--rng-accent': accent, '--rng-glow': glow }}
         onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onKeyDown={onKey}>
      <div className="rng-rail" />
      <div className="rng-fill" style={{ width: pct + '%' }} />
      <div className="rng-thumb" style={{ left: pct + '%' }} />
    </div>
  );
}

// ── Editable number readout ──────────────────────────────────────────────────
function ValEdit({ value, min, max, step, unit, onChange }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const inputRef = React.useRef(null);
  React.useEffect(() => { if (editing && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); } }, [editing]);
  const decimals = (String(step).split('.')[1] || '').length;
  const commit = () => {
    let v = parseFloat(draft);
    if (isNaN(v)) { setEditing(false); return; }
    v = Math.max(min, Math.min(max, Math.round(v / step) * step));
    onChange(parseFloat(v.toFixed(decimals)));
    setEditing(false);
  };
  if (editing) {
    return (
      <span className="rng-val editing">
        <input ref={inputRef} className="rng-val-input" type="number" inputMode="decimal"
               min={min} max={max} step={step} value={draft}
               onChange={(e) => setDraft(e.target.value)} onBlur={commit}
               onKeyDown={(e) => {
                 if (e.key === 'Enter') { e.preventDefault(); commit(); }
                 if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
               }} />
        <span className="unit"> / {unit}</span>
      </span>
    );
  }
  return (
    <span className="rng-val editable" title="Click to type a value" onClick={() => { setDraft(value.toFixed(decimals)); setEditing(true); }}>
      <span className="rng-val-num">{value.toFixed(decimals)}</span><span className="unit"> / {unit}</span>
    </span>
  );
}

const DIFF_WORD = (d) => d < 12 ? 'Easy' : d < 30 ? 'Medium' : d < 55 ? 'Hard' : d < 80 ? 'Very Hard' : 'Extreme';
const DIFF_COLOR = (d) => d < 12 ? 'oklch(0.60 0.14 152)' : d < 30 ? 'oklch(0.62 0.13 100)' : d < 55 ? 'oklch(0.68 0.15 70)' : d < 80 ? 'oklch(0.62 0.17 35)' : 'oklch(0.55 0.20 18)';

// ── In-drawer comment editor ────────────────────────────────────────────────
function CommentEditor({ auth, identity, gameId, onOpenLogin, onPosted }) {
  const POPULAR = React.useMemo(() => ((window.DATA && window.DATA.TAGS) || []).slice(0, 10).map((t) => t.name), []);
  const [rating, setRating] = React.useState(0);
  const [diff, setDiff] = React.useState(0);
  const [hasReview, setHasReview] = React.useState(false);
  const [tags, setTags] = React.useState([]);
  const [custom, setCustom] = React.useState('');
  const [body, setBody] = React.useState('');
  const [verified, setVerified] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  if (auth === 'out') {
    return (
      <div className="cmt-login-line">
        {window.ic2.lock} Log in to comment
        <button className="cmt-login-btn" onClick={onOpenLogin}>{window.ic2.login} Login</button>
      </div>
    );
  }

  const quota = getQuota('comment', 20);
  const toggleTag = (t) => {
    if (!tags.includes(t) && tags.length >= 10) {
      window.pushToast('Limit reached', 'You can select at most 10 tags.', 'warn');
      return;
    }
    setTags((cur) => cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]);
  };
  const addCustom = () => {
    const t = custom.trim().toLowerCase().replace(/\s+/g, '-');
    if (!t) return;
    if (t.length > 20) {
      window.pushToast('Tag too long', 'Tags must be 20 characters or less.', 'warn');
      return;
    }
    if (tags.length >= 10) {
      window.pushToast('Limit reached', 'You can select at most 10 tags.', 'warn');
      return;
    }
    if (!tags.includes(t)) setTags((cur) => [...cur, t]);
    setCustom('');
  };
  const customTags = tags.filter((t) => !POPULAR.includes(t));

  const post = async () => {
    setErr('');
    if (body.trim().length < 4) { setErr('Comment is too short.'); return; }
    if (!verified) { setErr('Complete the verification challenge first.'); return; }
    if (quota.left <= 0) { setErr('Daily comment limit reached (20/20).'); window.pushToast('Limit reached', 'No comments left today', 'warn'); return; }
    
    setSubmitting(true);
    try {
      let headers = {
        'Content-Type': 'application/json'
      };
      if (typeof Clerk !== 'undefined' && Clerk.session) {
        const token = await Clerk.session.getToken();
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
      }

      const res = await fetch('/api/comments', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          game_id: parseInt(gameId, 10),
          rating: hasReview ? parseFloat(rating) : null,
          difficulty: hasReview ? parseFloat(diff) : null,
          content: body.trim(),
          tags: tags,
          turnstile_token: verified
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP error ${res.status}`);
      }

      consumeQuota('comment', 20);
      window.pushToast('Comment posted', 'Pending review — visible only to you for now', 'success');
      onPosted && onPosted();
      setRating(0); setDiff(0); setTags([]); setCustom(''); setBody(''); setVerified(false); setHasReview(false);
    } catch (e) {
      setErr(e.message || 'Failed to post comment.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="cmt-editor">
      <h5 style={{ margin: '0 0 12px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>Write a review</h5>

      <label className="switch-wrap">
        <input
          type="checkbox"
          checked={hasReview}
          onChange={(e) => setHasReview(e.target.checked)}
          className="switch-input"
        />
        <div className="switch-track">
          <div className="switch-thumb" />
        </div>
        <span className="switch-label">Include rating and difficulty</span>
      </label>

      {hasReview && (
        <div className="cmt-editor-grid" style={{ flexDirection: 'column', gap: 16, marginTop: 12 }}>
          <div className="rng" style={{ width: '100%' }}>
            <div className="rng-head">
              <span className="rng-label">Rating</span>
              <ValEdit value={rating} min={0} max={10} step={0.1} unit="10" onChange={setRating} />
            </div>
            <DragSlider value={rating} min={0} max={10} step={0.1}
                        accent="oklch(0.74 0.14 80)" glow="oklch(0.92 0.06 80 / 0.6)"
                        onChange={setRating} />
            <div className="rng-ticks"><span>0.0</span><span>5.0</span><span>10.0</span></div>
          </div>

          <div className="rng" style={{ width: '100%' }}>
            <div className="rng-head">
              <span className="rng-label">Difficulty</span>
              <span className="diff-word" style={{ color: DIFF_COLOR(diff), borderColor: 'currentColor' }}>{DIFF_WORD(diff)}</span>
              <ValEdit value={diff} min={0} max={100} step={0.1} unit="100" onChange={setDiff} />
            </div>
            <DragSlider value={diff} min={0} max={100} step={0.1}
                        accent={DIFF_COLOR(diff)} glow="oklch(0.90 0.06 50 / 0.5)"
                        onChange={setDiff} />
            <div className="rng-ticks"><span>0.0</span><span>50.0</span><span>100.0</span></div>
          </div>
        </div>
      )}

      <div className="chip-picker" style={{ margin: '16px 0 11px' }}>
        {POPULAR.map((t) => (
          <button key={t} className={'tag' + (tags.includes(t) ? ' on' : '')} onClick={() => toggleTag(t)}>{t}</button>
        ))}
        {customTags.map((t) => (
          <span key={t} className="tag on custom">{t}
            <button className="tag-x" title="Remove" onClick={() => toggleTag(t)}>{window.ic.x}</button>
          </span>
        ))}
        <span className="tag-input-wrap">
          <input className="tag-input" value={custom} placeholder="add tag…" maxLength={20}
                 onChange={(e) => setCustom(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } }} />
          <button className="tag-input-add" title="Add tag" disabled={!custom.trim()} onClick={addCustom}>{window.ic.plus}</button>
        </span>
      </div>

      <textarea className="field-textarea" value={body} rows={3} placeholder="Share your thoughts on this game…"
                style={{ marginBottom: 11 }} onChange={(e) => setBody(e.target.value)} />

      <window.Turnstile verified={verified} onVerify={setVerified} />

      {err && <div className="form-err-banner" style={{ margin: '11px 0 0' }}>{window.ic.warning} {err}</div>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
        <button className="btn-submit" onClick={post} disabled={quota.left <= 0 || submitting}>
          {submitting ? <window.Spinner light={true} /> : window.ic.mail} <span>Post review</span>
        </button>
        <span className={'quota' + (quota.left <= 2 ? ' low' : '')}>Remaining today: <b>{quota.left}/{quota.max}</b></span>
      </div>
    </div>
  );
}

Object.assign(window, {
  seedMyData, addSubmission, getQuota, consumeQuota, LoginGate,
  SubmitGameView, MyContentView, StatusBadge, RecordRow, CommentEditor,
  DragSlider, DIFF_WORD, DIFF_COLOR,
});
