const need = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

const controlSecret = need('CONTROL_SECRET');
if (controlSecret.length < 32) throw new Error('CONTROL_SECRET must be at least 32 characters');
// The shared token is optional. Once personal admin accounts are in use, unset ADMIN_TOKEN to retire it.
const adminToken = process.env.ADMIN_TOKEN || '';
if (adminToken && adminToken.length < 24) throw new Error('ADMIN_TOKEN must be at least 24 characters, or unset it');
const baseDomain = need('BASE_DOMAIN').toLowerCase();
if (!/^[a-z0-9.-]+$/.test(baseDomain)) throw new Error('BASE_DOMAIN must be a plain domain name');
const githubRepo = process.env.GITHUB_REPO || '';
if (githubRepo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepo)) {
  throw new Error('GITHUB_REPO must look like owner/repo');
}
const githubBranch = process.env.GITHUB_BRANCH || 'main';
if (!/^[A-Za-z0-9._/-]+$/.test(githubBranch)) throw new Error('GITHUB_BRANCH has invalid characters');

export const config = {
  port: Number(process.env.PORT || 4000),
  baseDomain,
  workspaceScheme: process.env.WORKSPACE_SCHEME || 'http',
  workspacePort: process.env.WORKSPACE_PORT || '',
  controlDbUrl: need('CONTROL_DB_URL'),
  controlSecret,
  adminToken,
  registerLimitPerHour: Number(process.env.REGISTER_LIMIT_PER_HOUR || 5),
  loginLimitPer15Min: Number(process.env.LOGIN_LIMIT_PER_15_MIN || 10),
  // Number of proxies in front of the control plane. nginx adds X-Forwarded-For, so the default is 1.
  trustProxy: Number(process.env.TRUST_PROXY || 1),
  tenantPgHost: process.env.TENANT_PG_HOST || 'voyage-postgres',
  tenantPgPort: Number(process.env.TENANT_PG_PORT || 5432),
  dockerSocket: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
  dockerNetwork: process.env.DOCKER_NETWORK || 'voyage-net',
  dockerBin: process.env.DOCKER_BIN || 'docker',
  tenantImageRepo: process.env.TENANT_IMAGE_REPO || 'voyage-tenant',
  vesperaImageRepo: process.env.VESPERA_IMAGE_REPO || 'vespera-tenant',
  // New workspaces are created on this product. Vespera is the official product.
  tenantDefaultProduct: process.env.TENANT_DEFAULT_PRODUCT || 'vespera',
  tenantDefaultVersion: process.env.TENANT_DEFAULT_VERSION || 'v1',
  tenantPort: 3000,
  nginxContainer: process.env.NGINX_CONTAINER || 'voyage-nginx',
  nginxTenantDir: process.env.NGINX_TENANT_DIR || '/etc/nginx/tenants',
  healthTimeoutMs: Number(process.env.HEALTH_TIMEOUT_MS || 90000),
  // GitHub: the token stays on the server and is only sent to GitHub's API and git.
  githubRepo,
  githubBranch,
  githubToken: process.env.GITHUB_TOKEN || '',
  githubApiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
  // Local clone of the repository (git root) and the folder inside it that holds the project.
  repoRoot: process.env.REPO_ROOT || '/workspace',
  projectSubdir: process.env.PROJECT_SUBDIR || 'voyage',
  gitAskpass: process.env.GIT_ASKPASS || '',
  // Per-client recording storage lives under this root. In production it is a Docker volume per client.
  storageRoot: process.env.STORAGE_ROOT || '/data',
  // How often usage is sampled. One sample = one unit of running time.
  meterIntervalMs: Number(process.env.METER_INTERVAL_MS || 3600000),
  // AWS cost sync frequency. Cost Explorer data changes slowly, so syncing every few hours is enough.
  awsSyncIntervalMs: Number(process.env.AWS_SYNC_INTERVAL_MS || 6 * 3600000),
};
