import { Router } from 'express';
import { db } from './db.js';
import { billingForMonth, loadRates, validateRateUpdate, recordSummaries, RATE_LABELS, DEFAULT_RATES } from './billing.js';
import { syncAws, awsStatus } from './aws-cost.js';
import { collectUsage } from './metering.js';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { audit } from './audit.js';
import { SLUG_RE } from './security.js';

export const billingRouter = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const intervalMinutes = () => config.meterIntervalMs / 60000;
const currentMonth = () => new Date().toISOString().slice(0, 7);
const monthParam = (req) => {
  const m = String(req.query.month || '');
  if (m === '') return currentMonth();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new HttpError(400, 'month must look like 2026-11');
  return m;
};

billingRouter.get('/billing', wrap(async (req, res) => {
  const month = monthParam(req);
  const slug = req.query.slug ? String(req.query.slug) : '';
  if (slug && !SLUG_RE.test(slug)) throw new HttpError(400, 'invalid client');
  const bill = await billingForMonth(month, intervalMinutes());
  const daily = await db.query(
    `SELECT to_char(u.day, 'YYYY-MM-DD') AS day, SUM(u.api_requests)::bigint AS requests,
            SUM(u.running_samples)::bigint AS samples
     FROM usage_daily u WHERE to_char(u.day, 'YYYY-MM') = $1 AND ($2 = '' OR u.slug = $2)
     GROUP BY u.day ORDER BY u.day`,
    [month, slug]
  );
  res.json({
    ...bill,
    tenants: slug ? bill.tenants.filter((t) => t.slug === slug) : bill.tenants,
    daily: daily.rows.map((d) => ({ day: d.day, requests: Number(d.requests), samples: Number(d.samples) })),
    aws_sync: await awsStatus(),
    labels: { estimated: 'Estimated (calculated by the platform)', aws: 'AWS-reported (Cost Explorer, delayed about one day)' },
  });
}));

billingRouter.get('/billing/history', wrap(async (req, res) => {
  const slug = String(req.query.slug || '');
  if (!SLUG_RE.test(slug)) throw new HttpError(400, 'a valid client is required');
  const { rows } = await db.query(
    'SELECT month, usage_charges, allocated_aws, platform_fee, total, computed_at FROM billing_summaries WHERE slug = $1 ORDER BY month DESC LIMIT 24',
    [slug]
  );
  res.json(rows);
}));

billingRouter.get('/pricing', wrap(async (req, res) => {
  res.json({ rates: await loadRates(), defaults: DEFAULT_RATES, labels: RATE_LABELS });
}));

billingRouter.put('/pricing', wrap(async (req, res) => {
  const updates = await validateRateUpdate(req.body?.rates);
  for (const [key, value] of Object.entries(updates)) {
    await db.query(
      `INSERT INTO pricing_rules (key, value, updated_at, updated_by) VALUES ($1, $2, now(), 'admin')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = 'admin'`,
      [key, value]
    );
  }
  audit('pricing.update', { keys: Object.keys(updates) });
  res.json({ rates: await loadRates() });
}));

billingRouter.post('/usage/collect', wrap(async (req, res) => {
  await collectUsage();
  await recordSummaries(currentMonth(), intervalMinutes());
  res.json({ collected: true, month: currentMonth() });
}));

billingRouter.post('/aws/sync', wrap(async (req, res) => {
  res.json(await syncAws());
}));

// Scheduled jobs. Each job runs alone, and failures are logged without stopping the platform.
let meteringRunning = false;
export const runBillingJobs = {
  async metering() {
    if (meteringRunning) return;
    meteringRunning = true;
    try {
      await collectUsage();
      await recordSummaries(currentMonth(), intervalMinutes());
    } catch (err) {
      console.error('metering job failed', err.message);
    } finally {
      meteringRunning = false;
    }
  },
  async aws() {
    try {
      await syncAws();
    } catch (err) {
      console.error('aws sync job failed', err.message);
    }
  },
};
