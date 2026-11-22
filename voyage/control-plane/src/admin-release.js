import { Router } from 'express';
import { db } from './db.js';
import { getTenant } from './provision.js';
import { listCommits, getCommit, compare } from './github.js';
import { startRelease, releaseStatus, history, deployRecorded } from './deploy-history.js';
import { startBuildForCommit, listBuilds, existingBuildFor } from './builds.js';
import { isSha } from './git.js';
import { HttpError } from './errors.js';
import { SLUG_RE, VERSION_RE } from './security.js';

export const releaseRouter = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const slugQuery = (req) => {
  const slug = String(req.query.slug || '');
  if (!SLUG_RE.test(slug)) throw new HttpError(400, 'a valid client slug is required');
  return slug;
};

releaseRouter.get('/github/commits', wrap(async (req, res) => {
  res.json(await listCommits(20));
}));

// Latest commit, its changed files, and what this client has not received yet.
releaseRouter.get('/github/changes', wrap(async (req, res) => {
  const slug = slugQuery(req);
  if (!(await getTenant(slug))) throw new HttpError(404, 'Workspace not found');
  const [latest] = await listCommits(1);
  if (!latest) return res.json({ latest: null, latestFiles: [], baseline: null, files: null, upToDate: false });
  const { rows } = await db.query(
    "SELECT commit_hash FROM deployments WHERE slug = $1 AND status = 'succeeded' AND commit_hash IS NOT NULL ORDER BY id DESC LIMIT 1",
    [slug]
  );
  const baseline = rows[0]?.commit_hash ?? null;
  const detail = await getCommit(latest.sha);
  const upToDate = baseline === latest.sha;
  const files = baseline === null ? null : upToDate ? [] : await compare(baseline, latest.sha);
  res.json({ latest, latestFiles: detail.files, baseline, files, upToDate });
}));

releaseRouter.post('/releases', wrap(async (req, res) => {
  res.status(202).json(await startRelease(String(req.body?.slug || ''), String(req.body?.sha || '')));
}));

releaseRouter.get('/releases/status', wrap(async (req, res) => {
  res.json(await releaseStatus(slugQuery(req)));
}));

releaseRouter.get('/releases/history', wrap(async (req, res) => {
  res.json(await history(slugQuery(req)));
}));

// Rollback only to a version this client has actually run, so arbitrary images cannot be deployed.
releaseRouter.post('/releases/rollback', wrap(async (req, res) => {
  const slug = String(req.body?.slug || '');
  const version = String(req.body?.version || '');
  if (!SLUG_RE.test(slug)) throw new HttpError(404, 'Workspace not found');
  if (!VERSION_RE.test(version)) throw new HttpError(400, 'version must look like v1, v2, ...');
  const t = await getTenant(slug);
  if (!t) throw new HttpError(404, 'Workspace not found');
  const { rows } = await db.query(
    "SELECT 1 FROM deployments WHERE slug = $1 AND to_version = $2 AND status IN ('succeeded','rolled_back')", [slug, version]);
  if (!rows.length && t.previous_version !== version) {
    throw new HttpError(422, `${version} has never been running for this client`);
  }
  res.status(202).json(await deployRecorded(slug, version, 'rollback'));
}));

// Vespera release line: build the next release from a commit on the configured branch. Nothing is deployed.
releaseRouter.post('/products/vespera/build', wrap(async (req, res) => {
  const sha = String(req.body?.sha || '');
  if (!isSha(sha)) throw new HttpError(400, 'sha must be a 40-character commit id');
  if (!(await listCommits(100)).some((c) => c.sha === sha)) throw new HttpError(422, 'That commit is not on the configured branch');
  const existing = await existingBuildFor(sha, 'vespera');
  if (existing) {
    throw new HttpError(409, `This commit is already built as ${String(existing.version).toUpperCase()}. Make a new commit to build a new release.`);
  }
  const meta = await getCommit(sha);
  res.status(202).json(await startBuildForCommit(meta, 'vespera'));
}));

releaseRouter.get('/products/vespera/builds', wrap(async (req, res) => {
  res.json(await listBuilds('vespera'));
}));

// Controlled migration: moves one legacy Voyage workspace to Vespera. Data, domain and volumes are kept.
releaseRouter.post('/tenants/:slug/migrate-to-vespera', wrap(async (req, res) => {
  const slug = String(req.params.slug || '');
  if (!SLUG_RE.test(slug)) throw new HttpError(404, 'Workspace not found');
  const version = String(req.body?.version || 'v1');
  if (!VERSION_RE.test(version)) throw new HttpError(400, 'version must look like v1, v2, ...');
  const t = await getTenant(slug);
  if (!t) throw new HttpError(404, 'Workspace not found');
  if (t.product === 'vespera') throw new HttpError(409, 'This workspace already runs Vespera');
  res.status(202).json(await deployRecorded(slug, version, 'deploy', 'vespera'));
}));
