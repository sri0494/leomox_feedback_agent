export const LANGS = ['te', 'en', 'hi'];
export const PERMS = ['granted', 'denied', 'unknown', 'withdrawn'];

export function parseLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}
export const normalizeMobile = (raw) => String(raw).replace(/[\s-]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, '');
export const validMobile = (m) => /^[6-9]\d{9}$/.test(m);

export function validateCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { fatal: 'CSV is empty' };
  const header = parseLine(lines.shift()).map((h) => h.toLowerCase());
  const miss = ['mobile_number', 'preferred_language', 'contact_permission_status'].filter((h) => !header.includes(h));
  if (miss.length) return { fatal: 'Missing required columns: ' + miss.join(', ') };
  if (lines.length > 5000) return { fatal: 'Too many rows (max 5000 per import)' };
  const seen = new Set(), rows = [], errors = [];
  lines.forEach((ln, i) => {
    const v = parseLine(ln), r = {};
    header.forEach((h, j) => (r[h] = v[j] || ''));
    const number = normalizeMobile(r.mobile_number), e = [];
    if (!validMobile(number)) e.push('Invalid mobile number'); else if (seen.has(number)) e.push('Duplicate number in file');
    if (!LANGS.includes(r.preferred_language)) e.push('Language must be te, en or hi');
    if (!PERMS.includes(r.contact_permission_status)) e.push('Unrecognised permission status');
    if (e.length) { errors.push({ row: i + 2, error: e.join('; '), data: ln }); return; }
    seen.add(number);
    const eligible = r.contact_permission_status === 'granted' && !!r.permission_recorded_at;
    rows.push({ number, language: r.preferred_language, locality: r.locality || null, mandal: r.mandal || null, constituency: r.constituency || null,
      permission: r.contact_permission_status, permission_at: r.permission_recorded_at || null, source: r.source || null,
      eligible, reason: eligible ? '' : r.contact_permission_status !== 'granted' ? 'Permission not granted' : 'No permission timestamp' });
  });
  return { rows, errors };
}
export const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export const mask = (n) => 'XXXXXX' + String(n).slice(-4);
