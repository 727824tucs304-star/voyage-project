import { db } from './db.js';
import { getTenant, deployVersion } from './provision.js';
import { buildFor, startBuildForCommit, waitForBuild } from './builds.js';
import { listCommits, getCommit } from './github.js';
import { isSha } from './git.js';
import { HttpError } from './errors.js';
import { audit } from './audit.js';
import { recordRelease } from './release-notes.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const active = new Set(); // clients with a release in progress

// Records a deploy or rollback and follows it to its real outcome.
export async function deployRecorded(slug, version, kind = 'deploy') {
  const before = await getTenant(slug);
  if (!before) throw new HttpError(404, 'Workspace not found');
  const build = await buildFor(version);
  const result = await deployVersion(slug, version); // validates; throws if refused
  const { rows } = await db.query(
    `INSERT INTO deployments (slug, kind, from_version, to_version, commit_hash, status)
     VALUES ($1, $2, $3, $4, $5, 'running') RETURNING id`,
    [slug, kind, before.version, version, build?.commit_hash ?? null]
  );
  audit(`${kind}.start`, { slug, from: before.version, to: version, commit: build?.commit_hash ?? null });
  watch(rows[0].id, slug, before.version, version, Date.now(), kind);
  return result;
}

async function finish(id, slug, status, detail) {
  await db.query('UPDATE deployments SET status = $2, detail = $3, finished_at = now() WHERE id = $1', [id, status, detail]);
  audit('deploy.finish', { id, slug, status, detail });
}

// Reads the tenant's actual state until the change lands, is rolled back, or fails.
async function watch(id, slug, previous, target, startedAt, kind) {
  let sawUpdating = false;
  while (Date.now() - startedAt < 15 * 60 * 1000) {
    await sleep(2000);
    const t = await getTenant(slug);
    if (!t) return finish(id, slug, 'failed', 'workspace no longer exists');
    if (t.status === 'updating') sawUpdating = true;
    if (!sawUpdating && Date.now() - startedAt < 15000) continue;
    if (t.status === 'ready' && t.version === target) return succeed(id, slug, target, kind);
    if (t.status === 'ready' && t.version === previous && t.error_message?.includes('rolled back')) {
      return finish(id, slug, 'rolled_back', t.error_message);
    }
    if (t.status === 'failed') return finish(id, slug, 'failed', t.error_message || 'unknown error');
  }
  return finish(id, slug, 'failed', 'timed out waiting for the change');
}

async function succeed(id, slug, target, kind) {
  const build = await buildFor(target);
  await recordRelease(slug, {
    version: target, kind, commit: build?.commit_hash, message: build?.commit_message || `Release ${target}`,
  }).catch((err) => audit('release_note.error', { slug, error: err.message }));
  return finish(id, slug, 'succeeded', `now on ${target}`);
}

async function recordFailure(slug, version, commit, detail) {
  const t = await getTenant(slug);
  await db.query(
    `INSERT INTO deployments (slug, kind, from_version, to_version, commit_hash, status, detail, finished_at)
     VALUES ($1, 'deploy', $2, $3, $4, 'failed', $5, now())`,
    [slug, t?.version ?? null, version, commit, detail]
  );
  audit('deploy.finish', { slug, status: 'failed', detail });
}

// "DEPLOY CHANGES": validates everything synchronously, then runs build and deploy in the background.
export async function startRelease(slug, sha) {
  if (!isSha(sha)) throw new HttpError(400, 'sha must be a 40-character commit id');
  const t = await getTenant(slug);
  if (!t) throw new HttpError(404, 'Workspace not found');
  if (t.status !== 'ready') throw new HttpError(409, `Workspace is ${t.status}; wait until it is ready`);
  if (active.has(slug)) throw new HttpError(409, 'A deployment is already running for this client');
  const onBranch = (await listCommits(100)).some((c) => c.sha === sha);
  if (!onBranch) throw new HttpError(422, 'That commit is not on the configured branch');

  active.add(slug);
  try {
    const meta = await getCommit(sha);
    const reuse = await db.query(
      "SELECT version FROM builds WHERE commit_hash = $1 AND status = 'succeeded' ORDER BY id DESC LIMIT 1", [sha]);
    let version, buildId = null;
    if (reuse.rows[0]) {
      version = reuse.rows[0].version;                 // this commit was already built: reuse its image
    } else {
      const started = await startBuildForCommit(meta);
      version = started.version;
      buildId = started.id;
    }
    audit('release.request', { slug, commit: sha, version });
    completeRelease(slug, sha, version, buildId).finally(() => active.delete(slug));
    return { accepted: true, slug, commit: sha, version };
  } catch (err) {
    active.delete(slug);
    throw err;
  }
}

async function completeRelease(slug, sha, version, buildId) {
  try {
    if (buildId) {
      const built = await waitForBuild(buildId);
      if (built.status !== 'succeeded') return await recordFailure(slug, version, sha, 'image build failed (see build output)');
    }
    await deployRecorded(slug, version, 'deploy');
  } catch (err) {
    audit('release.error', { slug, error: err.message });
    await recordFailure(slug, version, sha, err.message).catch(() => {});
  }
}

export async function releaseStatus(slug) {
  const [d, b] = await Promise.all([
    db.query('SELECT * FROM deployments WHERE slug = $1 ORDER BY id DESC LIMIT 1', [slug]),
    db.query(`SELECT id, version, commit_hash, status, right(log, 1500) AS log_tail
              FROM builds ORDER BY id DESC LIMIT 1`),
  ]);
  return { slug, deploying: active.has(slug), latestDeployment: d.rows[0] || null, latestBuild: b.rows[0] || null };
}

export async function history(slug) {
  const { rows } = await db.query(
    `SELECT d.id, d.kind, d.from_version, d.to_version, d.commit_hash, d.status, d.detail,
            d.created_at, d.finished_at, b.commit_message
     FROM deployments d
     LEFT JOIN builds b ON b.version = d.to_version AND b.status = 'succeeded'
     WHERE d.slug = $1 ORDER BY d.id DESC LIMIT 50`,
    [slug]
  );
  return rows;
}
