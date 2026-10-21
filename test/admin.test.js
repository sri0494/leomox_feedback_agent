import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, CSV, campaignBody, PW, reauth, loginAs, tokenFrom } from './helpers.js';

const mk = async (m, o = {}) => (await m.post('/api/campaigns', campaignBody(o))).json;
const withCalls = async (t, m, c) => { await m.post(`/api/campaigns/${c.id}/contacts/import`, { csv: CSV }); await m.post(`/api/campaigns/${c.id}/status`, { status: 'active' }); await m.post(`/api/campaigns/${c.id}/run`, { limit: 100 }); await m.post(`/api/campaigns/${c.id}/status`, { status: 'paused' }); };

test('campaign create: full field set, validation, duplicate names, history + audit', async () => {
  const t = await boot(); const m = await loginAs(t, 'mgr@t.io'), ad = await loginAs(t, 'admin@t.io');
  const c = await mk(m, { name: 'Water Survey', description: 'Phase 1', campaign_type: 'follow_up_survey', start_date: '2026-11-01', end_date: '2026-11-30', retries: 3 });
  assert.equal(c.status, 'draft'); assert.equal(c.description, 'Phase 1'); assert.equal(c.campaign_type, 'follow_up_survey'); assert.match(c.consent_requirement, /always enforced/); assert.equal(c.version, 1);
  for (const bad of [{ name: 'ab' }, { language: 'xx' }, { campaign_type: 'robocall' }, { window_start: '20:00', window_end: '09:00' }, { start_date: '2026-12-01', end_date: '2026-11-01' }, { retries: 99 }, { start_date: 'tomorrow' }])
    assert.equal((await m.post('/api/campaigns', campaignBody(bad))).status, 400, JSON.stringify(bad));
  const dup = await m.post('/api/campaigns', campaignBody({ name: 'water survey' })); assert.equal(dup.status, 409); assert.equal(dup.json.code, 'DUPLICATE_NAME');
  const h = (await m.get(`/api/campaigns/${c.id}/changes`)).json; assert.equal(h[0].action, 'create'); assert.equal(h[0].by, 'mgr@t.io');
  assert.ok((await ad.get('/api/audit')).json.some((l) => l.action === 'campaign_create'));
  await t.close();
});

test('campaign edit: loads values, records who/when/what, optimistic locking, pause-before-change, confirm when started', async () => {
  const t = await boot(); const m = await loginAs(t, 'mgr@t.io'), ad = await loginAs(t, 'admin@t.io');
  const c = await mk(m);
  assert.equal((await m.req('PATCH', `/api/campaigns/${c.id}`, { name: 'Renamed campaign' })).status, 400, 'version required');
  const ok = await m.req('PATCH', `/api/campaigns/${c.id}`, { version: c.version, name: 'Renamed campaign', description: 'New text', retries: 1 });
  assert.equal(ok.status, 200); assert.equal(ok.json.name, 'Renamed campaign'); assert.equal(ok.json.version, 2); assert.equal(ok.json.retries, 1);
  const hist = (await m.get(`/api/campaigns/${c.id}/changes`)).json.find((x) => x.action === 'update');
  assert.deepEqual(Object.keys(hist.changes).sort(), ['name', 'purpose', 'retries']); assert.equal(hist.by, 'mgr@t.io'); assert.ok(hist.created_at);
  const stale = await m.req('PATCH', `/api/campaigns/${c.id}`, { version: 1, name: 'Stale edit' }); assert.equal(stale.status, 409); assert.equal(stale.json.code, 'CONFLICT');
  const [a, b] = await Promise.all([1, 2].map((i) => m.req('PATCH', `/api/campaigns/${c.id}`, { version: 2, description: 'race ' + i })));
  assert.deepEqual([a.status, b.status].sort(), [200, 409], 'concurrent edits: exactly one wins');
  const log = (await ad.get('/api/audit')).json.find((l) => l.action === 'campaign_update'); assert.match(log.detail, /fields=/);
  // started campaign rules
  const c2 = await mk(m, { name: 'Started one' }); await withCalls(t, m, c2); let cur = (await m.get(`/api/campaigns/${c2.id}`)).json;
  await m.post(`/api/campaigns/${c2.id}/status`, { status: 'active' }); cur = (await m.get(`/api/campaigns/${c2.id}`)).json;
  const pr = await m.req('PATCH', `/api/campaigns/${c2.id}`, { version: cur.version, retries: 0 }); assert.equal(pr.status, 409); assert.equal(pr.json.code, 'PAUSE_REQUIRED');
  assert.equal((await m.req('PATCH', `/api/campaigns/${c2.id}`, { version: cur.version, name: 'Started renamed' })).status, 200, 'name is safe while active');
  await m.post(`/api/campaigns/${c2.id}/status`, { status: 'paused' }); cur = (await m.get(`/api/campaigns/${c2.id}`)).json;
  const cf = await m.req('PATCH', `/api/campaigns/${c2.id}`, { version: cur.version, retries: 0 }); assert.equal(cf.status, 409); assert.equal(cf.json.code, 'CONFIRM_REQUIRED'); assert.deepEqual(cf.json.fields, ['retries']);
  assert.equal((await m.req('PATCH', `/api/campaigns/${c2.id}`, { version: cur.version, retries: 0, confirm: true })).status, 200);
  const sc = { ...cur.questions, te: cur.questions.te.map((x, i) => (i === 1 ? 'Edited question' : x)) };
  assert.equal((await m.put(`/api/campaigns/${c2.id}/questions`, { questions: sc })).json.code, 'CONFIRM_REQUIRED');
  assert.equal((await m.put(`/api/campaigns/${c2.id}/questions`, { questions: sc, confirm: true })).status, 200);
  await t.close();
});

