// End-to-end test: five tenants through the real control plane, with real PostgreSQL,
// real tenant app processes, real bcrypt/JWT and real `nginx -t`.
// Docker itself is replaced by fake-docker.mjs (see its header).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import pg from 'pg';
import { startFakeDocker } from './fake-docker.mjs';
import { startFakeGithub } from './fake-github.mjs';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const TENANT_ENTRY = path.join(REPO, 'tenant-app', 'server', 'index.js');
const CONTROL_DIR = path.join(REPO, 'control-plane');
const WORK = '/tmp/voyage-test';
const SOCK = path.join(WORK, 'docker.sock');
const CONTROL_PORT = 4100;
const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;
const ADMIN_TOKEN = crypto.randomBytes(24).toString('hex');
const PROV_PW = `prov${crypto.randomBytes(8).toString('hex')}`;
const REMOTE = path.join(WORK, 'remote.git');
const WS = path.join(WORK, 'workspace');
const IMAGE_FILE = path.join(WORK, 'extra-images.txt');
const BUILD_CMD = path.join(WORK, 'fake-build.sh');
const BUILD_LOG = path.join(WORK, 'build-log.txt');
const GH_PORT = 4200;
const GITHUB_TOKEN = `ghp_test_${crypto.randomBytes(12).toString('hex')}`;
const PASSWORD = 'SecurePass123';

// Clear leftovers from any previous crashed run (stale control plane / tenant processes / hosts entries).
execFileSync('bash', ['-c', 'pkill -KILL -f "[t]enant-app/server/index.js"; pkill -KILL -f "[s]rc/index.js"; true']);
{
  const kept = fs.readFileSync('/etc/hosts', 'utf8').split('\n').filter((l) => !l.includes('# voyage-test'));
  fs.writeFileSync('/etc/hosts', kept.join('\n'));
}
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'tenants'), { recursive: true });
// Source workspace: a real git repository with a bare "GitHub" remote, laid out like the server clone (project in voyage/).
fs.mkdirSync(path.join(WS, 'voyage'), { recursive: true });
execFileSync('bash', ['-c', `cd "${REPO}" && tar --exclude=node_modules --exclude=dist -cf - tenant-app control-plane/src README.md | tar -xf - -C "${WS}/voyage"`]);
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', REMOTE]);
execFileSync('bash', ['-c', `cd "${WS}" && git init -q -b main && git remote add origin "${REMOTE}" && git add -A && git -c user.name=t -c user.email=t@t commit -qm "initial" && git push -q -u origin main`]);
// "docker build" stand-in: records the new tag the way a successful build would make it visible.
fs.writeFileSync(BUILD_CMD, `#!/bin/sh\nfor a in "$@"; do ctx="$a"; done\ntag=""\nwhile [ $# -gt 0 ]; do case "$1" in -t) tag="$2"; shift ;; esac; shift; done\nhash=$(sha256sum "$ctx/client/src/pages.jsx" | cut -d' ' -f1)\necho "$tag $hash" >> "${BUILD_LOG}"\necho "$tag" >> "${IMAGE_FILE}"\necho "Successfully tagged $tag"\n`, { mode: 0o755 });
const CONFIG_PATH = path.join(WS, 'voyage', 'control-plane', 'src', 'config.js');
fs.mkdirSync(path.join(WORK, 'logs'), { recursive: true });

// nginx main config for this host: the real config with the tenant include pointed at WORK.
const nginxMain = path.join(WORK, 'nginx-main.conf');
fs.writeFileSync(nginxMain, fs.readFileSync(path.join(REPO, 'nginx', 'nginx.conf'), 'utf8')
  .replace('/etc/nginx/tenants/*.conf', `${WORK}/tenants/*.conf`)
  .replace('pid /var/run/nginx.pid;', `pid ${WORK}/nginx.pid;`));

// ---------- Postgres: fresh control DB + provisioner role (same statements as postgres/init) ----------
const psql = (sql) => execFileSync('runuser', ['-u', 'postgres', '--', 'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-d', 'postgres', '-c', sql], { stdio: 'pipe' });
const listSql = (sql) => execFileSync('runuser', ['-u', 'postgres', '--', 'psql', '-tA', '-d', 'postgres', '-c', sql], { encoding: 'utf8' })
  .split('\n').map((l) => l.trim()).filter(Boolean);
for (const db of listSql("SELECT datname FROM pg_database WHERE datname LIKE 'tenant\\_%'")) psql(`DROP DATABASE IF EXISTS "${db}"`);
for (const role of listSql("SELECT rolname FROM pg_roles WHERE rolname LIKE 'tenant\\_%'")) psql(`DROP ROLE IF EXISTS "${role}"`);
psql('DROP DATABASE IF EXISTS voyage_control');
psql('DROP ROLE IF EXISTS voyage_provisioner');
psql(`CREATE ROLE voyage_provisioner LOGIN CREATEDB CREATEROLE PASSWORD '${PROV_PW}'`);
psql('CREATE DATABASE voyage_control OWNER voyage_provisioner');

const CONTROL_DB = `postgres://voyage_provisioner:${PROV_PW}@127.0.0.1:5432/voyage_control`;
const controlDb = new pg.Client({ connectionString: CONTROL_DB });
await controlDb.connect();

