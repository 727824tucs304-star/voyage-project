import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { HttpError } from './errors.js';

export const isSha = (s) => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);

function run(cmd, args) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (cmd === 'git' && config.gitAskpass) env.GIT_ASKPASS = config.gitAskpass;
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new HttpError(502, `${cmd} ${args[0]} failed: ${String(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(stdout);
    });
  });
}
const git = (args) => run('git', ['-C', config.repoRoot, ...args]);

export async function fetchBranch() {
  await git(['fetch', '--quiet', 'origin', config.githubBranch]);
}

// Writes the tenant-app folder as it was at this commit into dir.
export async function exportTenantApp(sha, dir) {
  const type = await git(['cat-file', '-t', sha]).catch(() => '');
  if (type.trim() !== 'commit') throw new HttpError(422, 'That commit could not be fetched from GitHub');
  const tar = path.join(dir, 'source.tar');
  await git(['archive', '--format=tar', `--output=${tar}`, sha, '--', `${config.projectSubdir}/tenant-app`]);
  await run('tar', ['-xf', tar, '-C', dir]);
  await fs.rm(tar);
  return path.join(dir, config.projectSubdir, 'tenant-app');
}
