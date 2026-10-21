import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { newId, atLeast, ROLES, hashPassword, revokeUserSessions, passwordPolicy, sha, withTx } from './auth.js';

const SAFE = 'id,email,name,phone,role,status,campaign_scope,can_archive,created_at,disabled_at,password_changed_at';
const RESET_MS = 30 * 60_000, INVITE_MS = 48 * 3_600_000;
const manageable = (actor, targetRole) => actor === 'SUPER_ADMIN' || (actor === 'ADMIN' && ['MANAGER', 'VIEWER'].includes(targetRole));
const assignable = manageable;

// Row lock so two concurrent requests cannot each remove "the other" SUPER_ADMIN. Real PostgreSQL supports it;
// the in-memory test database does not, so support is detected once.
let rowLocks = null;
async function lockSuperAdmins(db) {
  if (rowLocks === false) return;
  try { await db.query("SELECT id FROM users WHERE role='SUPER_ADMIN' ORDER BY id FOR UPDATE"); rowLocks = true; }
  catch (e) { if (rowLocks === true) throw e; rowLocks = false; }
}

const otherActiveSupers = async (db, id) => Number((await db.query("SELECT COUNT(*) AS n FROM users WHERE role='SUPER_ADMIN' AND status='active' AND id <> $1", [id])).rows[0].n) > 0;

// Single-process queue for SUPER_ADMIN changes (the DB row lock covers multiple instances).
let chain = Promise.resolve();
const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

