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

// Clerk bearer headers for the API calls below.
async function apiAuthHeaders() {
  const headers = {};
  if (typeof Clerk !== 'undefined' && Clerk.session) {
    const token = await Clerk.session.getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

// ── Direct-upload constants (mirror functions/api/_lib/uploads.js) ──────────
const UP_GAME_EXTS = ['.zip', '.rar', '.7z', '.tar', '.gz', '.exe'];
const UP_GAME_MAX = 500 * 1024 * 1024;
const UP_SHOT_MAX = 8 * 1024 * 1024;
const fmtMB = (b) => (b / (1024 * 1024) >= 100 ? Math.round(b / (1024 * 1024)) : (b / (1024 * 1024)).toFixed(1)) + ' MB';

const TopBar = ({ crumb }) => (
  <div className="topbar">
    <button className="iconbtn mobile-menu-btn" onClick={() => window.toggleSidebar && window.toggleSidebar()} title="Toggle menu">
      {window.ic.menu}
    </button>
    <span className="crumb"><b>{window.t('library')}</b><span>/</span>{crumb}</span>
  </div>
);

// ── Login gate (shown when logged out) ──────────────────────────────────────
function LoginGate({ icon, title, sub, onOpenLogin }) {
  return (
    <div className="login-gate">
      <div className="lg-ic">{icon || window.ic2.lock}</div>
      <h3>{title}</h3>
      <p>{sub}</p>
      <button className="doc-btn accent" onClick={onOpenLogin}>{window.ic2.login} {window.t('login_to_continue')}</button>
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

  // Direct upload of the game file: 'url' keeps the classic link input;
  // 'upload' stages the file in R2 via a presigned PUT minted by our API.
  const [fileMode, setFileMode] = React.useState('url');
  const [up, setUp] = React.useState({ st: 'idle', pct: 0, name: '', size: 0, key: '', url: '', msg: '' });
  const [shotBusy, setShotBusy] = React.useState(-1);
  const fileInputRef = React.useRef(null);
  const shotInputRef = React.useRef(null);
  const shotSlotRef = React.useRef(0);
  const xhrRef = React.useRef(null);
  // Generation counter: bumping it strands every older upload chain — at its
  // next checkpoint the chain sees it's stale, frees its own staged object and
  // stops touching state. This is what makes the X button effective during the
  // mint and verify phases (when no XHR exists to abort).
  const upGenRef = React.useRef(0);

  const cancelStagedKey = async (key) => {
    if (!key) return;
    try {
      await fetch('/api/submissions/upload-cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await apiAuthHeaders()) },
        body: JSON.stringify({ key })
      });
    } catch (e) {}
  };

  const startUpload = async (file) => {
    if (!file) return;
    const extMatch = /\.[A-Za-z0-9]{1,6}$/.exec(file.name || '');
    const ext = extMatch ? extMatch[0].toLowerCase() : '';
    if (!UP_GAME_EXTS.includes(ext)) {
      window.pushToast(window.t('upload_bad_type'), UP_GAME_EXTS.join(' · '), 'warn');
      return;
    }
    if (file.size > UP_GAME_MAX) {
      window.pushToast(window.t('upload_too_large'), fmtMB(file.size), 'warn');
      return;
    }
    const gen = ++upGenRef.current;
    const stale = () => upGenRef.current !== gen;
    if (xhrRef.current) { try { xhrRef.current.abort(); } catch (e) {} xhrRef.current = null; }
    const prevKey = up.key;
    if (prevKey) cancelStagedKey(prevKey); // replacing — free the old staged object
    setUp({ st: 'busy', pct: 0, name: file.name, size: file.size, key: '', url: '', msg: '' });
    let key = '';
    let myXhr = null;
    try {
      const res = await fetch('/api/submissions/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await apiAuthHeaders()) },
        body: JSON.stringify({ filename: file.name, size: file.size })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      key = data.key;
      if (stale()) { cancelStagedKey(key); return; }
      setUp((u) => ({ ...u, key }));
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        myXhr = xhr;
        xhr.open('PUT', data.url);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && !stale()) setUp((u) => (u.st === 'busy' ? { ...u, pct: Math.round((e.loaded / e.total) * 100) } : u));
        };
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error(`Upload failed (HTTP ${xhr.status})`));
        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.onabort = () => reject(new Error('__aborted__'));
        xhrRef.current = xhr;
        xhr.send(file);
      });
      if (xhrRef.current === myXhr) xhrRef.current = null;
      if (stale()) { cancelStagedKey(key); return; }
      const fin = await fetch('/api/submissions/upload-complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await apiAuthHeaders()) },
        body: JSON.stringify({ key })
      });
      const finData = await fin.json().catch(() => ({}));
      if (!fin.ok || !finData.success) throw new Error(finData.error || `HTTP ${fin.status}`);
      if (stale()) { cancelStagedKey(key); return; }
      setUp({ st: 'done', pct: 100, name: file.name, size: finData.size, key, url: finData.url, msg: '' });
    } catch (e) {
      if (myXhr && xhrRef.current === myXhr) xhrRef.current = null;
      if (stale()) { if (key) cancelStagedKey(key); return; } // a newer chain/remove owns the state now
      if (key) cancelStagedKey(key);
      if (e.message === '__aborted__') {
        setUp({ st: 'idle', pct: 0, name: '', size: 0, key: '', url: '', msg: '' });
      } else {
        setUp({ st: 'err', pct: 0, name: file.name, size: file.size, key: '', url: '', msg: e.message || '' });
      }
    }
  };

  const removeUpload = () => {
    upGenRef.current++; // strand any in-flight chain (it frees its own key)
    if (xhrRef.current) { try { xhrRef.current.abort(); } catch (e) {} xhrRef.current = null; }
    const key = up.key;
    setUp({ st: 'idle', pct: 0, name: '', size: 0, key: '', url: '', msg: '' });
    if (key) cancelStagedKey(key);
  };

  const uploadShot = async (i, file) => {
    if (!file) return;
    if (file.size > UP_SHOT_MAX) {
      window.pushToast(window.t('upload_shot_too_large'), fmtMB(file.size), 'warn');
      return;
    }
    setShotBusy(i);
    try {
      const res = await fetch('/api/submissions/upload-screenshot', {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream', ...(await apiAuthHeaders()) },
        body: file
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      setShot(i, data.url);
    } catch (e) {
      window.pushToast(window.t('upload_failed'), e.message || '', 'error');
    } finally {
      setShotBusy(-1);
    }
  };

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
      window.pushToast(window.t('limit_reached_toast'), window.t('max_tags_toast_desc'), 'warn');
      return;
    }
    setTags((cur) => cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]);
  };

  const addCustom = () => {
    const t = custom.trim().toLowerCase().replace(/\s+/g, '-');
    if (!t) return;
    if (t.length > 20) {
      window.pushToast(window.t('tag_too_long_toast'), window.t('tag_too_long_toast_desc'), 'warn');
      return;
    }
    if (tags.length >= 10) {
      window.pushToast(window.t('limit_reached_toast'), window.t('max_tags_toast_desc'), 'warn');
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
    if (!nameValid) { setErr(window.t('game_name_required')); return; }
    if (!authorValid) { setErr(window.t('at_least_one_creator')); return; }
    if (fileMode === 'upload') {
      if (up.st !== 'done' || !up.url) { setErr(window.t('upload_required_error')); return; }
    } else if (!form.url.trim() || !urlValid) { setErr(window.t('url_required_error')); return; }
    if (shotBusy !== -1) { setErr(window.t('upload_shot_busy')); return; }
    if (!verified) { setErr(window.t('complete_verification_error')); return; }
    if (quota.left <= 0) { setErr(window.t('daily_limit_reached_desc')); window.pushToast(window.t('limit_reached_toast'), window.t('used_all_submissions_desc'), 'warn'); return; }

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
          external_url: fileMode === 'upload' ? up.url : form.url.trim(),
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
      // Neutralize the upload machinery: strand any in-flight chain, and free
      // a staged file only when it was NOT part of this submission (URL mode).
      // In upload mode the staged object now belongs to the pending row — the
      // merge/reject lifecycle owns it from here.
      upGenRef.current++;
      if (xhrRef.current) { try { xhrRef.current.abort(); } catch (e2) {} xhrRef.current = null; }
      if (fileMode === 'url' && up.key) cancelStagedKey(up.key);
      setUp({ st: 'idle', pct: 0, name: '', size: 0, key: '', url: '', msg: '' });
      window.pushToast(window.t('submission_received_toast'), window.t('pending_review_toast_desc', { name: form.name.trim() }), 'success');
      setDone(true);
    } catch (e) {
      setErr(e.message || window.t('failed_submit_game'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>
      <TopBar crumb={window.t('submit_game')} />
      <div className="docview">
        <div className="doc" style={{ maxWidth: 680 }}>
          <div className="doc-head">
            <h1 className="doc-title"><span className="doc-title-ic">{window.ic2.upload}</span>{window.t('submit_game')}</h1>
            <p className="doc-sub">
              Found a fangame missing from the archive? Submit it for review. Approved entries are crawled,
              mirrored, and added to the public catalog.
            </p>
          </div>

          {auth === 'out' ? (
            <LoginGate title={window.t('login_required_title')} sub={window.t('submit_game_login_desc')} onOpenLogin={onOpenLogin} />
          ) : done ? (
            <div className="submit-banner">
              <div className="sb-ic">{window.ic.check}</div>
              <div>
                <h3>{window.t('pending_review_title')}</h3>
                <p>{window.t('pending_review_desc', { name: form.name.trim() })}</p>
                <div className="sb-actions">
                  <button className="doc-btn" onClick={() => { setForm({ name: '', url: '', desc: '' }); setAuthors([identity?.nick || '']); setTags([]); setShots(['']); setVerified(false); setTouched(false); setDone(false); setFileMode('url'); setUp({ st: 'idle', pct: 0, name: '', size: 0, key: '', url: '', msg: '' }); }}>
                    {window.ic.plus} {window.t('submit_another')}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="form-card">
              <div className="form-card-body">
                <div className="field">
                  <label className="field-label">{window.t('game_name_label')} <span className="req">*</span></label>
                  <input className={'field-input' + (touched && !nameValid ? ' invalid' : '')} value={form.name}
                         placeholder="e.g. I Wanna Be The Guy" onChange={(e) => set('name', e.target.value)} />
                  {touched && !nameValid && <span className="field-err">{window.ic.warning} {window.t('enter_min_chars')}</span>}
                </div>
 
                <div className="field">
                  <label className="field-label">{window.t('creator_name_label')} <span className="req">*</span></label>
                  {authors.map((a, i) => (
                    <div className="shot-link-row" key={i} style={{ marginBottom: i < authors.length - 1 ? 8 : 0 }}>
                      <input className={'field-input' + (touched && !a.trim() ? ' invalid' : '')} value={a} placeholder={i === 0 ? window.t('original_creator_placeholder') : window.t('co_creator_placeholder')}
                             onChange={(e) => setAuthor(i, e.target.value)} />
                      {authors.length > 1 && (
                        <button className="icon-x-btn" type="button" title={window.t('remove_btn')} onClick={() => setAuthors((as) => as.filter((_, j) => j !== i))}>{window.ic.x}</button>
                      )}
                    </div>
                  ))}
                  {authors.length < 5 && (
                    <button className="chip-add" type="button" style={{ marginTop: 8 }} onClick={() => setAuthors((as) => [...as, ''])}>{window.ic.plus} {window.t('add_another_author')}</button>
                  )}
                  {touched && !authorValid && <span className="field-err">{window.ic.warning} {window.t('at_least_one_creator')}</span>}
                </div>
 
                <div className="field">
                  <label className="field-label">{window.t('download_url')} <span className="req">*</span></label>
                  <div className="upl-seg" role="tablist">
                    <button type="button" className={'upl-seg-btn' + (fileMode === 'url' ? ' on' : '')} onClick={() => setFileMode('url')}>{window.ic.link} {window.t('upload_mode_url')}</button>
                    <button type="button" className={'upl-seg-btn' + (fileMode === 'upload' ? ' on' : '')} onClick={() => setFileMode('upload')}>{window.ic2.upload} {window.t('upload_mode_file')}</button>
                  </div>
                  {fileMode === 'url' ? (
                    <React.Fragment>
                      <input className={'field-input mono' + (touched && !urlValid ? ' invalid' : '')} value={form.url}
                             placeholder="https://host.example.com/game.zip" onChange={(e) => set('url', e.target.value)} />
                      {touched && !urlValid
                        ? <span className="field-err">{window.ic.warning} {window.t('url_format_error')}</span>
                        : <span className="field-help">{window.t('url_input_help')}</span>}
                    </React.Fragment>
                  ) : (
                    <React.Fragment>
                      <input ref={fileInputRef} type="file" accept={UP_GAME_EXTS.join(',')} style={{ display: 'none' }}
                             onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; startUpload(f); }} />
                      {(up.st === 'idle' || up.st === 'err') && (
                        <button type="button" className="upl-drop" onClick={() => fileInputRef.current && fileInputRef.current.click()}>
                          {window.ic2.upload}
                          <span>{up.st === 'err' ? window.t('upload_retry') : window.t('upload_pick')}</span>
                          <em>{window.t('upload_pick_sub')}</em>
                        </button>
                      )}
                      {up.st === 'err' && <span className="field-err">{window.ic.warning} {window.t('upload_failed')}{up.msg ? ': ' + up.msg : ''}</span>}
                      {up.st === 'busy' && (
                        <div className="upl-file">
                          <div className="upl-file-head">
                            <span className="upl-name mono">{up.name}</span>
                            <span className="upl-size mono">{fmtMB(up.size)}</span>
                            <button className="icon-x-btn" type="button" title={window.t('remove_btn')} onClick={removeUpload}>{window.ic.x}</button>
                          </div>
                          <div className="upl-bar"><div className="upl-bar-fill" style={{ width: up.pct + '%' }} /></div>
                          <span className="field-help mono">{up.pct < 100 ? `${window.t('upload_uploading')} ${up.pct}%` : window.t('upload_verifying')}</span>
                        </div>
                      )}
                      {up.st === 'done' && (
                        <div className="upl-file done">
                          <div className="upl-file-head">
                            {window.ic.check}
                            <span className="upl-name mono">{up.name}</span>
                            <span className="upl-size mono">{fmtMB(up.size)}</span>
                            <button className="icon-x-btn" type="button" title={window.t('upload_remove')} onClick={removeUpload}>{window.ic.x}</button>
                          </div>
                          <span className="field-help">{window.t('upload_done_help')}</span>
                        </div>
                      )}
                      {touched && up.st !== 'done' && up.st !== 'busy' && <span className="field-err">{window.ic.warning} {window.t('upload_required_error')}</span>}
                    </React.Fragment>
                  )}
                </div>
 
                <div className="field">
                  <label className="field-label">{window.t('custom_tags')} <span className="opt">{window.t('desc_label_help')}</span></label>
                  <div className="chip-picker">
                    {POPULAR.map((t) => (
                      <button key={t} type="button" className={'tag' + (tags.includes(t) ? ' on' : '')} onClick={() => toggleTag(t)}>{t}</button>
                    ))}
                    {customTags.map((t) => (
                      <span key={t} className="tag on custom">{t}
                        <button className="tag-x" type="button" title={window.t('remove_btn')} onClick={() => toggleTag(t)}>{window.ic.x}</button>
                      </span>
                    ))}
                    <span className="tag-input-wrap">
                      <input className="tag-input" value={custom} placeholder="add tag…" maxLength={20}
                             onChange={(e) => setCustom(e.target.value)}
                             onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } }} />
                      <button className="tag-input-add" type="button" title="Add tag" disabled={!custom.trim()} onClick={addCustom}>{window.ic.plus}</button>
                    </span>
                  </div>
                  <span className="field-help">{window.t('tags_selection_help', { count: tags.length })}</span>
                </div>

                <div className="field">
                  <label className="field-label">{window.t('description_label')} <span className="opt">{window.t('desc_label_help')}</span><span className="field-counter">{form.desc.length}/500</span></label>
                  <textarea className="field-textarea" value={form.desc} maxLength={500} rows={4}
                            placeholder={window.t('desc_placeholder')}
                            onChange={(e) => set('desc', e.target.value)} />
                </div>

                <div className="field">
                  <label className="field-label">{window.t('screenshot_links_label')} <span className="opt">{window.t('desc_label_help')}</span></label>
                  <input ref={shotInputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" style={{ display: 'none' }}
                         onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; uploadShot(shotSlotRef.current, f); }} />
                  {shots.map((s, i) => (
                    <div className="shot-link-row" key={i}>
                      <input className="field-input mono" value={s} placeholder="https://i.example.com/shot.png"
                             onChange={(e) => setShot(i, e.target.value)} />
                      <button className="icon-x-btn" type="button" title={window.t('upload_shot_title')} disabled={shotBusy !== -1}
                              onClick={() => { shotSlotRef.current = i; if (shotInputRef.current) shotInputRef.current.click(); }}>
                        {shotBusy === i ? <window.Spinner /> : window.ic2.upload}
                      </button>
                      {shots.length > 1 && (
                        <button className="icon-x-btn" type="button" title={window.t('remove_btn')} disabled={shotBusy !== -1}
                                onClick={() => setShots((ss) => ss.filter((_, j) => j !== i))}>{window.ic.x}</button>
                      )}
                    </div>
                  ))}
                  {shots.length < 5 && (
                    <button className="chip-add" type="button" style={{ marginTop: 8 }} onClick={() => setShots((s) => [...s, ''])}>{window.ic.plus} {window.t('add_another_link')}</button>
                  )}
                </div>

                <div className="field">
                  <label className="field-label">Verification <span className="req">*</span></label>
                  <window.Turnstile verified={verified} onVerify={setVerified} />
                </div>
              </div>

              {err && <div className="form-err-banner" style={{ marginBottom: 16 }}>{window.ic.warning} {err}</div>}

              <div className="form-foot">
                <button className="btn-submit" onClick={submit} disabled={quota.left <= 0 || submitting || shotBusy !== -1}>
                  {submitting ? <window.Spinner light={true} /> : window.ic2.upload} <span>{window.t('submit_game_btn')}</span>
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
  const map = { approved: window.t('status_approved'), pending: window.t('status_pending'), rejected: window.t('status_rejected') };
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
              <div className="rec-snippet on-game" style={{ marginTop: 4 }}>on {rec.game}{rec.rating ? ' · ' + window.t('rating_value', { rating: rec.rating }) : ''}</div>
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
              {open && <div className="rec-reason"><b>{window.t('status_rejected')}:</b> {rec.reason}</div>}
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
      <TopBar crumb={window.t('my_content')} />
      <div className="docview">
        <div className="doc" style={{ maxWidth: 680 }}>
          <div className="doc-head">
            <h1 className="doc-title"><span className="doc-title-ic">{window.ic2.inbox}</span>{window.t('my_content')}</h1>
            <p className="doc-sub">Track the status of everything you've contributed — submitted games and posted reviews.</p>
          </div>

          {auth === 'out' ? (
            <LoginGate icon={window.ic2.inbox} title={window.t('sign_in_view_content')} sub={window.t('view_content_signin_desc')} onOpenLogin={onOpenLogin} />
          ) : (
            <>
              <div className="mc-tabs">
                <button className={'mc-tab' + (tab === 'subs' ? ' on' : '')} onClick={() => setTab('subs')}>
                  {window.ic2.upload} {window.t('my_game_submissions')} {phase === 'ready' && <span className="ct">{data.subs.length}</span>}
                </button>
                <button className={'mc-tab' + (tab === 'cmts' ? ' on' : '')} onClick={() => setTab('cmts')}>
                  {window.ic.mail} {window.t('my_reviews_comments')} {phase === 'ready' && <span className="ct">{data.cmts.length}</span>}
                </button>
              </div>

              {phase === 'loading' && <window.SkeletonList rows={3} />}
              {phase === 'error' && <window.ErrorState sub={window.t('error_load_content')} onRetry={load} />}
              {phase === 'ready' && rows.length === 0 && (
                <window.EmptyState
                  icon={tab === 'subs' ? window.ic2.upload : window.ic.mail}
                  title={tab === 'subs' ? window.t('no_submissions_title') : window.t('no_comments_title')}
                  sub={tab === 'subs' ? window.t('no_submissions_desc') : window.t('no_comments_desc')} />
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
  const [hasRating, setHasRating] = React.useState(false);
  const [hasDiff, setHasDiff] = React.useState(false);
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
          rating: hasRating ? parseFloat(rating) : null,
          difficulty: hasDiff ? parseFloat(diff) : null,
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
      setRating(0); setDiff(0); setTags([]); setCustom(''); setBody(''); setVerified(false);
      setHasRating(false); setHasDiff(false);
    } catch (e) {
      setErr(e.message || 'Failed to post comment.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="cmt-editor">
      <h5 style={{ margin: '0 0 12px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>{window.t('write_review')}</h5>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', marginBottom: 12 }}>
        <label className="switch-wrap" style={{ marginBottom: 0 }}>
          <input
            type="checkbox"
            checked={hasRating}
            onChange={(e) => setHasRating(e.target.checked)}
            className="switch-input"
          />
          <div className="switch-track">
            <div className="switch-thumb" />
          </div>
          <span className="switch-label">{window.t('include_rating')}</span>
        </label>

        <label className="switch-wrap" style={{ marginBottom: 0 }}>
          <input
            type="checkbox"
            checked={hasDiff}
            onChange={(e) => setHasDiff(e.target.checked)}
            className="switch-input"
          />
          <div className="switch-track">
            <div className="switch-thumb" />
          </div>
          <span className="switch-label">{window.t('include_difficulty')}</span>
        </label>
      </div>

      {(hasRating || hasDiff) && (
        <div className="cmt-editor-grid" style={{ flexDirection: 'column', gap: 16, marginTop: 12 }}>
          {hasRating && (
            <div className="rng" style={{ width: '100%' }}>
              <div className="rng-head">
                <span className="rng-label">{window.t('rating')}</span>
                <ValEdit value={rating} min={0} max={10} step={0.1} unit="10" onChange={setRating} />
              </div>
              <DragSlider value={rating} min={0} max={10} step={0.1}
                          accent="oklch(0.74 0.14 80)" glow="oklch(0.92 0.06 80 / 0.6)"
                          onChange={setRating} />
              <div className="rng-ticks"><span>0.0</span><span>5.0</span><span>10.0</span></div>
            </div>
          )}

          {hasDiff && (
            <div className="rng" style={{ width: '100%' }}>
              <div className="rng-head">
                <span className="rng-label">{window.t('difficulty')}</span>
                <span className="diff-word" style={{ color: DIFF_COLOR(diff), borderColor: 'currentColor' }}>{DIFF_WORD(diff)}</span>
                <ValEdit value={diff} min={0} max={100} step={0.1} unit="100" onChange={setDiff} />
              </div>
              <DragSlider value={diff} min={0} max={100} step={0.1}
                          accent={DIFF_COLOR(diff)} glow="oklch(0.90 0.06 50 / 0.5)"
                          onChange={setDiff} />
              <div className="rng-ticks"><span>0.0</span><span>50.0</span><span>100.0</span></div>
            </div>
          )}
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

      <textarea className="field-textarea" value={body} rows={3} placeholder={window.t('write_comment_placeholder')}
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
