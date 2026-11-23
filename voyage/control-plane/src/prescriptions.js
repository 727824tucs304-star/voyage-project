import { billingForMonth } from './billing.js';
import { db } from './db.js';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { buildFindings } from './prescription-rules.js';

const interval = () => config.meterIntervalMs / 60000;
const num = (v) => Number(v || 0);

export function previousMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}

function mergeServices(current, previous) {
  const names = new Set([...current.map((s) => s.service), ...previous.map((s) => s.service)]);
  const cur = new Map(current.map((s) => [s.service, s.amount]));
  const prev = new Map(previous.map((s) => [s.service, s.amount]));
  return [...names].map((name) => {
    const c = cur.get(name) || 0;
    const p = prev.get(name) || 0;
    return { service: name, current: c, previous: p, change: p > 0 ? (c - p) / p : null };
  }).sort((a, b) => b.current - a.current);
}

function summarise(client, findings, aws) {
  const top = findings.filter((f) => f.severity === 'high' || f.severity === 'medium').slice(0, 3);
  const head = client && client.expectedBudget != null
    ? `Estimated bill $${client.estimatedBill.toFixed(2)} against an expected $${client.expectedBudget.toFixed(2)}.`
    : client ? `Estimated bill $${client.estimatedBill.toFixed(2)}. No expected budget is set for this customer.`
    : `AWS account cost $${aws.total.toFixed(2)} this month.`;
  if (!top.length) return `${head} No high or medium issues found.`;
  return `${head} Main points: ${top.map((f) => f.title).join('; ')}.`;
}

export async function prescriptionFor(slug, month) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, 'month must look like 2026-11');
  const prev = previousMonth(month);
  const [bill, prevBill] = await Promise.all([billingForMonth(month, interval()), billingForMonth(prev, interval())]);
  const { rows: [syncRow] } = await db.query('SELECT status, message, last_success FROM aws_sync_state WHERE id = 1');
  const ready = bill.tenants.filter((t) => t.status === 'ready');
  const fleet = {
    cpuAvg: ready.length ? ready.reduce((s, t) => s + num(t.cpu_avg_percent), 0) / ready.length : null,
    readyCount: ready.length,
  };
  const aws = {
    total: num(bill.aws.total), ec2: num(bill.aws.ec2),
    services: (bill.aws.services || []).map((s) => ({ service: s.service, amount: num(s.amount) })),
  };
  const prevAws = {
    services: (prevBill.aws.services || []).map((s) => ({ service: s.service, amount: num(s.amount) })),
  };
  let client = null;
  if (slug) {
    const row = bill.tenants.find((t) => t.slug === slug);
    if (!row) throw new HttpError(404, 'Customer not found');
    const { rows: [meta] } = await db.query('SELECT monthly_budget FROM tenants WHERE slug = $1', [slug]);
    const prevRow = prevBill.tenants.find((t) => t.slug === slug);
    const expectedBudget = meta?.monthly_budget == null ? null : num(meta.monthly_budget);
    client = {
      slug, name: row.company_name, status: row.status,
      expectedBudget,
      estimatedBill: num(row.total_bill),
      usageCharges: num(row.usage_charges),
      allocatedAws: num(row.allocated_aws.total),
      platformFee: num(bill.rates.platform_fee),
      variance: expectedBudget == null ? null : num(row.total_bill) - expectedBudget,
      requests: num(row.requests),
      runningHours: num(row.running_hours),
      storageMb: num(row.storage_mb),
      prevStorageMb: prevRow ? num(prevRow.storage_mb) : 0,
      networkGb: num(row.network_gb),
    };
  }
  const findings = buildFindings({
    aws, prevAws,
    unallocated: num(bill.overview.unallocated_aws),
    sync: syncRow ? { status: syncRow.status, message: syncRow.message, last_success: syncRow.last_success } : null,
    client: client ? { ...client } : null,
    fleet,
  });
  return {
    month,
    previous_month: prev,
    client,
    aws: { total: aws.total, unallocated: num(bill.overview.unallocated_aws), sync: syncRow || null },
    services: mergeServices(aws.services, prevAws.services),
    findings,
    summary: summarise(client, findings, aws),
  };
}
