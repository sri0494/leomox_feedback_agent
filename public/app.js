'use strict';
const $ = (s) => document.querySelector(s);
const E = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LANG = { te: 'Telugu', en: 'English', hi: 'Hindi' };
const CATS = ['Drinking water', 'Drainage & sanitation', 'Roads & facilities', 'Civil supplies & pensions', 'Office accessibility'];
const OUTS = ['completed', 'declined', 'opted_out', 'no_answer', 'busy', 'failed'];
const TABS = [['dash', 'Overview'], ['camp', 'Campaigns'], ['script', 'Script'], ['imp', 'Contacts'], ['calls', 'Calls'], ['exp', 'Feedback'], ['prov', 'System']];
const ROLE = ['VIEWER', 'MANAGER', 'ADMIN', 'SUPER_ADMIN'];

// Tab-scoped id: lives in sessionStorage (per tab, survives refresh, gone with the tab). No auth secrets are stored client-side.
const TAB = sessionStorage.getItem('lm_tab') || (() => { const t = [...crypto.getRandomValues(new Uint8Array(12))].map((x) => x.toString(16).padStart(2, '0')).join(''); sessionStorage.setItem('lm_tab', t); return t; })();
let me = null, csrf = null, idleMs = 900000, lastAct = Date.now(), lastPing = 0;
const S = { showArchived: false, tab: 'dash', camps: [], cur: null, lang: 'te', qs: null, f: { outcome: '', language: '', category: '', q: '', page: 1 }, sel: null, preview: null, msg: '' };
const can = (r) => me && ROLE.indexOf(me.role) >= ROLE.indexOf(r);
const pct = (o) => (o.value == null ? 'n/a (0 in base)' : Math.round(o.value * 100) + '% (' + o.num + '/' + o.den + ')');

async function api(path, { method = 'GET', body, raw } = {}) {
  const h = { 'X-Tab-Id': TAB };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (csrf) h['X-CSRF-Token'] = csrf;
  const r = await fetch(path, { method, headers: h, credentials: 'same-origin', body: body !== undefined ? JSON.stringify(body) : undefined });
  if (r.status === 401) { const j = await r.json().catch(() => ({})); toLogin(j.code === 'SESSION_EXPIRED' ? 'Your session has expired. Please log in again.' : ''); throw new Error('unauthenticated'); }
  if (raw) { if (!r.ok) throw new Error('Request failed'); return r.blob(); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const er = new Error(j.error || 'Request failed'); er.code = j.code; er.fields = j.fields; throw er; }
  return j;
}
function toLogin(msg) { me = null; csrf = null; S.camps = []; S.cur = null; S.sel = null; S.preview = null; S.qs = null; renderLogin(msg); }

function renderLogin(msg = '') {
  $('#app').innerHTML = `<div class="login"><div class="card"><img src="/icon-192.png" alt="LeoMox logo"><h1>LeoMox Feedback Call Agent</h1><div class="mu" style="text-align:center;font-size:13px">Sign in to continue</div>
  ${msg ? `<div class="note" role="alert">${E(msg)}</div>` : ''}<form data-form="login"><label for="em">Email</label><input id="em" type="email" autocomplete="username" required>
  <label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required><div class="row"><button class="btn p" style="width:100%">Log in</button></div><div id="lerr" class="err" role="alert"></div></form></div></div>`;
}
async function boot() {
  try { const j = await fetch('/api/auth/me', { headers: { 'X-Tab-Id': TAB }, credentials: 'same-origin' }); if (j.ok) { start(await j.json()); return; } const d = await j.json().catch(() => ({})); renderLogin(d.code === 'SESSION_EXPIRED' ? 'Your session has expired. Please log in again.' : ''); }
  catch { renderLogin('Cannot reach the server.'); }
}
async function start(info) { me = info.user; csrf = info.csrfToken; idleMs = info.idleSeconds * 1000; lastAct = Date.now(); lastPing = Date.now(); await loadCamps(); shell(); }
async function loadCamps() { S.camps = await api('/api/campaigns' + (S.showArchived ? '?archived=include' : '')); if (!S.camps.find((c) => c.id === S.cur)) S.cur = S.camps[0]?.id || null; }

function shell() {
  $('#app').innerHTML = `<header class="hdr"><img src="/icon-192.png" alt=""><div><h1>LeoMox Feedback Call Agent</h1><small>Structured outbound feedback surveys</small></div><span class="badge">MOCK TELEPHONY · no real calls</span><span class="sp"></span><small>${E(me.email)} · ${E(me.role)}</small><button class="btn" data-act="logout">Log out</button></header>
  <nav role="tablist">${TABS.map(([k, v]) => `<button role="tab" class="${S.tab === k ? 'on' : ''}" data-act="go" data-id="${k}">${v}</button>`).join('')}</nav><main><div class="row"><label for="cs">Campaign</label><select id="cs" data-chg="cur">${S.camps.map((c) => `<option value="${c.id}" ${c.id === S.cur ? 'selected' : ''}>${E(c.name)} (${E(c.status_display)})</option>`).join('') || '<option value="">No campaigns yet</option>'}</select></div><div id="msg" role="status"></div><div id="view"><div class="empty">Loading…</div></div></main>`;
  view();
}
const flash = (t, bad) => { const m = $('#msg'); if (m) m.innerHTML = t ? `<div class="note ${bad ? 'err' : ''}">${E(t)}</div>` : ''; };
async function view() {
  const v = $('#view'); if (!v) return;
  try { v.innerHTML = await V[S.tab](); } catch (e) { if (e.message !== 'unauthenticated') v.innerHTML = `<div class="card err">${E(e.message)}</div>`; }
}
const noCamp = '<div class="card empty">Select or create a campaign first (Campaigns tab).</div>';

