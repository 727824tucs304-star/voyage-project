import pg from 'pg';
import { config } from './config.js';
import { db, adminPool } from './db.js';
import { inspectContainer } from './docker.js';
import { tenantSecrets } from './security.js';
import { audit } from './audit.js';

const TENANT_DDL = 'CREATE TABLE IF NOT EXISTS usage_daily (day DATE PRIMARY KEY, api_requests INTEGER NOT NULL DEFAULT 0)';

// Reads the per-day request counts from the client's own database, as the client's own role.
async function tenantDays(t) {
  const { dbPassword } = tenantSecrets(t.slug);
  const client = new pg.Client({
    connectionString: `postgres://${t.db_user}:${dbPassword}@${config.tenantPgHost}:${config.tenantPgPort}/${t.db_name}`,
  });
  await client.connect();
  try {
    await client.query(TENANT_DDL);
    const { rows } = await client.query('SELECT day::text AS day, api_requests FROM usage_daily');
    return rows;
  } finally {
    await client.end();
  }
}

async function collectOne(t) {
  const today = new Date().toISOString().slice(0, 10);
  const size = Number((await adminPool.query('SELECT pg_database_size($1)::bigint AS bytes', [t.db_name])).rows[0].bytes);
  const info = await inspectContainer(t.container_name);
  const running = info?.State?.Running ? 1 : 0;

  for (const d of await tenantDays(t)) {
    await db.query(
      `INSERT INTO usage_daily (slug, day, api_requests, storage_bytes) VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug, day) DO UPDATE SET api_requests = EXCLUDED.api_requests,
         storage_bytes = CASE WHEN EXCLUDED.day = CURRENT_DATE THEN EXCLUDED.storage_bytes ELSE usage_daily.storage_bytes END`,
      [t.slug, d.day, d.api_requests, d.day === today ? size : 0]
    );
  }
  await db.query(
    `INSERT INTO usage_daily (slug, day, running_samples, storage_bytes) VALUES ($1, $2, $3, $4)
     ON CONFLICT (slug, day) DO UPDATE SET running_samples = usage_daily.running_samples + EXCLUDED.running_samples,
       storage_bytes = EXCLUDED.storage_bytes`,
    [t.slug, today, running, size]
  );
}

export async function collectUsage() {
  const { rows } = await db.query("SELECT * FROM tenants WHERE status = 'ready'");
  for (const t of rows) {
    try {
      await collectOne(t);
    } catch (err) {
      audit('usage.error', { slug: t.slug, error: err.message });
    }
  }
  audit('usage.collected', { tenants: rows.length });
}
