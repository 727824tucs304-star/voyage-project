import { Router } from 'express';
import { pool } from './db.js';
import { HttpError, text, oneOf } from './validate.js';

export const BUTTON_COLORS = ['blue', 'green', 'indigo', 'violet', 'rose', 'amber', 'teal', 'slate'];
const DEFAULTS = { app_name: 'Vespera', button_color: 'violet' };

async function readTheme() {
  const { rows } = await pool.query('SELECT key, value FROM settings');
  const theme = { ...DEFAULTS };
  for (const row of rows) if (row.key in DEFAULTS) theme[row.key] = row.value;
  return theme;
}

function validateTheme(body) {
  const app_name = text(body, 'app_name', { max: 40, required: true });
  const button_color = oneOf(body, 'button_color', BUTTON_COLORS);
  if (!button_color) throw new HttpError(400, 'button_color is required');
  return { app_name, button_color };
}

// Writes only the values that actually changed, and records each change in the history table.
async function saveTheme(input, who) {
  const current = await readTheme();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const key of Object.keys(input)) {
      if (current[key] === input[key]) continue;
      await client.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, input[key]]
      );
      await client.query(
        'INSERT INTO settings_history (setting_key, old_value, new_value, changed_by) VALUES ($1, $2, $3, $4)',
        [key, current[key], input[key], who]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return readTheme();
}

const who = (req) => req.user?.name || req.user?.email || 'admin';

// Public: the login page and every signed-in page need the theme before anyone signs in.
export const themePublic = Router();
themePublic.get('/theme', async (req, res, next) => {
  try {
    res.json(await readTheme());
  } catch (err) {
    next(err);
  }
});

// Protected: changes, history, restore.
export const themePrivate = Router();
themePrivate.put('/theme', async (req, res, next) => {
  try {
    res.json(await saveTheme(validateTheme(req.body), who(req)));
  } catch (err) {
    next(err);
  }
});

themePrivate.get('/theme/history', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, setting_key, old_value, new_value, changed_by, changed_at FROM settings_history ORDER BY id DESC LIMIT 50'
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

themePrivate.post('/theme/history/:id/restore', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Not found');
    const { rows } = await pool.query('SELECT setting_key, old_value FROM settings_history WHERE id = $1', [id]);
    if (!rows[0]) throw new HttpError(404, 'History entry not found');
    const current = await readTheme();
    const candidate = { ...current, [rows[0].setting_key]: rows[0].old_value };
    res.json(await saveTheme(validateTheme(candidate), who(req)));
  } catch (err) {
    next(err);
  }
});