const V = {
  async dash() {
    if (!S.cur) return noCamp;
    const a = await api(`/api/campaigns/${S.cur}/analytics`), t = a.totals, k = (n, l) => `<div class="k"><b>${n}</b><span>${l}</span></div>`;
    return `${a.mock ? '<div class="note">Figures include <b>simulated</b> calls from the mock provider.</div>' : ''}<div class="note">${E(a.note)} Collected: ${a.collected.from ? E(String(a.collected.from).slice(0, 10)) + ' to ' + E(String(a.collected.to).slice(0, 10)) : 'no calls yet'}.</div>
    <div class="row">${can('MANAGER') ? `<button class="btn p" data-act="run">▶ Run mock calls (active campaign)</button>` : ''}<span class="mu">Campaign status: <span class="pill">${E(a.campaign.status)}</span></span></div>
    <div class="grid">${k(t.eligible_contacts, 'Eligible contacts')}${k(t.attempted, 'Attempted')}${k(t.answered, 'Answered')}${k(t.completed, 'Completed')}${k(t.declined, 'Declined')}${k(t.failed, 'Failed')}${k(t.busy, 'Busy')}${k(t.no_answer, 'Unanswered')}${k(t.opted_out, 'Opted out')}</div>
    <div class="card" style="margin-top:14px"><h2>Rates (with denominators)</h2><div class="tw"><table>
    <tr><td>Answer rate (answered ÷ attempted)</td><td>${pct(a.rates.answer)}</td></tr><tr><td>Completion rate (completed ÷ answered)</td><td>${pct(a.rates.completion)}</td></tr><tr><td>Decline rate (declined ÷ answered)</td><td>${pct(a.rates.decline)}</td></tr><tr><td>Opt-out rate (opted-out ÷ answered)</td><td>${pct(a.rates.opt_out)}</td></tr>
    <tr><td>Average duration (completed calls)</td><td>${a.avg_duration_s == null ? 'n/a' : a.avg_duration_s + ' s'}</td></tr><tr><td>Retry attempts</td><td>${t.retries}</td></tr><tr><td>Suppression list (global)</td><td>${t.suppression_list}</td></tr></table></div></div>`;
  },
  async camp() {
    const canArch = can('ADMIN') || me.canArchive;
    const btn = (act, id, label, extra = '', cls = '') => `<button class="btn ${cls}" data-act="${act}" data-id="${id}" ${extra}>${label}</button>`;
    const rows = S.camps.map((c) => `<tr><td>${E(c.name)}${c.description ? `<div class="mu">${E(c.description)}</div>` : ''}</td><td><span class="pill ${c.archived ? 'wr' : c.status === 'closed' ? 'er' : ''}">${E(c.status_display)}</span></td><td>${E(c.campaign_type.replace('_', ' '))}</td><td>${LANG[c.language]}</td><td>${E(c.start_date || '–')} → ${E(c.end_date || '–')}</td><td>${E(c.window_start)}–${E(c.window_end)} IST</td><td>${c.retries}</td><td>${c.recording}</td><td>${can('MANAGER') ? `<div class="row">${c.archived ? (canArch ? btn('restore', c.id, 'Restore') : '') : `${btn('editcamp', c.id, 'Edit')}${c.status === 'draft' || c.status === 'paused' ? `<button class="btn p" data-act="status" data-id="${c.id}" data-to="active">${c.status === 'draft' ? 'Activate' : 'Resume'}</button>` : ''}${c.status === 'active' ? `<button class="btn" data-act="status" data-id="${c.id}" data-to="paused">Pause</button>` : ''}${c.status !== 'closed' ? `<button class="btn" data-act="status" data-id="${c.id}" data-to="closed">Close</button>` : ''}${btn('dup', c.id, 'Duplicate')}${canArch ? btn('archive', c.id, 'Archive', '', 'er') : ''}`}${btn('hist', c.id, 'History')}</div>` : ''}</td></tr>`).join('');
    let dry = ''; const cur = S.camps.find((x) => x.id === S.cur);
    if (cur && !cur.archived && can('MANAGER')) { const d = await api(`/api/campaigns/${S.cur}/dry-run`); dry = `<div class="card"><h2>Dry run: ${E(cur.name)}</h2><p>Pending contacts: <b>${d.pending}</b> · eligible now: <b>${d.eligible}</b> · missing permission: ${d.no_permission} · suppressed: ${d.suppressed}. Permission and suppression are re-checked immediately before every dial; uploading a list is never treated as consent.</p><div class="mu">First prompt (${LANG[d.language]}), recording ${d.recording}:</div><p>${E(d.firstPrompt)}</p></div>`; }
    return `<div class="card"><div class="row"><h2 style="margin:0">Campaigns</h2><span class="sp" style="flex:1"></span>${can('MANAGER') ? `<label><input type="checkbox" data-chg="arch" ${S.showArchived ? 'checked' : ''}> Show archived</label><button class="btn p" data-act="newcamp">Create campaign</button>` : ''}</div>${S.camps.length ? `<div class="tw"><table><tr><th>Name</th><th>Status</th><th>Type</th><th>Language</th><th>Schedule</th><th>Window</th><th>Retries</th><th>Recording</th><th></th></tr>${rows}</table></div>` : '<div class="empty">No campaigns yet.</div>'}</div>${dry}`;
  },
  async script() {
    if (!S.cur) return noCamp;
    const c = await api(`/api/campaigns/${S.cur}`); if (!S.qs || S.qs.id !== c.id) S.qs = { id: c.id, q: JSON.parse(JSON.stringify(c.questions)) };
    return `<div class="card"><h2>Question bank</h2><div class="row">${Object.entries(LANG).map(([k, v]) => `<button class="btn ${k === S.lang ? 'p' : ''}" data-act="lang" data-id="${k}">${v}</button>`).join('')}</div><div class="note">Neutral wording; respondents may skip, say not applicable, or prefer not to answer. The greeting must disclose the automated assistant and the purpose.</div>
    ${S.qs.q[S.lang].map((t, i) => `<h3>${i ? 'Question ' + i + ' · ' + CATS[i - 1] : 'Greeting, disclosure and purpose'}</h3><textarea data-q="${i}" aria-label="Prompt ${i}" ${can('MANAGER') ? '' : 'readonly'}>${E(t)}</textarea>`).join('')}
    ${can('MANAGER') ? '<div class="row"><button class="btn p" data-act="savescript">Save script (all languages)</button></div>' : ''}</div>`;
  },
  async imp() {
    if (!S.cur) return noCamp; if (!can('MANAGER')) return '<div class="card empty">Contact lists are visible to Manager role and above.</div>';
    const list = await api(`/api/campaigns/${S.cur}/contacts?pageSize=50`), p = S.preview;
    const prev = p ? `<h3>Preview</h3><div class="grid"><div class="k"><b>${p.rows.length + p.errors.length}</b><span>Rows read</span></div><div class="k"><b>${p.rows.length}</b><span>Valid</span></div><div class="k"><b>${p.errors.length}</b><span>Rejected</span></div><div class="k"><b>${p.rows.filter((r) => r.eligible).length}</b><span>Eligible to call</span></div></div>
    ${p.errors.length ? `<h3>Row errors</h3><div class="tw"><table><tr><th>Row</th><th>Problem</th><th>Data</th></tr>${p.errors.map((e) => `<tr><td>${e.row}</td><td>${E(e.error)}</td><td class="mu">${E(e.data)}</td></tr>`).join('')}</table></div><div class="row"><button class="btn" data-act="errcsv">Download error report</button></div>` : ''}
    <div class="row"><button class="btn p" data-act="doimport">Import ${p.rows.length} valid rows</button></div>` : '';
    return `<div class="card"><h2>CSV import</h2><div class="mu">Columns: mobile_number, preferred_language (te/en/hi), locality, mandal, constituency, contact_permission_status, permission_recorded_at, source.</div><div class="row"><button class="btn" data-act="tmpl">Download CSV template</button><input type="file" id="csvf" accept=".csv,text/csv" aria-label="CSV file"></div><textarea id="csv" style="min-height:120px;font-family:monospace;font-size:12px" aria-label="CSV text" placeholder="Paste CSV here"></textarea><div class="row"><button class="btn p" data-act="validate">Validate &amp; preview</button></div>${prev}</div>
    <div class="card"><h2>Contacts in campaign (${list.total}; numbers masked)</h2>${list.items.length ? `<div class="tw"><table><tr><th>Number</th><th>Lang</th><th>Locality</th><th>Permission</th><th>Status</th></tr>${list.items.map((r) => `<tr><td>${E(r.number)}</td><td>${r.language}</td><td>${E(r.locality) || '–'}</td><td>${r.permission}</td><td><span class="pill">${r.status}</span></td></tr>`).join('')}</table></div>` : '<div class="empty">No contacts imported yet.</div>'}</div>`;
  },
  async calls() {
    if (S.sel) {
      if (!can('MANAGER')) return '<div class="card empty">Call detail requires Manager role.</div>';
      const x = await api('/api/calls/' + S.sel);
      return `<button class="btn" data-act="back">← Back</button><div class="card" style="margin-top:10px"><h2>Call ${E(x.number)} ${x.is_mock ? '<span class="pill wr">mock</span>' : ''} <span class="pill">${x.outcome}</span></h2><div class="mu">${LANG[x.language]} · ${x.attempts} attempt(s) · ${x.duration_s}s · recording stored: ${x.recording_stored ? 'yes' : 'no'}</div>
      <h3>Timeline</h3><div class="tl">${x.timeline.map((t) => `<div><b>${E(t.step)}</b> — ${E(t.detail)}</div>`).join('')}</div>
      <h3>Answers and AI classification (estimates, linked to transcript evidence)</h3>${x.responses.length ? `<div class="tw"><table><tr><th>Q</th><th>Category</th><th>Summary</th><th>Sentiment</th><th>Conf.</th><th>Transcript</th></tr>${x.responses.map((r) => r.skipped ? `<tr><td>${E(r.question_id)}</td><td>${E(r.category)}</td><td colspan="4" class="mu">Skipped by respondent (kept as unknown)</td></tr>` : `<tr><td>${E(r.question_id)}</td><td>${E(r.category)}</td><td>${r.classification ? E(r.classification.issue_summary) : '<span class="pill wr">classification pending</span>'}${r.needs_review ? ' <span class="pill wr">human review</span>' : ''}</td><td>${r.classification ? E(r.classification.sentiment) : '–'}</td><td>${r.classification ? r.classification.confidence : '–'}</td><td class="mu">“${E(r.transcript)}”</td></tr>`).join('')}</table></div>` : '<div class="empty">No responses for this outcome.</div>'}</div>`;
    }
    const f = S.f, q = new URLSearchParams({ page: f.page, pageSize: 20 }); if (S.cur) q.set('campaign_id', S.cur); for (const k of ['outcome', 'language', 'category', 'q']) if (f[k]) q.set(k, f[k]);
    const d = await api('/api/calls?' + q);
    return `<div class="card"><h2>Call history</h2><div class="row"><select data-chg="f.outcome" aria-label="Outcome"><option value="">All outcomes</option>${OUTS.map((o) => `<option ${f.outcome === o ? 'selected' : ''}>${o}</option>`).join('')}</select><select data-chg="f.language" aria-label="Language"><option value="">All languages</option>${Object.entries(LANG).map(([k, v]) => `<option value="${k}" ${f.language === k ? 'selected' : ''}>${v}</option>`).join('')}</select><select data-chg="f.category" aria-label="Category"><option value="">All categories</option>${CATS.map((o) => `<option ${f.category === o ? 'selected' : ''}>${E(o)}</option>`).join('')}</select><input data-chg="f.q" placeholder="Locality, then Enter" value="${E(f.q)}" aria-label="Locality search"></div>
    ${d.items.length ? `<div class="tw"><table><tr><th>Number</th><th>Locality</th><th>Lang</th><th>Outcome</th><th>Attempts</th><th>When</th></tr>${d.items.map((x) => `<tr class="cl" tabindex="0" data-act="open" data-id="${x.id}"><td>${E(x.number)}</td><td>${E(x.locality) || '–'}</td><td>${x.language}</td><td><span class="pill ${['failed', 'opted_out'].includes(x.outcome) ? 'er' : ''}">${x.outcome}</span></td><td>${x.attempts}</td><td class="mu">${E(String(x.created_at).slice(0, 16).replace('T', ' '))}</td></tr>`).join('')}</table></div><div class="row"><button class="btn" data-act="pg" data-id="-1" ${f.page <= 1 ? 'disabled' : ''}>Previous</button><span class="mu">Page ${d.page} · ${d.total} calls</span><button class="btn" data-act="pg" data-id="1" ${d.page * d.pageSize >= d.total ? 'disabled' : ''}>Next</button></div>` : '<div class="empty">No calls match. Import contacts, activate the campaign and run mock calls.</div>'}</div>`;
  },
  async exp() {
    if (!S.cur) return noCamp;
    const a = await api(`/api/campaigns/${S.cur}/analytics`); const n = a.totals.completed;
    if (!a.collected.from) return '<div class="card empty">No feedback yet.</div>';
    return `<div class="note">${E(a.note)} Based on ${n} completed calls collected ${E(String(a.collected.from).slice(0, 10))} to ${E(String(a.collected.to).slice(0, 10))}.${a.mock ? ' Data is simulated.' : ''}</div>
    <div class="card"><h2>Reported concerns by category</h2>${CATS.map((c) => { const o = a.categories[c], p = o.answered ? o.negative_or_mixed / o.answered : 0; return `<div class="row"><span style="width:210px">${E(c)}</span><div class="bar"><i style="width:${p * 100}%"></i></div><span class="mu">${o.answered ? Math.round(p * 100) + '% (' + o.negative_or_mixed + '/' + o.answered + ') negative or mixed' : 'no classified answers'} · ${o.skipped} skipped · ${o.pending} pending</span></div>`; }).join('')}</div>
    <div class="card"><h2>Sentiment (estimate of expressed language)</h2><div class="row">${Object.entries(a.sentiment).map(([k, v]) => `<span class="pill ${k === 'uncertain' ? 'wr' : ''}">${k}: ${v}</span>`).join('')}</div></div>
    <div class="card"><h2>Human-review queue (${a.review_queue.length})</h2><div class="mu">Low confidence or possibly urgent. Not treated as verified.</div>${a.review_queue.map((r) => `<div style="margin-top:6px"><span class="pill wr">${E(r.category)}</span> conf ${r.confidence ?? 'n/a'} · “${E(r.excerpt)}”</div>`).join('') || '<div class="empty">Nothing to review.</div>'}</div>
    <div class="card"><h2>Unresolved: respondent reports no response (${a.unresolved.length})</h2>${a.unresolved.map((r) => `<div>“${E(r.excerpt)}”</div>`).join('') || '<div class="empty">None.</div>'}</div>
    <div class="row">${can('MANAGER') ? '<button class="btn p" data-act="export">Export CSV (masked numbers)</button>' : ''}<button class="btn" data-act="print">Print summary</button></div>`;
  },
  async prov() {
    const pr = await api('/api/providers'); let more = '';
    if (can('ADMIN')) {
      const [au, us] = await Promise.all([api('/api/audit'), api('/api/users')]);
      const mgr = (r) => me.role === 'SUPER_ADMIN' || (me.role === 'ADMIN' && ['MANAGER', 'VIEWER'].includes(r));
      more = `<div class="card"><div class="row"><h2 style="margin:0">Users</h2><span style="flex:1"></span><button class="btn p" data-act="newuser">Create user</button></div><div class="tw"><table><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Campaign access</th><th></th></tr>${us.map((u) => `<tr><td>${E(u.name)}</td><td>${E(u.email)}</td><td>${u.role}${u.can_archive ? ' <span class="pill">may archive</span>' : ''}</td><td><span class="pill ${u.status === 'disabled' ? 'er' : u.status === 'invited' ? 'wr' : ''}">${u.status}</span></td><td>${u.campaign_scope}</td><td>${mgr(u.role) || u.id === me.id ? `<div class="row"><button class="btn" data-act="uedit" data-id="${u.id}">Edit</button>${u.id !== me.id && mgr(u.role) ? `${u.status === 'disabled' ? `<button class="btn" data-act="uen" data-id="${u.id}">Enable</button>` : `<button class="btn er" data-act="udis" data-id="${u.id}">Disable</button><button class="btn" data-act="ureset" data-id="${u.id}">${u.status === 'invited' ? 'New invite link' : 'Reset password link'}</button>`}` : ''}</div>` : ''}</td></tr>`).join('')}</table></div></div>
      <div class="card"><h2>Audit log (latest 100)</h2><div class="tw"><table><tr><th>When</th><th>Action</th><th>Detail</th></tr>${au.map((a) => `<tr><td class="mu">${E(String(a.created_at).slice(0, 19).replace('T', ' '))}</td><td>${E(a.action)}</td><td class="mu">${E(a.detail)}</td></tr>`).join('')}</table></div></div>`;
    }
    return `<div class="card"><h2>Provider health</h2><div class="tw"><table><tr><th>Adapter</th><th>State</th></tr>${pr.map((p) => `<tr><td>${E(p.name)}</td><td><span class="pill ${['mock', 'not_configured', 'not_implemented'].includes(p.state) ? 'wr' : p.state === 'misconfigured' ? 'er' : ''}">${E(p.state)}</span></td></tr>`).join('')}</table></div><div class="note">Secrets are never sent to the browser. Real telephony/STT/TTS/LLM adapters and R2 recording storage are not implemented in this build.</div></div>${more}`;
  }
};

