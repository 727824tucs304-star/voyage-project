import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

pg.types.setTypeParser(1700, (v) => Number.parseFloat(v)); // NUMERIC -> number
pg.types.setTypeParser(1082, (v) => v);                    // DATE -> 'YYYY-MM-DD'

const here = path.dirname(fileURLToPath(import.meta.url));

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

// Runs on every start. Schema is idempotent; the admin is created only when no users exist.
export async function initDatabase() {
  const schema = fs.readFileSync(path.join(here, '..', 'schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query('INSERT INTO company (id, name) VALUES (1, $1) ON CONFLICT (id) DO NOTHING',
    [process.env.COMPANY_NAME || 'My Company']);

  const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD_HASH } = process.env;
  if (ADMIN_EMAIL && ADMIN_PASSWORD_HASH) {
    await pool.query(
      `INSERT INTO users (name, email, password_hash)
       SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM users)`,
      [ADMIN_NAME || 'Administrator', ADMIN_EMAIL.toLowerCase(), ADMIN_PASSWORD_HASH]
    );
  }
}
