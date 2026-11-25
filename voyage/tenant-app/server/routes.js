import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from './db.js';
import { requireAuth, sign } from './auth.js';
import { signInBlocked, recordFailedSignIn, clearFailedSignIns } from './signin-limit.js';
import { HttpError, text, number, integer, date, time, oneOf } from './validate.js';
import { meetingsRouter } from './meetings.js';
import { themePublic, themePrivate } from './theme.js';

const TRIP_STATUSES = ['planned', 'ongoing', 'completed', 'cancelled'];
const EVENT_CATEGORIES = ['transport', 'accommodation', 'activity', 'meal', 'other'];
const EXPENSE_CATEGORIES = ['transport', 'accommodation', 'food', 'activities', 'shopping', 'other'];

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

async function assertTrip(id) {
  const { rowCount } = await pool.query('SELECT 1 FROM trips WHERE id = $1', [id]);
  if (!rowCount) throw notFound();
}

const destinationInput = (b) => ({
  name: text(b, 'name', { max: 120, required: true }),
  country: text(b, 'country', { max: 120 }),
  notes: text(b, 'notes', { max: 2000 }),
});

const tripInput = (b) => {
  const start_date = date(b, 'start_date', { required: true });
  const end_date = date(b, 'end_date', { required: true });
  if (end_date < start_date) throw new HttpError(400, 'end_date must be on or after start_date');
  return {
    title: text(b, 'title', { max: 120, required: true }),
    destination_id: integer(b, 'destination_id'),
    start_date,
    end_date,
    budget: number(b, 'budget', { max: 1e9 }) ?? 0,
    status: oneOf(b, 'status', TRIP_STATUSES, 'planned'),
  };
};

const eventInput = (b) => ({
  title: text(b, 'title', { max: 120, required: true }),
  location: text(b, 'location', { max: 200 }),
  event_date: date(b, 'event_date', { required: true }),
  event_time: time(b, 'event_time'),
  description: text(b, 'description', { max: 2000 }),
  category: oneOf(b, 'category', EVENT_CATEGORIES, 'activity'),
  estimated_cost: number(b, 'estimated_cost', { max: 1e9 }) ?? 0,
});

const expenseInput = (b) => ({
  description: text(b, 'description', { max: 200, required: true }),
  category: oneOf(b, 'category', EXPENSE_CATEGORIES, 'other'),
  amount: number(b, 'amount', { min: 0, max: 1e9, required: true }),
  expense_date: date(b, 'expense_date', { required: true }),
  trip_id: integer(b, 'trip_id'),
});

const TRIP_SELECT = `
  SELECT t.*, d.name AS destination_name,
    COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.trip_id = t.id), 0) AS total_expenses
  FROM trips t
  LEFT JOIN destinations d ON d.id = t.destination_id`;

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

api.get('/dashboard/stats', wrap(async (req, res) => {
  const trips = await pool.query(`
    SELECT COUNT(*)::int AS total_trips,
      COUNT(*) FILTER (WHERE status <> 'cancelled' AND start_date >= CURRENT_DATE)::int AS upcoming_trips,
      COUNT(*) FILTER (WHERE status = 'completed' OR (status <> 'cancelled' AND end_date < CURRENT_DATE))::int AS completed_trips
    FROM trips`);
  const spent = await pool.query('SELECT COALESCE(SUM(amount), 0) AS total_expenses FROM expenses');
  res.json({ ...trips.rows[0], total_expenses: spent.rows[0].total_expenses });
}));