const val = (id) => $('#' + id)?.value;
async function act(a, el) {
  const id = el.dataset.id;
  try {
    if (a === 'go') { S.tab = id; S.sel = null; shell(); return; }
    if (a === 'logout') { try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch {} toLogin(''); return; }
    if (a === 'lang') { S.lang = id; return view(); }
    if (a === 'open') { S.sel = id; return view(); }
    if (a === 'back') { S.sel = null; return view(); }
    if (a === 'pg') { S.f.page = Math.max(1, S.f.page + Number(id)); return view(); }
    if (a === 'print') return window.print();
    if (a === 'newcamp') return createCamp();
    if (a === 'editcamp') return editCamp(id);
    if (a === 'archive') return archiveCamp(id);
    if (a === 'restore') { await api(`/api/campaigns/${id}/restore`, { method: 'POST', body: {} }); await loadCamps(); flash('Campaign restored'); return shell(); }
    if (a === 'hist') return showHistory(id);
    if (a === 'status') { await api(`/api/campaigns/${id}/status`, { method: 'POST', body: { status: el.dataset.to } }); await loadCamps(); flash('Campaign ' + el.dataset.to); return shell(); }
    if (a === 'dup') { await api(`/api/campaigns/${id}/duplicate`, { method: 'POST', body: {} }); await loadCamps(); flash('Campaign duplicated'); return shell(); }
    if (a === 'run') { const r = await api(`/api/campaigns/${S.cur}/run`, { method: 'POST', body: { limit: 100 } }); flash(`Mock run: ${r.claimed} dialled, ${r.skipped_permission} skipped (no permission), ${r.skipped_suppressed} suppressed, ${r.deferred_window} deferred (calling window).`); return view(); }
    if (a === 'savescript') { let r = await putScript(false); if (r === 'confirm') r = await putScript(true); if (r) flash('Script saved'); return; }
    if (a === 'tmpl') return download(new Blob(['mobile_number,preferred_language,locality,mandal,constituency,contact_permission_status,permission_recorded_at,source\n9XXXXXXXXX,te,,,,granted,2026-01-01,example\n'], { type: 'text/csv' }), 'contacts-template.csv');
    if (a === 'validate') { S.preview = await api(`/api/campaigns/${S.cur}/contacts/validate`, { method: 'POST', body: { csv: val('csv') } }); S.csvText = val('csv'); return view(); }
    if (a === 'errcsv') return download(new Blob(['row,error,data\n' + S.preview.errors.map((e) => `${e.row},"${e.error}","${String(e.data).replace(/"/g, '""')}"`).join('\n')], { type: 'text/csv' }), 'import-errors.csv');
    if (a === 'doimport') { const r = await api(`/api/campaigns/${S.cur}/contacts/import`, { method: 'POST', body: { csv: S.csvText } }); S.preview = null; flash(`Imported ${r.inserted}; ${r.already_in_campaign} already present; ${r.rejected} rejected.`); return view(); }
    if (a === 'export') return download(await api(`/api/campaigns/${S.cur}/export.csv`, { raw: true }), 'feedback-export.csv');
    if (a === 'newuser') return createUser();
    if (a === 'uedit') return editUser(id);
    if (a === 'udis') return userAction(id, 'disable');
    if (a === 'uen') return userAction(id, 'enable');
    if (a === 'ureset') return userAction(id, 'reset');
  } catch (e) { if (e.message !== 'unauthenticated') flash(e.message, true); }
}
function download(blob, name) { const u = URL.createObjectURL(blob), a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 1000); }

