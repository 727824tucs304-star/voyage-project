import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { exec } from './docker.js';

export function tenantConf(host, containerName) {
  return `# Managed by the Voyage control plane. Do not edit by hand.
server {
    listen 80;
    server_name ${host};
    client_max_body_size 5m;

    location / {
        resolver 127.0.0.11 valid=10s ipv6=off;
        set $tenant_upstream ${containerName}:${config.tenantPort};
        proxy_pass http://$tenant_upstream;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`;
}

// Writes the tenant's routing file, validates the full nginx config, then reloads.
// On failure the previous file is restored so one bad change cannot break other tenants.
export async function applyTenantConf(slug, content) {
  await fs.mkdir(config.nginxTenantDir, { recursive: true });
  const file = path.join(config.nginxTenantDir, `${slug}.conf`);
  let previous = null;
  try {
    previous = await fs.readFile(file, 'utf8');
  } catch {
    /* first write */
  }
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, content, { mode: 0o644 });
  await fs.rename(tmp, file);
  try {
    const test = await exec(config.nginxContainer, ['nginx', '-t']);
    if (test.exitCode !== 0) throw new Error(`nginx config test failed: ${test.output.trim().slice(0, 300)}`);
    const reload = await exec(config.nginxContainer, ['nginx', '-s', 'reload']);
    if (reload.exitCode !== 0) throw new Error(`nginx reload failed: ${reload.output.trim().slice(0, 300)}`);
  } catch (err) {
    if (previous !== null) await fs.writeFile(file, previous);
    else await fs.rm(file, { force: true });
    throw err;
  }
}
