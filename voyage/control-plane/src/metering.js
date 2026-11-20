import pg from 'pg';
import { config } from './config.js';
import { db, adminPool } from './db.js';
import { inspectContainer, containerStats } from './docker.js';
import { tenantSecrets } from './security.js';
import { audit } from './audit.js';

// CPU percent of one core-set over the sample window, as Docker reports it.
export function cpuPercent(s) {
  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
  const sysDelta = s.cpu_stats.system_cpu_usage - s.precpu_stats.system_cpu_usage;
  if (!(sysDelta > 0)) return null;
  return (cpuDelta / sysDelta) * (s.cpu_stats.online_cpus || 1) * 100;
}

const networkBytes = (s) => Object.values(s.networks || {}).reduce((sum, n) => sum + (n.rx_bytes || 0) + (n.tx_bytes || 0), 0);

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
  // Resource samples only exist while the container is running; missing samples are skipped, not guessed.
  const stats = running ? await containerStats(t.container_name).catch(() => null) : null;
  const cpu = stats ? cpuPercent(stats) : null;
  const mem = stats?.memory_stats?.usage ?? null;
  const net = stats ? networkBytes(stats) : null;

  for (const d of await tenantDays(t)) {
    await db.query(
      `INSERT INTO usage_daily (slug, day, api_requests, storage_bytes) VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug, day) DO UPDATE SET api_requests = EXCLUDED.api_requests,
         storage_bytes = CASE WHEN EXCLUDED.day = CURRENT_DATE THEN EXCLUDED.storage_bytes ELSE usage_daily.storage_bytes END`,
      [t.slug, d.day, d.api_requests, d.day === today ? size : 0]
    );
  }
  await db.query(
    `INSERT INTO usage_daily (slug, day, running_samples, storage_bytes, cpu_percent_sum, stat_samples,
       mem_bytes_sum, mem_peak_bytes, network_bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (slug, day) DO UPDATE SET
       running_samples = usage_daily.running_samples + EXCLUDED.running_samples,
       storage_bytes = EXCLUDED.storage_bytes,
       cpu_percent_sum = usage_daily.cpu_percent_sum + EXCLUDED.cpu_percent_sum,
       stat_samples = usage_daily.stat_samples + EXCLUDED.stat_samples,
       mem_bytes_sum = usage_daily.mem_bytes_sum + EXCLUDED.mem_bytes_sum,
       mem_peak_bytes = GREATEST(usage_daily.mem_peak_bytes, EXCLUDED.mem_peak_bytes),
       network_bytes = GREATEST(usage_daily.network_bytes, EXCLUDED.network_bytes)`,
    [t.slug, today, running, size, cpu ?? 0, cpu === null ? 0 : 1, mem ?? 0, mem ?? 0, net ?? 0]
  );
}

export async function collectUsage() {
  const { rows } = await db.query("SELECT * FROM tenants WHERE status = 'ready' AND archived_at IS NULL");
  for (const t of rows) {
    try {
      await collectOne(t);
    } catch (err) {
      audit('usage.error', { slug: t.slug, error: err.message });
    }
  }
  audit('usage.collected', { tenants: rows.length });
}
