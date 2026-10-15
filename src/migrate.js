import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
const cfg = loadConfig();
if (!cfg.databaseUrl) { console.error('DATABASE_URL is required'); process.exit(1); }
const pool = createPool(cfg.databaseUrl);
migrate(pool).then(() => { console.log('migrations complete'); return pool.end(); }).catch((e) => { console.error(e.message); process.exit(1); });
