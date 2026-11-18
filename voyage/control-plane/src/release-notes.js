import pg from 'pg';
import { config } from './config.js';
import { tenantSecrets } from './security.js';
import { names } from './provision.js';
import { audit } from './audit.js';

const DDL = `CREATE TABLE IF NOT EXISTS release_notes (
  id SERIAL PRIMARY KEY,
  version TEXT NOT NULL,
  kind TEXT NOT NULL,
  commit_hash TEXT,
  message TEXT NOT NULL,
  released_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

// Connects as the client's own database role, so it can only write to that client's database.
export async function recordRelease(slug, { version, kind, commit, message }) {
  const { dbName, dbUser } = names(slug);
  const { dbPassword } = tenantSecrets(slug);
  const client = new pg.Client({
    connectionString: `postgres://${dbUser}:${dbPassword}@${config.tenantPgHost}:${config.tenantPgPort}/${dbName}`,
  });
  await client.connect();
  try {
    await client.query(DDL);
    await client.query(
      'INSERT INTO release_notes (version, kind, commit_hash, message) VALUES ($1, $2, $3, $4)',
      [version, kind, commit || null, String(message || `Release ${version}`).slice(0, 200)]
    );
  } finally {
    await client.end();
  }
  audit('release_note.recorded', { slug, version, kind });
}
