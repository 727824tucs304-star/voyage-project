import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from './db.js';
import { requireAuth, sign } from './auth.js';
import { signInBlocked, recordFailedSignIn, clearFailedSignIns } from './signin-limit.js';
import { HttpError, text, number, integer, date, time, oneOf } from './validate.js';
import { meetingsRouter } from './meetings.js';
import { themePublic, themePrivate } from './theme.js';


const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const notFound = () => new HttpError(404, 'Not found');
const idParam = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw notFound();
  return id;
};

// Table and column names below come from constants in this file, never from request input.
async function insert(table, data) {
  const cols = Object.keys(data);
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`;
  return (await pool.query(sql, Object.values(data))).rows[0];
}

async function update(table, id, data) {
  const cols = Object.keys(data);
  const sql = `UPDATE ${table} SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${cols.length + 1} RETURNING *`;
  const { rows } = await pool.query(sql, [...Object.values(data), id]);
  if (!rows[0]) throw notFound();
  return rows[0];
}

async function remove(table, id) {
  const { rowCount } = await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  if (!rowCount) throw notFound();
}

export const api = Router();

// ---- Public endpoints ----
api.get('/health', wrap(async (req, res) => {
  await pool.query('SELECT 1');
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM users');
  res.json({ ok: true, db: true, version: process.env.APP_VERSION || 'unknown', adminReady: rows[0].n > 0 });
}));

api.post('/auth/login', wrap(async (req, res) => {
  const email = text(req.body, 'email', { max: 254, required: true }).toLowerCase();
  const password = req.body?.password;
  if (typeof password !== 'string' || !password || password.length > 200) {
    throw new HttpError(400, 'password is required');
  }
  if (signInBlocked(email)) {
    throw new HttpError(429, 'Too many failed sign-in attempts. Wait 15 minutes and try again.');
  }
  const { rows } = await pool.query('SELECT id, name, email, password_hash FROM users WHERE email = $1', [email]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    recordFailedSignIn(email);
    throw new HttpError(401, 'Invalid email or password');
  }
  clearFailedSignIns(email);
  res.json({ token: sign(user), user: { id: user.id, name: user.name, email: user.email } });
}));

// ---- Protected endpoints ----
api.use(themePublic);

api.use(requireAuth);

api.get('/auth/me', (req, res) => {
  res.json({ user: { id: req.user.sub, name: req.user.name, email: req.user.email } });
});

api.get('/settings', wrap(async (req, res) => {
  const company = await pool.query('SELECT name FROM company WHERE id = 1');
  const admin = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [req.user.sub]);
  res.json({
    company: { name: company.rows[0]?.name ?? '' },
    admin: admin.rows[0] ?? null,
    version: process.env.APP_VERSION || 'unknown',
  });
}));
api.put('/settings/company', wrap(async (req, res) => {
  const name = text(req.body, 'name', { max: 120, required: true });
  await pool.query('UPDATE company SET name = $1, updated_at = now() WHERE id = 1', [name]);
  res.json({ company: { name } });
}));
api.put('/settings/profile', wrap(async (req, res) => {
  const name = text(req.body, 'name', { max: 80, required: true });
  const email = text(req.body, 'email', { max: 254, required: true }).toLowerCase();
  const pw = req.body?.password;
  const params = [req.user.sub, name, email];
  let sql = 'UPDATE users SET name = $2, email = $3';
  if (pw !== undefined && pw !== null && pw !== '') {
    if (typeof pw !== 'string' || pw.length < 8 || pw.length > 128) {
      throw new HttpError(400, 'password must be 8-128 characters');
    }
    params.push(await bcrypt.hash(pw, 12));
    sql += ', password_hash = $4';
  }
  try {
    const { rows } = await pool.query(`${sql} WHERE id = $1 RETURNING id, name, email`, params);
    if (!rows[0]) throw notFound();
    res.json({ admin: rows[0] });
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'That email is already in use');
    throw err;
  }
}));

api.get('/releases', wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, version, kind, commit_hash, message, released_at FROM release_notes ORDER BY id DESC LIMIT 100'
  );
  res.json(rows);
}));

api.get('/whats-new', (req, res) => {
  res.json({
    version: process.env.APP_VERSION || 'unknown',
    commit: (process.env.RELEASE_COMMIT || '').slice(0, 7) || null,
    message: process.env.RELEASE_MESSAGE || null,
    releasedAt: process.env.RELEASE_DATE || null,
  });
});

const DETAIL_KINDS = ['stay', 'transport', 'contact', 'note'];
// ---- Team: user management ----
async function callerRole(req) {
  const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [req.user.sub]);
  return rows[0]?.role || null;
}
const adminOnly = (req, res, next) => {
  callerRole(req)
    .then((role) => (role === 'admin' ? next() : next(new HttpError(403, 'Only an administrator can manage users.'))))
    .catch(next);
};

api.get('/users', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, email, role, created_at FROM users ORDER BY created_at, id');
  res.json(rows);
}));

api.post('/users', adminOnly, wrap(async (req, res) => {
  const name = text(req.body, 'name', { max: 80, required: true });
  const email = text(req.body, 'email', { max: 254, required: true }).toLowerCase();
  const role = oneOf(req.body, 'role', ['admin', 'member'], 'member');
  const password = req.body?.password;
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw new HttpError(400, 'password must be 8-200 characters');
  }
  const hash = await bcrypt.hash(password, 12);
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role, created_at',
      [name, email, hash, role]);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'A user with that email already exists');
    throw err;
  }
}));

api.put('/users/:id/password', adminOnly, wrap(async (req, res) => {
  const id = idParam(req);
  const password = req.body?.password;
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw new HttpError(400, 'password must be 8-200 characters');
  }
  const hash = await bcrypt.hash(password, 12);
  const { rowCount } = await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [id, hash]);
  if (!rowCount) throw notFound();
  res.json({ ok: true });
}));

api.delete('/users/:id', adminOnly, wrap(async (req, res) => {
  const id = idParam(req);
  if (id === Number(req.user.sub)) throw new HttpError(400, 'You cannot remove your own account');
  const { rows: [target] } = await pool.query('SELECT role FROM users WHERE id = $1', [id]);
  if (!target) throw notFound();
  if (target.role === 'admin') {
    const { rows: [count] } = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin'");
    if (count.n <= 1) throw new HttpError(400, 'A workspace must keep at least one administrator');
  }
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
  res.status(204).end();
}));

api.use(meetingsRouter);
api.use(themePrivate);

api.use((req, res) => res.status(404).json({ error: 'Not found' }));
