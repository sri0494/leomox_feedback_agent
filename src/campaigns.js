import { newId, atLeast } from './auth.js';

export const TYPES = ['feedback_survey', 'follow_up_survey'];
const LANGS = ['te', 'en', 'hi'];
const FIELDS = ['name', 'purpose', 'campaign_type', 'language', 'start_date', 'end_date', 'window_start', 'window_end', 'max_duration_s', 'retries', 'concurrency', 'recording'];
// Changing these while calls are pending would change who is called, when, or how results are read.
const AFFECTS_PENDING = ['campaign_type', 'language', 'start_date', 'end_date', 'window_start', 'window_end', 'max_duration_s', 'retries', 'concurrency', 'recording'];
const TRANS = { draft: ['active', 'closed'], active: ['paused', 'closed'], paused: ['active', 'closed'], closed: [] };
const today = () => new Date().toISOString().slice(0, 10);

export const view = (c, withScript = false) => {
  const { questions, ...rest } = c;
  return { ...rest, description: c.purpose, archived: !!c.archived_at, status_display: c.archived_at ? 'archived' : c.status,
    consent_requirement: 'Recorded permission is required for every contact (always enforced)', ...(withScript ? { questions } : {}) };
};

export function mountCampaigns(app, { pool, need, needC, audit, ah, bad, getCampaign, allowed, defaultQuestions, withTx }) {
  const str = (v, max, name, req = true) => { const s = String(v ?? '').trim(); if (req && !s) throw bad(`${name} is required`); if (s.length > max) throw bad(`${name} is too long (max ${max})`); return s; };
  const int = (v, lo, hi, name) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`${name} must be an integer ${lo}-${hi}`); return n; };
  const hhmm = (v, name) => { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) throw bad(`${name} must be HH:MM`); return String(v); };
  const date = (v, name) => { const s = String(v ?? '').trim(); if (!s) return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw bad(`${name} must be YYYY-MM-DD`); return s; };

  function fields(b) {
    const f = {
      name: str(b.name, 120, 'name'), purpose: str(b.description ?? b.purpose, 500, 'description', false),
      campaign_type: TYPES.includes(b.campaign_type ?? 'feedback_survey') ? (b.campaign_type ?? 'feedback_survey') : (() => { throw bad('campaign_type must be one of ' + TYPES.join(', ')); })(),
      language: LANGS.includes(b.language) ? b.language : (() => { throw bad('language must be te, en or hi'); })(),
      start_date: date(b.start_date, 'start_date'), end_date: date(b.end_date, 'end_date'),
      window_start: hhmm(b.window_start ?? '09:00', 'window_start'), window_end: hhmm(b.window_end ?? '19:00', 'window_end'),
      max_duration_s: int(b.max_duration_s ?? 150, 30, 600, 'max_duration_s'), retries: int(b.retries ?? 2, 0, 5, 'retries'),
      concurrency: int(b.concurrency ?? 5, 1, 50, 'concurrency'), recording: b.recording === 'on' ? 'on' : 'off'
    };
    if (f.name.length < 3) throw bad('name must be at least 3 characters');
    if (f.window_start >= f.window_end) throw bad('window_start must be before window_end');
    if (f.start_date && f.end_date && f.end_date < f.start_date) throw bad('end_date must not be before start_date');
    return f;
  }
  const uniqueName = async (db, name, exceptId = null) => {
    const r = await db.query('SELECT id FROM feedback_campaigns WHERE lower(name)=$1 AND archived_at IS NULL', [name.toLowerCase()]);
    if (r.rows.some((x) => x.id !== exceptId)) throw bad('A campaign with this name already exists', 409, 'DUPLICATE_NAME');
  };
  const record = (db, c, user, action, changes, version) => db.query('INSERT INTO feedback_campaign_changes (id,campaign_id,user_id,action,version,changes) VALUES ($1,$2,$3,$4,$5,$6)', [newId(), c.id, user.id, action, version ?? c.version, JSON.stringify(changes)]);
  const hasCalls = async (id) => Number((await pool.query('SELECT COUNT(*) AS n FROM feedback_calls WHERE campaign_id=$1', [id])).rows[0].n) > 0;
  const live = (c) => { if (c.archived_at) throw bad('Campaign is archived; restore it to make changes', 409, 'ARCHIVED'); if (c.status === 'closed') throw bad('Campaign is closed', 409, 'CLOSED'); };
  const mayArchive = async (req) => { if (atLeast(req.user.role, 'ADMIN') || req.user.canArchive) return; await audit(req.user.id, 'access_denied', `${req.method} ${req.path} archive not authorised`); throw bad('You are not authorised to archive or restore campaigns', 403, 'FORBIDDEN'); };

  app.get('/api/campaigns', need('VIEWER'), ah(async (req, res) => {
    const mode = req.query.archived || 'exclude';
    if (!['exclude', 'include', 'only'].includes(mode)) throw bad('archived must be exclude, include or only');
    if (mode !== 'exclude' && !atLeast(req.user.role, 'MANAGER')) throw bad('Insufficient role', 403, 'FORBIDDEN');
    const where = mode === 'exclude' ? 'WHERE archived_at IS NULL' : mode === 'only' ? 'WHERE archived_at IS NOT NULL' : '';
    let rows = (await pool.query(`SELECT id,name,purpose,campaign_type,language,status,window_start,window_end,max_duration_s,retries,concurrency,recording,start_date,end_date,created_at,version,archived_at,archived_by FROM feedback_campaigns ${where} ORDER BY created_at DESC`)).rows;
    const al = await allowed(req.user); if (al) rows = rows.filter((r) => al.has(r.id));
    res.json(rows.map((r) => view(r)));
  }));

  app.post('/api/campaigns', need('MANAGER'), ah(async (req, res) => {
    const f = fields(req.body || {}); const id = newId();
    const c = await withTx(pool, async (db) => {
      await uniqueName(db, f.name);
      await db.query('INSERT INTO feedback_campaigns (id,name,purpose,campaign_type,language,start_date,end_date,window_start,window_end,max_duration_s,retries,concurrency,recording,questions,created_by,updated_at,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$15)',
        [id, f.name, f.purpose, f.campaign_type, f.language, f.start_date, f.end_date, f.window_start, f.window_end, f.max_duration_s, f.retries, f.concurrency, f.recording, JSON.stringify(defaultQuestions), req.user.id, new Date()]);
      if (req.user.scope === 'assigned' && !atLeast(req.user.role, 'ADMIN')) await db.query('INSERT INTO user_campaigns (user_id,campaign_id) VALUES ($1,$2)', [req.user.id, id]);
      await record(db, { id, version: 1 }, req.user, 'create', { recording: f.recording, language: f.language });
      return id;
    });
    await audit(req.user.id, 'campaign_create', `${c} "${f.name}" recording=${f.recording}`);
    res.status(201).json(view(await getCampaign(c), true));
  }));

  app.get('/api/campaigns/:id', needC('VIEWER'), ah(async (req, res) => res.json(view(await getCampaign(req.params.id), true))));

  app.patch('/api/campaigns/:id', needC('MANAGER'), ah(async (req, res) => {
    const c = await getCampaign(req.params.id), b = req.body || {}; live(c);
    if (!Number.isInteger(b.version)) throw bad('version is required (reload the campaign and retry)');
    const f = fields({ ...c, description: c.purpose, ...b, ...('description' in b ? {} : { purpose: undefined }) });
    const changes = {}; for (const k of FIELDS) if (String(c[k] ?? '') !== String(f[k] ?? '')) changes[k] = { from: c[k] ?? null, to: f[k] ?? null };
    const keys = Object.keys(changes);
    if (!keys.length) return res.json(view(c, true));
    const pend = keys.filter((k) => AFFECTS_PENDING.includes(k));
    if (c.status === 'active' && pend.length) throw bad(`Pause the campaign before changing: ${pend.join(', ')}`, 409, 'PAUSE_REQUIRED', { fields: pend });
    if (pend.length && await hasCalls(c.id) && b.confirm !== true)
      throw bad('This campaign has already placed calls. These changes affect pending calls and how results are compared in reports.', 409, 'CONFIRM_REQUIRED', { fields: pend });
    if ('name' in changes) await uniqueName(pool, f.name, c.id);
    const out = await withTx(pool, async (db) => {
      const u = await db.query('UPDATE feedback_campaigns SET name=$1,purpose=$2,campaign_type=$3,language=$4,start_date=$5,end_date=$6,window_start=$7,window_end=$8,max_duration_s=$9,retries=$10,concurrency=$11,recording=$12,version=version+1,updated_at=$13,updated_by=$14 WHERE id=$15 AND version=$16 RETURNING version',
        [f.name, f.purpose, f.campaign_type, f.language, f.start_date, f.end_date, f.window_start, f.window_end, f.max_duration_s, f.retries, f.concurrency, f.recording, new Date(), req.user.id, c.id, b.version]);
      if (!u.rows.length) throw bad('This campaign was changed by someone else. Reload and try again.', 409, 'CONFLICT');
      await record(db, c, req.user, 'update', changes, u.rows[0].version);
      return u.rows[0].version;
    });
    await audit(req.user.id, 'campaign_update', `${c.id} v${out} fields=${keys.join(',')}`);
    if (changes.recording) await audit(req.user.id, 'recording_policy_change', `${c.id} ${c.recording}->${f.recording}`);
    res.json(view(await getCampaign(c.id), true));
  }));

  app.put('/api/campaigns/:id/questions', needC('MANAGER'), ah(async (req, res) => {
    const c = await getCampaign(req.params.id), q = req.body?.questions, out = {}; live(c);
    if (!q || typeof q !== 'object') throw bad('questions required');
    for (const l of LANGS) {
      if (!Array.isArray(q[l]) || q[l].length !== 6 || q[l].some((t) => typeof t !== 'string' || !t.trim() || t.length > 600)) throw bad(`questions.${l} must be 6 non-empty strings (greeting + 5 questions)`);
      out[l] = q[l].map((t) => t.trim());
    }
    const changedLangs = LANGS.filter((l) => JSON.stringify(out[l]) !== JSON.stringify(c.questions[l]));
    if (!changedLangs.length) return res.json({ ok: true, changed: [] });
    if (c.status === 'active') throw bad('Pause the campaign before changing the script', 409, 'PAUSE_REQUIRED', { fields: ['script'] });
    if (await hasCalls(c.id) && req.body.confirm !== true) throw bad('Calls have already used the current script; changing it affects pending calls and comparability of results.', 409, 'CONFIRM_REQUIRED', { fields: ['script'] });
    await withTx(pool, async (db) => {
      await db.query('UPDATE feedback_campaigns SET questions=$1,version=version+1,updated_at=$2,updated_by=$3 WHERE id=$4', [JSON.stringify(out), new Date(), req.user.id, c.id]);
      await record(db, c, req.user, 'script_update', { languages: changedLangs }, c.version + 1);
    });
    await audit(req.user.id, 'script_update', `${c.id} languages=${changedLangs.join(',')}`);
    res.json({ ok: true, changed: changedLangs });
  }));

  app.post('/api/campaigns/:id/status', needC('MANAGER'), ah(async (req, res) => {
    const c = await getCampaign(req.params.id), to = req.body?.status;
    if (c.archived_at) throw bad('Campaign is archived; restore it first', 409, 'ARCHIVED');
    if (!(TRANS[c.status] || []).includes(to)) throw bad(`Cannot change status from ${c.status} to ${to}`, 409, 'BAD_TRANSITION');
    if (to === 'active') {
      if (c.end_date && c.end_date < today()) throw bad('The campaign end date has passed; update the schedule first', 409, 'SCHEDULE_PASSED');
      const el = c.status === 'draft' ? await pool.query("SELECT COUNT(*) AS n FROM feedback_contacts WHERE campaign_id=$1 AND status='pending' AND permission='granted' AND permission_at IS NOT NULL", [c.id]) : { rows: [{ n: 1 }] }; // first activation only
      if (Number(el.rows[0].n) === 0) throw bad('Import at least one contact with recorded permission before activating', 409, 'NO_ELIGIBLE_CONTACTS');
    }
    await withTx(pool, async (db) => {
      const u = await db.query('UPDATE feedback_campaigns SET status=$1,version=version+1,updated_at=$2,updated_by=$3 WHERE id=$4 AND status=$5 RETURNING version', [to, new Date(), req.user.id, c.id, c.status]);
      if (!u.rows.length) throw bad('Campaign status changed concurrently', 409, 'CONFLICT');
      await record(db, c, req.user, 'status', { status: { from: c.status, to } }, u.rows[0].version);
    });
    await audit(req.user.id, to === 'active' ? (c.status === 'paused' ? 'campaign_resume' : 'campaign_activate') : to === 'paused' ? 'campaign_pause' : 'campaign_close', `${c.id} ${c.status}->${to}`);
    res.json(view(await getCampaign(c.id)));
  }));

  app.post('/api/campaigns/:id/duplicate', needC('MANAGER'), ah(async (req, res) => {
    const c = await getCampaign(req.params.id); let name = c.name.replace(/ \(copy( \d+)?\)$/, '') + ' (copy)', n = 1;
    while ((await pool.query('SELECT 1 FROM feedback_campaigns WHERE lower(name)=$1 AND archived_at IS NULL', [name.toLowerCase()])).rows.length) name = c.name.replace(/ \(copy( \d+)?\)$/, '') + ` (copy ${++n})`;
    const id = newId();
    await withTx(pool, async (db) => {
      await db.query('INSERT INTO feedback_campaigns (id,name,purpose,campaign_type,language,start_date,end_date,window_start,window_end,max_duration_s,retries,concurrency,recording,questions,created_by,updated_at,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$15)',
        [id, name, c.purpose, c.campaign_type, c.language, c.start_date, c.end_date, c.window_start, c.window_end, c.max_duration_s, c.retries, c.concurrency, c.recording, JSON.stringify(c.questions), req.user.id, new Date()]);
      if (req.user.scope === 'assigned' && !atLeast(req.user.role, 'ADMIN')) await db.query('INSERT INTO user_campaigns (user_id,campaign_id) VALUES ($1,$2)', [req.user.id, id]);
      await record(db, { id, version: 1 }, req.user, 'create', { duplicated_from: c.id });
    });
    await audit(req.user.id, 'campaign_create', `${id} duplicate of ${c.id}`);
    res.status(201).json(view(await getCampaign(id), true));
  }));

  // "Delete" is implemented as archive: nothing linked to calls, recordings, transcripts, feedback or audit logs is ever removed.
  app.post('/api/campaigns/:id/archive', needC('MANAGER'), ah(async (req, res) => {
    await mayArchive(req); const c = await getCampaign(req.params.id);
    if (c.archived_at) throw bad('Campaign is already archived', 409, 'ARCHIVED');
    if (c.status === 'active') throw bad('Pause the campaign before archiving it', 409, 'PAUSE_REQUIRED');
    if (req.body?.confirm_name !== c.name) throw bad('Type the exact campaign name to confirm archiving', 400, 'CONFIRMATION_MISMATCH');
    await withTx(pool, async (db) => {
      await db.query('UPDATE feedback_campaigns SET archived_at=$1,archived_by=$2,version=version+1,updated_at=$1,updated_by=$2 WHERE id=$3', [new Date(), req.user.id, c.id]);
      await record(db, c, req.user, 'archive', { archived: { from: false, to: true } }, c.version + 1);
    });
    await audit(req.user.id, 'campaign_archive', `${c.id} "${c.name}"`);
    res.json(view(await getCampaign(c.id)));
  }));
  app.post('/api/campaigns/:id/restore', needC('MANAGER'), ah(async (req, res) => {
    await mayArchive(req); const c = await getCampaign(req.params.id);
    if (!c.archived_at) throw bad('Campaign is not archived', 409);
    await uniqueName(pool, c.name, c.id);
    await withTx(pool, async (db) => {
      await db.query('UPDATE feedback_campaigns SET archived_at=NULL,archived_by=NULL,version=version+1,updated_at=$1,updated_by=$2 WHERE id=$3', [new Date(), req.user.id, c.id]);
      await record(db, c, req.user, 'restore', { archived: { from: true, to: false } }, c.version + 1);
    });
    await audit(req.user.id, 'campaign_restore', c.id);
    res.json(view(await getCampaign(c.id)));
  }));
  app.get('/api/campaigns/:id/changes', needC('MANAGER'), ah(async (req, res) => {
    await getCampaign(req.params.id);
    res.json((await pool.query('SELECT h.id,h.action,h.version,h.changes,h.created_at,u.email AS by FROM feedback_campaign_changes h LEFT JOIN users u ON u.id=h.user_id WHERE h.campaign_id=$1 ORDER BY h.created_at DESC, h.id LIMIT 200', [req.params.id])).rows);
  }));
  // Only contacts that have never been dialled can be removed (their rows are not linked to any call).
  app.delete('/api/campaigns/:id/contacts/:cid', needC('MANAGER'), ah(async (req, res) => {
    const c = await getCampaign(req.params.id); live(c);
    if (c.status === 'active') throw bad('Pause the campaign before removing contacts', 409, 'PAUSE_REQUIRED');
    const r = await pool.query("DELETE FROM feedback_contacts WHERE id=$1 AND campaign_id=$2 AND status='pending' RETURNING id", [req.params.cid, c.id]);
    if (!r.rows.length) throw bad('Only pending contacts that have not been dialled can be removed', 409);
    await audit(req.user.id, 'contact_remove', `${c.id}`); res.json({ ok: true });
  }));
}
