import http from 'node:http';
import { execFileSync } from 'node:child_process';

// TEST DOUBLE for the GitHub REST API (no internet access in the sandbox). It answers from a real
// bare git repository using GitHub's response shapes, so the control plane's GitHub client runs over real HTTP.
export function startFakeGithub({ port, remote, branch }) {
  const git = (args) => execFileSync('git', ['-C', remote, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const LETTER = { A: 'added', M: 'modified', D: 'removed' };
  const files = (out) => out.split('\n').filter(Boolean).map((line) => {
    const [code, ...p] = line.split('\t');
    return { filename: p[p.length - 1], status: code.startsWith('R') ? 'renamed' : (LETTER[code] || 'changed') };
  });
  const shape = (line) => {
    const [sha, author, date, subject] = line.split('\x1f');
    return { sha, commit: { message: subject, author: { name: author, date } }, author: { login: author } };
  };
  const exists = (sha) => { try { git(['cat-file', '-e', `${sha}^{commit}`]); return true; } catch { return false; } };
  const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const seenAuth = [];

  const server = http.createServer((req, res) => {
    seenAuth.push(req.headers.authorization || '');
    const { pathname, searchParams } = new URL(req.url, 'http://github.test');
    try {
      let m;
      if (/^\/repos\/[^/]+\/[^/]+\/commits$/.test(pathname)) {
        const n = Number(searchParams.get('per_page') || 30);
        const out = git(['log', `-n${n}`, '--format=%H%x1f%an%x1f%aI%x1f%s', branch]).trim();
        return send(res, 200, out ? out.split('\n').map(shape) : []);
      }
      if ((m = pathname.match(/^\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]+)$/))) {
        if (!exists(m[1])) return send(res, 404, { message: 'Not Found' });
        const sha = git(['rev-parse', m[1]]).trim();
        const header = git(['log', '-1', '--format=%H%x1f%an%x1f%aI%x1f%s', sha]).trim();
        return send(res, 200, { ...shape(header), files: files(git(['show', '--name-status', '--format=', sha])) });
      }
      if ((m = pathname.match(/^\/repos\/[^/]+\/[^/]+\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/))) {
        if (!exists(m[1]) || !exists(m[2])) return send(res, 404, { message: 'Not Found' });
        return send(res, 200, { status: 'ahead', files: files(git(['diff', '--name-status', m[1], m[2]])) });
      }
      return send(res, 404, { message: 'Not Found' });
    } catch (err) {
      return send(res, 500, { message: err.message });
    }
  });
  server.listen(port, '127.0.0.1');
  return { seenAuth, close: () => server.close() };
}
