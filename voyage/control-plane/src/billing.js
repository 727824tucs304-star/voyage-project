import { db } from './db.js';
import { HttpError } from './errors.js';

// Platform prices to clients (not AWS's bill). Admins can change these in the Usage & Billing page.
export const DEFAULT_RATES = {
  base_fee: 9,
  requests_free: 10000, requests_per_1000: 0.5,
  storage_free_mb: 100, storage_per_100mb: 0.1,
  hours_free: 720, hour_price: 0.01,
  cpu_free_core_hours: 10, cpu_per_core_hour: 0.02,
  mem_free_gb_hours: 5, mem_per_gb_hour: 0.005,
  net_free_gb: 1, net_per_gb: 0.05,
  platform_fee: 0,
  alloc_weight_cpu: 0.5, alloc_weight_mem: 0.5,
};

export const RATE_LABELS = {
  base_fee: 'Base fee per client per month (USD)',
  requests_free: 'API requests included per month',
  requests_per_1000: 'API requests: price per 1,000 above allowance (USD)',
  storage_free_mb: 'Database storage included (MB)',
  storage_per_100mb: 'Database storage: price per 100 MB above allowance (USD)',
  hours_free: 'Running hours included per month',
  hour_price: 'Running time: price per hour above allowance (USD)',
  cpu_free_core_hours: 'CPU core-hours included per month',
  cpu_per_core_hour: 'CPU: price per core-hour above allowance (USD)',
  mem_free_gb_hours: 'Memory GB-hours included per month',
  mem_per_gb_hour: 'Memory: price per GB-hour above allowance (USD)',
  net_free_gb: 'Network transfer included per month (GB)',
  net_per_gb: 'Network: price per GB above allowance (USD)',
  platform_fee: 'Optional platform fee per client per month (USD)',
  alloc_weight_cpu: 'Shared EC2 cost: weight of CPU share',
  alloc_weight_mem: 'Shared EC2 cost: weight of memory share',
};

const money = (n) => Math.round(n * 100) / 100;
const round1 = (n) => Math.round(n * 10) / 10;
const GB = 1024 ** 3;
const MB = 1024 ** 2;

export async function loadRates() {
  const { rows } = await db.query('SELECT key, value FROM pricing_rules');
  const rates = { ...DEFAULT_RATES };
  for (const r of rows) if (r.key in DEFAULT_RATES) rates[r.key] = Number(r.value);
  return rates;
}

export async function validateRateUpdate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'rates must be an object');
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (!(key in DEFAULT_RATES)) throw new HttpError(400, `unknown rate: ${key}`);
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1000000) throw new HttpError(400, `${key} must be a number from 0 to 1,000,000`);
    out[key] = n;
  }
  const merged = { ...(await loadRates()), ...out };
  if (Math.abs(merged.alloc_weight_cpu + merged.alloc_weight_mem - 1) > 1e-9) {
    throw new HttpError(400, 'CPU and memory allocation weights must add up to 1');
  }
  return out;
}

// Usage for one month per client, summed from the daily records.
async function monthlyUsage(month) {
  const { rows } = await db.query(
    `SELECT t.slug, t.company_name, t.status,
            COALESCE(SUM(u.api_requests), 0)::bigint AS api_requests,
            COALESCE(MAX(u.storage_bytes), 0)::bigint AS storage_peak_bytes,
            COALESCE(SUM(u.running_samples), 0)::bigint AS running_samples,
            COALESCE(SUM(u.cpu_percent_sum), 0)::float8 AS cpu_percent_sum,
            COALESCE(SUM(u.stat_samples), 0)::bigint AS stat_samples,
            COALESCE(SUM(u.mem_bytes_sum), 0)::float8 AS mem_bytes_sum,
            COALESCE(MAX(u.mem_peak_bytes), 0)::bigint AS mem_peak_bytes,
            COALESCE(SUM(u.network_bytes), 0)::bigint AS network_bytes
     FROM tenants t
     LEFT JOIN usage_daily u ON u.slug = t.slug AND to_char(u.day, 'YYYY-MM') = $1
     WHERE t.archived_at IS NULL
     GROUP BY t.slug, t.company_name, t.status
     ORDER BY t.company_name`,
    [month]
  );
  return rows;
}

// Turns raw counters into billable quantities. Averages use only samples that had a resource reading.
function derive(row, intervalMinutes) {
  const hours = (Number(row.running_samples) * intervalMinutes) / 60;
  const samples = Number(row.stat_samples);
  const cpuAvgPct = samples ? Number(row.cpu_percent_sum) / samples : 0;
  const memAvgBytes = samples ? Number(row.mem_bytes_sum) / samples : 0;
  return {
    requests: Number(row.api_requests),
    storageMb: Number(row.storage_peak_bytes) / MB,
    hours,
    cpuAvgPct,
    coreHours: (cpuAvgPct / 100) * hours,
    memAvgGb: memAvgBytes / GB,
    gbHours: (memAvgBytes / GB) * hours,
    memPeakMb: Number(row.mem_peak_bytes) / MB,
    networkGb: Number(row.network_bytes) / GB,
  };
}

