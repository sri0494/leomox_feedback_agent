import { newDb } from 'pg-mem';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { createMockTelephony, mulberry32 } from '../src/providers.js';

export const PW = 'Correct-Horse-9';
export async function boot(over = {}) {
  // TEST_DATABASE_URL => run against a real Postgres (isolated schema per boot); otherwise in-memory pg-mem.
  let pool, dropSchema = async () => {};
  if (process.env.TEST_DATABASE_URL) {
    const url = process.env.TEST_DATABASE_URL, schema = 't_' + crypto.randomBytes(5).toString('hex');
    const admin = new pg.Pool({ connectionString: url, max: 1 }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 5 });
    dropSchema = async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); };
  } else { pool = new (newDb().adapters.createPg().Pool)(); }
  await migrate(pool, () => {});
  const cfg = { ...loadConfig({ NODE_ENV: 'test', WEBHOOK_SIGNING_SECRET: 'whsec_test_123' }), ...over };
  for (const [email, role] of [['super@t.io', 'SUPER_ADMIN'], ['admin@t.io', 'ADMIN'], ['mgr@t.io', 'MANAGER'], ['view@t.io', 'VIEWER']])
    await pool.query('INSERT INTO users (id,email,name,password_hash,role) VALUES ($1,$2,$3,$4,$5)', [crypto.randomUUID(), email, role, bcrypt.hashSync(PW, 4), role]);
  const app = createApp({ pool, cfg, telephony: createMockTelephony(mulberry32(over.seed ?? 7)) });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { pool, cfg, base, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => dropSchema().then(r, r)); }), client: (tab) => makeClient(base, tab) };
}

export function makeClient(base, tab = crypto.randomBytes(8).toString('hex')) {
  const jar = {};
  const c = {
    tab, csrf: null, jar,
    async req(method, path, body, extra = {}) {
      const headers = { 'x-tab-id': c.tab, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra };
      if (c.csrf && !('x-csrf-token' in extra)) headers['x-csrf-token'] = c.csrf;
      const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) headers.cookie = cookie;
      const r = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      for (const sc of r.headers.getSetCookie()) {
        const [pair] = sc.split(';'); const i = pair.indexOf('=');
        const name = pair.slice(0, i), val = pair.slice(i + 1);
        if (/expires=thu, 01 jan 1970/i.test(sc) || val === '') delete jar[name]; else jar[name] = val;
      }
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, json, text, headers: r.headers };
    },
    get: (p, e) => c.req('GET', p, undefined, e), post: (p, b = {}, e) => c.req('POST', p, b, e), put: (p, b, e) => c.req('PUT', p, b, e),
    async login(email, password = PW) { const r = await c.post('/api/auth/login', { email, password }); if (r.status === 200) c.csrf = r.json.csrfToken; return r; }
  };
  return c;
}
export const CSV = `mobile_number,preferred_language,locality,mandal,constituency,contact_permission_status,permission_recorded_at,source
9876543210,te,Ward 4,Mangalagiri,,granted,2026-09-01,a
+919812345678,en,Ward 7,Tadepalli,,granted,2026-09-02,a
9000011111,hi,Ward 1,Mangalagiri,,granted,2026-09-02,a
9876543210,te,dup,,,granted,2026-09-01,a
12345,te,,,,granted,2026-09-01,b
9123456780,fr,,,,granted,2026-09-01,b
9345678901,te,Ward 2,,,unknown,,b
9456789012,te,Ward 9,,,denied,2026-09-03,b
9567890123,en,Ward 1,,,granted,2026-09-04,c
9678901234,te,Ward 3,,,granted,2026-09-04,c
9789012345,te,Ward 5,,,granted,2026-09-05,c
9890123456,hi,Ward 6,,,granted,2026-09-05,c
9701234567,te,Ward 8,,,granted,2026-09-06,c
9612345678,en,Ward 2,,,granted,2026-09-06,c
9523456789,te,Ward 4,,,granted,2026-09-06,c
9434567890,te,Ward 1,,,granted,2026-09-07,c`;
export const campaignBody = (o = {}) => ({ name: 'Test campaign', language: 'te', ...o });
