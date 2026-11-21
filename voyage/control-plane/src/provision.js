import bcrypt from 'bcryptjs';
import pg from 'pg';
import { config } from './config.js';
import { db, adminPool } from './db.js';
import * as docker from './docker.js';
import { applyTenantConf, tenantConf } from './nginx.js';
import { HttpError } from './errors.js';
import { tenantSecrets, baseSlug, randomSuffix, SLUG_RE, VERSION_RE } from './security.js';
import { releaseInfo } from './builds.js';
import { imageRef, imageRepo } from './products.js';

const busy = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function names(slug) {
  return {
    dbName: `tenant_${slug}`,
    dbUser: `tenant_${slug}`,
    container: `voyage-tenant-${slug}`,
    host: `${slug}.${config.baseDomain}`,
  };
}

export async function getTenant(slug) {
  const { rows } = await db.query('SELECT * FROM tenants WHERE slug = $1', [slug]);
  return rows[0] || null;
}

async function setStatus(slug, status, errorMessage = null) {
  await db.query(
    'UPDATE tenants SET status = $2, error_message = $3, updated_at = now() WHERE slug = $1',
    [slug, status, errorMessage]
  );
}

async function logStep(slug, step, status, detail = '') {
  const entry = [{ step, status, detail: String(detail).slice(0, 500), at: new Date().toISOString() }];
  await db.query(
    `UPDATE tenants SET current_step = $2, provisioning_log = provisioning_log || $3::jsonb, updated_at = now()
     WHERE slug = $1`,
    [slug, step, JSON.stringify(entry)]
  );
}

async function runStep(slug, step, fn) {
  await logStep(slug, step, 'running');
  try {
    const detail = await fn();
    await logStep(slug, step, 'ok', detail ?? '');
    return detail;
  } catch (err) {
    await logStep(slug, step, 'failed', err.message);
    throw err;
  }
}

// Runs one statement as the provisioner connected to a specific tenant database.
async function asProvisionerOn(dbName, sql) {
  const url = new URL(config.controlDbUrl);
  url.pathname = `/${dbName}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function ensureDatabase(slug) {
  const { dbName, dbUser } = names(slug);
  const { dbPassword } = tenantSecrets(slug);
  if (!/^[0-9a-f]+$/.test(dbPassword)) throw new Error('credential material has an unexpected format');

  // Role: the tenant can log in and only to its own database.
  const role = await adminPool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [dbUser]);
  if (role.rowCount === 0) await adminPool.query(`CREATE ROLE "${dbUser}" LOGIN PASSWORD '${dbPassword}'`);
  else await adminPool.query(`ALTER ROLE "${dbUser}" LOGIN PASSWORD '${dbPassword}'`);

  // Database: owned by the provisioner; the tenant gets CONNECT and CREATE on its own schema only.
  const database = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (database.rowCount === 0) await adminPool.query(`CREATE DATABASE "${dbName}"`);
  await adminPool.query(`REVOKE ALL ON DATABASE "${dbName}" FROM PUBLIC`);
  await adminPool.query(`GRANT CONNECT, TEMPORARY ON DATABASE "${dbName}" TO "${dbUser}"`);
  await asProvisionerOn(dbName, `GRANT USAGE, CREATE ON SCHEMA public TO "${dbUser}"`);
  return `${dbName} ready for ${dbUser}`;
}

async function ensureContainer(t, version, { force = false, product = t.product } = {}) {
  const n = names(t.slug);
  const image = imageRef(product, version);
  const current = await docker.inspectContainer(n.container);

  // Idempotent: a retry reuses a healthy container on the right image instead of recreating it.
  if (!force && current && current.Config?.Image === image) {
    if (!current.State?.Running) await docker.startContainer(n.container);
    return `reused ${n.container}`;
  }

  const { dbPassword, jwtSecret } = tenantSecrets(t.slug);
  const env = [
    `DATABASE_URL=postgres://${n.dbUser}:${dbPassword}@${config.tenantPgHost}:${config.tenantPgPort}/${n.dbName}`,
    `JWT_SECRET=${jwtSecret}`,
    `COMPANY_NAME=${t.company_name}`,
    `STORAGE_DIR=${config.storageRoot}/${t.slug}`,
    `PORT=${config.tenantPort}`,
    'HOST=0.0.0.0',
  ];
  env.push(`TENANT_SLUG=${t.slug}`, `TRANSCRIPTION_PROVIDER=${process.env.TRANSCRIPTION_PROVIDER || 'aws'}`, `TRANSCRIBE_LANGUAGE=${process.env.TRANSCRIBE_LANGUAGE || 'en-US'}`);
  if (process.env.AWS_REGION) env.push(`AWS_REGION=${process.env.AWS_REGION}`);
  if (process.env.TRANSCRIBE_BUCKET) env.push(`TRANSCRIBE_BUCKET=${process.env.TRANSCRIBE_BUCKET}`);
  if (process.env.TRANSCRIPTION_MOCK_DELAY_MS) env.push(`TRANSCRIPTION_MOCK_DELAY_MS=${process.env.TRANSCRIPTION_MOCK_DELAY_MS}`);

  // The admin account is only needed on first start; the database already holds it afterwards.
  if (t.admin_password_hash) {
    env.push(`ADMIN_NAME=${t.admin_name}`, `ADMIN_EMAIL=${t.admin_email}`, `ADMIN_PASSWORD_HASH=${t.admin_password_hash}`);
  }

  const rel = await releaseInfo(version, product);
  env.push(`RELEASE_VERSION=${version}`, `RELEASE_COMMIT=${rel.commit}`, `RELEASE_MESSAGE=${rel.message}`, `RELEASE_DATE=${rel.date}`);

  // The container is disposable: all state lives in the tenant's database.
  await docker.removeContainer(n.container);
  await docker.createContainer(n.container, {
    Image: image,
    Env: env,
    Labels: { 'voyage.role': 'tenant', 'voyage.tenant': t.slug, 'voyage.version': version, 'voyage.product': product },
    HostConfig: {
      NetworkMode: config.dockerNetwork,
      RestartPolicy: { Name: 'unless-stopped' },
      Memory: 512 * 1024 * 1024,
      PidsLimit: 256,
      // Recordings and reports survive container replacement, updates and rollbacks.
      Mounts: [{ Type: 'volume', Source: `vespera-files-${t.slug}`, Target: '/data' }],
    },
  });
  await docker.startContainer(n.container);
  return `${n.container} running ${image}`;
}