test('archive: confirmation, permissions, history preserved, read-only, restore, default list excludes', async () => {
  const t = await boot(); const m = await loginAs(t, 'mgr@t.io'), ad = await loginAs(t, 'admin@t.io'), v = await loginAs(t, 'view@t.io');
  const c = await mk(m, { name: 'To archive' }); await withCalls(t, m, c);
  const before = { calls: (await t.pool.query('SELECT COUNT(*) AS n FROM feedback_calls')).rows[0].n, resp: (await t.pool.query('SELECT COUNT(*) AS n FROM feedback_responses')).rows[0].n };
  assert.ok(Number(before.calls) > 0 && Number(before.resp) > 0);
  assert.equal((await m.post(`/api/campaigns/${c.id}/archive`, { confirm_name: c.name })).status, 403, 'manager without explicit authorisation');
  assert.equal((await v.post(`/api/campaigns/${c.id}/archive`, { confirm_name: c.name })).status, 403);
  await m.post(`/api/campaigns/${c.id}/status`, { status: 'active' });
  assert.equal((await ad.post(`/api/campaigns/${c.id}/archive`, { confirm_name: c.name })).json.code, 'PAUSE_REQUIRED');
  await m.post(`/api/campaigns/${c.id}/status`, { status: 'paused' });
  const mis = await ad.post(`/api/campaigns/${c.id}/archive`, { confirm_name: 'wrong' }); assert.equal(mis.status, 400); assert.equal(mis.json.code, 'CONFIRMATION_MISMATCH');
  const ar = await ad.post(`/api/campaigns/${c.id}/archive`, { confirm_name: c.name }); assert.equal(ar.status, 200); assert.equal(ar.json.status_display, 'archived'); assert.ok(ar.json.archived_at); assert.ok(ar.json.archived_by);
  const after = { calls: (await t.pool.query('SELECT COUNT(*) AS n FROM feedback_calls')).rows[0].n, resp: (await t.pool.query('SELECT COUNT(*) AS n FROM feedback_responses')).rows[0].n };
  assert.deepEqual(after, before, 'calls, responses/transcripts/feedback untouched');
  assert.equal((await m.get(`/api/calls?campaign_id=${c.id}`)).json.total, Number(before.calls), 'history still readable');
  assert.equal((await m.get(`/api/campaigns/${c.id}/analytics`)).status, 200); assert.equal((await m.get(`/api/campaigns/${c.id}/export.csv`)).status, 200);
  assert.ok(!(await m.get('/api/campaigns')).json.some((x) => x.id === c.id), 'excluded by default');
  assert.ok((await m.get('/api/campaigns?archived=include')).json.some((x) => x.id === c.id)); assert.equal((await m.get('/api/campaigns?archived=only')).json.length, 1);
  assert.equal((await v.get('/api/campaigns?archived=include')).status, 403);
  for (const [fn, why] of [[() => m.post(`/api/campaigns/${c.id}/status`, { status: 'active' }), 'status'], [() => m.post(`/api/campaigns/${c.id}/run`, {}), 'run'], [() => m.post(`/api/campaigns/${c.id}/contacts/import`, { csv: CSV }), 'import'], [() => m.req('PATCH', `/api/campaigns/${c.id}`, { version: 99, name: 'nope nope' }), 'edit']])
    assert.equal((await fn()).json.code, 'ARCHIVED', why);
  const clash = await mk(m, { name: 'To archive' }); assert.equal((await ad.post(`/api/campaigns/${c.id}/restore`, {})).json.code, 'DUPLICATE_NAME', 'restore cannot create a duplicate name');
  await t.pool.query('UPDATE feedback_campaigns SET name=$1 WHERE id=$2', ['Other name', clash.id]);
  const rs = await ad.post(`/api/campaigns/${c.id}/restore`, {}); assert.equal(rs.status, 200); assert.equal(rs.json.archived, false);
  // explicit authorisation lets a manager archive
  const su = await loginAs(t, 'super@t.io'); const mid = (await t.pool.query("SELECT id FROM users WHERE email='mgr@t.io'")).rows[0].id;
  assert.equal((await su.req('PATCH', `/api/users/${mid}`, { can_archive: true, ...reauth })).status, 200);
  const m2 = await loginAs(t, 'mgr@t.io'); assert.equal((await m2.post(`/api/campaigns/${c.id}/archive`, { confirm_name: c.name })).status, 200);
  const actions = (await ad.get('/api/audit')).json.map((l) => l.action); assert.ok(actions.includes('campaign_archive') && actions.includes('campaign_restore'));
  await t.close();
});

