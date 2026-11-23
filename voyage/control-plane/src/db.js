import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Personal admin accounts and their sessions. Passwords are stored only as bcrypt hashes.
const ADMIN_SQL = `
CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  disabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_sessions_expiry ON admin_sessions (expires_at);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS monthly_budget NUMERIC;
`;

export const db = new pg.Pool({ connectionString: config.controlDbUrl, max: 10 });

// CREATE ROLE / CREATE DATABASE cannot run inside the control database, so use the 'postgres' maintenance DB.
const maintenanceUrl = new URL(config.controlDbUrl);
maintenanceUrl.pathname = '/postgres';
export const adminPool = new pg.Pool({ connectionString: maintenanceUrl.toString(), max: 2 });

export async function initControlDb(attempts = 30) {
  const sql = fs.readFileSync(path.join(here, '..', 'schema.sql'), 'utf8');
  for (let i = 1; ; i++) {
    try {
      await db.query(sql);
      await db.query(ADMIN_SQL);
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      console.warn(`control database not ready (attempt ${i}), retrying`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
