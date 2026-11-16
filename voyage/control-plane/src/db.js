import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

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
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      console.warn(`control database not ready (attempt ${i}), retrying`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
