import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';

export const ROLES = ['VIEWER', 'MANAGER', 'ADMIN', 'SUPER_ADMIN'];
export const atLeast = (role, min) => ROLES.indexOf(role) >= ROLES.indexOf(min);
export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const TAB = /^[a-f0-9]{16,64}$/;
const cookieName = (tab) => 'lm_sid_' + tab.slice(0, 16);
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
export const newId = () => crypto.randomUUID();

function parseCookies(h = '') {
  const out = {};
  for (const p of h.split(';')) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return out;
}
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export function createAuth({ pool, cfg, audit }) {
  const cookieOpts = { httpOnly: true, secure: cfg.prod, sameSite: 'lax', path: '/' }; // no maxAge => session cookie

  async function revoke(id) {
    await pool.query('UPDATE sessions SET revoked_at=$1 WHERE id=$2 AND revoked_at IS NULL', [new Date(), id]);
  }

  // Returns { s } for a valid session or { code } explaining why not. Enforces idle + absolute lifetime server-side.
  async function resolve(req) {
    const tab = req.get('x-tab-id') || '';
    if (!TAB.test(tab)) return { code: 'UNAUTHENTICATED', tab: null };
    const sid = parseCookies(req.headers.cookie)[cookieName(tab)];
    if (!sid) return { code: 'UNAUTHENTICATED', tab };
    const { rows } = await pool.query(
      'SELECT s.*, u.email, u.name, u.role, u.status, u.campaign_scope, u.can_archive FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.sid_hash=$1', [sha(sid)]);
    const s = rows[0];
    if (!s || s.tab_id !== tab) return { code: 'UNAUTHENTICATED', tab };
    const now = Date.now();
    if (s.revoked_at) return { code: 'SESSION_EXPIRED', tab };
    if (s.status !== 'active') { await revoke(s.id); return { code: 'UNAUTHENTICATED', tab }; }
    if (now - new Date(s.last_seen_at).getTime() > cfg.idleMs || now > new Date(s.expires_at).getTime()) {
      await revoke(s.id);
      return { code: 'SESSION_EXPIRED', tab };
    }
    await pool.query('UPDATE sessions SET last_seen_at=$1 WHERE id=$2', [new Date(now), s.id]);
    return { s, tab };
  }

  function sameOrigin(req) {
    const o = req.get('origin');
    if (!o) return true;
    try { return new URL(o).host === req.get('host'); } catch { return false; }
  }

  // Auth + CSRF + optional minimum role, enforced on every protected route.
  const requireAuth = (minRole = 'VIEWER') => async (req, res, next) => {
    try {
      const r = await resolve(req);
      if (!r.s) {
        if (r.tab) res.clearCookie(cookieName(r.tab), cookieOpts);
        return res.status(401).json({ error: r.code === 'SESSION_EXPIRED' ? 'Your session has expired. Please log in again.' : 'Authentication required', code: r.code });
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        if (!sameOrigin(req) || !safeEq(req.get('x-csrf-token') || '', r.s.csrf_token))
          return res.status(403).json({ error: 'CSRF validation failed', code: 'CSRF' });
      }
      if (!atLeast(r.s.role, minRole)) {
        await audit(r.s.user_id, 'access_denied', `${req.method} ${req.path} requires ${minRole}, role ${r.s.role}`);
        return res.status(403).json({ error: 'Insufficient role', code: 'FORBIDDEN' });
      }
      req.user = { id: r.s.user_id, email: r.s.email, name: r.s.name, role: r.s.role, scope: r.s.campaign_scope, canArchive: !!r.s.can_archive };
      req.sess = { id: r.s.id, csrf: r.s.csrf_token };
      next();
    } catch (e) { next(e); }
  };

  const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts, try later' } });
  const info = (user, s) => ({
    user: { id: user.id ?? user.user_id, email: user.email, name: user.name, role: user.role, canArchive: !!user.can_archive, campaignScope: user.campaign_scope || 'all' },
    csrfToken: s.csrf_token ?? s.csrf, idleSeconds: cfg.idleMs / 1000, maxSeconds: cfg.maxMs / 1000
  });

  function mount(app) {
    app.post('/api/auth/login', loginLimiter, async (req, res, next) => {
      try {
        const tab = req.get('x-tab-id') || '';
        const email = String(req.body?.email || '').trim().toLowerCase();
        const password = String(req.body?.password || '');
        if (!TAB.test(tab) || !email || !password) return res.status(400).json({ error: 'Email, password and tab id are required' });
        const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
        const u = rows[0];
        const now = new Date();
        const locked = u?.locked_until && new Date(u.locked_until) > now;
        const ok = await bcrypt.compare(password, u?.password_hash || DUMMY_HASH);
        if (!u || u.status !== 'active' || locked || !ok) {
          if (u && !locked) {
            const f = u.failed_attempts + 1;
            await pool.query('UPDATE users SET failed_attempts=$1, locked_until=$2 WHERE id=$3', [f >= 5 ? 0 : f, f >= 5 ? new Date(Date.now() + 15 * 60_000) : null, u.id]);
          }
          await audit(u?.id || null, 'login_failed', email);
          return res.status(401).json({ error: locked ? 'Account temporarily locked' : 'Invalid email or password', code: 'BAD_CREDENTIALS' });
        }
        await pool.query('UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=$1', [u.id]);
        // replace any prior session on this tab; remove stale rows
        const old = parseCookies(req.headers.cookie)[cookieName(tab)];
        if (old) await pool.query('UPDATE sessions SET revoked_at=$1 WHERE sid_hash=$2 AND revoked_at IS NULL', [now, sha(old)]);
        await pool.query('DELETE FROM sessions WHERE expires_at < $1', [new Date(Date.now() - 86_400_000)]);
        const sid = crypto.randomBytes(32).toString('hex');
        const s = { id: newId(), csrf_token: crypto.randomBytes(24).toString('hex') };
        await pool.query('INSERT INTO sessions (id,sid_hash,user_id,tab_id,csrf_token,created_at,last_seen_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$6,$7)',
          [s.id, sha(sid), u.id, tab, s.csrf_token, now, new Date(Date.now() + cfg.maxMs)]);
        res.cookie(cookieName(tab), sid, cookieOpts);
        await audit(u.id, 'login', '');
        res.json(info(u, s));
      } catch (e) { next(e); }
    });

    app.get('/api/auth/me', async (req, res, next) => {
      try {
        const r = await resolve(req);
        if (!r.s) {
          if (r.tab) res.clearCookie(cookieName(r.tab), cookieOpts);
          return res.status(401).json({ error: r.code === 'SESSION_EXPIRED' ? 'Your session has expired. Please log in again.' : 'Authentication required', code: r.code });
        }
        res.json(info({ id: r.s.user_id, email: r.s.email, name: r.s.name, role: r.s.role, can_archive: r.s.can_archive, campaign_scope: r.s.campaign_scope }, r.s));
      } catch (e) { next(e); }
    });

    app.post('/api/auth/ping', requireAuth(), (req, res) => res.json({ ok: true }));

    app.post('/api/auth/logout', async (req, res, next) => {
      try {
        const r = await resolve(req);
        if (r.s) {
          if (!sameOrigin(req) || !safeEq(req.get('x-csrf-token') || '', r.s.csrf_token)) return res.status(403).json({ error: 'CSRF validation failed', code: 'CSRF' });
          await revoke(r.s.id);
          await audit(r.s.user_id, 'logout', '');
        }
        if (r.tab) res.clearCookie(cookieName(r.tab), cookieOpts);
        res.json({ ok: true });
      } catch (e) { next(e); }
    });
  }

  return { requireAuth, mount };
}

