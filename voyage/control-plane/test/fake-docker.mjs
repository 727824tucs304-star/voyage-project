// TEST DOUBLE for the Docker Engine API (no Docker daemon exists in the test sandbox).
// Implements only the endpoints the control plane uses. Each "container" is a real
// tenant-app Node process bound to its own loopback IP; the container name is mapped in
// /etc/hosts so the control plane reaches it by name, the same way Docker's DNS would.
// nginx -t runs the real nginx binary against the generated tenant configs.
import http from 'node:http';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const MARK = '# voyage-test';

function setHosts(name, ip) {
  const lines = fs.readFileSync('/etc/hosts', 'utf8').split('\n')
    .filter((l) => l && !l.includes(` ${name} ${MARK}`));
  if (ip) lines.push(`${ip} ${name} ${MARK}`);
  fs.writeFileSync('/etc/hosts', lines.join('\n') + '\n');
}

export function startFakeDocker({ socketPath, tenantEntry, nginxMain, logDir }) {
  const containers = new Map();
  const execs = new Map();
  const ips = new Map();
  const images = new Set(['voyage-tenant:v1', 'voyage-tenant:v2']);
  let networkReady = false;
  let seq = 1000;
  // The edge proxy is a long-running container on the host; it has no tenant process.
  containers.set('voyage-nginx', {
    Id: 'nginx0', name: 'voyage-nginx', child: null,
    Config: { Image: 'nginx:1.27-alpine', Env: [], Labels: {} },
    State: { Running: true, Pid: 1 },
  });

  const ipFor = (name) => {
    if (!ips.has(name)) ips.set(name, `127.0.0.${ips.size + 10}`);
    return ips.get(name);
  };
  const envObj = (list = []) =>
    Object.fromEntries(list.map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
  const describe = (c) => ({
    Id: c.Id,
    Name: `/${c.name}`,
    Config: { Image: c.Config.Image, Env: c.Config.Env, Labels: c.Config.Labels },
    State: c.State,
    NetworkSettings: { Networks: { 'voyage-net': { IPAddress: ipFor(c.name) } } },
  });

  function startProc(c) {
    const env = {
      ...envObj(c.Config.Env),
      APP_VERSION: c.Config.Image.split(':')[1], // what the image bakes in at build time
      NODE_ENV: 'production',
      PATH: process.env.PATH,
      HOST: ipFor(c.name),
    };
    const out = fs.openSync(`${logDir}/${c.name}.log`, 'a');
    const child = spawn(process.execPath, [tenantEntry], { env, stdio: ['ignore', out, out] });
    c.child = child;
    c.State = { Running: true, Pid: child.pid };
    setHosts(c.name, env.HOST);
  }

  function stopProc(c) {
    return new Promise((resolve) => {
      const child = c.child;
      c.child = null;
      c.State = { Running: false, Pid: 0 };
      if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
    });
  }

  function runExec(cmd) {
    if (cmd[0] === 'nginx' && cmd[1] === '-t') {
      const r = spawnSync('nginx', ['-t', '-c', nginxMain], { encoding: 'utf8' });
      return { status: r.status, output: (r.stdout || '') + (r.stderr || '') };
    }
    if (cmd[0] === 'nginx' && cmd[1] === '-s') {
      return { status: 0, output: 'reload accepted (test harness has no running nginx master)\n' };
    }
    return { status: 127, output: `unsupported command: ${cmd.join(' ')}` };
  }

  async function handle(method, url, body, send) {
    const p = decodeURIComponent(url.pathname);
    let m;
    if (method === 'GET' && p === '/images/json') {
      return send(200, [...images].map((t) => ({ RepoTags: [t] })));
    }
    if (method === 'GET' && (m = p.match(/^\/images\/(.+)\/json$/))) {
      return images.has(m[1]) ? send(200, { Id: m[1] }) : send(404, { message: 'no such image' });
    }
    if (method === 'GET' && (m = p.match(/^\/networks\/(.+)$/))) {
      return networkReady && m[1] === 'voyage-net' ? send(200, { Name: m[1] }) : send(404, { message: 'network not found' });
    }
    if (method === 'POST' && p === '/networks/create') {
      networkReady = true;
      return send(201, { Id: 'net1' });
    }
    if (method === 'POST' && p === '/containers/create') {
      const name = url.searchParams.get('name');
      if (containers.has(name)) return send(409, { message: 'Conflict: container name already in use' });
      if (!images.has(body.Image)) return send(404, { message: `No such image: ${body.Image}` });
      if (body.HostConfig?.NetworkMode !== 'voyage-net') return send(400, { message: 'unexpected network' });
      const Id = `c${(seq++).toString(16)}`;
      containers.set(name, {
        Id, name, child: null,
        Config: { Image: body.Image, Env: body.Env || [], Labels: body.Labels || {} },
        State: { Running: false, Pid: 0 },
      });
      return send(201, { Id });
    }
    if (method === 'GET' && (m = p.match(/^\/containers\/([^/]+)\/json$/))) {
      const c = containers.get(m[1]);
      return c ? send(200, describe(c)) : send(404, { message: 'no such container' });
    }
    if (method === 'POST' && (m = p.match(/^\/containers\/([^/]+)\/start$/))) {
      const c = containers.get(m[1]);
      if (!c) return send(404, { message: 'no such container' });
      if (c.State.Running) return send(304);
      startProc(c);
      return send(204);
    }
    if (method === 'POST' && (m = p.match(/^\/containers\/([^/]+)\/stop$/))) {
      const c = containers.get(m[1]);
      if (!c) return send(404, { message: 'no such container' });
      await stopProc(c);
      setHosts(c.name, null);
      return send(204);
    }
    if (method === 'DELETE' && (m = p.match(/^\/containers\/([^/]+)$/))) {
      const c = containers.get(m[1]);
      if (!c) return send(404, { message: 'no such container' });
      await stopProc(c);
      setHosts(c.name, null);
      containers.delete(c.name);
      return send(204);
    }
    if (method === 'POST' && (m = p.match(/^\/containers\/([^/]+)\/exec$/))) {
      const c = containers.get(m[1]);
      if (!c) return send(404, { message: 'no such container' });
      const id = `e${seq++}`;
      execs.set(id, { cmd: body.Cmd, exitCode: null });
      return send(201, { Id: id });
    }
    if (method === 'POST' && (m = p.match(/^\/exec\/([^/]+)\/start$/))) {
      const e = execs.get(m[1]);
      if (!e) return send(404, { message: 'no such exec' });
      const r = runExec(e.cmd);
      e.exitCode = r.status;
      return send(200, r.output);
    }
    if (method === 'GET' && (m = p.match(/^\/exec\/([^/]+)\/json$/))) {
      return send(200, { ExitCode: execs.get(m[1])?.exitCode ?? -1 });
    }
    return send(404, { message: `fake docker: unsupported ${method} ${p}` });
  }

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* none */ }
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': typeof data === 'string' ? 'text/plain' : 'application/json' });
      res.end(data === undefined || data === null ? '' : typeof data === 'string' ? data : JSON.stringify(data));
    };
    try {
      await handle(req.method, new URL(req.url, 'http://docker'), body, send);
    } catch (err) {
      send(500, { message: err.message });
    }
  });

  try { fs.rmSync(socketPath, { force: true }); } catch { /* ok */ }
  server.listen(socketPath);

  return {
    server,
    stopAll: async () => {
      for (const c of containers.values()) { await stopProc(c); setHosts(c.name, null); }
      server.close();
    },
  };
}