export function mountUsers(app, { pool, need, audit, ah, bad }) {
  const tx = (target, fn) => (target.role === 'SUPER_ADMIN' ? serial(() => withTx(pool, fn)) : withTx(pool, fn));
  const deny = async (req, why, code = 'FORBIDDEN') => { await audit(req.user.id, 'access_denied', `${req.method} ${req.path}: ${why}`); throw bad(why, 403, code); };
  async function reauth(req) {
    const pw = String(req.body?.reauth_password || '');
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    if (!pw || !(await bcrypt.compare(pw, rows[0].password_hash))) { await audit(req.user.id, 'reauth_failed', `${req.method} ${req.path}`); throw bad('Confirm your password to continue', 403, 'REAUTH_REQUIRED'); }
  }
  const getUser = async (id) => { const { rows } = await pool.query(`SELECT ${SAFE} FROM users WHERE id=$1`, [String(id)]); if (!rows[0]) throw bad('User not found', 404); return rows[0]; };
  const withScope = async (u) => ({ ...u, campaign_ids: (await pool.query('SELECT campaign_id FROM user_campaigns WHERE user_id=$1', [u.id])).rows.map((r) => r.campaign_id) });
  async function issueToken(db, userId, kind, ms, by) {
    await db.query('UPDATE user_tokens SET used_at=$1 WHERE user_id=$2 AND used_at IS NULL', [new Date(), userId]); // older links die when a new one is issued
    const raw = crypto.randomBytes(32).toString('base64url'), expires = new Date(Date.now() + ms);
    await db.query('INSERT INTO user_tokens (id,user_id,kind,token_hash,expires_at,created_by) VALUES ($1,$2,$3,$4,$5,$6)', [newId(), userId, kind, sha(raw), expires, by]);
    return { raw, expires };
  }
  const link = (req, kind, raw) => `${req.protocol}://${req.get('host')}/#${kind}=${raw}`;
  const scopeArgs = async (db, b) => {
    const scope = b.campaign_scope ?? 'all'; if (!['all', 'assigned'].includes(scope)) throw bad('campaign_scope must be all or assigned');
    const ids = Array.isArray(b.campaign_ids) ? [...new Set(b.campaign_ids.map(String))] : [];
    if (scope === 'assigned') for (const id of ids) if (!(await db.query('SELECT 1 FROM feedback_campaigns WHERE id=$1', [id])).rows.length) throw bad('Unknown campaign in campaign_ids');
    return { scope, ids: scope === 'assigned' ? ids : [] };
  };
  const checkPhone = (v) => { const s = String(v ?? '').trim(); if (s && !/^\+?[0-9 ()-]{7,20}$/.test(s)) throw bad('Invalid phone number'); return s || null; };

  app.get('/api/users', need('ADMIN'), ah(async (req, res) => {
    const st = req.query.status; const rows = (await pool.query(`SELECT ${SAFE} FROM users ORDER BY created_at DESC, id`)).rows;
    res.json(rows.filter((u) => !st || u.status === st));
  }));
  app.get('/api/users/:id', need('ADMIN'), ah(async (req, res) => res.json(await withScope(await getUser(req.params.id)))));

  app.post('/api/users', need('ADMIN'), ah(async (req, res) => {
    const b = req.body || {}, email = String(b.email || '').trim().toLowerCase(), name = String(b.name || '').trim();
    if (!name || name.length > 100) throw bad('Full name is required (max 100 characters)');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) throw bad('Invalid email address');
    if (!ROLES.includes(b.role)) throw bad('Invalid role');
    if (!assignable(req.user.role, b.role)) await deny(req, 'You cannot assign that role');
    if (atLeast(b.role, 'ADMIN')) await reauth(req);
    const phone = checkPhone(b.phone), canArchive = b.can_archive === true && b.role === 'MANAGER';
    if ((await pool.query('SELECT 1 FROM users WHERE email=$1', [email])).rows.length) throw bad('An account with this email already exists', 409, 'DUPLICATE_EMAIL');
    const id = newId();
    let tok;
    try {
      tok = await withTx(pool, async (db) => {
        const sc = await scopeArgs(db, b);
        await db.query('INSERT INTO users (id,email,name,phone,password_hash,role,status,campaign_scope,can_archive) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [id, email, name, phone, hashPassword(crypto.randomBytes(24).toString('hex')), b.role, 'invited', sc.scope, canArchive]); // unusable password until the invite is accepted
        for (const c of sc.ids) await db.query('INSERT INTO user_campaigns (user_id,campaign_id) VALUES ($1,$2)', [id, c]);
        return issueToken(db, id, 'invite', INVITE_MS, req.user.id);
      });
    } catch (e) { if (/unique|duplicate/i.test(e.message) && !e.expose) throw bad('An account with this email already exists', 409, 'DUPLICATE_EMAIL'); throw e; }
    await audit(req.user.id, 'user_create', `${id} ${email} role=${b.role}`);
    res.status(201).json({ id, email, role: b.role, status: 'invited', invite_link: link(req, 'invite', tok.raw), invite_expires_at: tok.expires, note: 'Share this one-time link securely; it is not shown again.' });
  }));

  app.patch('/api/users/:id', need('ADMIN'), ah(async (req, res) => {
    const t = await getUser(req.params.id), b = req.body || {}, self = t.id === req.user.id;
    if (!self && !manageable(req.user.role, t.role)) await deny(req, 'You cannot manage this account');
    const set = {}, changes = {}; let sensitive = false;
    if ('name' in b) { const n = String(b.name).trim(); if (!n || n.length > 100) throw bad('Invalid name'); if (n !== t.name) { set.name = n; changes.name = true; } }
    if ('phone' in b) { const p = checkPhone(b.phone); if (p !== t.phone) { set.phone = p; changes.phone = true; } }
    if ('role' in b && b.role !== t.role) {
      if (!ROLES.includes(b.role)) throw bad('Invalid role');
      if (self) await deny(req, 'You cannot change your own role', 'SELF_MODIFICATION');
      if (!assignable(req.user.role, b.role)) await deny(req, 'You cannot assign that role');
      await reauth(req); set.role = b.role; changes.role = { from: t.role, to: b.role }; sensitive = true;
    }
    const newRole = set.role || t.role;
    if ('can_archive' in b && (b.can_archive === true) !== t.can_archive) {
      if (self) await deny(req, 'You cannot change your own permissions', 'SELF_MODIFICATION');
      if (b.can_archive === true && newRole !== 'MANAGER') throw bad('Archive permission applies to MANAGER accounts only');
      set.can_archive = b.can_archive === true; changes.can_archive = set.can_archive; sensitive = true;
    }
    if (set.role && set.role !== 'MANAGER' && t.can_archive && !('can_archive' in set)) { set.can_archive = false; changes.can_archive = false; }
    let sc = null;
    if ('campaign_scope' in b || 'campaign_ids' in b) {
      const want = await scopeArgs(pool, { campaign_scope: b.campaign_scope ?? t.campaign_scope, campaign_ids: b.campaign_ids });
      const cur = (await pool.query('SELECT campaign_id FROM user_campaigns WHERE user_id=$1', [t.id])).rows.map((r) => r.campaign_id).sort();
      if (want.scope !== t.campaign_scope || JSON.stringify([...want.ids].sort()) !== JSON.stringify(cur)) { // only a real change counts
        if (self) await deny(req, 'You cannot change your own access scope', 'SELF_MODIFICATION');
        sc = want; set.campaign_scope = sc.scope; changes.campaign_scope = sc.scope; sensitive = true;
      }
    }
    if (!Object.keys(set).length && !sc) return res.json(await withScope(t));
    await tx(t, async (db) => {
      if (set.role && t.role === 'SUPER_ADMIN' && t.status === 'active') {
        await lockSuperAdmins(db);
        if (!(await otherActiveSupers(db, t.id))) throw bad('The last active SUPER_ADMIN cannot be demoted', 409, 'LAST_SUPER_ADMIN');
      }
      const cols = Object.keys(set); if (cols.length) await db.query(`UPDATE users SET ${cols.map((c, i) => `${c}=$${i + 2}`).join(',')} WHERE id=$1`, [t.id, ...cols.map((c) => set[c])]);
      if (sc) { await db.query('DELETE FROM user_campaigns WHERE user_id=$1', [t.id]); for (const c of sc.ids) await db.query('INSERT INTO user_campaigns (user_id,campaign_id) VALUES ($1,$2)', [t.id, c]); }
      if (sensitive) await revokeUserSessions(db, t.id); // privileges changed: force re-login
    });
    await audit(req.user.id, changes.role ? 'user_role_change' : 'user_update', `${t.id} ${JSON.stringify(changes)}`);
    res.json(await withScope(await getUser(t.id)));
  }));

  const setStatus = (to) => ah(async (req, res) => {
    const t = await getUser(req.params.id);
    if (t.id === req.user.id) await deny(req, 'You cannot change your own account status', 'SELF_MODIFICATION');
    if (!manageable(req.user.role, t.role)) await deny(req, 'You cannot manage this account');
    await reauth(req);
    if (to === 'disabled') {
      if (t.status === 'disabled') throw bad('Account is already disabled', 409);
      await tx(t, async (db) => {
        if (t.role === 'SUPER_ADMIN' && t.status === 'active') {
          await lockSuperAdmins(db);
          if (!(await otherActiveSupers(db, t.id))) throw bad('The last active SUPER_ADMIN cannot be disabled', 409, 'LAST_SUPER_ADMIN');
        }
        await db.query("UPDATE users SET status='disabled',disabled_at=$2,disabled_by=$3 WHERE id=$1", [t.id, new Date(), req.user.id]);
        await revokeUserSessions(db, t.id);
        await db.query('UPDATE user_tokens SET used_at=$1 WHERE user_id=$2 AND used_at IS NULL', [new Date(), t.id]);
      });
      await audit(req.user.id, 'user_disable', t.id);
    } else {
      if (t.status !== 'disabled') throw bad('Account is not disabled', 409);
      await pool.query('UPDATE users SET status=$2,disabled_at=NULL,disabled_by=NULL WHERE id=$1', [t.id, t.password_changed_at ? 'active' : 'invited']);
      await audit(req.user.id, 'user_enable', t.id);
    }
    res.json(await withScope(await getUser(t.id)));
  });
  app.post('/api/users/:id/disable', need('ADMIN'), setStatus('disabled'));
  app.post('/api/users/:id/enable', need('ADMIN'), setStatus('active'));

  // Admin-initiated reset (or a fresh invite for accounts that never finished setup). Returns a one-time link.
  app.post('/api/users/:id/reset', need('ADMIN'), ah(async (req, res) => {
    const t = await getUser(req.params.id);
    if (!manageable(req.user.role, t.role) && t.id !== req.user.id) await deny(req, 'You cannot manage this account');
    if (t.status === 'disabled') throw bad('Enable the account before issuing a link', 409);
    await reauth(req);
    const kind = t.status === 'invited' ? 'invite' : 'reset';
    const tok = await withTx(pool, (db) => issueToken(db, t.id, kind, kind === 'invite' ? INVITE_MS : RESET_MS, req.user.id));
    await audit(req.user.id, 'password_reset_initiated', `${t.id} kind=${kind}`);
    res.json({ link: link(req, kind, tok.raw), kind, expires_at: tok.expires, note: 'Share this single-use link securely; it is not shown again.' });
  }));

  // ---- public, rate-limited
  const lim = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts, try later' } });
  // No mailer is configured, so this only records the request for administrators; the response never reveals whether the email exists.
  app.post('/api/auth/forgot', lim, ah(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 200);
    const u = email ? (await pool.query('SELECT id,status FROM users WHERE email=$1', [email])).rows[0] : null;
    await audit(u?.status === 'active' ? u.id : null, 'password_reset_requested', u?.status === 'active' ? 'known account' : 'unmatched');
    res.json({ ok: true, message: 'If an account exists for that email, an administrator can issue a reset link.' });
  }));
  app.post('/api/auth/complete', lim, ah(async (req, res) => {
    const token = String(req.body?.token || ''), password = String(req.body?.password || ''), invalid = () => bad('This link is invalid or has expired', 400, 'INVALID_TOKEN');
    if (token.length < 20 || token.length > 200) throw invalid();
    const { rows } = await pool.query('SELECT t.id,t.user_id,t.kind,t.expires_at,t.used_at,u.email,u.status FROM user_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=$1', [sha(token)]);
    const t = rows[0];
    if (!t || t.used_at || new Date(t.expires_at) < new Date() || t.status === 'disabled') throw invalid();
    const problems = passwordPolicy(password, t.email); if (problems.length) throw bad('Password must have: ' + problems.join('; '), 400, 'WEAK_PASSWORD');
    await withTx(pool, async (db) => {
      const used = await db.query('UPDATE user_tokens SET used_at=$1 WHERE id=$2 AND used_at IS NULL RETURNING id', [new Date(), t.id]); // single use, race-safe
      if (!used.rows.length) throw invalid();
      await db.query("UPDATE users SET password_hash=$2,status='active',password_changed_at=$3,failed_attempts=0,locked_until=NULL WHERE id=$1", [t.user_id, hashPassword(password), new Date()]);
      await db.query('UPDATE user_tokens SET used_at=$1 WHERE user_id=$2 AND used_at IS NULL', [new Date(), t.user_id]);
      await revokeUserSessions(db, t.user_id);
    });
    await audit(t.user_id, t.kind === 'invite' ? 'invite_accepted' : 'password_reset_completed', '');
    res.json({ ok: true });
  }));
}