function usageCharges(u, r) {
  const over = (used, free) => Math.max(0, used - free);
  const lines = [
    { item: 'Base plan', quantity: 1, unit: 'per month', included: 1, billable: 1, amount: r.base_fee },
    { item: 'API requests', quantity: u.requests, unit: 'requests', included: r.requests_free,
      billable: over(u.requests, r.requests_free), amount: money((over(u.requests, r.requests_free) / 1000) * r.requests_per_1000) },
    { item: 'Database storage (peak)', quantity: round1(u.storageMb), unit: 'MB', included: r.storage_free_mb,
      billable: round1(over(u.storageMb, r.storage_free_mb)), amount: money(Math.ceil(over(u.storageMb, r.storage_free_mb) / 100) * r.storage_per_100mb) },
    { item: 'Running time', quantity: round1(u.hours), unit: 'hours', included: r.hours_free,
      billable: round1(over(u.hours, r.hours_free)), amount: money(over(u.hours, r.hours_free) * r.hour_price) },
    { item: 'CPU', quantity: round1(u.coreHours), unit: 'core-hours', included: r.cpu_free_core_hours,
      billable: round1(over(u.coreHours, r.cpu_free_core_hours)), amount: money(over(u.coreHours, r.cpu_free_core_hours) * r.cpu_per_core_hour) },
    { item: 'Memory', quantity: round1(u.gbHours), unit: 'GB-hours', included: r.mem_free_gb_hours,
      billable: round1(over(u.gbHours, r.mem_free_gb_hours)), amount: money(over(u.gbHours, r.mem_free_gb_hours) * r.mem_per_gb_hour) },
    { item: 'Network transfer', quantity: round1(u.networkGb), unit: 'GB', included: r.net_free_gb,
      billable: round1(over(u.networkGb, r.net_free_gb)), amount: money(over(u.networkGb, r.net_free_gb) * r.net_per_gb) },
  ];
  return { lines, total: money(lines.reduce((s, l) => s + l.amount, 0)) };
}

// AWS costs for the month, grouped into the three services we allocate, plus everything else.
async function awsForMonth(month) {
  const { rows } = await db.query('SELECT service, amount_usd FROM aws_cost_records WHERE period_month = $1', [month]);
  const out = { ec2: 0, ebs: 0, dataTransfer: 0, other: 0, total: 0, services: [] };
  for (const r of rows) {
    const amount = Number(r.amount_usd);
    const s = r.service;
    if (/Elastic Compute Cloud - Compute/i.test(s)) out.ec2 += amount;
    else if (/Elastic Block Store|^EC2 - Other/i.test(s)) out.ebs += amount;
    else if (/Data Transfer/i.test(s)) out.dataTransfer += amount;
    else out.other += amount;
    out.total += amount;
    out.services.push({ service: s, amount: money(amount) });
  }
  return { ...out, total: money(out.total) };
}

// Full bill view for one month. Every AWS figure here comes from Cost Explorer records, never a guess.
export async function billingForMonth(month, intervalMinutes) {
  const rates = await loadRates();
  const rows = await monthlyUsage(month);
  const usage = rows.map((row) => ({ row, u: derive(row, intervalMinutes) }));
  const totals = usage.reduce((t, { u }) => ({
    core: t.core + u.coreHours, gb: t.gb + u.gbHours, storage: t.storage + u.storageMb, net: t.net + u.networkGb,
  }), { core: 0, gb: 0, storage: 0, net: 0 });
  const aws = await awsForMonth(month);
  const share = (part, whole) => (whole > 0 ? part / whole : 0);

  const tenants = usage.map(({ row, u }) => {
    const charges = usageCharges(u, rates);
    const allocEc2 = aws.ec2 * (rates.alloc_weight_cpu * share(u.coreHours, totals.core) + rates.alloc_weight_mem * share(u.gbHours, totals.gb));
    const allocEbs = aws.ebs * share(u.storageMb, totals.storage);
    const allocNet = aws.dataTransfer * share(u.networkGb, totals.net);
    const allocated = { ec2: money(allocEc2), ebs: money(allocEbs), network: money(allocNet), total: money(allocEc2 + allocEbs + allocNet) };
    return {
      slug: row.slug,
      company_name: row.company_name,
      status: row.status,
      requests: u.requests,
      storage_mb: round1(u.storageMb),
      running_hours: round1(u.hours),
      cpu_avg_percent: round1(u.cpuAvgPct),
      cpu_core_hours: round1(u.coreHours),
      mem_avg_gb: Math.round(u.memAvgGb * 1000) / 1000,
      mem_peak_mb: round1(u.memPeakMb),
      network_gb: round1(u.networkGb),
      usage_charges: charges.total,
      usage_lines: charges.lines,
      allocated_aws: allocated,
      platform_fee: rates.platform_fee,
      total_bill: money(charges.total + allocated.total + rates.platform_fee),
    };
  });

  const allocatedTotal = money(tenants.reduce((s, t) => s + t.allocated_aws.total, 0));
  return {
    month,
    interval_minutes: intervalMinutes,
    rates,
    aws,
    overview: {
      aws_total: aws.total,
      customer_charges: money(tenants.reduce((s, t) => s + t.total_bill, 0)),
      allocated_aws: allocatedTotal,
      unallocated_aws: money(aws.total - allocatedTotal),
      active_tenants: tenants.filter((t) => t.status === 'ready').length,
    },
    tenants,
  };
}

// Stores each client's bill for the month. The primary key makes repeated runs update, never duplicate.
export async function recordSummaries(month, intervalMinutes) {
  const bill = await billingForMonth(month, intervalMinutes);
  for (const t of bill.tenants) {
    await db.query(
      `INSERT INTO billing_summaries (slug, month, usage_charges, allocated_aws, platform_fee, total)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (slug, month) DO UPDATE SET usage_charges = EXCLUDED.usage_charges,
         allocated_aws = EXCLUDED.allocated_aws, platform_fee = EXCLUDED.platform_fee,
         total = EXCLUDED.total, computed_at = now()`,
      [t.slug, month, t.usage_charges, t.allocated_aws.total, t.platform_fee, t.total_bill]
    );
  }
  return bill.tenants.length;
}
