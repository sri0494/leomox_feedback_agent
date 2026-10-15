export function loadConfig(env = process.env) {
  const prod = env.NODE_ENV === 'production';
  const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d);
  const c = {
    prod,
    port: num(env.PORT, 3000),
    databaseUrl: env.DATABASE_URL || '',
    idleMs: num(env.SESSION_IDLE_MINUTES, 15) * 60_000,
    maxMs: num(env.SESSION_MAX_HOURS, 12) * 3_600_000,
    superEmail: (env.SUPERADMIN_EMAIL || '').trim().toLowerCase(),
    superPassword: env.SUPERADMIN_PASSWORD || '',
    webhookSecret: env.WEBHOOK_SIGNING_SECRET || '',
    telephony: env.TELEPHONY_PROVIDER || 'mock',
    stt: env.STT_PROVIDER || 'mock',
    tts: env.TTS_PROVIDER || 'mock',
    ai: env.AI_PROVIDER || 'mock',
    mockIgnoreWindow: env.MOCK_IGNORE_CALLING_WINDOW !== 'false',
    autoMigrate: env.AUTO_MIGRATE !== 'false',
    trustProxy: env.TRUST_PROXY !== 'false'
  };
  const errs = [];
  if (prod && !c.databaseUrl) errs.push('DATABASE_URL is required in production');
  if (c.superEmail && c.superPassword.length < 10) errs.push('SUPERADMIN_PASSWORD must be at least 10 characters');
  for (const k of ['telephony', 'stt', 'tts', 'ai'])
    if (c[k] !== 'mock') errs.push(`${k.toUpperCase()}_PROVIDER="${c[k]}" is not implemented yet; use "mock"`);
  if (errs.length) throw new Error('Invalid configuration: ' + errs.join('; '));
  return c;
}