api.get('/dashboard/upcoming', wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT t.id, t.title, t.start_date, t.end_date, t.status, d.name AS destination_name
    FROM trips t LEFT JOIN destinations d ON d.id = t.destination_id
    WHERE t.status <> 'cancelled' AND t.start_date >= CURRENT_DATE
    ORDER BY t.start_date, t.id LIMIT 5`);
  res.json(rows);
}));

// Trips
api.get('/trips', wrap(async (req, res) => {
  const { rows } = await pool.query(`${TRIP_SELECT} ORDER BY t.start_date, t.id`);
  res.json(rows);
}));
api.get('/trips/:id', wrap(async (req, res) => {
  const { rows } = await pool.query(`${TRIP_SELECT} WHERE t.id = $1`, [idParam(req)]);
  if (!rows[0]) throw notFound();
  res.json(rows[0]);
}));
api.post('/trips', wrap(async (req, res) => {
  res.status(201).json(await insert('trips', tripInput(req.body)));
}));
api.put('/trips/:id', wrap(async (req, res) => {
  res.json(await update('trips', idParam(req), tripInput(req.body)));
}));
api.delete('/trips/:id', wrap(async (req, res) => {
  await remove('trips', idParam(req));
  res.status(204).end();
}));

// Itinerary events (chronological per trip)
api.get('/trips/:id/events', wrap(async (req, res) => {
  const tripId = idParam(req);
  await assertTrip(tripId);
  const { rows } = await pool.query(
    'SELECT * FROM itinerary_events WHERE trip_id = $1 ORDER BY event_date, event_time NULLS LAST, id',
    [tripId]
  );
  res.json(rows);
}));
api.post('/trips/:id/events', wrap(async (req, res) => {
  const tripId = idParam(req);
  await assertTrip(tripId);
  res.status(201).json(await insert('itinerary_events', { trip_id: tripId, ...eventInput(req.body) }));
}));
api.put('/events/:id', wrap(async (req, res) => {
  res.json(await update('itinerary_events', idParam(req), eventInput(req.body)));
}));
api.delete('/events/:id', wrap(async (req, res) => {
  await remove('itinerary_events', idParam(req));
  res.status(204).end();
}));

// Destinations
api.get('/destinations', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM destinations ORDER BY name, id');
  res.json(rows);
}));
api.post('/destinations', wrap(async (req, res) => {
  res.status(201).json(await insert('destinations', destinationInput(req.body)));
}));
api.put('/destinations/:id', wrap(async (req, res) => {
  res.json(await update('destinations', idParam(req), destinationInput(req.body)));
}));
api.delete('/destinations/:id', wrap(async (req, res) => {
  await remove('destinations', idParam(req));
  res.status(204).end();
}));

// Expenses
api.get('/expenses', wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT e.*, t.title AS trip_title
    FROM expenses e LEFT JOIN trips t ON t.id = e.trip_id
    ORDER BY e.expense_date DESC, e.id DESC`);
  res.json(rows);
}));
api.post('/expenses', wrap(async (req, res) => {
  res.status(201).json(await insert('expenses', expenseInput(req.body)));
}));
api.put('/expenses/:id', wrap(async (req, res) => {
  res.json(await update('expenses', idParam(req), expenseInput(req.body)));
}));
api.delete('/expenses/:id', wrap(async (req, res) => {
  await remove('expenses', idParam(req));
  res.status(204).end();
}));

// Settings
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

// Trip details: stays, transport, emergency contacts and notes.
const DETAIL_KINDS = ['stay', 'transport', 'contact', 'note'];
const detailInput = (b) => {
  const kind = oneOf(b, 'kind', DETAIL_KINDS);
  if (!kind) throw new HttpError(400, 'kind is required');
  const starts_on = date(b, 'starts_on');
  const ends_on = date(b, 'ends_on');
  if (starts_on && ends_on && ends_on < starts_on) throw new HttpError(400, 'ends_on must be on or after starts_on');
  const phone = text(b, 'phone', { max: 20 });
  if (phone && !/^\+?[0-9 ()-]{6,20}$/.test(phone)) throw new HttpError(400, 'phone looks invalid');
  return {
    kind,
    title: text(b, 'title', { max: 120, required: true }),
    reference: text(b, 'reference', { max: 60 }),
    starts_on,
    ends_on,
    time_text: text(b, 'time_text', { max: 40 }),
    phone,
    amount: number(b, 'amount', { max: 1e9 }),
    notes: text(b, 'notes', { max: 1000 }),
  };
};

api.get('/trips/:id/details', wrap(async (req, res) => {
  const tripId = idParam(req);
  await assertTrip(tripId);
  const { rows } = await pool.query(
    'SELECT * FROM trip_details WHERE trip_id = $1 ORDER BY kind, starts_on NULLS LAST, id', [tripId]);
  res.json(rows);
}));
api.post('/trips/:id/details', wrap(async (req, res) => {
  const tripId = idParam(req);
  await assertTrip(tripId);
  res.status(201).json(await insert('trip_details', { trip_id: tripId, ...detailInput(req.body) }));
}));
api.delete('/details/:id', wrap(async (req, res) => {
  await remove('trip_details', idParam(req));
  res.status(204).end();
}));

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
