// Minimal Docker Engine API client over the unix socket. Only the provisioning service uses it.
import http from 'node:http';
import { config } from './config.js';
import { VERSION_RE } from './security.js';

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {};
    const req = http.request({ socketPath: config.dockerSocket, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = raw;
        try {
          data = raw ? JSON.parse(raw) : null;
        } catch {
          /* plain text or multiplexed stream */
        }
        resolve({ status: res.statusCode, data });
      });
    });
    req.setTimeout(120_000, () => req.destroy(new Error('Docker API request timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function ensureNetwork() {
  const found = await request('GET', `/networks/${encodeURIComponent(config.dockerNetwork)}`);
  if (found.status === 200) return;
  const created = await request('POST', '/networks/create', {
    Name: config.dockerNetwork,
    Driver: 'bridge',
    Labels: { app: 'voyage' },
  });
  if (created.status !== 201) throw new Error(`could not create network ${config.dockerNetwork} (HTTP ${created.status})`);
}

export async function imageExists(image) {
  return (await request('GET', `/images/${encodeURIComponent(image)}/json`)).status === 200;
}

export async function listTenantVersions() {
  const r = await request('GET', '/images/json');
  const prefix = `${config.tenantImageRepo}:`;
  return (r.data || [])
    .flatMap((img) => img.RepoTags || [])
    .filter((tag) => tag.startsWith(prefix))
    .map((tag) => tag.slice(prefix.length))
    .filter((v) => VERSION_RE.test(v))
    .sort();
}

export async function inspectContainer(name) {
  const r = await request('GET', `/containers/${encodeURIComponent(name)}/json`);
  return r.status === 200 ? r.data : null;
}

export async function createContainer(name, spec) {
  const r = await request('POST', `/containers/create?name=${encodeURIComponent(name)}`, spec);
  if (r.status !== 201) throw new Error(`create ${name} failed: ${r.data?.message || `HTTP ${r.status}`}`);
}

export async function startContainer(name) {
  const r = await request('POST', `/containers/${encodeURIComponent(name)}/start`);
  if (r.status !== 204 && r.status !== 304) throw new Error(`start ${name} failed: ${r.data?.message || `HTTP ${r.status}`}`);
}

export async function removeContainer(name) {
  const r = await request('DELETE', `/containers/${encodeURIComponent(name)}?force=true`);
  if (r.status !== 204 && r.status !== 404) throw new Error(`remove ${name} failed: ${r.data?.message || `HTTP ${r.status}`}`);
}

// Runs a command inside a running container and returns its exit code and output.
export async function exec(container, cmd) {
  const created = await request('POST', `/containers/${encodeURIComponent(container)}/exec`, {
    AttachStdout: true,
    AttachStderr: true,
    Cmd: cmd,
  });
  if (created.status !== 201) throw new Error(`exec in ${container} failed (HTTP ${created.status})`);
  const out = await request('POST', `/exec/${created.data.Id}/start`, { Detach: false, Tty: false });
  const info = await request('GET', `/exec/${created.data.Id}/json`);
  const text = typeof out.data === 'string' ? out.data : '';
  return {
    exitCode: info.data?.ExitCode ?? -1,
    output: text.replace(/[^\x09\x0a\x20-\x7e]/g, ''),
  };
}
