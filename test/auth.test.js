import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, makeClient, PW } from './helpers.js';

test('login, me (refresh), logout, and reuse of a logged-out cookie', async () => {
  const t = await boot(); const a = t.client();
  assert.equal((await a.get('/api/auth/me')).status, 401);
  const l = await a.login('mgr@t.io'); assert.equal(l.status, 200);
  assert.equal(l.json.user.role, 'MANAGER'); assert.equal(l.json.idleSeconds, 900);
  const sc = l.headers.getSetCookie()[0]; assert.match(sc, /HttpOnly/i); assert.match(sc, /SameSite=Lax/i); assert.doesNotMatch(sc, /Max-Age|Expires/i, 'must be a session cookie');
  assert.equal((await a.get('/api/auth/me')).status, 200); // page refresh
  const saved = { ...a.jar };
  assert.equal((await a.post('/api/auth/logout')).status, 200);
  assert.equal((await a.get('/api/auth/me')).status, 401);
  const replay = makeClient(t.base, a.tab); Object.assign(replay.jar, saved);
  const r = await replay.get('/api/auth/me'); assert.equal(r.status, 401, 'revoked session must not be reusable');
  await t.close();
});

test('session cookie is Secure in production', async () => {
  const t = await boot({ prod: true }); const a = t.client();
  const l = await a.login('mgr@t.io'); assert.match(l.headers.getSetCookie()[0], /Secure/i);
  await t.close();
});

test('tab-scoped sessions: a new tab must log in, concurrent tabs stay independent', async () => {
  const t = await boot(); const a = t.client(), b = t.client();
  await a.login('mgr@t.io');
  assert.equal((await b.get('/api/auth/me')).status, 401, 'new tab has no session');
  await b.login('view@t.io');
  assert.equal((await a.get('/api/auth/me')).json.user.role, 'MANAGER');
  assert.equal((await b.get('/api/auth/me')).json.user.role, 'VIEWER');
  await b.post('/api/auth/logout');
  assert.equal((await a.get('/api/auth/me')).status, 200, 'logging out tab B must not log out tab A');
  const stolen = makeClient(t.base, b.tab); Object.assign(stolen.jar, a.jar); // cookie of tab A presented with another tab id
  assert.equal((await stolen.get('/api/auth/me')).status, 401, 'cookie is bound to its tab id');
  await t.close();
});

test('inactivity timeout invalidates server-side and cannot be reused', async () => {
  const t = await boot(); const a = t.client(); await a.login('mgr@t.io');
  await t.pool.query('UPDATE sessions SET last_seen_at=$1', [new Date(Date.now() - 16 * 60_000)]);
  const r = await a.get('/api/campaigns'); assert.equal(r.status, 401); assert.equal(r.json.code, 'SESSION_EXPIRED'); assert.match(r.json.error, /session has expired/i);
  const rows = (await t.pool.query('SELECT revoked_at FROM sessions')).rows; assert.ok(rows[0].revoked_at, 'session revoked in DB');
  assert.equal((await a.get('/api/auth/me')).status, 401);
  await t.close();
});

test('activity within the window keeps the session alive but the absolute max lifetime still applies', async () => {
  const t = await boot(); const a = t.client(); await a.login('mgr@t.io');
  await t.pool.query('UPDATE sessions SET last_seen_at=$1', [new Date(Date.now() - 10 * 60_000)]);
  assert.equal((await a.post('/api/auth/ping')).status, 200); // resets idle timer
  await t.pool.query('UPDATE sessions SET last_seen_at=$1', [new Date(Date.now() - 10 * 60_000)]);
  assert.equal((await a.get('/api/auth/me')).status, 200, 'idle timer was reset by the ping');
  await t.pool.query('UPDATE sessions SET expires_at=$1', [new Date(Date.now() - 1000)]); // activity cannot extend past max lifetime
  assert.equal((await a.get('/api/auth/me')).json.code, 'SESSION_EXPIRED');
  await t.close();
});

test('configurable idle timeout', async () => {
  const t = await boot({ idleMs: 50 }); const a = t.client(); await a.login('mgr@t.io');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal((await a.get('/api/auth/me')).json.code, 'SESSION_EXPIRED');
  await t.close();
});

test('CSRF token required on state-changing requests; cross-origin rejected', async () => {
  const t = await boot(); const a = t.client(); await a.login('mgr@t.io');
  assert.equal((await a.post('/api/campaigns', { name: 'x', language: 'te' }, { 'x-csrf-token': 'wrong' })).status, 403);
  assert.equal((await a.post('/api/campaigns', { name: 'x', language: 'te' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await a.post('/api/campaigns', { name: 'x', language: 'te' })).status, 201);
  await t.close();
});

test('bad credentials, lockout after repeated failures, no user enumeration', async () => {
  const t = await boot(); const a = t.client();
  const e1 = await a.login('nobody@t.io', 'whatever'), e2 = await a.login('mgr@t.io', 'wrong-password');
  assert.equal(e1.status, 401); assert.equal(e1.json.error, e2.json.error);
  for (let i = 0; i < 5; i++) await a.login('view@t.io', 'bad-pass');
  assert.equal((await a.login('view@t.io', PW)).status, 401, 'locked even with right password');
  await t.close();
});

test('every protected endpoint rejects unauthenticated direct requests', async () => {
  const t = await boot(); const a = t.client();
  for (const [m, p] of [['GET', '/api/campaigns'], ['POST', '/api/campaigns'], ['GET', '/api/calls'], ['GET', '/api/calls/x'], ['GET', '/api/campaigns/x/analytics'], ['GET', '/api/campaigns/x/export.csv'], ['POST', '/api/campaigns/x/run'], ['GET', '/api/audit'], ['POST', '/api/users'], ['GET', '/api/providers'], ['POST', '/api/suppression']])
    assert.equal((await a.req(m, p, m === 'POST' ? {} : undefined)).status, 401, `${m} ${p}`);
  await t.close();
});

test('role-based access', async () => {
  const t = await boot(); const v = t.client(), m = t.client(), ad = t.client(), su = t.client();
  await v.login('view@t.io'); await m.login('mgr@t.io'); await ad.login('admin@t.io'); await su.login('super@t.io');
  assert.equal((await v.get('/api/campaigns')).status, 200);
  assert.equal((await v.post('/api/campaigns', { name: 'x', language: 'te' })).status, 403);
  assert.equal((await v.get('/api/calls/anything')).status, 403);
  assert.equal((await m.get('/api/audit')).status, 403);
  assert.equal((await ad.get('/api/audit')).status, 200);
  const nu = { email: 'new@t.io', password: 'LongEnough-123', role: 'MANAGER' };
  assert.equal((await m.post('/api/users', nu)).status, 403);
  assert.equal((await ad.post('/api/users', { ...nu, role: 'SUPER_ADMIN', email: 's2@t.io' })).status, 403);
  assert.equal((await ad.post('/api/users', { ...nu, role: 'ADMIN', email: 'a2@t.io' })).status, 403);
  assert.equal((await ad.post('/api/users', nu)).status, 201);
  assert.equal((await su.post('/api/users', { ...nu, role: 'ADMIN', email: 'a3@t.io' })).status, 201);
  assert.equal((await t.client().login('new@t.io', 'LongEnough-123')).status, 200);
  await t.close();
});
