import { config } from './config.js';
import { HttpError } from './errors.js';

function repo() {
  if (!config.githubRepo) throw new HttpError(503, 'GITHUB_REPO is not configured on the server');
  return config.githubRepo;
}

async function gh(apiPath) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'voyage-control-plane',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;
  let res;
  try {
    res = await fetch(`${config.githubApiUrl}${apiPath}`, { headers, signal: AbortSignal.timeout(15000) });
  } catch (err) {
    throw new HttpError(502, `GitHub is unreachable: ${err.message}`);
  }
  if (res.status === 404) throw new HttpError(404, 'Not found on GitHub');
  if (!res.ok) throw new HttpError(502, `GitHub returned HTTP ${res.status}`);
  return res.json();
}

const STATUS = { added: 'added', modified: 'modified', removed: 'deleted', renamed: 'renamed', copied: 'added', changed: 'modified' };
const toFiles = (list = []) => list.map((f) => ({ path: f.filename, status: STATUS[f.status] || f.status }));
const summarise = (c) => ({
  sha: c.sha,
  short: c.sha.slice(0, 7),
  message: c.commit.message.split('\n')[0],
  author: c.commit.author?.name || c.author?.login || 'unknown',
  date: c.commit.author?.date || null,
});

export async function listCommits(count = 20) {
  const data = await gh(`/repos/${repo()}/commits?sha=${encodeURIComponent(config.githubBranch)}&per_page=${count}`);
  return data.map(summarise);
}

export async function getCommit(sha) {
  const c = await gh(`/repos/${repo()}/commits/${sha}`);
  return { ...summarise(c), files: toFiles(c.files) };
}

export async function compare(base, head) {
  const c = await gh(`/repos/${repo()}/compare/${base}...${head}`);
  return toFiles(c.files);
}