test('assigned-scope users only see and reach their campaigns (server-enforced)', async () => {
  const t = await boot(); const su = await loginAs(t, 'super@t.io'), m = await loginAs(t, 'mgr@t.io');
  const mine = await mk(su, { name: 'Mine here' }), other = await mk(su, { name: 'Not mine' });
  await withCalls(t, su, other);
  const mid = (await t.pool.query("SELECT id FROM users WHERE email='mgr@t.io'")).rows[0].id;
  assert.equal((await su.req('PATCH', `/api/users/${mid}`, { campaign_scope: 'assigned', campaign_ids: [mine.id], ...reauth })).status, 200);
  assert.equal((await m.get('/api/campaigns')).status, 401, 'privilege change revoked the session');
  const m2 = await loginAs(t, 'mgr@t.io');
  assert.deepEqual((await m2.get('/api/campaigns')).json.map((x) => x.id), [mine.id]);
  for (const p of [`/api/campaigns/${other.id}`, `/api/campaigns/${other.id}/analytics`, `/api/campaigns/${other.id}/export.csv`, `/api/campaigns/${other.id}/contacts`]) assert.equal((await m2.get(p)).status, 404, p);
  assert.equal((await m2.post(`/api/campaigns/${other.id}/run`, {})).status, 404);
  assert.equal((await m2.get('/api/calls')).json.total, 0); assert.equal((await m2.get(`/api/calls?campaign_id=${other.id}`)).json.total, 0);
  const callId = (await t.pool.query('SELECT id FROM feedback_calls LIMIT 1')).rows[0].id; assert.equal((await m2.get(`/api/calls/${callId}`)).status, 404);
  const own = await mk(m2, { name: 'Created by scoped' }); assert.equal((await m2.get(`/api/campaigns/${own.id}`)).status, 200, 'creator is auto-assigned');
  assert.ok((await su.get('/api/audit')).json.some((l) => l.action === 'access_denied'));
  await t.close();
});

