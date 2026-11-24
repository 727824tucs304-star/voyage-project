// Deploys one customer workspace to one image version, using the same deployment logic as the admin console.
// Run inside the control container by GitHub Actions, through AWS Systems Manager:
//   node src/deploy-cli.js <customer-slug> <version>
// The existing health check and automatic rollback still apply.
import { db } from './db.js';
import { deployRecorded } from './deploy-history.js';

const finish = async (code, message) => {
  console.log(message);
  await db.end();
  process.exit(code);
};

const [slug, version] = process.argv.slice(2);
if (!slug || !version) await finish(2, 'usage: deploy-cli.js <customer-slug> <version>');
if (!/^[a-z0-9-]{2,40}$/.test(slug) || !/^v\d+$/.test(version)) await finish(2, 'invalid customer name or version');

const { rows: [before] } = await db.query('SELECT status, version FROM tenants WHERE slug = $1', [slug]);
if (!before) await finish(2, `no customer named ${slug}`);
console.log(`Deploying ${version} to ${slug} (currently ${before.version}, status ${before.status})`);

try {
  await deployRecorded(slug, version);
} catch (err) {
  await finish(1, `deployment was refused: ${err.message}`);
}

// Wait for the deployment to finish: the health check passes, or the automatic rollback runs.
await new Promise((r) => setTimeout(r, 3000));
const deadline = Date.now() + 15 * 60 * 1000;
let row;
while (Date.now() < deadline) {
  ({ rows: [row] } = await db.query('SELECT status, version, error_message FROM tenants WHERE slug = $1', [slug]));
  if (row.status !== 'updating') break;
  await new Promise((r) => setTimeout(r, 5000));
}

if (row.status === 'ready' && row.version === version && !row.error_message) {
  await finish(0, `SUCCESS: ${slug} is running ${version} and passed its health check`);
} else if (row.status === 'ready' && row.error_message && row.error_message.includes('rolled back')) {
  await finish(1, `ROLLED BACK: ${row.error_message}`);
} else {
  await finish(1, `FAILED: status=${row.status}, version=${row.version}, detail=${row.error_message || 'none'}`);
}