// ---------- Start the fake Docker engine and the real control plane ----------
const fake = startFakeDocker({ socketPath: SOCK, tenantEntry: TENANT_ENTRY, nginxMain, logDir: path.join(WORK, 'logs'), imageFile: IMAGE_FILE });
const gh = startFakeGithub({ port: GH_PORT, remote: REMOTE, branch: 'main' });
const control = spawn(process.execPath, ['src/index.js'], {
  cwd: CONTROL_DIR,
  env: {
    PATH: process.env.PATH,
    PORT: String(CONTROL_PORT),
    BASE_DOMAIN: 'localhost',
    WORKSPACE_SCHEME: 'http',
    CONTROL_DB_URL: CONTROL_DB,
    TENANT_PG_HOST: '127.0.0.1',
    TENANT_PG_PORT: '5432',
    CONTROL_SECRET: crypto.randomBytes(32).toString('hex'),
    ADMIN_TOKEN,
    DOCKER_SOCKET: SOCK,
    DOCKER_NETWORK: 'voyage-net',
    TENANT_IMAGE_REPO: 'voyage-tenant',
    TENANT_DEFAULT_VERSION: 'v1',
    NGINX_CONTAINER: 'voyage-nginx',
    NGINX_TENANT_DIR: path.join(WORK, 'tenants'),
    HEALTH_TIMEOUT_MS: '60000',
    DOCKER_BIN: BUILD_CMD,
    REPO_ROOT: WS,
    PROJECT_SUBDIR: 'voyage',
    GITHUB_REPO: 'test-org/voyage',
    GITHUB_BRANCH: 'main',
    GITHUB_TOKEN,
    GITHUB_API_URL: `http://127.0.0.1:${GH_PORT}`,
    METER_INTERVAL_MS: '3000',
    AWS_CLI_BIN: path.join(CONTROL_DIR, 'test', 'fake-aws.sh'),
    AWS_MODE_FILE: path.join(WORK, 'aws-mode'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let controlLog = '';
process.on('exit', () => fs.writeFileSync('/tmp/control.log', controlLog));
control.stdout.on('data', (d) => (controlLog += d));
control.stderr.on('data', (d) => (controlLog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, url, { body, token, headers: extra = {} } = {}) {
  const headers = { ...extra };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = r.status === 204 ? null : await r.json().catch(() => null);
  return { status: r.status, data };
}
const ctl = (method, p, opts) => call(method, `${CONTROL}${p}`, opts);
const adminOpts = { token: ADMIN_TOKEN };
const tenantApi = (slug, method, p, opts) => call(method, `http://voyage-tenant-${slug}:3000/api${p}`, opts);

function dockerApi(method, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCK, method, path: p }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, data: d ? JSON.parse(d) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitFor(fn, label, timeoutMs = 120000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
    } catch (err) {
      last = err.message;
      if (String(err.message).includes('failed:')) throw err;
    }
    if (last && typeof last === 'object') return last;
    if (last === true) return last;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

const waitReady = (slug) =>
  waitFor(async () => {
    const { data } = await ctl('GET', `/api/tenants/${slug}`);
    if (data?.status === 'failed') throw new Error(`${slug} provisioning failed: ${data.errorMessage}`);
    return data?.status === 'ready' ? data : null;
  }, `${slug} ready`);

const adminRow = async (slug) => (await ctl('GET', '/api/admin/tenants', adminOpts)).data.find((t) => t.slug === slug);

const waitAdminReady = (slug, version) =>
  waitFor(async () => {
    const row = await adminRow(slug);
    if (row?.status === 'failed') throw new Error(`${slug} update failed: ${row.errorMessage}`);
    return row?.status === 'ready' && row.version === version ? row : null;
  }, `${slug} on ${version}`);

// Wait for the control plane to come up; if it dies, show why and stop.
let exited = null;
control.on('exit', (code) => (exited = code));
for (let i = 0; i < 120; i++) {
  if (exited !== null) break;
  try {
    if ((await fetch(`${CONTROL}/healthz`)).ok) break;
  } catch { /* not listening yet */ }
  await sleep(500);
}
if (exited !== null || !(await fetch(`${CONTROL}/healthz`).then((r) => r.ok).catch(() => false))) {
  console.log('control plane failed to start:\n' + controlLog.slice(-3000));
  control.kill('SIGTERM');
  await fake.stopAll();
  process.exit(1);
}

// ---------- Tests ----------
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${err.message.split('\n').join('\n        ')}`);
  }
}

const COMPANIES = [
  { company: 'Acme Travel', admin: 'ana@acme.test' },
  { company: 'Bluesky Tours', admin: 'ben@bluesky.test' },
  { company: 'Cedar Trips', admin: 'cara@cedar.test' },
  { company: 'Delta Journeys', admin: 'dan@delta.test' },
  { company: 'Echo Voyages', admin: 'eve@echo.test' },
];
const slugs = {};   // company -> slug
const pids = {};    // slug -> pid before update

console.log('\n[1] Input validation');
await check('rejects a malformed registration (bad email, short password)', async () => {
  const r = await ctl('POST', '/api/register', { body: { companyName: 'X Co', adminName: 'Al', email: 'nope', password: 'short' } });
  assert.equal(r.status, 400);
});
await check('rejects control characters in company name', async () => {
  const r = await ctl('POST', '/api/register', { body: { companyName: 'Bad\nName', adminName: 'Al', email: 'a@b.test', password: PASSWORD } });
  assert.equal(r.status, 400);
});
await check('rejects admin calls without the admin token', async () => {
  const r = await ctl('GET', '/api/admin/tenants');
  assert.equal(r.status, 401);
});

console.log('\n[2] Five-customer registration and automated provisioning');
await check('registers five companies (202 Accepted, provisioning starts)', async () => {
  for (const c of COMPANIES) {
    const r = await ctl('POST', '/api/register', {
      body: { companyName: c.company, adminName: 'Administrator', email: c.admin, password: PASSWORD },
    });
    assert.equal(r.status, 202, JSON.stringify(r.data));
    slugs[c.company] = r.data.slug;
  }
});
await check('all five workspaces reach "ready" through real provisioning steps', async () => {
  for (const slug of Object.values(slugs)) {
    const t = await waitReady(slug);
    assert.ok(t.workspaceUrl?.startsWith('http://'), 'workspace URL present');
    const steps = t.steps.map((s) => `${s.step}:${s.status}`);
    for (const s of ['create_database', 'start_container', 'configure_routing', 'health_check']) {
      assert.ok(steps.includes(`${s}:ok`), `${slug} step ${s} not ok: ${steps}`);
    }
  }
});
await check('registering the same company and email again is idempotent (200, same workspace)', async () => {
  const c = COMPANIES[0];
  const r = await ctl('POST', '/api/register', { body: { companyName: c.company, adminName: 'Administrator', email: c.admin, password: PASSWORD } });
  assert.equal(r.status, 200);
  assert.equal(r.data.slug, slugs[c.company]);
  const { rows } = await controlDb.query('SELECT count(*)::int AS n FROM tenants WHERE admin_email = $1', [c.admin]);
  assert.equal(rows[0].n, 1);
});
await check('a different admin for a company with the same name gets its own workspace', async () => {
  const r = await ctl('POST', '/api/register', { body: { companyName: 'Acme Travel', adminName: 'Other', email: 'other@acme.test', password: PASSWORD } });
  assert.equal(r.status, 202);
  assert.notEqual(r.data.slug, slugs['Acme Travel']);
  assert.match(r.data.slug, /^acmetravel[0-9a-f]{4}$/);
  await waitReady(r.data.slug);
  slugs['Acme Travel (second)'] = r.data.slug;
});

console.log('\n[3] Isolation: separate databases, roles and containers');
await check('each tenant has its own database and role in PostgreSQL', async () => {
  const { rows } = await controlDb.query("SELECT slug, db_name, db_user FROM tenants WHERE status = 'ready' ORDER BY slug");
  assert.equal(rows.length, 6);
  const adminDb = new pg.Client({ connectionString: CONTROL_DB.replace('/voyage_control', '/postgres') });
  await adminDb.connect();
  for (const row of rows) {
    const { rowCount } = await adminDb.query('SELECT 1 FROM pg_database WHERE datname = $1', [row.db_name]);
    assert.equal(rowCount, 1, `database ${row.db_name} missing`);
    const role = await adminDb.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [row.db_user]);
    assert.equal(role.rowCount, 1, `role ${row.db_user} missing`);
  }
  await adminDb.end();
});
await check('each tenant has its own running container with its own DATABASE_URL', async () => {
  const seen = new Set();
  for (const slug of Object.values(slugs)) {
    const r = await dockerApi('GET', `/containers/voyage-tenant-${slug}/json`);
    assert.equal(r.status, 200);
    assert.equal(r.data.State.Running, true);
    const url = r.data.Config.Env.find((e) => e.startsWith('DATABASE_URL=')).split('@')[1];
    assert.ok(url.endsWith(`/tenant_${slug}`), `container ${slug} points at ${url}`);
    seen.add(r.data.State.Pid);
  }
  assert.equal(seen.size, 6, 'each container is a distinct process');
});
await check('each tenant has its own nginx route file, and the generated nginx config passes `nginx -t`', async () => {
  for (const slug of Object.values(slugs)) {
    const conf = fs.readFileSync(path.join(WORK, 'tenants', `${slug}.conf`), 'utf8');
    assert.match(conf, new RegExp(`server_name ${slug}\\.localhost;`));
    assert.match(conf, new RegExp(`voyage-tenant-${slug}:3000`));
  }
  execFileSync('nginx', ['-t', '-c', nginxMain], { stdio: 'pipe' });
});
await check('each tenant container answers health checks with its own DB and admin ready', async () => {
  for (const slug of Object.values(slugs)) {
    const r = await tenantApi(slug, 'GET', '/health');
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.version, 'v1');
    assert.equal(r.data.adminReady, true);
  }
});
await check('a tenant database user cannot connect to another tenant database', async () => {
  const acme = await controlDb.query('SELECT db_user FROM tenants WHERE slug = $1', [slugs['Acme Travel']]);
  const bluesky = await controlDb.query('SELECT db_name FROM tenants WHERE slug = $1', [slugs['Bluesky Tours']]);
  const acmePw = await tenantPasswordFromContainer(slugs['Acme Travel']);
  const cross = new pg.Client({ connectionString: `postgres://${acme.rows[0].db_user}:${acmePw}@127.0.0.1:5432/${bluesky.rows[0].db_name}` });
  let code = null;
  try { await cross.connect(); } catch (err) { code = err.code; }
  assert.equal(code, '42501', `expected permission denied (42501), got ${code}`);
  const own = await controlDb.query('SELECT db_name FROM tenants WHERE slug = $1', [slugs['Acme Travel']]);
  const ownClient = new pg.Client({ connectionString: `postgres://${acme.rows[0].db_user}:${acmePw}@127.0.0.1:5432/${own.rows[0].db_name}` });
  await ownClient.connect();
  await ownClient.end();
});

async function tenantPasswordFromContainer(slug) {
  const r = await dockerApi('GET', `/containers/voyage-tenant-${slug}/json`);
  const url = new URL(r.data.Config.Env.find((e) => e.startsWith('DATABASE_URL=')).slice('DATABASE_URL='.length));
  return decodeURIComponent(url.password);
}

await check('admin password hashes are cleared from the control plane after provisioning', async () => {
  const { rows } = await controlDb.query("SELECT count(*)::int AS n FROM tenants WHERE admin_password_hash IS NOT NULL AND status = 'ready'");
  assert.equal(rows[0].n, 0);
});

console.log('\n[4] Tenant application: auth, CRUD, persistence');
const tokens = {};
await check('each tenant admin can sign in; wrong password is rejected', async () => {
  for (const c of COMPANIES) {
    const slug = slugs[c.company];
    const bad = await tenantApi(slug, 'POST', '/auth/login', { body: { email: c.admin, password: 'wrong-password' } });
    assert.equal(bad.status, 401);
    const ok = await tenantApi(slug, 'POST', '/auth/login', { body: { email: c.admin, password: PASSWORD } });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    tokens[c.company] = ok.data.token;
  }
});
await check('protected routes require a token', async () => {
  const r = await tenantApi(slugs['Acme Travel'], 'GET', '/trips');
  assert.equal(r.status, 401);
});

const acme = () => tokens['Acme Travel'];
const acmeSlug = () => slugs['Acme Travel'];
const ids = {};
await check('destinations, trips, itinerary and expenses: create, read, update, delete', async () => {
  const d = await tenantApi(acmeSlug(), 'POST', '/destinations', { token: acme(), body: { name: 'Lisbon', country: 'Portugal' } });
  assert.equal(d.status, 201);
  ids.dest = d.data.id;
  const t = await tenantApi(acmeSlug(), 'POST', '/trips', { token: acme(), body: {
    title: 'Lisbon spring', destination_id: ids.dest, start_date: '2099-04-01', end_date: '2099-04-07', budget: 2500, status: 'planned' } });
  assert.equal(t.status, 201, JSON.stringify(t.data));
  ids.trip = t.data.id;
  const bad = await tenantApi(acmeSlug(), 'POST', '/trips', { token: acme(), body: { title: 'x', start_date: '2099-05-10', end_date: '2099-05-01' } });
  assert.equal(bad.status, 400, 'end before start rejected');

  const e1 = await tenantApi(acmeSlug(), 'POST', `/trips/${ids.trip}/events`, { token: acme(), body: {
    title: 'Dinner at Time Out', location: 'Cais do Sodre', event_date: '2099-04-02', event_time: '20:30', category: 'meal', estimated_cost: 60 } });
  const e0 = await tenantApi(acmeSlug(), 'POST', `/trips/${ids.trip}/events`, { token: acme(), body: {
    title: 'Fly in', event_date: '2099-04-01', event_time: '08:00', category: 'transport', estimated_cost: 300 } });
  assert.equal(e1.status, 201);
  assert.equal(e0.status, 201);
  const list = await tenantApi(acmeSlug(), 'GET', `/trips/${ids.trip}/events`, { token: acme() });
  assert.deepEqual(list.data.map((e) => e.title), ['Fly in', 'Dinner at Time Out'], 'chronological order');
  const upd = await tenantApi(acmeSlug(), 'PUT', `/events/${e0.data.id}`, { token: acme(), body: {
    title: 'Fly in (delayed)', event_date: '2099-04-01', event_time: '10:00', category: 'transport', estimated_cost: 320 } });
  assert.equal(upd.data.title, 'Fly in (delayed)');
  await tenantApi(acmeSlug(), 'DELETE', `/events/${e1.data.id}`, { token: acme() });

  const x = await tenantApi(acmeSlug(), 'POST', '/expenses', { token: acme(), body: {
    description: 'Train tickets', amount: 45.5, category: 'transport', expense_date: '2099-04-02', trip_id: ids.trip } });
  assert.equal(x.status, 201);
  ids.expense = x.data.id;
  const stats = await tenantApi(acmeSlug(), 'GET', '/dashboard/stats', { token: acme() });
  assert.equal(stats.data.total_trips, 1);
  assert.equal(stats.data.upcoming_trips, 1);
  assert.equal(stats.data.total_expenses, 45.5);
  const trip = await tenantApi(acmeSlug(), 'PUT', `/trips/${ids.trip}`, { token: acme(), body: {
    title: 'Lisbon spring', destination_id: ids.dest, start_date: '2099-04-01', end_date: '2099-04-07', budget: 2600, status: 'ongoing' } });
  assert.equal(trip.data.budget, 2600);
});
await check('settings: company name and admin profile update', async () => {
  const c = await tenantApi(acmeSlug(), 'PUT', '/settings/company', { token: acme(), body: { name: 'Acme Travel Ltd' } });
  assert.equal(c.data.company.name, 'Acme Travel Ltd');
  const s = await tenantApi(acmeSlug(), 'GET', '/settings', { token: acme() });
  assert.equal(s.data.company.name, 'Acme Travel Ltd');
  assert.equal(s.data.version, 'v1');
});
await check('data persists after a container restart (stop + start, same database)', async () => {
  await dockerApi('POST', `/containers/voyage-tenant-${acmeSlug()}/stop`);
  await dockerApi('POST', `/containers/voyage-tenant-${acmeSlug()}/start`);
  await waitFor(async () => (await tenantApi(acmeSlug(), 'GET', '/health')).status === 200, 'acme restarted');
  const list = await tenantApi(acmeSlug(), 'GET', '/trips', { token: acme() });
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].title, 'Lisbon spring');
});

console.log('\n[5] Five tenants: data isolation');
await check('each tenant creates a trip; each sees only its own data', async () => {
  for (const c of COMPANIES) {
    const slug = slugs[c.company];
    const r = await tenantApi(slug, 'POST', '/trips', { token: tokens[c.company], body: {
      title: `Trip for ${slug}`, start_date: '2099-06-01', end_date: '2099-06-05' } });
    assert.equal(r.status, 201);
  }
  for (const c of COMPANIES) {
    const slug = slugs[c.company];
    const list = await tenantApi(slug, 'GET', '/trips', { token: tokens[c.company] });
    const titles = list.data.map((t) => t.title);
    assert.ok(titles.includes(`Trip for ${slug}`), `${slug} sees its own trip`);
    for (const other of Object.values(slugs)) {
      if (other !== slug) assert.ok(!titles.includes(`Trip for ${other}`), `${slug} must not see ${other}'s trip`);
    }
  }
});
await check('a token issued by one tenant is rejected by every other tenant', async () => {
  for (const other of COMPANIES.slice(1)) {
    const r = await tenantApi(slugs[other.company], 'GET', '/trips', { token: acme() });
    assert.equal(r.status, 401, `Acme token accepted by ${other.company}`);
  }
});

console.log('\n[6] Independent version deployment');
for (const slug of Object.values(slugs)) {
  const r = await dockerApi('GET', `/containers/voyage-tenant-${slug}/json`);
  pids[slug] = r.data.State.Pid;
}
const acmeTripsBefore = (await tenantApi(acmeSlug(), 'GET', '/trips', { token: acme() })).data.length;

await check('deploying an unknown image is refused (422) and an invalid version is refused (400)', async () => {
  const unknown = await ctl('POST', `/api/admin/tenants/${acmeSlug()}/deploy`, { ...adminOpts, body: { version: 'v9' } });
  assert.equal(unknown.status, 422);
  const invalid = await ctl('POST', `/api/admin/tenants/${acmeSlug()}/deploy`, { ...adminOpts, body: { version: 'latest; rm -rf /' } });
  assert.equal(invalid.status, 400);
});
await check('the admin page lists available versions', async () => {
  const r = await ctl('GET', '/api/admin/versions', adminOpts);
  assert.deepEqual(r.data.versions, ['v1', 'v2']);
});
await check('Client A (Acme) is upgraded to v2: container replaced, database preserved', async () => {
  const r = await ctl('POST', `/api/admin/tenants/${acmeSlug()}/deploy`, { ...adminOpts, body: { version: 'v2' } });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  await waitAdminReady(acmeSlug(), 'v2');
  const h = await tenantApi(acmeSlug(), 'GET', '/health');
  assert.equal(h.data.version, 'v2');
  const trips = await tenantApi(acmeSlug(), 'GET', '/trips', { token: acme() });
  assert.equal(trips.status, 200);
  assert.equal(trips.data.length, acmeTripsBefore, 'trips preserved across the container replacement');
  const newPid = (await dockerApi('GET', `/containers/voyage-tenant-${acmeSlug()}/json`)).data.State.Pid;
  assert.notEqual(newPid, pids[acmeSlug()], 'Acme container was recreated');
});
await check('Clients B, C, D and E remain on v1 and their containers were not touched', async () => {
  for (const c of COMPANIES.slice(1)) {
    const slug = slugs[c.company];
    const row = await adminRow(slug);
    assert.equal(row.version, 'v1', `${slug} version changed`);
    const h = await tenantApi(slug, 'GET', '/health');
    assert.equal(h.data.version, 'v1', `${slug} runtime version changed`);
    const pid = (await dockerApi('GET', `/containers/voyage-tenant-${slug}/json`)).data.State.Pid;
    assert.equal(pid, pids[slug], `${slug} container was restarted`);
  }
});
await check('the admin view reports Client A = v2 and the others = v1', async () => {
  const rows = (await ctl('GET', '/api/admin/tenants', adminOpts)).data;
  const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r.version]));
  assert.equal(bySlug[acmeSlug()], 'v2');
  for (const c of COMPANIES.slice(1)) assert.equal(bySlug[slugs[c.company]], 'v1', c.company);
  assert.equal(bySlug[slugs['Acme Travel (second)']], 'v1', 'second Acme workspace untouched');
});
await check('Acme sign-in still works on v2 and existing data is intact', async () => {
  const r = await tenantApi(acmeSlug(), 'POST', '/auth/login', { body: { email: 'ana@acme.test', password: PASSWORD } });
  assert.equal(r.status, 200);
  const exp = await tenantApi(acmeSlug(), 'GET', '/expenses', { token: r.data.token });
  assert.equal(exp.data.length, 1);
});
await check('rollback restores Client A to v1 with its data still in place', async () => {
  const r = await ctl('POST', `/api/admin/tenants/${acmeSlug()}/rollback`, adminOpts);
  assert.equal(r.status, 202);
  await waitAdminReady(acmeSlug(), 'v1');
  const trips = await tenantApi(acmeSlug(), 'GET', '/trips', { token: acme() });
  assert.equal(trips.data.length, acmeTripsBefore);
});
await check('after rollback the other four tenants are still untouched', async () => {
  for (const c of COMPANIES.slice(1)) {
    const slug = slugs[c.company];
    const pid = (await dockerApi('GET', `/containers/voyage-tenant-${slug}/json`)).data.State.Pid;
    assert.equal(pid, pids[slug], `${slug} restarted during rollback`);
  }
});

