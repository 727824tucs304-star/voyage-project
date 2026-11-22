import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db.js';
import { listTenantVersions } from './docker.js';
import { fetchBranch, exportTenantApp } from './git.js';
import { imageRef, imageRepo } from './products.js';
import { HttpError } from './errors.js';
import { audit } from './audit.js';
import { progressOf } from './build-progress.js';

const oneLine = (s, max = 200) => String(s || '').split('\n')[0].replace(/[\x00-\x1f\x7f]/g, '').slice(0, max);

// Next release number for one product. Legacy Voyage numbers never count towards Vespera.
export async function nextVersion(product = 'vespera') {
  const [dockerVersions, { rows }] = await Promise.all([
    listTenantVersions(imageRepo(product)),
    db.query('SELECT version FROM builds WHERE product = $1', [product]),
  ]);
  const used = [...dockerVersions, ...rows.map((r) => r.version)].map((v) => Number(v.slice(1)));
  return `v${Math.max(0, ...used) + 1}`;
}

// meta: { sha, message, date } from GitHub
export async function startBuildForCommit(meta, product = 'vespera') {
  const { rows: running } = await db.query("SELECT id FROM builds WHERE status = 'running'");
  if (running.length) throw new HttpError(409, 'Another image build is already running');
  await fetchBranch();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voyage-build-'));
  let context;
  try {
    context = await exportTenantApp(meta.sha, dir);
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true });
    throw err;
  }
  const version = await nextVersion(product);
  const { rows } = await db.query(
    `INSERT INTO builds (product, version, commit_hash, commit_message, commit_date, status)
     VALUES ($1, $2, $3, $4, $5, 'running') RETURNING id`,
    [product, version, meta.sha, oneLine(meta.message), meta.date || '']
  );
  runBuild(rows[0].id, version, meta.sha, context, dir, product);
  return { id: rows[0].id, version, commit: meta.sha, product };
}

function runBuild(id, version, commit, context, dir, product) {
  const args = [
    'build', '--label', `voyage.commit=${commit}`, '--label', `voyage.product=${product}`,
    '--build-arg', `APP_VERSION=${version}`, '-t', imageRef(product, version), context,
  ];
  let log = '';
  const keep = (chunk) => { log = (log + chunk).slice(-6000); };
  const finish = (ok, extra = '') =>
    db.query('UPDATE builds SET status = $2, log = $3, finished_at = now() WHERE id = $1',
      [id, ok ? 'succeeded' : 'failed', log + extra])
      .catch((err) => console.error('could not record build result', err));
  const cleanup = () => fs.rm(dir, { recursive: true, force: true }).catch(() => {});

  const child = spawn(config.dockerBin, args);
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.on('error', async (err) => { await cleanup(); finish(false, `\n${err.message}`); });
  child.on('close', async (code) => {
    await cleanup();
    finish(code === 0, code === 0 ? '' : `\nexit code ${code}`);
  });
  audit('build.start', { id, product, version, commit });
}

export async function waitForBuild(id) {
  const deadline = Date.now() + 20 * 60 * 1000;
  for (;;) {
    const { rows } = await db.query('SELECT * FROM builds WHERE id = $1', [id]);
    if (rows[0].status !== 'running') return rows[0];
    if (Date.now() > deadline) throw new HttpError(504, 'Image build timed out');
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export async function buildFor(version, product = 'vespera') {
  const { rows } = await db.query(
    "SELECT * FROM builds WHERE product = $1 AND version = $2 AND status = 'succeeded'", [product, version]);
  return rows[0] || null;
}

// Release note values passed into a tenant container at creation.
export async function releaseInfo(version, product = 'vespera') {
  const b = await buildFor(version, product);
  return { commit: b?.commit_hash || '', message: oneLine(b?.commit_message), date: b?.commit_date || '' };
}

export async function listBuilds(product = 'vespera') {
  const { rows } = await db.query(
    `SELECT id, product, version, commit_hash, commit_message, status, created_at, finished_at, log, right(log, 1500) AS log_tail
     FROM builds WHERE product = $1 ORDER BY id DESC LIMIT 20`, [product]);
  return rows.map(({ log, ...r }) => ({ ...r, progress: progressOf(r.status, log || '') }));
}

// A build cannot survive a control-plane restart; mark leftovers as failed.
export async function resumeBuilds() {
  await db.query(
    `UPDATE builds SET status = 'failed', log = log || E'\ninterrupted by control plane restart', finished_at = now()
     WHERE status = 'running'`
  );
}
