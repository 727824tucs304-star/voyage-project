import { execFile } from 'node:child_process';
import { db } from './db.js';
import { audit } from './audit.js';

// Reads actual AWS-reported costs from Cost Explorer through the AWS CLI. On EC2 the instance role supplies
// credentials, so none are stored in the application. Cost Explorer data is delayed by roughly a day.
const CLI = process.env.AWS_CLI_BIN || 'aws';
let syncing = false;

const pad = (n) => String(n).padStart(2, '0');
function previousAndCurrentMonth() {
  const now = new Date();
  const fmt = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return {
    start: fmt(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))),
    end: fmt(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))),
  };
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

async function setState(status, message, success) {
  await db.query(
    `INSERT INTO aws_sync_state (id, status, message, last_attempt, last_success)
     VALUES (1, $1, $2, now(), CASE WHEN $3 THEN now() END)
     ON CONFLICT (id) DO UPDATE SET status = $1, message = $2, last_attempt = now(),
       last_success = CASE WHEN $3 THEN now() ELSE aws_sync_state.last_success END`,
    [status, message, success]
  );
}

export async function awsStatus() {
  const { rows } = await db.query('SELECT status, message, last_attempt, last_success FROM aws_sync_state WHERE id = 1');
  return rows[0] || { status: 'never_synced', message: 'AWS cost data has not been synchronised yet.', last_attempt: null, last_success: null };
}

export async function syncAws() {
  if (syncing) return awsStatus();
  syncing = true;
  try {
    const { start, end } = previousAndCurrentMonth();
    const out = await run(CLI, [
      'ce', 'get-cost-and-usage',
      '--time-period', `Start=${start},End=${end}`,
      '--granularity', 'MONTHLY',
      '--metrics', 'UnblendedCost',
      '--group-by', 'Type=DIMENSION,Key=SERVICE',
      '--region', 'us-east-1',
      '--output', 'json',
    ]);
    const data = JSON.parse(out);
    const rows = [];
    for (const period of data.ResultsByTime || []) {
      const month = period.TimePeriod.Start.slice(0, 7);
      for (const g of period.Groups || []) rows.push([month, g.Keys[0], Number(g.Metrics.UnblendedCost.Amount)]);
    }
    const months = [...new Set(rows.map((r) => r[0]))];
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      if (months.length) await client.query('DELETE FROM aws_cost_records WHERE period_month = ANY($1)', [months]);
      for (const [month, service, amount] of rows) {
        await client.query('INSERT INTO aws_cost_records (period_month, service, amount_usd) VALUES ($1, $2, $3)', [month, service, amount]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await setState('ok', `Synchronised ${rows.length} cost lines (${start} to ${end}).`, true);
    audit('aws.sync', { lines: rows.length });
  } catch (err) {
    const msg = err.message || String(err);
    const status = /credential|Unable to locate|AccessDenied|not authorized|ENOENT|could not be found/i.test(msg)
      ? 'not_configured' : 'error';
    await setState(status, msg.slice(0, 300), false);
    audit('aws.sync_failed', { status, message: msg.slice(0, 200) });
  } finally {
    syncing = false;
  }
  return awsStatus();
}