test('user invitation flow, duplicate email, token expiry and single use', async () => {
  const t = await boot(); const ad = await loginAs(t, 'admin@t.io');
  const body = { name: 'Asha K', email: 'Asha@T.io', role: 'MANAGER', phone: '+91 98765 43210' };
  const inv = await ad.post('/api/users', body); assert.equal(inv.status, 201); assert.equal(inv.json.status, 'invited'); assert.match(inv.json.invite_link, /#invite=/);
  assert.equal(JSON.stringify(inv.json).includes('password'), false, 'no password fields in response');
  assert.equal((await ad.post('/api/users', { ...body, email: 'asha@t.io' })).json.code, 'DUPLICATE_EMAIL');
  assert.equal((await t.client().login('asha@t.io', 'Whatever-123')).status, 401, 'cannot log in before accepting invite');
  const tok = tokenFrom(inv.json.invite_link), anon = t.client();
  const stored = (await t.pool.query('SELECT token_hash FROM user_tokens')).rows.map((r) => r.token_hash); assert.ok(!stored.includes(tok), 'only a hash is stored');
  assert.equal((await anon.post('/api/auth/complete', { token: tok, password: 'short' })).json.code, 'WEAK_PASSWORD');
  assert.equal((await anon.post('/api/auth/complete', { token: tok, password: 'Fresh-Strong-77!' })).status, 200);
  assert.equal((await anon.post('/api/auth/complete', { token: tok, password: 'Another-Strong-88!' })).json.code, 'INVALID_TOKEN', 'single use');
  assert.equal((await t.client().login('asha@t.io', 'Fresh-Strong-77!')).status, 200);
  // expiry
  const u2 = await ad.post('/api/users', { name: 'B', email: 'b@t.io', role: 'VIEWER' }); await t.pool.query('UPDATE user_tokens SET expires_at=$1', [new Date(Date.now() - 1000)]);
  assert.equal((await anon.post('/api/auth/complete', { token: tokenFrom(u2.json.invite_link), password: 'Good-Pass-1234' })).json.code, 'INVALID_TOKEN');
  assert.equal((await anon.post('/api/auth/complete', { token: 'x'.repeat(40), password: 'Good-Pass-1234' })).json.code, 'INVALID_TOKEN');
  const f1 = await anon.post('/api/auth/forgot', { email: 'asha@t.io' }), f2 = await anon.post('/api/auth/forgot', { email: 'nobody@t.io' }); assert.deepEqual(f1.json, f2.json, 'no account enumeration');
  await t.close();
});

test('admin reset: link works once, expires, ends all sessions and replaces the password', async () => {
  const t = await boot(); const ad = await loginAs(t, 'admin@t.io'), m = await loginAs(t, 'mgr@t.io'); const mid = (await t.pool.query("SELECT id FROM users WHERE email='mgr@t.io'")).rows[0].id;
  assert.equal((await ad.post(`/api/users/${mid}/reset`, {})).json.code, 'REAUTH_REQUIRED');
  const r = await ad.post(`/api/users/${mid}/reset`, reauth); assert.equal(r.json.kind, 'reset'); assert.match(r.json.link, /#reset=/);
  const tok = tokenFrom(r.json.link), anon = t.client();
  assert.equal((await anon.post('/api/auth/complete', { token: tok, password: 'Brand-New-Pass-5' })).status, 200);
  assert.equal((await m.get('/api/auth/me')).status, 401, 'old sessions invalidated');
  assert.equal((await t.client().login('mgr@t.io', PW)).status, 401); assert.equal((await t.client().login('mgr@t.io', 'Brand-New-Pass-5')).status, 200);
  assert.equal((await anon.post('/api/auth/complete', { token: tok, password: 'Brand-New-Pass-6' })).json.code, 'INVALID_TOKEN');
  const r2 = await ad.post(`/api/users/${mid}/reset`, reauth); await t.pool.query('UPDATE user_tokens SET expires_at=$1', [new Date(Date.now() - 1000)]);
  assert.equal((await anon.post('/api/auth/complete', { token: tokenFrom(r2.json.link), password: 'Brand-New-Pass-7' })).json.code, 'INVALID_TOKEN', 'expired');
  const r3 = await ad.post(`/api/users/${mid}/reset`, reauth), r4 = await ad.post(`/api/users/${mid}/reset`, reauth);
  assert.equal((await anon.post('/api/auth/complete', { token: tokenFrom(r3.json.link), password: 'Brand-New-Pass-8' })).json.code, 'INVALID_TOKEN', 'issuing a new link voids the older one');
  assert.equal((await anon.post('/api/auth/complete', { token: tokenFrom(r4.json.link), password: 'Brand-New-Pass-8' })).status, 200);
  assert.ok((await ad.get('/api/audit')).json.some((l) => l.action === 'password_reset_completed'));
  await t.close();
});

test('disabling a user ends sessions immediately and blocks login; re-enable restores access', async () => {
  const t = await boot(); const ad = await loginAs(t, 'admin@t.io'), m = await loginAs(t, 'mgr@t.io'), m2 = await loginAs(t, 'mgr@t.io'); const mid = (await t.pool.query("SELECT id FROM users WHERE email='mgr@t.io'")).rows[0].id;
  assert.equal((await ad.post(`/api/users/${mid}/disable`, {})).json.code, 'REAUTH_REQUIRED');
  assert.equal((await ad.post(`/api/users/${mid}/disable`, { reauth_password: 'wrong-password-1' })).status, 403);
  const d = await ad.post(`/api/users/${mid}/disable`, reauth); assert.equal(d.json.status, 'disabled');
  for (const c of [m, m2]) { assert.equal((await c.get('/api/campaigns')).status, 401); assert.equal((await c.post('/api/campaigns', campaignBody())).status, 401); }
  assert.equal((await t.client().login('mgr@t.io')).status, 401);
  assert.equal((await ad.post(`/api/users/${mid}/enable`, reauth)).json.status, 'active');
  assert.equal((await t.client().login('mgr@t.io')).status, 200);
  const acts = (await ad.get('/api/audit')).json.map((l) => l.action); assert.ok(acts.includes('user_disable') && acts.includes('user_enable') && acts.includes('reauth_failed'));
  await t.close();
});

test('privilege rules: no escalation, no self-elevation, admins cannot touch admins, role change ends sessions', async () => {
  const t = await boot(); const ad = await loginAs(t, 'admin@t.io'), su = await loginAs(t, 'super@t.io'), m = await loginAs(t, 'mgr@t.io');
  const id = async (e) => (await t.pool.query('SELECT id FROM users WHERE email=$1', [e])).rows[0].id; const [aid, mid, sid] = [await id('admin@t.io'), await id('mgr@t.io'), await id('super@t.io')];
  const nu = (role, email) => ({ name: 'N', email, role, ...reauth });
  assert.equal((await ad.post('/api/users', nu('SUPER_ADMIN', 's2@t.io'))).status, 403); assert.equal((await ad.post('/api/users', nu('ADMIN', 'a2@t.io'))).status, 403);
  assert.equal((await ad.req('PATCH', `/api/users/${aid}`, { role: 'SUPER_ADMIN', ...reauth })).json.code, 'SELF_MODIFICATION');
  assert.equal((await m.req('PATCH', `/api/users/${mid}`, { role: 'ADMIN' })).status, 403, 'manager cannot reach the admin API');
  assert.equal((await ad.req('PATCH', `/api/users/${sid}`, { name: 'Hacked' })).status, 403); assert.equal((await ad.post(`/api/users/${sid}/disable`, reauth)).status, 403); assert.equal((await ad.post(`/api/users/${sid}/reset`, reauth)).status, 403);
  assert.equal((await ad.req('PATCH', `/api/users/${mid}`, { role: 'SUPER_ADMIN', ...reauth })).status, 403);
  assert.equal((await ad.req('PATCH', `/api/users/${mid}`, { role: 'ADMIN', ...reauth })).status, 403);
  assert.equal((await ad.req('PATCH', `/api/users/${mid}`, { role: 'VIEWER' })).json.code, 'REAUTH_REQUIRED');
  assert.equal((await ad.req('PATCH', `/api/users/${mid}`, { role: 'VIEWER', ...reauth })).status, 200);
  assert.equal((await m.get('/api/campaigns')).status, 401, 'old session ended after role change');
  assert.equal((await su.post('/api/users', nu('ADMIN', 'a3@t.io'))).status, 201);
  assert.equal((await su.post(`/api/users/${sid}/disable`, reauth)).json.code, 'SELF_MODIFICATION');
  assert.equal((await su.req('PATCH', `/api/users/${sid}`, { role: 'ADMIN', ...reauth })).json.code, 'SELF_MODIFICATION');
  assert.equal((await ad.post('/api/users', { name: 'N', email: 'bad-email', role: 'VIEWER' })).status, 400);
  assert.ok((await su.get('/api/audit')).json.some((l) => l.action === 'access_denied'), 'denied attempts are audited');
  assert.ok((await su.get('/api/audit')).json.some((l) => l.action === 'user_role_change'));
  await t.close();
});

test('the last active SUPER_ADMIN cannot be disabled or demoted, even by concurrent requests', async () => {
  const t = await boot(); const a = await loginAs(t, 'super@t.io');
  const b = (await a.post('/api/users', { name: 'S2', email: 's2@t.io', role: 'SUPER_ADMIN', ...reauth })).json;
  await t.client().post('/api/auth/complete', { token: tokenFrom(b.invite_link), password: 'Second-Super-99!' });
  const bc = await loginAs(t, 's2@t.io').catch(() => null); const bc2 = bc || t.client(); if (!bc) await bc2.login('s2@t.io', 'Second-Super-99!');
  const ida = (await t.pool.query("SELECT id FROM users WHERE email='super@t.io'")).rows[0].id, idb = (await t.pool.query("SELECT id FROM users WHERE email='s2@t.io'")).rows[0].id;
  const res = await Promise.all([a.post(`/api/users/${idb}/disable`, reauth), bc2.post(`/api/users/${ida}/disable`, { reauth_password: 'Second-Super-99!' })]);
  const active = (await t.pool.query("SELECT COUNT(*) AS n FROM users WHERE role='SUPER_ADMIN' AND status='active'")).rows[0].n;
  assert.ok(Number(active) >= 1, 'at least one active SUPER_ADMIN always remains: ' + res.map((r) => r.status));
  await t.close();
});

test('every administrative endpoint rejects lower roles and anonymous callers; no secrets in responses', async () => {
  const t = await boot(); const v = await loginAs(t, 'view@t.io'), m = await loginAs(t, 'mgr@t.io'), ad = await loginAs(t, 'admin@t.io'), anon = t.client();
  const c = await mk(ad, { name: 'Perm test' }); const uid = (await t.pool.query("SELECT id FROM users WHERE email='view@t.io'")).rows[0].id;
  const adminOnly = [['GET', '/api/users'], ['GET', `/api/users/${uid}`], ['POST', '/api/users'], ['PATCH', `/api/users/${uid}`], ['POST', `/api/users/${uid}/disable`], ['POST', `/api/users/${uid}/enable`], ['POST', `/api/users/${uid}/reset`], ['GET', '/api/audit']];
  for (const [mt, p] of adminOnly) for (const cl of [v, m]) assert.equal((await cl.req(mt, p, mt === 'GET' ? undefined : {})).status, 403, `${mt} ${p}`);
  for (const [mt, p] of adminOnly) assert.equal((await anon.req(mt, p, mt === 'GET' ? undefined : {})).status, 401, `anon ${mt} ${p}`);
  const mgrOnly = [['POST', '/api/campaigns'], ['PATCH', `/api/campaigns/${c.id}`], ['POST', `/api/campaigns/${c.id}/status`], ['POST', `/api/campaigns/${c.id}/duplicate`], ['POST', `/api/campaigns/${c.id}/archive`], ['POST', `/api/campaigns/${c.id}/restore`], ['GET', `/api/campaigns/${c.id}/changes`], ['PUT', `/api/campaigns/${c.id}/questions`]];
  for (const [mt, p] of mgrOnly) assert.equal((await v.req(mt, p, mt === 'GET' ? undefined : {})).status, 403, `viewer ${mt} ${p}`);
  assert.equal((await v.get(`/api/campaigns/${c.id}`)).status, 200, 'viewer can read');
  for (const [, p] of [['', '/api/users']]) { const r = await ad.get(p); assert.ok(r.status === 200); assert.ok(!/password|hash|token/i.test(r.text.replace(/campaign|password_changed_at/g, '')), 'no hashes/tokens in user list'); }
  assert.ok(!/password_hash|token_hash/.test((await ad.get(`/api/users/${uid}`)).text));
  assert.equal((await ad.post('/api/users', { name: 'X', email: 'x@t.io', role: 'VIEWER' })).status, 201); assert.equal((await t.pool.query("SELECT 1 FROM users WHERE email='x@t.io' AND status='invited'")).rows.length, 1);
  await t.close();
});

test('password policy', async () => {
  const { passwordPolicy } = await import('../src/auth.js');
  assert.ok(passwordPolicy('short1!').length); assert.ok(passwordPolicy('password123').length); assert.ok(passwordPolicy('onlyletterslong').length); assert.ok(passwordPolicy('mgr-person-2026', 'mgr-person@x.io').length);
  assert.deepEqual(passwordPolicy('Correct-Horse-9', 'a@b.io'), []);
});