export async function seedSuperAdmin(pool, cfg) {
  if (!cfg.superEmail) return false;
  const ex = await pool.query('SELECT 1 FROM users WHERE email=$1', [cfg.superEmail]);
  if (ex.rows.length) return false; // never overwrite existing credentials
  await pool.query('INSERT INTO users (id,email,name,password_hash,role,password_changed_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [newId(), cfg.superEmail, 'Super Admin', bcrypt.hashSync(cfg.superPassword, 12), 'SUPER_ADMIN', new Date()]);
  return true;
}
export const hashPassword = (p) => bcrypt.hashSync(p, Number(process.env.BCRYPT_COST) || 12);

export const revokeUserSessions = (db, userId) => db.query('UPDATE sessions SET revoked_at=$1 WHERE user_id=$2 AND revoked_at IS NULL', [new Date(), userId]);
const COMMON = new Set(['password', 'password1', 'password123', '1234567890', 'qwertyuiop', 'letmein123', 'admin12345', 'welcome123', 'changeme123']);
export function passwordPolicy(pw, email = '') {
  const e = [], p = String(pw || '');
  if (p.length < 10) e.push('at least 10 characters');
  if (p.length > 128) e.push('at most 128 characters');
  if (!(/[a-z]/i.test(p) && /[0-9\W_]/.test(p))) e.push('letters plus at least one digit or symbol');
  if (COMMON.has(p.toLowerCase())) e.push('not a common password');
  const local = String(email).split('@')[0].toLowerCase();
  if (local.length >= 4 && p.toLowerCase().includes(local)) e.push('must not contain your email name');
  return e;
}
export const withTx = async (pool, fn) => {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
};
