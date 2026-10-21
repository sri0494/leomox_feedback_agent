import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuth, newId, atLeast, withTx } from './auth.js';
import { mountCampaigns } from './campaigns.js';
import { mountUsers } from './users.js';
import { validateCsv, csvCell, mask } from './csv.js';
import { DEFAULT_QUESTIONS } from './defaultScript.js';
import { runCampaign } from './engine.js';
import { createMockTelephony, verifySignature, CATS } from './providers.js';

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400, code, extra) => Object.assign(new Error(msg), { status, expose: true, code, extra });
const LANGS = ['te', 'en', 'hi'];
const OUT = ['completed', 'declined', 'opted_out', 'no_answer', 'busy', 'failed'];
const RANK = { initiated: 0, ringing: 1, no_answer: 2, busy: 2, failed: 2, declined: 3, completed: 4, opted_out: 5 };

export function createApp({ pool, cfg, telephony = createMockTelephony() }) {
  const app = express();
  if (cfg.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  const csp = helmet.contentSecurityPolicy.getDefaultDirectives();
  if (!cfg.prod) delete csp['upgrade-insecure-requests']; // keeps plain-http local development working
  app.use(helmet({ contentSecurityPolicy: { useDefaults: false, directives: csp } }));
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const audit = (userId, action, detail = '') => pool.query('INSERT INTO feedback_audit_logs (id,user_id,action,detail) VALUES ($1,$2,$3,$4)', [newId(), userId, action, String(detail).slice(0, 500)]).catch(() => {});
  const auth = createAuth({ pool, cfg, audit });
  const need = auth.requireAuth;

  app.get('/healthz', (_q, r) => r.json({ ok: true }));
  app.get('/readyz', ah(async (_q, r) => { await pool.query('SELECT 1'); r.json({ ready: true }); }));
  auth.mount(app);

  const getCampaign = async (id) => { const { rows } = await pool.query('SELECT * FROM feedback_campaigns WHERE id=$1', [id]); if (!rows[0]) throw bad('Campaign not found', 404); return rows[0]; };
  const pageArgs = (q) => { const pageSize = Math.min(100, Math.max(1, +q.pageSize || 25)); const page = Math.max(1, +q.page || 1); return { pageSize, offset: (page - 1) * pageSize, page }; };
  const str = (v, max, name, req = true) => { const s = String(v ?? '').trim(); if (req && !s) throw bad(`${name} is required`); if (s.length > max) throw bad(`${name} is too long`); return s; };
  const hhmm = (v, name) => { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw bad(`${name} must be HH:MM`); return v; };
  const intIn = (v, lo, hi, name) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`${name} must be an integer ${lo}-${hi}`); return n; };

  function campaignFields(b) {
    const f = {
      name: str(b.name, 120, 'name'), purpose: str(b.purpose, 500, 'purpose', false),
      language: LANGS.includes(b.language) ? b.language : (() => { throw bad('language must be te, en or hi'); })(),
      window_start: hhmm(b.window_start || '09:00', 'window_start'), window_end: hhmm(b.window_end || '19:00', 'window_end'),
      max_duration_s: intIn(b.max_duration_s ?? 150, 30, 600, 'max_duration_s'), retries: intIn(b.retries ?? 2, 0, 5, 'retries'),
      concurrency: intIn(b.concurrency ?? 5, 1, 50, 'concurrency'), recording: b.recording === 'on' ? 'on' : 'off',
      start_date: str(b.start_date, 10, 'start_date', false) || null, end_date: str(b.end_date, 10, 'end_date', false) || null
    };
    if (f.window_start >= f.window_end) throw bad('window_start must be before window_end');
    return f;
  }

  // campaign-scope enforcement (users limited to assigned campaigns get 404 for anything else)
  const allowed = async (user) => {
    if (user.scope !== 'assigned' || atLeast(user.role, 'ADMIN')) return null;
    return new Set((await pool.query('SELECT campaign_id FROM user_campaigns WHERE user_id=$1', [user.id])).rows.map((r) => r.campaign_id));
  };
  const needC = (min) => [need(min), ah(async (req, _res, next) => {
    const al = await allowed(req.user);
    if (al && !al.has(req.params.id)) { await audit(req.user.id, 'access_denied', `campaign ${req.params.id} outside assigned scope`); throw bad('Campaign not found', 404); }
    next();
  })];
  mountCampaigns(app, { pool, need, needC, audit, ah, bad, getCampaign, allowed, defaultQuestions: DEFAULT_QUESTIONS, withTx });
  mountUsers(app, { pool, need, audit, ah, bad });

  // ---- contacts
  app.post('/api/campaigns/:id/contacts/validate', needC('MANAGER'), ah(async (req, res) => { await getCampaign(req.params.id); const v = validateCsv(req.body?.csv); if (v.fatal) throw bad(v.fatal); res.json({ ...v, rows: v.rows.map((r) => ({ ...r, number: mask(r.number) })) }); }));
  app.post('/api/campaigns/:id/contacts/import', needC('MANAGER'), ah(async (req, res) => {
    const c = await getCampaign(req.params.id); if (c.archived_at) throw bad('Campaign is archived', 409, 'ARCHIVED'); if (c.status === 'closed') throw bad('Campaign is closed', 409);
    const v = validateCsv(req.body?.csv); if (v.fatal) throw bad(v.fatal);
    let inserted = 0, existing = 0;
    for (const r of v.rows) {
      const ex = await pool.query('SELECT 1 FROM feedback_contacts WHERE campaign_id=$1 AND number=$2', [c.id, r.number]);
      if (ex.rows.length) { existing++; continue; }
      await pool.query('INSERT INTO feedback_contacts (id,campaign_id,number,language,locality,mandal,constituency,permission,permission_at,source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [newId(), c.id, r.number, r.language, r.locality, r.mandal, r.constituency, r.permission, r.permission_at, r.source]);
      inserted++;
    }
    await audit(req.user.id, 'contacts_import', `${c.id} inserted=${inserted} existing=${existing} rejected=${v.errors.length}`);
    res.json({ inserted, already_in_campaign: existing, rejected: v.errors.length, errors: v.errors });
  }));
  app.get('/api/campaigns/:id/contacts', needC('MANAGER'), ah(async (req, res) => {
    const { pageSize, offset, page } = pageArgs(req.query);
    const total = Number((await pool.query('SELECT COUNT(*) AS n FROM feedback_contacts WHERE campaign_id=$1', [req.params.id])).rows[0].n);
    const { rows } = await pool.query('SELECT id,number,language,locality,permission,permission_at,status FROM feedback_contacts WHERE campaign_id=$1 ORDER BY created_at, id LIMIT $2 OFFSET $3', [req.params.id, pageSize, offset]);
    res.json({ page, pageSize, total, items: rows.map((r) => ({ ...r, number: mask(r.number) })) });
  }));
  app.get('/api/campaigns/:id/dry-run', needC('MANAGER'), ah(async (req, res) => {
    const c = await getCampaign(req.params.id);
    const { rows } = await pool.query("SELECT permission,permission_at,number FROM feedback_contacts WHERE campaign_id=$1 AND status='pending'", [c.id]);
    const sup = new Set((await pool.query('SELECT number FROM feedback_suppression_entries')).rows.map((r) => r.number));
    const out = { pending: rows.length, eligible: 0, no_permission: 0, suppressed: 0 };
    for (const r of rows) { if (!(r.permission === 'granted' && r.permission_at)) out.no_permission++; else if (sup.has(r.number)) out.suppressed++; else out.eligible++; }
    res.json({ ...out, language: c.language, firstPrompt: c.questions[c.language][0], recording: c.recording });
  }));
  app.post('/api/campaigns/:id/run', needC('MANAGER'), ah(async (req, res) => {
    const c = await getCampaign(req.params.id);
    if (c.archived_at) throw bad('Campaign is archived', 409, 'ARCHIVED');
    const limit = intIn(req.body?.limit ?? 50, 1, 500, 'limit');
    const s = await runCampaign({ pool, cfg, campaign: c, telephony, limit });
    await audit(req.user.id, 'campaign_run', `${c.id} provider=${telephony.name} ${JSON.stringify(s.results)}`);
    res.json({ ...s, mock: !!telephony.isMock });
  }));
  app.post('/api/suppression', need('MANAGER'), ah(async (req, res) => {
    const n = String(req.body?.number || '').replace(/\D/g, '').slice(-10); if (!/^[6-9]\d{9}$/.test(n)) throw bad('Invalid mobile number');
    await pool.query('INSERT INTO feedback_suppression_entries (number,reason) SELECT $1,$2 WHERE NOT EXISTS (SELECT 1 FROM feedback_suppression_entries WHERE number=$1)', [n, 'manual']);
    await audit(req.user.id, 'suppression_add', mask(n)); res.status(201).json({ ok: true });
  }));

  // ---- calls
  app.get('/api/calls', need('VIEWER'), ah(async (req, res) => {
    const { pageSize, offset, page } = pageArgs(req.query), w = [], p = [];
    const add = (sql, v) => { p.push(v); w.push(sql.replace('?', '$' + p.length)); };
    if (req.query.campaign_id) add('c.campaign_id=?', String(req.query.campaign_id));
    if (OUT.includes(req.query.outcome)) add('c.outcome=?', req.query.outcome);
    if (LANGS.includes(req.query.language)) add('c.language=?', req.query.language);
    if (CATS.includes(req.query.category)) add('EXISTS (SELECT 1 FROM feedback_responses r WHERE r.call_id=c.id AND r.category=?)', req.query.category);
    if (req.query.q) add('k.locality LIKE ?', '%' + String(req.query.q).slice(0, 50) + '%');
    const al = await allowed(req.user);
    if (al) { if (!al.size) return res.json({ page, pageSize, total: 0, items: [] }); add('c.campaign_id = ANY(?)', [...al]); }
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const base = `FROM feedback_calls c JOIN feedback_contacts k ON k.id=c.contact_id ${where}`;
    const total = Number((await pool.query(`SELECT COUNT(*) AS n ${base}`, p)).rows[0].n);
    const { rows } = await pool.query(`SELECT c.id,c.campaign_id,c.outcome,c.attempts,c.duration_s,c.language,c.is_mock,c.created_at,k.number,k.locality ${base} ORDER BY c.created_at DESC, c.id LIMIT $${p.length + 1} OFFSET $${p.length + 2}`, [...p, pageSize, offset]);
    res.json({ page, pageSize, total, items: rows.map((r) => ({ ...r, number: mask(r.number) })) });
  }));
  app.get('/api/calls/:id', need('MANAGER'), ah(async (req, res) => {
    const { rows } = await pool.query('SELECT c.*,k.number,k.locality FROM feedback_calls c JOIN feedback_contacts k ON k.id=c.contact_id WHERE c.id=$1', [req.params.id]);
    if (!rows[0]) throw bad('Call not found', 404);
    const al = await allowed(req.user); if (al && !al.has(rows[0].campaign_id)) throw bad('Call not found', 404);
    const responses = (await pool.query('SELECT question_id,category,transcript,skipped,stt_confidence,classification_status,classification,needs_review FROM feedback_responses WHERE call_id=$1 ORDER BY question_id', [req.params.id])).rows;
    await audit(req.user.id, 'call_view', req.params.id);
    res.json({ ...rows[0], number: mask(rows[0].number), responses });
  }));

  // ---- analytics / export
  app.get('/api/campaigns/:id/analytics', needC('VIEWER'), ah(async (req, res) => {
    const c = await getCampaign(req.params.id);
    const cnt = {}; for (const r of (await pool.query('SELECT outcome, COUNT(*) AS n FROM feedback_calls WHERE campaign_id=$1 GROUP BY outcome', [c.id])).rows) cnt[r.outcome] = Number(r.n);
    const g = (k) => cnt[k] || 0, attempted = Object.values(cnt).reduce((a, b) => a + b, 0), answered = g('completed') + g('declined') + g('opted_out');
    const contacts = Number((await pool.query('SELECT COUNT(*) AS n FROM feedback_contacts WHERE campaign_id=$1', [c.id])).rows[0].n);
    const eligible = Number((await pool.query("SELECT COUNT(*) AS n FROM feedback_contacts WHERE campaign_id=$1 AND permission='granted' AND permission_at IS NOT NULL", [c.id])).rows[0].n);
    const agg = (await pool.query("SELECT COALESCE(SUM(duration_s),0) AS d, COUNT(*) AS n FROM feedback_calls WHERE campaign_id=$1 AND outcome='completed'", [c.id])).rows[0];
    const at = (await pool.query('SELECT COALESCE(SUM(attempts),0) AS a, COUNT(*) AS n FROM feedback_calls WHERE campaign_id=$1', [c.id])).rows[0];
    const retAll = Number(at.a) - Number(at.n);
    const rs = (await pool.query('SELECT r.id,r.call_id,r.category,r.skipped,r.classification,r.needs_review,r.transcript,r.classification_status FROM feedback_responses r JOIN feedback_calls c ON c.id=r.call_id WHERE c.campaign_id=$1', [c.id])).rows;
    const cat = {}; CATS.forEach((k) => (cat[k] = { answered: 0, negative_or_mixed: 0, skipped: 0, pending: 0 }));
    const sent = { positive: 0, neutral: 0, negative: 0, mixed: 0, uncertain: 0 }; const review = [], unresolved = []; let dates = [];
    for (const r of rs) {
      const o = cat[r.category]; if (r.skipped) { o.skipped++; continue; }
      if (r.classification_status !== 'done') { o.pending++; if (r.needs_review) review.push({ call_id: r.call_id, category: r.category, confidence: null, excerpt: r.transcript }); continue; }
      const k = r.classification; o.answered++; sent[k.sentiment]++; if (['negative', 'mixed'].includes(k.sentiment)) o.negative_or_mixed++;
      if (r.needs_review) review.push({ call_id: r.call_id, category: r.category, confidence: k.confidence, excerpt: k.excerpt });
      if (k.question_id === 'q5' && k.response_received === 'no') unresolved.push({ call_id: r.call_id, summary: k.issue_summary, excerpt: k.excerpt });
    }
    dates = (await pool.query('SELECT MIN(created_at) AS a, MAX(created_at) AS b FROM feedback_calls WHERE campaign_id=$1', [c.id])).rows[0];
    const sup = Number((await pool.query('SELECT COUNT(*) AS n FROM feedback_suppression_entries')).rows[0].n);
    res.json({ campaign: { id: c.id, name: c.name, status: c.status }, note: 'Respondent-reported; sentiment is an estimate of expressed language and not representative of the wider population.',
      mock: (await pool.query('SELECT 1 FROM feedback_calls WHERE campaign_id=$1 AND is_mock=TRUE LIMIT 1', [c.id])).rows.length > 0,
      totals: { contacts, eligible_contacts: eligible, attempted, answered, completed: g('completed'), declined: g('declined'), opted_out: g('opted_out'), busy: g('busy'), no_answer: g('no_answer'), failed: g('failed'), retries: retAll, suppression_list: sup },
      rates: { answer: { value: attempted ? answered / attempted : null, num: answered, den: attempted }, completion: { value: answered ? g('completed') / answered : null, num: g('completed'), den: answered },
        decline: { value: answered ? g('declined') / answered : null, num: g('declined'), den: answered }, opt_out: { value: answered ? g('opted_out') / answered : null, num: g('opted_out'), den: answered } },
      avg_duration_s: Number(agg.n) ? Math.round(Number(agg.d) / Number(agg.n)) : null, categories: cat, sentiment: sent, review_queue: review, unresolved, collected: { from: dates.a, to: dates.b } });
  }));
  app.get('/api/campaigns/:id/export.csv', needC('MANAGER'), ah(async (req, res) => {
    const c = await getCampaign(req.params.id);
    const { rows } = await pool.query('SELECT c.id AS call_id,c.outcome,c.language,c.is_mock,k.number,r.question_id,r.category,r.classification,r.skipped FROM feedback_calls c JOIN feedback_contacts k ON k.id=c.contact_id LEFT JOIN feedback_responses r ON r.call_id=c.id WHERE c.campaign_id=$1 ORDER BY c.created_at, c.id, r.question_id', [c.id]);
    const lines = ['call_id,outcome,language,is_mock,number_masked,question_id,category,sentiment,confidence,summary,skipped'];
    for (const r of rows) { const k = r.classification || {}; lines.push([r.call_id, r.outcome, r.language, r.is_mock, mask(r.number), r.question_id, r.category, k.sentiment, k.confidence, k.issue_summary, r.skipped].map(csvCell).join(',')); }
    await audit(req.user.id, 'export', c.id);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="feedback-export.csv"' }).send(lines.join('\n'));
  }));

  // ---- providers / admin
  app.get('/api/providers', need('VIEWER'), (_q, r) => r.json([
    { name: 'Telephony', state: cfg.telephony === 'mock' ? 'mock' : 'misconfigured' }, { name: 'Speech-to-text', state: cfg.stt === 'mock' ? 'mock' : 'misconfigured' },
    { name: 'Text-to-speech', state: cfg.tts === 'mock' ? 'mock' : 'misconfigured' }, { name: 'AI classifier', state: cfg.ai === 'mock' ? 'mock' : 'misconfigured' },
    { name: 'Cloudflare R2 recordings', state: 'not_implemented' }, { name: 'Webhook signing secret', state: cfg.webhookSecret ? 'configured' : 'not_configured' }]));
  app.get('/api/audit', need('ADMIN'), ah(async (_q, r) => r.json((await pool.query('SELECT id,user_id,action,detail,created_at FROM feedback_audit_logs ORDER BY created_at DESC LIMIT 100')).rows)));

  // ---- signed, idempotent provider webhook
  app.post('/api/webhooks/telephony', ah(async (req, res) => {
    if (!cfg.webhookSecret) return res.status(503).json({ error: 'Webhook signing secret not configured' });
    if (!verifySignature(cfg.webhookSecret, req.rawBody || Buffer.alloc(0), req.get('x-leomox-signature'))) return res.status(401).json({ error: 'Invalid signature' });
    const b = req.body || {};
    if (typeof b.event_id !== 'string' || !b.event_id || typeof b.provider_call_id !== 'string' || ![...Object.keys(RANK)].includes(b.type)) throw bad('Invalid event schema');
    try { await pool.query('INSERT INTO feedback_webhook_events (event_id,provider_call_id,event_type) VALUES ($1,$2,$3)', [b.event_id.slice(0, 100), b.provider_call_id.slice(0, 100), b.type]); }
    catch { return res.json({ ok: true, duplicate: true }); } // unique event_id => already processed
    const { rows } = await pool.query('SELECT id,outcome,contact_id FROM feedback_calls WHERE provider_call_id=$1', [b.provider_call_id]);
    const call = rows[0]; if (!call) return res.json({ ok: true, applied: false, reason: 'unknown call' });
    if ((RANK[b.type] ?? 0) <= (RANK[call.outcome] ?? 0)) return res.json({ ok: true, applied: false, reason: 'out-of-order or stale event ignored' });
    await pool.query('UPDATE feedback_calls SET outcome=$1 WHERE id=$2', [b.type, call.id]);
    if (b.type === 'opted_out') {
      const k = (await pool.query('SELECT number FROM feedback_contacts WHERE id=$1', [call.contact_id])).rows[0];
      await pool.query('INSERT INTO feedback_suppression_entries (number,reason) SELECT $1,$2 WHERE NOT EXISTS (SELECT 1 FROM feedback_suppression_entries WHERE number=$1)', [k.number, 'opted_out']);
      await pool.query("UPDATE feedback_contacts SET status='opted_out' WHERE id=$1", [call.contact_id]);
    }
    res.json({ ok: true, applied: true });
  }));

  app.use(express.static(pub, { index: false, setHeaders: (r, p) => { if (p.endsWith('.html')) r.set('Cache-Control', 'no-store'); } }));
  app.get('/', (_q, r) => { r.set('Cache-Control', 'no-store'); r.sendFile(path.join(pub, 'index.html')); });
  app.use('/api', (_q, r) => r.status(404).json({ error: 'Not found' }));
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err.expose) return res.status(err.status || 400).json({ error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.extra || {}) });
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    console.error(err); res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}
