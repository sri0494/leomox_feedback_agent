import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { boot, CSV, campaignBody } from './helpers.js';
import { validateCsv, csvCell, normalizeMobile } from '../src/csv.js';
import { validateClassification, mockClassify, inCallingWindow, verifySignature } from '../src/providers.js';
import { loadConfig } from '../src/config.js';

const sign = (secret, body) => crypto.createHmac('sha256', secret).update(body).digest('hex');
async function setup(over) {
  const t = await boot(over); const m = t.client(); await m.login('mgr@t.io');
  const c = (await m.post('/api/campaigns', campaignBody())).json;
  return { t, m, c };
}

test('CSV validation: formats, duplicates, malformed rows, eligibility', () => {
  const v = validateCsv(CSV);
  assert.equal(v.rows.length + v.errors.length, 16);
  assert.equal(v.errors.length, 3);
  assert.ok(v.errors.some((e) => /Invalid mobile/.test(e.error)) && v.errors.some((e) => /Duplicate/.test(e.error)) && v.errors.some((e) => /Language/.test(e.error)));
  assert.equal(v.rows.find((r) => r.number === '9812345678').eligible, true, '+91 normalised');
  assert.equal(v.rows.find((r) => r.number === '9345678901').eligible, false);
  assert.equal(v.rows.find((r) => r.number === '9456789012').reason, 'Permission not granted');
  assert.match(validateCsv('a,b\n1,2').fatal, /Missing required columns/);
  assert.equal(normalizeMobile('098765 43210'), '9876543210');
});
test('CSV export is protected against formula injection', () => { assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"'); assert.equal(csvCell('+1'), "'+1"); });

test('classification schema rejects malformed AI output and requires transcript evidence', () => {
  const text = 'Water comes only every other day.';
  const good = mockClassify({ text, qi: 0, sttConfidence: 0.8 });
  assert.deepEqual(validateClassification(good, text), []);
  assert.ok(validateClassification({ ...good, sentiment: 'angry' }, text).length);
  assert.ok(validateClassification({ ...good, excerpt: 'invented quote' }, text).length);
  assert.ok(validateClassification({ ...good, extra: 1 }, text).length);
  assert.ok(validateClassification({ ...good, confidence: 2 }, text).length);
});

test('calling window is evaluated in IST', () => {
  assert.equal(inCallingWindow(new Date('2026-10-14T05:00:00Z'), '09:00', '19:00'), true);   // 10:30 IST
  assert.equal(inCallingWindow(new Date('2026-10-14T14:00:00Z'), '09:00', '19:00'), false);  // 19:30 IST
  assert.equal(inCallingWindow(new Date('2026-10-14T02:00:00Z'), '09:00', '19:00'), false);  // 07:30 IST
});
test('config validation: provider names and weak superadmin password are rejected', () => {
  assert.throws(() => loadConfig({ TELEPHONY_PROVIDER: 'twilio' }), /not implemented/);
  assert.throws(() => loadConfig({ SUPERADMIN_EMAIL: 'a@b.io', SUPERADMIN_PASSWORD: 'short' }), /at least 10/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /DATABASE_URL/);
  assert.doesNotThrow(() => loadConfig({}));
});

test('end-to-end mock campaign: create -> import -> dry-run -> run -> analytics -> export; no duplicate calls', async () => {
  const { t, m, c } = await setup(); const id = c.id;
  const prev = await m.post(`/api/campaigns/${id}/contacts/validate`, { csv: CSV });
  assert.equal(prev.json.errors.length, 3); assert.match(prev.json.rows[0].number, /^XXXXXX\d{4}$/);
  const imp = await m.post(`/api/campaigns/${id}/contacts/import`, { csv: CSV });
  assert.equal(imp.json.inserted, 13); assert.equal(imp.json.rejected, 3);
  assert.equal((await m.post(`/api/campaigns/${id}/contacts/import`, { csv: CSV })).json.already_in_campaign, 13, 're-import is idempotent');
  const dry = (await m.get(`/api/campaigns/${id}/dry-run`)).json; assert.equal(dry.pending, 13); assert.equal(dry.eligible, 11); assert.equal(dry.no_permission, 2);
  assert.equal((await m.post(`/api/campaigns/${id}/run`, {})).status, 409, 'draft campaign cannot run');
  assert.equal((await m.post(`/api/campaigns/${id}/status`, { status: 'active' })).status, 200);
  const run = (await m.post(`/api/campaigns/${id}/run`, { limit: 100 })).json;
  assert.equal(run.mock, true); assert.equal(run.skipped_permission, 2); assert.equal(run.claimed, 11);
  const run2 = (await m.post(`/api/campaigns/${id}/run`, { limit: 100 })).json; assert.equal(run2.claimed, 0, 'repeat run dials nobody twice');
  const calls = (await m.get(`/api/calls?campaign_id=${id}`)).json; assert.equal(calls.total, 11); assert.ok(calls.items.every((x) => x.is_mock === true && /^XXXXXX/.test(x.number)));
  const dup = (await t.pool.query('SELECT contact_id, COUNT(*) AS n FROM feedback_calls GROUP BY contact_id')).rows; assert.ok(dup.every((r) => Number(r.n) === 1));
  const an = (await m.get(`/api/campaigns/${id}/analytics`)).json;
  assert.equal(an.totals.attempted, 11); assert.equal(an.rates.answer.den, 11);
  assert.equal(an.rates.completion.den, an.totals.answered, 'completion denominator is answered calls');
  assert.equal(an.mock, true);
  const detail = (await m.get(`/api/calls/${calls.items.find((x) => x.outcome === 'completed').id}`)).json;
  assert.ok(detail.responses.length > 0 && detail.timeline.length > 0);
  for (const r of detail.responses.filter((r) => r.classification)) assert.ok(r.transcript.includes(r.classification.excerpt), 'every classification links to source evidence');
  const exp = await m.get(`/api/campaigns/${id}/export.csv`); assert.equal(exp.status, 200); assert.match(exp.text, /^call_id,outcome/); assert.doesNotMatch(exp.text, /\b9876543210\b/, 'export masks numbers');
  const f = (await m.get(`/api/calls?campaign_id=${id}&outcome=declined`)).json; assert.ok(f.items.every((x) => x.outcome === 'declined'));
  assert.equal((await m.get(`/api/calls?campaign_id=${id}&pageSize=3&page=2`)).json.items.length, 3);
  await t.close();
});

test('declined/opted-out contacts are suppressed and never dialled again (even in another campaign)', async () => {
  const { t, m, c } = await setup({ seed: 3 });
  await m.post(`/api/campaigns/${c.id}/contacts/import`, { csv: CSV }); await m.post(`/api/campaigns/${c.id}/status`, { status: 'active' });
  await m.post(`/api/campaigns/${c.id}/run`, { limit: 100 });
  const sup = (await t.pool.query('SELECT number FROM feedback_suppression_entries')).rows.map((r) => r.number);
  const nonCompleted = (await t.pool.query("SELECT k.number FROM feedback_calls c JOIN feedback_contacts k ON k.id=c.contact_id WHERE c.outcome IN ('declined','opted_out')")).rows.map((r) => r.number);
  assert.deepEqual(new Set(sup), new Set(nonCompleted)); assert.ok(sup.length > 0, 'seed produced at least one decline/opt-out');
  const c2 = (await m.post('/api/campaigns', campaignBody({ name: 'Second' }))).json;
  await m.post(`/api/campaigns/${c2.id}/contacts/import`, { csv: CSV }); await m.post(`/api/campaigns/${c2.id}/status`, { status: 'active' });
  const r2 = (await m.post(`/api/campaigns/${c2.id}/run`, { limit: 100 })).json;
  assert.equal(r2.skipped_suppressed, sup.length);
  const redialled = (await t.pool.query('SELECT 1 FROM feedback_calls c JOIN feedback_contacts k ON k.id=c.contact_id WHERE c.campaign_id=$1 AND k.number = ANY($2)', [c2.id, sup])).rows; assert.equal(redialled.length, 0);
  await t.close();
});

test('manual suppression is honoured before dialling', async () => {
  const { t, m, c } = await setup();
  await m.post(`/api/campaigns/${c.id}/contacts/import`, { csv: CSV }); await m.post('/api/suppression', { number: '+91 98765 43210' });
  await m.post(`/api/campaigns/${c.id}/status`, { status: 'active' });
  assert.equal((await m.post(`/api/campaigns/${c.id}/run`, { limit: 100 })).json.skipped_suppressed, 1);
  await t.close();
});

test('calling window enforced when mock override is off', async () => {
  const { t, m, c } = await setup({ mockIgnoreWindow: false });
  await m.req('PATCH', `/api/campaigns/${c.id}`, { version: c.version, window_start: '00:00', window_end: '00:01' });
  await m.post(`/api/campaigns/${c.id}/contacts/import`, { csv: CSV }); await m.post(`/api/campaigns/${c.id}/status`, { status: 'active' });
  const r = (await m.post(`/api/campaigns/${c.id}/run`, { limit: 100 })).json;
  assert.equal(r.claimed, 0); assert.equal(r.deferred_window, 11);
  assert.equal((await t.pool.query("SELECT 1 FROM feedback_contacts WHERE status='pending'")).rows.length, 11, 'deferred contacts stay pending (the 2 without permission are skipped)');
  await t.close();
});

test('campaign lifecycle rules, script validation and recording audit', async () => {
  const { t, m, c } = await setup(); const ad = t.client(); await ad.login('admin@t.io');
  assert.equal((await m.post(`/api/campaigns/${c.id}/status`, { status: 'paused' })).status, 409);
  const noc = await m.post(`/api/campaigns/${c.id}/status`, { status: 'active' }); assert.equal(noc.status, 409); assert.equal(noc.json.code, 'NO_ELIGIBLE_CONTACTS');
  await m.post(`/api/campaigns/${c.id}/contacts/import`, { csv: CSV });
  assert.equal((await m.post(`/api/campaigns/${c.id}/status`, { status: 'active' })).status, 200); await m.post(`/api/campaigns/${c.id}/status`, { status: 'paused' });
  assert.equal((await m.post(`/api/campaigns/${c.id}/status`, { status: 'active' })).status, 200);
  await m.post(`/api/campaigns/${c.id}/status`, { status: 'closed' });
  assert.equal((await m.post(`/api/campaigns/${c.id}/status`, { status: 'active' })).status, 409);
  const dup = await m.post(`/api/campaigns/${c.id}/duplicate`); assert.equal(dup.json.status, 'draft');
  assert.equal((await m.put(`/api/campaigns/${dup.json.id}/questions`, { questions: { en: ['x'], te: [], hi: [] } })).status, 400);
  assert.equal((await m.put(`/api/campaigns/${c.id}/questions`, { questions: dup.json.questions })).status, 409, 'closed campaigns are read-only');
  assert.equal((await m.req('PATCH', `/api/campaigns/${dup.json.id}`, { version: dup.json.version, recording: 'on' })).status, 200);
  assert.ok((await ad.get('/api/audit')).json.some((l) => l.action === 'recording_policy_change'));
  assert.equal((await m.post('/api/campaigns', { name: '', language: 'zz' })).status, 400);
  await t.close();
});

test('webhook: signature required, schema validated, idempotent, out-of-order safe, opt-out suppresses', async () => {
  const { t, m, c } = await setup({ seed: 11 });
  await m.post(`/api/campaigns/${c.id}/contacts/import`, { csv: CSV }); await m.post(`/api/campaigns/${c.id}/status`, { status: 'active' }); await m.post(`/api/campaigns/${c.id}/run`, { limit: 100 });
  const call = (await t.pool.query("SELECT provider_call_id, contact_id FROM feedback_calls WHERE outcome='completed' LIMIT 1")).rows[0];
  const send = (obj, sig) => { const body = JSON.stringify(obj); return fetch(t.base + '/api/webhooks/telephony', { method: 'POST', headers: { 'content-type': 'application/json', 'x-leomox-signature': sig ?? sign(t.cfg.webhookSecret, body) }, body }).then(async (r) => ({ status: r.status, json: await r.json() })); };
  const ev = { event_id: 'e1', provider_call_id: call.provider_call_id, type: 'opted_out' };
  assert.equal((await send(ev, 'deadbeef')).status, 401, 'bad signature');
  assert.equal((await send({ event_id: '', provider_call_id: 'x', type: 'bogus' })).status, 400, 'schema');
  assert.equal((await send({ ...ev, type: 'ringing', event_id: 'e0' })).json.applied, false, 'stale/out-of-order event ignored');
  const first = await send(ev); assert.equal(first.json.applied, true);
  assert.equal((await send(ev)).json.duplicate, true, 'duplicate delivery deduplicated');
  const num = (await t.pool.query('SELECT number FROM feedback_contacts WHERE id=$1', [call.contact_id])).rows[0].number;
  assert.equal((await t.pool.query('SELECT 1 FROM feedback_suppression_entries WHERE number=$1', [num])).rows.length, 1);
  assert.equal(Number((await t.pool.query("SELECT COUNT(*) AS n FROM feedback_webhook_events WHERE event_id='e1'")).rows[0].n), 1);
  assert.equal(verifySignature('', Buffer.from('x'), 'x'), false);
  await t.close();
});

test('webhook is refused when no signing secret is configured', async () => {
  const t = await boot({ webhookSecret: '' });
  const r = await fetch(t.base + '/api/webhooks/telephony', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(r.status, 503);
  await t.close();
});

test('health endpoints, security headers, no secrets or stack traces in errors', async () => {
  const t = await boot();
  assert.equal((await fetch(t.base + '/healthz')).status, 200); assert.equal((await fetch(t.base + '/readyz')).status, 200);
  const r = await fetch(t.base + '/'); assert.equal(r.status, 200); assert.ok(r.headers.get('content-security-policy')); assert.equal(r.headers.get('cache-control'), 'no-store');
  const bad = await fetch(t.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' }); assert.equal(bad.status, 400);
  assert.equal((await fetch(t.base + '/api/nope')).status, 404);
  await t.close();
});

test('CSP: scripts restricted to self; upgrade-insecure-requests only in production', async () => {
  const dev = await boot({ prod: false }), prod = await boot({ prod: true });
  const d = (await fetch(dev.base + '/')).headers.get('content-security-policy'), p = (await fetch(prod.base + '/')).headers.get('content-security-policy');
  assert.match(d, /script-src 'self'/); assert.match(p, /script-src 'self'/);
  assert.doesNotMatch(d, /upgrade-insecure-requests/); assert.match(p, /upgrade-insecure-requests/);
  await dev.close(); await prod.close();
});
