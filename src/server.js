import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { createApp } from './app.js';
import { seedSuperAdmin } from './auth.js';

const cfg = loadConfig();
if (!cfg.databaseUrl) { console.error('DATABASE_URL is required'); process.exit(1); }
const pool = createPool(cfg.databaseUrl);
if (cfg.autoMigrate) await migrate(pool);
if (await seedSuperAdmin(pool, cfg)) console.log('SuperAdmin created from SUPERADMIN_EMAIL');
const server = createApp({ pool, cfg }).listen(cfg.port, () => console.log(`LeoMox Feedback Call Agent on :${cfg.port} (telephony=${cfg.telephony})`));
const stop = () => server.close(() => pool.end().then(() => process.exit(0)));
process.on('SIGTERM', stop); process.on('SIGINT', stop);