async function waitHealthy(slug, expectedVersion) {
  const url = `http://${names(slug).container}:${config.tenantPort}/api/health`;
  const deadline = Date.now() + config.healthTimeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok && body.adminReady) {
        if (body.version !== expectedVersion) {
          throw new Error(`version mismatch: expected ${expectedVersion}, container reports ${body.version}`);
        }
        return `healthy on ${expectedVersion}`;
      }
      last = `HTTP ${res.status}`;
    } catch (err) {
      if (err.message.startsWith('version mismatch')) throw err;
      last = err.cause?.code || err.message;
    }
    await sleep(2000);
  }
  throw new Error(`health check timed out (${last})`);
}

async function runProvisioning(slug) {
  const t = await getTenant(slug);
  if (!t) return;
  const n = names(slug);
  try {
    await setStatus(slug, 'provisioning');
    await runStep(slug, 'create_database', () => ensureDatabase(slug));
    await runStep(slug, 'verify_image', async () => {
      if (!(await docker.imageExists(imageRef(t.product, t.version)))) {
        throw new Error(`image ${imageRef(t.product, t.version)} is not built on this host`);
      }
      return imageRef(t.product, t.version);
    });
    await runStep(slug, 'ensure_network', () => docker.ensureNetwork());
    await runStep(slug, 'start_container', () => ensureContainer(t, t.version));
    await runStep(slug, 'configure_routing', async () => {
      await applyTenantConf(slug, tenantConf(n.host, n.container));
      return n.host;
    });
    await runStep(slug, 'health_check', () => waitHealthy(slug, t.version));
    await db.query(
      `UPDATE tenants SET status = 'ready', current_step = 'ready', error_message = NULL,
         admin_password_hash = NULL, updated_at = now() WHERE slug = $1`,
      [slug]
    );
  } catch (err) {
    await setStatus(slug, 'failed', err.message);
  }
}

// Serialises operations per tenant, so two requests can never touch the same container at once.
function launch(slug, work) {
  if (busy.has(slug)) return false;
  busy.add(slug);
  work()
    .catch((err) => console.error(`operation for ${slug} crashed`, err))
    .finally(() => busy.delete(slug));
  return true;
}

export function startProvisioning(slug) {
  return launch(slug, () => runProvisioning(slug));
}

export async function registerTenant({ companyName, adminName, email, password }) {
  const existing = await findRegistration(email, companyName);
  if (existing) return { tenant: existing, created: false };

  const passwordHash = await bcrypt.hash(password, 12);
  const base = baseSlug(companyName);
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? base : `${base.slice(0, 25)}${randomSuffix()}`;
    if (!SLUG_RE.test(slug)) continue;
    const n = names(slug);
    try {
      const { rows } = await db.query(
        `INSERT INTO tenants (slug, company_name, admin_name, admin_email, admin_password_hash,
           domain, db_name, db_user, container_name, version, product, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'provisioning') RETURNING *`,
        [slug, companyName, adminName, email, passwordHash, n.host, n.dbName, n.dbUser, n.container, config.tenantDefaultVersion, config.tenantDefaultProduct]
      );
      return { tenant: rows[0], created: true };
    } catch (err) {
      if (err.code !== '23505') throw err;
      // A concurrent identical request may have won the race; otherwise the slug was taken and we retry.
      const again = await findRegistration(email, companyName);
      if (again) return { tenant: again, created: false };
    }
  }
  throw new HttpError(409, 'Could not allocate a workspace name. Try a slightly different company name.');
}