console.log('\n[7] GitHub-connected Deployment Manager');
const DEV = path.join(WORK, 'developer');
const PAGES_REL = 'voyage/tenant-app/client/src/pages.jsx';
const PAGES_MSG = 'Add metrics module, tidy pages, drop old README';
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const gitOut = (...args) => execFileSync('git', ['-C', REMOTE, ...args], { encoding: 'utf8' }).trim();
const buildEntries = () => (fs.existsSync(BUILD_LOG) ? fs.readFileSync(BUILD_LOG, 'utf8').trim().split('\n').map((l) => l.split(' ')) : []);
const otherSlugs = () => COMPANIES.slice(1).map((c) => slugs[c.company]);
const snapshot = async (list) => {
  const out = {};
  for (const s of list) {
    out[s] = { pid: (await dockerApi('GET', `/containers/voyage-tenant-${s}/json`)).data.State.Pid, version: (await adminRow(s)).version };
  }
  return out;
};
const lastDeploymentId = async () => Number((await controlDb.query('SELECT COALESCE(MAX(id), 0) AS m FROM deployments')).rows[0].m);
const waitDeployment = (slug, afterId) => waitFor(async () => {
  const d = (await ctl('GET', `/api/admin/releases/status?slug=${slug}`, adminOpts)).data.latestDeployment;
  if (!d || Number(d.id) <= afterId || d.status === 'running') return null;
  return d;
}, `deployment of ${slug}`, 240000);
const sameOthers = async (before) => {
  for (const s of otherSlugs()) {
    const now = await snapshot([s]);
    assert.equal(now[s].pid, before[s].pid, `${s} container was restarted`);
    assert.equal(now[s].version, before[s].version, `${s} version changed`);
  }
};
let commit1 = null, commit2 = null, v3 = null, v4 = null;

