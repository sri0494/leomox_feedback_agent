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
const S = { tab: 'dash', camps: [], cur: null, lang: 'te', qs: null, f: { outcome: '', language: '', category: '', q: '', page: 1 }, sel: null, preview: null, msg: '' };
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
  if (!r.ok) throw new Error(j.error || 'Request failed');
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
async function loadCamps() { S.camps = await api('/api/campaigns'); if (!S.camps.find((c) => c.id === S.cur)) S.cur = S.camps[0]?.id || null; }

function shell() {
  $('#app').innerHTML = `<header class="hdr"><img src="/icon-192.png" alt=""><div><h1>LeoMox Feedback Call Agent</h1><small>Structured outbound feedback surveys</small></div><span class="badge">MOCK TELEPHONY · no real calls</span><span class="sp"></span><small>${E(me.email)} · ${E(me.role)}</small><button class="btn" data-act="logout">Log out</button></header>
  <nav role="tablist">${TABS.map(([k, v]) => `<button role="tab" class="${S.tab === k ? 'on' : ''}" data-act="go" data-id="${k}">${v}</button>`).join('')}</nav><main><div class="row"><label for="cs">Campaign</label><select id="cs" data-chg="cur">${S.camps.map((c) => `<option value="${c.id}" ${c.id === S.cur ? 'selected' : ''}>${E(c.name)} (${c.status})</option>`).join('') || '<option value="">No campaigns yet</option>'}</select></div><div id="msg" role="status"></div><div id="view"><div class="empty">Loading…</div></div></main>`;
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
    const rows = S.camps.map((c) => `<tr><td>${E(c.name)}</td><td><span class="pill ${c.status === 'closed' ? 'er' : ''}">${c.status}</span></td><td>${LANG[c.language]}</td><td>${E(c.window_start)}–${E(c.window_end)} IST</td><td>${c.retries}</td><td>${c.recording}</td><td>${can('MANAGER') ? `<div class="row">${c.status === 'draft' || c.status === 'paused' ? `<button class="btn p" data-act="status" data-id="${c.id}" data-to="active">${c.status === 'draft' ? 'Activate' : 'Resume'}</button>` : ''}${c.status === 'active' ? `<button class="btn" data-act="status" data-id="${c.id}" data-to="paused">Pause</button>` : ''}${c.status !== 'closed' ? `<button class="btn" data-act="status" data-id="${c.id}" data-to="closed">Close</button>` : ''}<button class="btn" data-act="dup" data-id="${c.id}">Duplicate</button></div>` : ''}</td></tr>`).join('');
    let dry = ''; if (S.cur && can('MANAGER')) { const d = await api(`/api/campaigns/${S.cur}/dry-run`); dry = `<div class="card"><h2>Dry run (selected campaign)</h2><p>Pending contacts: <b>${d.pending}</b> · eligible now: <b>${d.eligible}</b> · missing permission: ${d.no_permission} · suppressed: ${d.suppressed}. Permission and suppression are re-checked immediately before every dial; uploading a list is never treated as consent.</p><div class="mu">First prompt (${LANG[d.language]}), recording ${d.recording}:</div><p>${E(d.firstPrompt)}</p></div>`; }
    const form = can('MANAGER') ? `<div class="card"><h2>New campaign</h2><div class="row"><input id="nc_name" placeholder="Campaign name" aria-label="Campaign name" maxlength="120"><select id="nc_lang" aria-label="Language">${Object.entries(LANG).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select><label>From <input id="nc_ws" value="09:00" size="5"></label><label>to <input id="nc_we" value="19:00" size="5"></label><label>Retries <input id="nc_r" type="number" min="0" max="5" value="2" style="width:64px"></label><select id="nc_rec" aria-label="Recording"><option value="off">Recording off (default)</option><option value="on">Recording on (requires notice/consent)</option></select><button class="btn p" data-act="newcamp">Create</button></div></div>` : '';
    return `<div class="card"><h2>Campaigns</h2>${S.camps.length ? `<div class="tw"><table><tr><th>Name</th><th>Status</th><th>Language</th><th>Calling window</th><th>Retries</th><th>Recording</th><th></th></tr>${rows}</table></div>` : '<div class="empty">No campaigns yet.</div>'}</div>${dry}${form}`;
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
      const au = await api('/api/audit');
      more = `<div class="card"><h2>Create user</h2><div class="row"><input id="u_e" type="email" placeholder="email" aria-label="Email"><input id="u_n" placeholder="name" aria-label="Name"><input id="u_p" type="password" placeholder="password (10+ chars)" aria-label="Password" autocomplete="new-password"><select id="u_r" aria-label="Role">${ROLE.filter((r) => ROLE.indexOf(r) < ROLE.indexOf(me.role) || (me.role === 'SUPER_ADMIN')).map((r) => `<option>${r}</option>`).join('')}</select><button class="btn p" data-act="newuser">Create</button></div></div>
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
    if (a === 'newcamp') { await api('/api/campaigns', { method: 'POST', body: { name: val('nc_name'), language: val('nc_lang'), window_start: val('nc_ws'), window_end: val('nc_we'), retries: Number(val('nc_r')), recording: val('nc_rec') } }); await loadCamps(); S.cur = S.camps[0].id; flash('Campaign created'); return shell(); }
    if (a === 'status') { await api(`/api/campaigns/${id}/status`, { method: 'POST', body: { status: el.dataset.to } }); await loadCamps(); flash('Campaign ' + el.dataset.to); return shell(); }
    if (a === 'dup') { await api(`/api/campaigns/${id}/duplicate`, { method: 'POST', body: {} }); await loadCamps(); flash('Campaign duplicated'); return shell(); }
    if (a === 'run') { const r = await api(`/api/campaigns/${S.cur}/run`, { method: 'POST', body: { limit: 100 } }); flash(`Mock run: ${r.claimed} dialled, ${r.skipped_permission} skipped (no permission), ${r.skipped_suppressed} suppressed, ${r.deferred_window} deferred (calling window).`); return view(); }
    if (a === 'savescript') { await api(`/api/campaigns/${S.cur}/questions`, { method: 'PUT', body: { questions: S.qs.q } }); return flash('Script saved'); }
    if (a === 'tmpl') return download(new Blob(['mobile_number,preferred_language,locality,mandal,constituency,contact_permission_status,permission_recorded_at,source\n9XXXXXXXXX,te,,,,granted,2026-01-01,example\n'], { type: 'text/csv' }), 'contacts-template.csv');
    if (a === 'validate') { S.preview = await api(`/api/campaigns/${S.cur}/contacts/validate`, { method: 'POST', body: { csv: val('csv') } }); S.csvText = val('csv'); return view(); }
    if (a === 'errcsv') return download(new Blob(['row,error,data\n' + S.preview.errors.map((e) => `${e.row},"${e.error}","${String(e.data).replace(/"/g, '""')}"`).join('\n')], { type: 'text/csv' }), 'import-errors.csv');
    if (a === 'doimport') { const r = await api(`/api/campaigns/${S.cur}/contacts/import`, { method: 'POST', body: { csv: S.csvText } }); S.preview = null; flash(`Imported ${r.inserted}; ${r.already_in_campaign} already present; ${r.rejected} rejected.`); return view(); }
    if (a === 'export') return download(await api(`/api/campaigns/${S.cur}/export.csv`, { raw: true }), 'feedback-export.csv');
    if (a === 'newuser') { await api('/api/users', { method: 'POST', body: { email: val('u_e'), name: val('u_n'), password: val('u_p'), role: val('u_r') } }); flash('User created'); return view(); }
  } catch (e) { if (e.message !== 'unauthenticated') flash(e.message, true); }
}
function download(blob, name) { const u = URL.createObjectURL(blob), a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 1000); }

document.addEventListener('click', (e) => { const el = e.target.closest('[data-act]'); if (el) act(el.dataset.act, el); });
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('tr[data-act]')) act(e.target.dataset.act, e.target); });
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'csvf' && t.files[0]) { const r = new FileReader(); r.onload = () => { $('#csv').value = String(r.result); }; r.readAsText(t.files[0]); return; }
  const k = t.dataset.chg; if (!k) return;
  if (k === 'cur') { S.cur = t.value; S.qs = null; S.preview = null; S.sel = null; return view(); }
  const [, f] = k.split('.'); S.f[f] = t.value; S.f.page = 1; view();
});
document.addEventListener('input', (e) => { const i = e.target.dataset?.q; if (i !== undefined && S.qs) S.qs.q[S.lang][Number(i)] = e.target.value; });
document.addEventListener('submit', async (e) => {
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
boot();
