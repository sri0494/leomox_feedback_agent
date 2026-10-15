import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export const createPool = (url) => new pg.Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30_000 });

// Applies versioned .sql files in order, each in a transaction. Safe if two instances start together:
// the loser hits a conflict, re-checks and moves on.
export async function migrate(pool, log = console.log) {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const done = await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f]);
    if (done.rows.length) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      await client.query('COMMIT');
      log(`migration applied: ${f}`);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      const again = await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f]);
      if (!again.rows.length) throw e;
    } finally {
      client.release();
    }
  }
}
