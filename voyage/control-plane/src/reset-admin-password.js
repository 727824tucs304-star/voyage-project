// Resets an admin password and signs that account out everywhere. Run inside the control container:
//   sudo docker exec -e ADMIN_EMAIL=you@example.com -e ADMIN_NEW_PASSWORD="$P" voyage-control node src/reset-admin-password.js
import bcrypt from 'bcryptjs';
import { initControlDb, db } from './db.js';
import { audit } from './audit.js';

const { ADMIN_EMAIL: email, ADMIN_NEW_PASSWORD: password } = process.env;
if (!email || !password || password.length < 12) {
  console.error('Set ADMIN_EMAIL and ADMIN_NEW_PASSWORD (at least 12 characters).');
  process.exit(1);
}
await initControlDb();
const passwordHash = await bcrypt.hash(password, 12);
const { rows } = await db.query('UPDATE admins SET password_hash = $2 WHERE email = $1 RETURNING id', [email.toLowerCase(), passwordHash]);
if (!rows.length) {
  console.error('No admin account with that email.');
  process.exit(1);
}
await db.query('DELETE FROM admin_sessions WHERE admin_id = $1', [rows[0].id]);
audit('admin.password_reset', { email: email.toLowerCase() });
console.log('Password reset. All sessions for that account were signed out.');
await db.end();