await check('VS Code change: a developer commits and pushes to GitHub', async () => {
  execFileSync('bash', ['-c', `git clone -q "${REMOTE}" "${DEV}" && cd "${DEV}" && git config user.name "Dev Person" && git config user.email dev@example.test`]);
  fs.appendFileSync(path.join(DEV, PAGES_REL), '\n// dev-change-1\n');
  fs.writeFileSync(path.join(DEV, 'voyage/tenant-app/server/metrics.js'), 'export const metrics = true;\n');
  execFileSync('git', ['-C', DEV, 'rm', '-q', 'voyage/README.md']);
  execFileSync('bash', ['-c', `cd "${DEV}" && git add -A && git commit -qm "${PAGES_MSG}" && git push -q origin main`]);
  commit1 = gitOut('rev-parse', 'main');
});
await check('GitHub connection returns the latest commits with message and author; token never returned', async () => {
  const r = await ctl('GET', '/api/admin/github/commits', adminOpts);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data[0].sha, commit1);
  assert.equal(r.data[0].message, PAGES_MSG);
  assert.equal(r.data[0].author, 'Dev Person');
  assert.ok(!JSON.stringify(r.data).includes(GITHUB_TOKEN), 'token must not leave the server');
  assert.ok(gh.seenAuth.includes(`Bearer ${GITHUB_TOKEN}`), 'GitHub requests are authenticated on the server');
});
await check('change detection: added, modified and deleted files are identified', async () => {
  const r = await ctl('GET', `/api/admin/github/changes?slug=${acmeSlug()}`, adminOpts);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.latest.sha, commit1);
  assert.equal(r.data.baseline, null, 'no GitHub-tracked deployment for Client A yet');
  const st = Object.fromEntries(r.data.latestFiles.map((f) => [f.path, f.status]));
  assert.equal(st[PAGES_REL], 'modified');
  assert.equal(st['voyage/tenant-app/server/metrics.js'], 'added');
  assert.equal(st['voyage/README.md'], 'deleted');
});
await check('DEPLOY CHANGES builds the commit and deploys it to Client A only', async () => {
  const others = await snapshot(otherSlugs());
  const after = await lastDeploymentId();
  const r = await ctl('POST', '/api/admin/releases', { ...adminOpts, body: { slug: acmeSlug(), sha: commit1 } });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  const dep = await waitDeployment(acmeSlug(), after);
  assert.equal(dep.status, 'succeeded', dep.detail);
  v3 = dep.to_version;
  assert.equal(dep.commit_hash, commit1);
  const built = buildEntries().find(([tag]) => tag.endsWith(`:${v3}`));
  assert.equal(built[1], sha256(execFileSync('git', ['-C', REMOTE, 'show', `${commit1}:${PAGES_REL}`])), 'the image was built from exactly this commit');
  assert.equal((await tenantApi(acmeSlug(), 'GET', '/health')).data.version, v3);
  const env = (await dockerApi('GET', `/containers/voyage-tenant-${acmeSlug()}/json`)).data.Config.Env;
  assert.ok(env.includes(`RELEASE_MESSAGE=${PAGES_MSG}`), 'release note reached the container');
  await sameOthers(others);
});
await check("Client A's workspace shows What's New with the deployed commit message and date", async () => {
  const r = await tenantApi(acmeSlug(), 'GET', '/whats-new', { token: acme() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.version, v3);
  assert.equal(r.data.message, PAGES_MSG);
  assert.ok(r.data.releasedAt, 'release date present');
  assert.ok(!JSON.stringify(r.data).includes(GITHUB_TOKEN), 'no credentials exposed to customers');
});
await check('deployment history records commit hash, message, versions and status', async () => {
  const r = await ctl('GET', `/api/admin/releases/history?slug=${acmeSlug()}`, adminOpts);
  const row = r.data[0];
  assert.equal(row.to_version, v3);
  assert.equal(row.commit_hash, commit1);
  assert.equal(row.commit_message, PAGES_MSG);
  assert.equal(row.status, 'succeeded');
  assert.ok(row.created_at);
});
await check('after a second push, only the changes not yet deployed are listed', async () => {
  fs.appendFileSync(path.join(DEV, PAGES_REL), '\n// dev-change-2\n');
  execFileSync('bash', ['-c', `cd "${DEV}" && git commit -qam "Second pages tweak" && git push -q origin main`]);
  commit2 = gitOut('rev-parse', 'main');
  const r = await ctl('GET', `/api/admin/github/changes?slug=${acmeSlug()}`, adminOpts);
  assert.equal(r.data.latest.sha, commit2);
  assert.equal(r.data.baseline, commit1);
  assert.equal(r.data.upToDate, false);
  assert.deepEqual(r.data.files, [{ path: PAGES_REL, status: 'modified' }]);
});
await check('deploying the new commit leaves Client A up to date; other clients untouched', async () => {
  const others = await snapshot(otherSlugs());
  const after = await lastDeploymentId();
  const r = await ctl('POST', '/api/admin/releases', { ...adminOpts, body: { slug: acmeSlug(), sha: commit2 } });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  const dep = await waitDeployment(acmeSlug(), after);
  assert.equal(dep.status, 'succeeded', dep.detail);
  v4 = dep.to_version;
  assert.notEqual(v4, v3);
  const c = await ctl('GET', `/api/admin/github/changes?slug=${acmeSlug()}`, adminOpts);
  assert.equal(c.data.upToDate, true);
  assert.deepEqual(c.data.files, []);
  await sameOthers(others);
});
await check('rolling back Client A to an earlier version is recorded and keeps its trips', async () => {
  const trips = (await tenantApi(acmeSlug(), 'GET', '/trips', { token: acme() })).data.length;
  const after = await lastDeploymentId();
  const r = await ctl('POST', '/api/admin/releases/rollback', { ...adminOpts, body: { slug: acmeSlug(), version: v3 } });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  const dep = await waitDeployment(acmeSlug(), after);
  assert.equal(dep.kind, 'rollback');
  assert.equal(dep.status, 'succeeded', dep.detail);
  assert.equal((await tenantApi(acmeSlug(), 'GET', '/health')).data.version, v3);
  assert.equal((await tenantApi(acmeSlug(), 'GET', '/trips', { token: acme() })).data.length, trips);
});
await check("Client A's Updates page lists the update and the rollback, newest first", async () => {
  const r = await tenantApi(acmeSlug(), 'GET', '/releases', { token: acme() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data[0].kind, 'rollback');
  assert.equal(r.data[0].version, v3);
  assert.ok(r.data.some((x) => x.kind === 'deploy' && x.version === v4 && x.message === 'Second pages tweak'));
  assert.ok(r.data.some((x) => x.kind === 'deploy' && x.version === v3));
});
await check('invalid requests are refused before anything is built or deployed', async () => {
  const cases = [
    ['/api/admin/releases', { slug: acmeSlug(), sha: 'main' }, 400],
    ['/api/admin/releases', { slug: acmeSlug(), sha: '0'.repeat(40) }, 422],
    ['/api/admin/releases', { slug: 'nosuchclient', sha: commit2 }, 404],
    ['/api/admin/releases/rollback', { slug: acmeSlug(), version: 'v9' }, 422],
    ['/api/admin/releases/rollback', { slug: acmeSlug(), version: 'latest; rm' }, 400],
  ];
  for (const [p, body, code] of cases) {
    const r = await ctl('POST', p, { ...adminOpts, body });
    assert.equal(r.status, code, `${p} ${JSON.stringify(body)} returned ${r.status}`);
  }
});

console.log('\n[8] Usage, AWS cost allocation and billing');
const MODE_FILE = path.join(WORK, 'aws-mode');
const billing = async (month = '') => (await ctl('GET', `/api/admin/billing${month ? `?month=${month}` : ''}`, adminOpts)).data;
const thisMonth = new Date().toISOString().slice(0, 7);

await check('usage is measured per client: requests, CPU, memory, storage and network', async () => {
  const deadline = Date.now() + 90000;
  let b = null;
  while (Date.now() < deadline) {
    b = await billing();
    const acme = b.tenants.find((t) => t.slug === acmeSlug());
    if (b.tenants.length >= 6 && b.tenants.every((t) => t.cpu_avg_percent > 0 && t.storage_mb > 0 && t.mem_peak_mb > 0 && t.network_gb >= 0)
      && acme.requests > 0) break;
    await sleep(1000);
  }
  assert.ok(b.tenants.length >= 6, `expected every client, got ${b.tenants.length}`);
  for (const t of b.tenants) {
    assert.ok(t.cpu_avg_percent > 0, `${t.company_name} has CPU readings`);
    assert.ok(t.mem_peak_mb > 0, `${t.company_name} has memory readings`);
    assert.ok(t.storage_mb > 0, `${t.company_name} has database storage`);
  }
  assert.ok(b.tenants.find((t) => t.slug === acmeSlug()).requests > 0, 'API requests counted for Client A');
});

await check('AWS costs sync from Cost Explorer and are shown as AWS-reported, not invented', async () => {
  const r = await ctl('POST', '/api/admin/aws/sync', adminOpts);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'ok', r.data.message);
  const b = await billing();
  assert.equal(b.aws.ec2, 12.5);
  assert.equal(b.aws.ebs, 3);
  assert.equal(b.aws.dataTransfer, 1.5);
  assert.equal(b.overview.aws_total, 17.5);
  assert.equal(b.aws_sync.status, 'ok');
});

await check('shared EC2, EBS and transfer costs are allocated by measured usage; the rest stays unallocated', async () => {
  const b = await billing();
  const ec2 = b.tenants.reduce((s, t) => s + t.allocated_aws.ec2, 0);
  const ebs = b.tenants.reduce((s, t) => s + t.allocated_aws.ebs, 0);
  assert.ok(Math.abs(ec2 - 12.5) < 0.05, `EC2 allocated ${ec2}`);
  assert.ok(Math.abs(ebs - 3) < 0.05, `EBS allocated ${ebs}`);
  assert.ok(Math.abs(b.overview.unallocated_aws - 0.5) < 0.05, `unallocated ${b.overview.unallocated_aws}`);
});

await check('each client bill = usage charges + allocated AWS + platform fee', async () => {
  const b = await billing();
  for (const t of b.tenants) {
    const expected = t.usage_charges + t.allocated_aws.total + t.platform_fee;
    assert.ok(Math.abs(t.total_bill - expected) < 0.02, `${t.company_name}: ${t.total_bill} vs ${expected}`);
    assert.equal(t.usage_lines.length, 7);
  }
});

await check('pricing can be changed by the admin; invalid pricing is refused', async () => {
  let r = await ctl('PUT', '/api/admin/pricing', { ...adminOpts, body: { rates: { base_fee: 10 } } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const acme = (await billing()).tenants.find((t) => t.slug === acmeSlug());
  assert.equal(acme.usage_lines[0].amount, 10, 'new base fee applied');
  await ctl('PUT', '/api/admin/pricing', { ...adminOpts, body: { rates: { base_fee: 9 } } });
  r = await ctl('PUT', '/api/admin/pricing', { ...adminOpts, body: { rates: { alloc_weight_cpu: 0.7 } } });
  assert.equal(r.status, 400, 'weights must add up to 1');
  r = await ctl('PUT', '/api/admin/pricing', { ...adminOpts, body: { rates: { made_up_rate: 1 } } });
  assert.equal(r.status, 400, 'unknown rate refused');
});

await check('usage collection and billing summaries do not duplicate on repeat runs', async () => {
  await ctl('POST', '/api/admin/usage/collect', adminOpts);
  await ctl('POST', '/api/admin/usage/collect', adminOpts);
  const h = await ctl('GET', `/api/admin/billing/history?slug=${acmeSlug()}`, adminOpts);
  assert.equal(h.status, 200);
  assert.equal(h.data.filter((x) => x.month === thisMonth).length, 1, 'one summary per client per month');
});

await check('a missing AWS permission is reported clearly and never breaks the page', async () => {
  fs.writeFileSync(MODE_FILE, 'denied');
  const r = await ctl('POST', '/api/admin/aws/sync', adminOpts);
  assert.equal(r.data.status, 'not_configured', JSON.stringify(r.data));
  const b = await billing();
  assert.equal(b.aws_sync.status, 'not_configured');
  assert.equal(b.overview.aws_total, 17.5, 'last good AWS figures are kept, not invented');
  fs.writeFileSync(MODE_FILE, 'ok');
  assert.equal((await ctl('POST', '/api/admin/aws/sync', adminOpts)).data.status, 'ok');
});

await check('billing is admin-only; clients cannot reach it and bad input is refused', async () => {
  assert.equal((await ctl('GET', '/api/admin/billing')).status, 401);
  assert.equal((await ctl('GET', '/api/admin/pricing')).status, 401);
  assert.equal((await ctl('POST', '/api/admin/aws/sync')).status, 401);
  const tenantTry = await tenantApi(acmeSlug(), 'GET', '/admin/billing', { token: acme() });
  assert.notEqual(tenantTry.status, 200);
  assert.equal((await ctl('GET', '/api/admin/billing?month=2026-13', adminOpts)).status, 400);
  assert.equal((await ctl('GET', '/api/admin/billing/history?slug=../etc', adminOpts)).status, 400);
});

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`}`);
if (failed) console.log('\n--- control plane log (tail) ---\n' + controlLog.slice(-2500));

control.kill('SIGTERM');
await fake.stopAll();
gh.close();
await controlDb.end();
process.exit(failed ? 1 : 0);
