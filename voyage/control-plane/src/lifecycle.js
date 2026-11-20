import { db } from './db.js';
import * as docker from './docker.js';
import { names } from './provision.js';
import { getTenant } from './provision.js';
import { HttpError } from './errors.js';
import { audit } from './audit.js';

// Archiving stops a workspace and hides it from every active list. Its database, files and
// routing are kept, so it can be restored. Nothing is deleted here.
export async function archiveTenant(slug) {
  const t = await getTenant(slug);
  if (!t) throw new HttpError(404, 'Workspace not found');
  if (t.archived_at) throw new HttpError(409, 'Workspace is already archived');
  await docker.stopContainer(names(slug).container);
  await db.query('UPDATE tenants SET archived_at = now(), updated_at = now() WHERE slug = $1', [slug]);
  audit('tenant.archived', { slug });
  return { slug, archived: true };
}

export async function restoreTenant(slug) {
  const t = await getTenant(slug);
  if (!t) throw new HttpError(404, 'Workspace not found');
  if (!t.archived_at) throw new HttpError(409, 'Workspace is not archived');
  await docker.startContainer(names(slug).container);
  await db.query('UPDATE tenants SET archived_at = NULL, updated_at = now() WHERE slug = $1', [slug]);
  audit('tenant.restored', { slug });
  return { slug, archived: false };
}
