import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { db, initControlDb } from './db.js';
import * as P from './provision.js';
import { HttpError } from './errors.js';
import { EMAIL_RE, SLUG_RE, safeEqual } from './security.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
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

const requireAdmin = (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !safeEqual(token, config.adminToken)) return res.status(401).json({ error: 'Admin token required' });
  return next();
};

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---- Registration and status (public) ----
app.post('/api/register', wrap(async (req, res) => {
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

// ---- Administration (admin token required) ----
app.get('/api/admin/versions', requireAdmin, wrap(async (req, res) => {
  res.json({ versions: await P.listVersions() });
}));

app.get('/api/admin/tenants', requireAdmin, wrap(async (req, res) => {
  const { rows } = await db.query('SELECT * FROM tenants ORDER BY created_at, id');
  res.json(rows.map(P.adminView));
}));

app.post('/api/admin/tenants/:slug/deploy', requireAdmin, wrap(async (req, res) => {
  const version = typeof req.body?.version === 'string' ? req.body.version : '';
  res.status(202).json(await P.deployVersion(slugParam(req), version));
}));

app.post('/api/admin/tenants/:slug/rollback', requireAdmin, wrap(async (req, res) => {
  res.status(202).json(await P.rollbackVersion(slugParam(req)));
}));

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
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`Voyage control plane listening on :${config.port} (base domain ${config.baseDomain})`);
  });
}

main().catch((err) => {
  console.error('control plane failed to start', err);
  process.exit(1);
});