document.addEventListener('click', (e) => { const el = e.target.closest('[data-act]'); if (el) act(el.dataset.act, el); });
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('tr[data-act]')) act(e.target.dataset.act, e.target); });
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'csvf' && t.files[0]) { const r = new FileReader(); r.onload = () => { $('#csv').value = String(r.result); }; r.readAsText(t.files[0]); return; }
  const k = t.dataset.chg; if (!k) return;
  if (k === 'arch') { S.showArchived = t.checked; loadCamps().then(shell); return; }
  if (k === 'cur') { S.cur = t.value; S.qs = null; S.preview = null; S.sel = null; return view(); }
  const [, f] = k.split('.'); S.f[f] = t.value; S.f.page = 1; view();
});
document.addEventListener('input', (e) => { const i = e.target.dataset?.q; if (i !== undefined && S.qs) S.qs.q[S.lang][Number(i)] = e.target.value; });
document.addEventListener('submit', async (e) => {
  if (e.target.dataset.form === 'setpw') {
    e.preventDefault(); const f = e.target, err = f.querySelector('.err');
    if (f.pw.value !== f.pw2.value) { err.textContent = 'Passwords do not match'; return; }
    try { const r = await fetch('/api/auth/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: f.dataset.token, password: f.pw.value }) }); const j = await r.json().catch(() => ({})); if (!r.ok) { err.textContent = j.error || 'Could not set password'; return; } renderLogin('Password saved. Please log in.'); }
    catch { err.textContent = 'Cannot reach the server.'; }
    return;
  }
  if (e.target.dataset.form !== 'login') return; e.preventDefault();
  try { const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tab-Id': TAB }, credentials: 'same-origin', body: JSON.stringify({ email: val('em'), password: val('pw') }) }); const j = await r.json().catch(() => ({})); if (!r.ok) { $('#lerr').textContent = j.error || 'Login failed'; return; } start(j); }
  catch { $('#lerr').textContent = 'Cannot reach the server.'; }
});

// Activity tracking: mirror the server's idle policy (the server is authoritative) and keep the session alive while the user is active.
for (const ev of ['click', 'keydown', 'touchstart', 'scroll']) addEventListener(ev, () => { lastAct = Date.now(); }, { passive: true });
setInterval(async () => {
  if (!me) return;
  if (Date.now() - lastAct > idleMs) { try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch {} toLogin('Your session has expired. Please log in again.'); return; }
  if (lastAct > lastPing && Date.now() - lastPing > 60000) { lastPing = Date.now(); api('/api/auth/ping', { method: 'POST', body: {} }).catch(() => {}); }
}, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && me) api('/api/auth/me').catch(() => {}); });
function route() {
  const m = location.hash.match(/^#(invite|reset)=([\w-]+)$/);
  if (!m) return boot();
  history.replaceState(null, '', location.pathname); // keep the one-time token out of history and referrers
  $('#app').innerHTML = `<div class="login"><div class="card"><img src="/icon-192.png" alt="LeoMox logo"><h1>${m[1] === 'invite' ? 'Welcome to LeoMox' : 'Reset your password'}</h1><div class="mu" style="text-align:center;font-size:13px">Choose a password (10+ characters, with a letter and a digit or symbol).</div><form data-form="setpw" data-token="${E(m[2])}"><label for="pw">New password</label><input id="pw" name="pw" type="password" autocomplete="new-password" required><label for="pw2">Confirm password</label><input id="pw2" name="pw2" type="password" autocomplete="new-password" required><div class="row"><button class="btn p" style="width:100%">Save password</button></div><div class="err" role="alert"></div></form></div></div>`;
}
route();

// ---- dialogs and admin helpers
function ask({ title, body = '', fields = [], ok = 'Confirm', danger = false, noCancel = false }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog'), opt = (o) => (typeof o === 'string' ? { v: o, l: o } : o);
    const inp = (f) => f.type === 'select' ? `<select name="${f.name}">${f.options.map(opt).map((o) => `<option value="${E(o.v)}" ${o.v === f.value ? 'selected' : ''}>${E(o.l)}</option>`).join('')}</select>`
      : f.type === 'multi' ? `<select name="${f.name}" multiple size="4">${f.options.map(opt).map((o) => `<option value="${E(o.v)}" ${(f.value || []).includes(o.v) ? 'selected' : ''}>${E(o.l)}</option>`).join('')}</select>`
      : f.type === 'checkbox' ? `<input type="checkbox" name="${f.name}" ${f.value ? 'checked' : ''}>`
      : `<input name="${f.name}" type="${f.type || 'text'}" value="${E(f.value ?? '')}" ${f.required ? 'required' : ''} ${f.readonly ? 'readonly' : ''} autocomplete="off" ${f.type === 'password' ? 'autocomplete="current-password"' : ''}>`;
    d.innerHTML = `<form method="dialog"><h2>${E(title)}</h2><div>${body}</div>${fields.map((f) => `<label class="fl">${E(f.label)}${inp(f)}</label>`).join('')}<div class="row"><button class="btn ${danger ? 'er' : 'p'}" value="ok">${E(ok)}</button>${noCancel ? '' : '<button class="btn" value="cancel" formnovalidate>Cancel</button>'}</div></form>`;
    document.body.appendChild(d);
    d.addEventListener('close', () => {
      const good = d.returnValue === 'ok', v = {};
      if (good) for (const f of fields) { const el = d.querySelector(`[name="${f.name}"]`); v[f.name] = f.type === 'multi' ? [...el.selectedOptions].map((o) => o.value) : f.type === 'checkbox' ? el.checked : el.value; }
      d.remove(); resolve(good ? v : null);
    });
    d.showModal();
  });
}
const LANGOPT = [{ v: 'te', l: 'Telugu' }, { v: 'en', l: 'English' }, { v: 'hi', l: 'Hindi' }];
function campFields(c = {}) {
  return [
    { name: 'name', label: 'Campaign name', value: c.name || '', required: true },
    { name: 'description', label: 'Description', value: c.description || '' },
    { name: 'campaign_type', label: 'Campaign type', type: 'select', options: [{ v: 'feedback_survey', l: 'Feedback survey' }, { v: 'follow_up_survey', l: 'Follow-up survey' }], value: c.campaign_type || 'feedback_survey' },
    { name: 'language', label: 'Language', type: 'select', options: LANGOPT, value: c.language || 'te' },
    { name: 'start_date', label: 'Start date (YYYY-MM-DD, optional)', value: c.start_date || '' },
    { name: 'end_date', label: 'End date (optional)', value: c.end_date || '' },
    { name: 'window_start', label: 'Calling window from (IST)', value: c.window_start || '09:00' },
    { name: 'window_end', label: 'Calling window to (IST)', value: c.window_end || '19:00' },
    { name: 'retries', label: 'Retries (0 to 5)', type: 'number', value: c.retries ?? 2 },
    { name: 'recording', label: 'Recording (requires notice/consent when on)', type: 'select', options: ['off', 'on'], value: c.recording || 'off' }
  ];
}
const campBody = (v) => ({ ...v, retries: Number(v.retries) });
async function createCamp() {
  const v = await ask({ title: 'Create campaign', body: '<p class="mu">New campaigns start as Draft. Recorded permission is required for every contact; this is always enforced. Import contacts afterwards on the Contacts tab.</p>', fields: campFields(), ok: 'Create' });
  if (!v) return; await api('/api/campaigns', { method: 'POST', body: campBody(v) }); await loadCamps(); S.cur = S.camps[0]?.id; flash('Campaign created'); shell();
}
async function saveCampaign(id, body) {
  try { return await api(`/api/campaigns/${id}`, { method: 'PATCH', body }); }
  catch (e) {
    if (e.code === 'CONFIRM_REQUIRED') { const ok = await ask({ title: 'This campaign has already started', body: `<p>${E(e.message)}</p><p><b>Affected settings:</b> ${E((e.fields || []).join(', '))}</p><p>Changes are recorded in the campaign history. Existing calls, recordings and feedback are not modified.</p>`, ok: 'Apply changes' }); return ok ? saveCampaign(id, { ...body, confirm: true }) : null; }
    if (e.code === 'CONFLICT') { await loadCamps(); shell(); }
    throw e;
  }
}
async function editCamp(id) {
  const c = await api('/api/campaigns/' + id);
  const warn = c.status === 'active' ? '<div class="note">This campaign is active. Pause it before changing the schedule, language, calling window, retries or recording; name and description can be changed now.</div>' : '';
  const v = await ask({ title: 'Edit campaign', body: warn + '<p class="mu">History, calls, recordings and feedback are preserved. The change is recorded with your name and the fields modified.</p>', fields: campFields(c), ok: 'Save changes' });
  if (!v) return; const r = await saveCampaign(id, { ...campBody(v), version: c.version });
  if (r) { flash('Campaign updated'); await loadCamps(); shell(); }
}
async function archiveCamp(id) {
  const c = S.camps.find((x) => x.id === id);
  const v = await ask({ title: 'Archive campaign', danger: true, ok: 'Archive campaign', body: `<p>You are about to archive <b>${E(c.name)}</b>.</p><ul><li>It disappears from active lists and can no longer be run, edited or receive contacts.</li><li>Calls, recordings, transcripts, feedback, reports and audit history are <b>kept</b> and stay viewable under “Show archived”.</li><li>An authorised user can restore it later.</li></ul><p>A running campaign must be paused first.</p>`, fields: [{ name: 'confirm_name', label: `Type the campaign name to confirm: ${c.name}`, required: true }] });
  if (!v) return; await api(`/api/campaigns/${id}/archive`, { method: 'POST', body: { confirm_name: v.confirm_name } }); await loadCamps(); flash('Campaign archived'); shell();
}
async function showHistory(id) {
  const h = await api(`/api/campaigns/${id}/changes`);
  await ask({ title: 'Change history', noCancel: true, ok: 'Close', body: h.length ? `<div class="tw"><table><tr><th>When</th><th>Who</th><th>Action</th><th>Changes</th></tr>${h.map((x) => `<tr><td class="mu">${E(String(x.created_at).slice(0, 16).replace('T', ' '))}</td><td>${E(x.by || '–')}</td><td>${E(x.action)}</td><td class="mu">${E(Object.entries(x.changes).map(([k, v]) => (v && typeof v === 'object' && 'to' in v ? `${k}: ${v.from ?? '–'} → ${v.to ?? '–'}` : k)).join('; '))}</td></tr>`).join('')}</table></div>` : '<p>No history.</p>' });
}
async function putScript(confirm) {
  try { await api(`/api/campaigns/${S.cur}/questions`, { method: 'PUT', body: { questions: S.qs.q, ...(confirm ? { confirm: true } : {}) } }); return true; }
  catch (e) {
    if (e.code === 'CONFIRM_REQUIRED' && !confirm) { const ok = await ask({ title: 'Calls have already used this script', body: `<p>${E(e.message)}</p>`, ok: 'Save anyway' }); return ok ? 'confirm' : null; }
    flash(e.message, true); return null;
  }
}
const reauthField = (hint = '') => ({ name: 'reauth_password', label: 'Confirm with your own password' + hint, type: 'password', required: !hint });
async function showLink(title, link, expires) {
  await ask({ title, noCancel: true, ok: 'Done', body: `<p>Share this <b>one-time</b> link with the user over a secure channel. It is shown only now and expires ${E(String(expires).slice(0, 16).replace('T', ' '))} (UTC). Anyone with the link can set the password.</p><input readonly value="${E(link)}" style="width:100%" aria-label="One-time link">` });
}
async function createUser() {
  const roles = me.role === 'SUPER_ADMIN' ? ROLE : ['MANAGER', 'VIEWER'];
  const v = await ask({ title: 'Create user', ok: 'Create and get invite link', body: '<p class="mu">The user receives a one-time invite link and chooses their own password. Passwords are never set or seen by administrators.</p>', fields: [
    { name: 'name', label: 'Full name', required: true }, { name: 'email', label: 'Email address', type: 'email', required: true }, { name: 'phone', label: 'Phone (optional)' },
    { name: 'role', label: 'Role', type: 'select', options: roles, value: 'VIEWER' }, { name: 'campaign_scope', label: 'Campaign access', type: 'select', options: [{ v: 'all', l: 'All campaigns' }, { v: 'assigned', l: 'Only assigned campaigns' }], value: 'all' },
    { name: 'campaign_ids', label: 'Assigned campaigns (when limited)', type: 'multi', options: S.camps.map((c) => ({ v: c.id, l: c.name })) },
    { name: 'can_archive', label: 'May archive/restore campaigns (MANAGER only)', type: 'checkbox' }, reauthField(' (required for ADMIN and SUPER_ADMIN roles)')] });
  if (!v) return; const r = await api('/api/users', { method: 'POST', body: { ...v, reauth_password: v.reauth_password || undefined } });
  flash('User created (invited)'); await showLink('Invite link for ' + r.email, r.invite_link, r.invite_expires_at); view();
}
async function editUser(id) {
  const u = await api('/api/users/' + id), self = u.id === me.id;
  const roles = me.role === 'SUPER_ADMIN' ? ROLE : ['MANAGER', 'VIEWER'];
  const fields = [{ name: 'name', label: 'Full name', value: u.name, required: true }, { name: 'phone', label: 'Phone', value: u.phone || '' }];
  if (!self) fields.push({ name: 'role', label: `Role (currently ${u.role})`, type: 'select', options: roles.includes(u.role) ? roles : [u.role, ...roles], value: u.role },
    { name: 'campaign_scope', label: 'Campaign access', type: 'select', options: [{ v: 'all', l: 'All campaigns' }, { v: 'assigned', l: 'Only assigned campaigns' }], value: u.campaign_scope },
    { name: 'campaign_ids', label: 'Assigned campaigns', type: 'multi', options: S.camps.map((c) => ({ v: c.id, l: c.name })), value: u.campaign_ids },
    { name: 'can_archive', label: 'May archive/restore campaigns (MANAGER only)', type: 'checkbox', value: u.can_archive }, reauthField(' (required to change a role)'));
  const v = await ask({ title: 'Edit user: ' + u.email, ok: 'Save', body: `<p class="mu">Status: ${E(u.status)}. Changing role, access or archive permission ends the user's active sessions. All changes are audited.</p>`, fields });
  if (!v) return; if (!v.reauth_password) delete v.reauth_password; await api('/api/users/' + id, { method: 'PATCH', body: v }); flash('User updated'); view();
}
async function userAction(id, kind) {
  const u = await api('/api/users/' + id);
  const text = { disable: `<p>Disable <b>${E(u.email)}</b>? They are signed out everywhere immediately and cannot log in until re-enabled. Their campaigns, calls and feedback history are kept.</p>`, enable: `<p>Re-enable <b>${E(u.email)}</b>?</p>`, reset: `<p>Create a one-time ${u.status === 'invited' ? 'invite' : 'password-reset'} link for <b>${E(u.email)}</b>? Any older link stops working.</p>` }[kind];
  const v = await ask({ title: { disable: 'Disable account', enable: 'Enable account', reset: 'Issue one-time link' }[kind], danger: kind === 'disable', ok: 'Confirm', body: text, fields: [reauthField()] });
  if (!v) return; const r = await api(`/api/users/${id}/${kind}`, { method: 'POST', body: { reauth_password: v.reauth_password } });
  if (kind === 'reset') await showLink('One-time link for ' + u.email, r.link, r.expires_at); else flash(kind === 'disable' ? 'Account disabled; sessions ended' : 'Account enabled'); view();
}
