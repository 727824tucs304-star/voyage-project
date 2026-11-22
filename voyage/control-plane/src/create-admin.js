// Creates a personal admin account. Run inside the control container, for example:
//   sudo docker exec -e ADMIN_NEW_EMAIL=you@example.com -e ADMIN_NEW_NAME="Your Name" -e ADMIN_NEW_PASSWORD="$P" voyage-control node src/create-admin.js
import { initControlDb, db } from './db.js';
import { createAdmin } from './admin-auth.js';

const { ADMIN_NEW_EMAIL: email, ADMIN_NEW_NAME: name, ADMIN_NEW_PASSWORD: password } = process.env;
if (!email || !name || !password) {
  console.error('Set ADMIN_NEW_EMAIL, ADMIN_NEW_NAME and ADMIN_NEW_PASSWORD.');
  process.exit(1);
}
await initControlDb();
const admin = await createAdmin({ email, name, password });
console.log(`Created admin account for ${admin.email}`);
await db.end();