async function findRegistration(email, companyName) {
  const { rows } = await db.query('SELECT * FROM tenants WHERE admin_email = $1 AND company_name = $2', [email, companyName]);
  return rows[0] || null;
}

export async function retryProvisioning(slug) {
  const t = await getTenant(slug);
  if (!t) throw new HttpError(404, 'Workspace not found');
  if (t.status !== 'failed') throw new HttpError(409, 'Only failed provisioning can be retried');
  if (!startProvisioning(slug)) throw new HttpError(409, 'An operation is already running for this workspace');
  return { accepted: true, slug };
}

export async function deployVersion(slug, version, { product } = {}) {
  if (!VERSION_RE.test(version)) throw new HttpError(400, 'version must look like v1, v2, ...');
  const t = await getTenant(slug);
  if (!t) throw new HttpError(404, 'Workspace not found');
  if (t.status !== 'ready') throw new HttpError(409, `Workspace is ${t.status}; wait until it is ready`);
  if (t.archived_at) throw new HttpError(409, 'This workspace is archived. Restore it before deploying.');
  const target = product || t.product;
  if (t.version === version && target === t.product) throw new HttpError(409, `Workspace already runs ${version}`);
  if (!(await docker.imageExists(imageRef(target, version)))) {
    throw new HttpError(422, `Image ${imageRef(target, version)} is not available on this host`);
  }

  const previous = t.version;
  const started = launch(slug, async () => {
    await db.query("UPDATE tenants SET status = 'updating', error_message = NULL, updated_at = now() WHERE slug = $1", [slug]);
    try {
      await runStep(slug, `deploy_${version}`, () => ensureContainer(t, version, { force: true, product: target }));
      await runStep(slug, 'health_check', () => waitHealthy(slug, version));
      await db.query(
        `UPDATE tenants SET status = 'ready', version = $2, previous_version = $3, product = $4, current_step = 'ready',
           updated_at = now() WHERE slug = $1`,
        [slug, version, target === t.product ? previous : null, target]
      );
    } catch (err) {
      // Automatic rollback: restore the previous image so the workspace stays available.
      try {
        await runStep(slug, `rollback_to_${previous}`, () => ensureContainer(t, previous, { force: true }));
        await runStep(slug, 'rollback_health_check', () => waitHealthy(slug, previous));
        await db.query(
          `UPDATE tenants SET status = 'ready', current_step = 'ready', error_message = $2, updated_at = now()
           WHERE slug = $1`,
          [slug, `Update to ${version} failed (${err.message}); rolled back to ${previous}`]
        );
      } catch (rollbackErr) {
        await setStatus(slug, 'failed', `Update to ${version} failed and rollback failed: ${rollbackErr.message}`);
      }
    }
  });
  if (!started) throw new HttpError(409, 'An operation is already running for this workspace');
  return { accepted: true, slug, target: version };
}

export async function rollbackVersion(slug) {
  const t = await getTenant(slug);
  if (!t) throw new HttpError(404, 'Workspace not found');
  if (!t.previous_version) throw new HttpError(409, 'No previous version to roll back to');
  return deployVersion(slug, t.previous_version);
}

export async function resumeInterrupted() {
  await db.query(
    `UPDATE tenants SET status = 'failed', error_message = 'Interrupted during an update. Use Retry or Rollback.',
       updated_at = now() WHERE status = 'updating'`
  );
  const { rows } = await db.query("SELECT slug FROM tenants WHERE status = 'provisioning'");
  for (const r of rows) startProvisioning(r.slug);
}

export function listVersions(product = 'vespera') {
  return docker.listTenantVersions(imageRepo(product));
}

// Public view: no secrets, no hashes. Error text is shown only for failed workspaces.
export function publicView(t) {
  const latest = new Map();
  for (const s of t.provisioning_log || []) latest.set(s.step, s);
  return {
    slug: t.slug,
    companyName: t.company_name,
    status: t.status,
    currentStep: t.current_step,
    errorMessage: t.status === 'failed' ? t.error_message : null,
    workspaceUrl: t.status === 'ready' ? `${config.workspaceScheme}://${t.domain}` : null,
    steps: [...latest.values()],
  };
}

export function adminView(t) {
  return {
    slug: t.slug,
    companyName: t.company_name,
    adminEmail: t.admin_email,
    archivedAt: t.archived_at,
    product: t.product,
    domain: t.domain,
    databaseName: t.db_name,
    containerName: t.container_name,
    version: t.version,
    previousVersion: t.previous_version,
    status: t.status,
    currentStep: t.current_step,
    errorMessage: t.error_message,
    updatedAt: t.updated_at,
  };
}
