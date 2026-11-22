import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db } from './db.js';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { safeEqual } from './security.js';
import { audit } from './audit.js';

const SESSION_HOURS = 12;
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const bearer = (req) => {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
};

// Fixed-window limiter kept in memory. Adequate for one control-plane process.
const buckets = new Map();
export function limiter({ name, max, windowMs }) {
  return (req, res, next) => {
    const now = Date.now();
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
    }
    const key = `${name}:${req.ip}`;
    let b = buckets.get(key);
    if (!b || now > b.reset) {
      b = { count: 0, reset: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((b.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
    }
    return next();
  };
}

// Hashed comparison against a dummy hash when the email is unknown, so timing does not reveal accounts.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

export async function login(email, password) {
  const { rows: [a] } = await db.query(
    'SELECT id, email, name, password_hash, disabled FROM admins WHERE email = $1', [email]);
  const valid = await bcrypt.compare(password, a ? a.password_hash : DUMMY_HASH);
  if (!a || !valid || a.disabled) {
    audit('admin.login_failed', { email });
    throw new HttpError(401, 'Email or password is incorrect');
  }
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(
    "INSERT INTO admin_sessions (token_hash, admin_id, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))",
    [hash(token), a.id, SESSION_HOURS]);
  await db.query('UPDATE admins SET last_login_at = now() WHERE id = $1', [a.id]);
  await db.query('DELETE FROM admin_sessions WHERE expires_at < now()');
  audit('admin.login', { email: a.email });
  return { token, name: a.name, email: a.email };
}

export async function logout(req) {
  const token = bearer(req);
  if (token) await db.query('DELETE FROM admin_sessions WHERE token_hash = $1', [hash(token)]);
}

// Every admin route passes through here. Accepts a personal session, or the legacy shared token if it is still set.
export async function requireAdmin(req, res, next) {
  try {
    const token = bearer(req);
    if (!token) throw new HttpError(401, 'Sign in required');
    if (config.adminToken && safeEqual(token, config.adminToken)) {
      req.admin = { email: 'shared-token', name: 'Shared token' };
    } else {
      const { rows: [s] } = await db.query(
        `SELECT a.email, a.name FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
         WHERE s.token_hash = $1 AND s.expires_at > now() AND a.disabled = false`, [hash(token)]);
      if (!s) throw new HttpError(401, 'Sign in required');
      req.admin = s;
    }
    if (req.method !== 'GET') {
      audit('admin.action', { by: req.admin.email, method: req.method, path: req.originalUrl.split('?')[0] });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

export async function createAdmin({ email, name, password }) {
  if (password.length < 12) throw new Error('Password must be at least 12 characters');
  const passwordHash = await bcrypt.hash(password, 12);
  const { rows } = await db.query(
    'INSERT INTO admins (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email',
    [email.toLowerCase(), name, passwordHash]);
  return rows[0];
}
