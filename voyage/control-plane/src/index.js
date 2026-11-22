import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { db, initControlDb } from './db.js';
import * as P from './provision.js';
import { HttpError } from './errors.js';
import { EMAIL_RE, SLUG_RE, safeEqual } from './security.js';
import { releaseRouter } from './admin-release.js';
import { deployRecorded } from './deploy-history.js';
import { resumeBuilds, nextVersion } from './builds.js';
import { billingRouter, runBillingJobs } from './admin-billing.js';
import { archiveTenant, restoreTenant } from './lifecycle.js';
import { requireAdmin, login, logout, limiter } from './admin-auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(here, '..', 'public')));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

const clean = (value, field, min, max) => {
  if (typeof value !== 'string') throw new HttpError(400, `${field} is required`);
  const t = value.trim();
  if (t.length < min || t.length > max) throw new HttpError(400, `${field} must be ${min}-${max} characters`);
  if (/[\x00-\x1f\x7f]/.test(t)) throw new HttpError(400, `${field} contains invalid characters`);
  return t;
};

const slugParam = (req) => {
  if (!SLUG_RE.test(req.params.slug)) throw new HttpError(404, 'Workspace not found');
  return req.params.slug;
};

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---- Registration and status (public) ----
app.post('/api/register', limiter({ name: 'register', max: config.registerLimitPerHour, windowMs: 3600000 }), wrap(async (req, res) => {
  const b = req.body || {};
  const companyName = clean(b.companyName, 'companyName', 2, 80);
  const adminName = clean(b.adminName, 'adminName', 2, 80);
  const email = clean(b.email, 'email', 3, 120).toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'email is not valid');
  if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 128) {
    throw new HttpError(400, 'password must be 8-128 characters');
  }
  const { tenant, created } = await P.registerTenant({ companyName, adminName, email, password: b.password });
  if (created) P.startProvisioning(tenant.slug);
  res.status(created ? 202 : 200).json(P.publicView(tenant));
}));

app.get('/api/tenants/:slug', wrap(async (req, res) => {
  const tenant = await P.getTenant(slugParam(req));
  if (!tenant) throw new HttpError(404, 'Workspace not found');
  res.json(P.publicView(tenant));
}));

app.post('/api/tenants/:slug/retry', wrap(async (req, res) => {
  res.status(202).json(await P.retryProvisioning(slugParam(req)));
}));

// ---- Admin sign-in (personal accounts) ----
app.post('/api/admin/login', limiter({ name: 'login', max: config.loginLimitPer15Min, windowMs: 900000 }), wrap(async (req, res) => {
  const b = req.body || {};
  const email = clean(b.email, 'email', 3, 120).toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'email is not valid');
  if (typeof b.password !== 'string' || !b.password) throw new HttpError(400, 'password is required');
  res.json(await login(email, b.password));
}));
app.post('/api/admin/logout', wrap(async (req, res) => {
  await logout(req);
  res.status(204).end();
}));
app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ email: req.admin.email, name: req.admin.name }));

// ---- Administration (signed-in admin required) ----
app.get('/api/admin/versions', requireAdmin, wrap(async (req, res) => {
  const product = req.query.product === 'voyage' ? 'voyage' : 'vespera';
  res.json({ product, versions: await P.listVersions(product), next: await nextVersion(product) });
}));

app.get('/api/admin/tenants', requireAdmin, wrap(async (req, res) => {
  const includeArchived = req.query.include_archived === '1';
  const { rows } = await db.query(`SELECT * FROM tenants ${includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY created_at, id`);
  res.json(rows.map(P.adminView));
}));

app.post('/api/admin/tenants/:slug/deploy', requireAdmin, wrap(async (req, res) => {
  const version = typeof req.body?.version === 'string' ? req.body.version : '';
  res.status(202).json(await deployRecorded(slugParam(req), version));
}));

app.post('/api/admin/tenants/:slug/rollback', requireAdmin, wrap(async (req, res) => {
  const slug = slugParam(req);
  const t = await P.getTenant(slug);
  if (!t?.previous_version) throw new HttpError(409, 'No previous version to roll back to');
  res.status(202).json(await deployRecorded(slug, t.previous_version, 'rollback'));
}));

app.use('/api/admin', requireAdmin, releaseRouter);

app.post('/api/admin/tenants/:slug/archive', requireAdmin, wrap(async (req, res) => {
  if (req.body?.confirm !== slugParam(req)) throw new HttpError(400, 'Type the workspace name to confirm archiving');
  res.json(await archiveTenant(slugParam(req)));
}));
app.post('/api/admin/tenants/:slug/restore', requireAdmin, wrap(async (req, res) => {
  res.json(await restoreTenant(slugParam(req)));
}));

app.use('/api/admin', requireAdmin, billingRouter);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  console.error(err);
  return res.status(500).json({ error: 'Internal server error' });
});

async function main() {
  await initControlDb();
  await P.resumeInterrupted();
  await resumeBuilds();
  runBillingJobs.metering();
  setInterval(() => runBillingJobs.metering(), config.meterIntervalMs);
  runBillingJobs.aws();
  setInterval(() => runBillingJobs.aws(), config.awsSyncIntervalMs);
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`Vespera control plane listening on :${config.port} (base domain ${config.baseDomain})`);
  });
}

main().catch((err) => {
  console.error('control plane failed to start', err);
  process.exit(1);
});
