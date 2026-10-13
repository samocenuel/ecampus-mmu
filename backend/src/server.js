import crypto from 'node:crypto';
import { createApp } from './app.js';
import { hashPassword } from './auth.js';
import { config } from './config.js';
import { insert, q } from './db.js';
import { startReminderLoop } from './services/schedule.js';

// SEED_DEMO=true loads the demo university into an empty database (used by the hosted demo).
// On a public server the demo's platform owner must not keep the published demo password,
// so it gets SUPER_ADMIN_PASSWORD, or a random one nobody knows.
if (process.env.SEED_DEMO === 'true' && !q.get('SELECT 1 FROM universities LIMIT 1')) {
  const { seedDemo } = await import('./seed.js');
  seedDemo({ ownerPassword: process.env.SUPER_ADMIN_PASSWORD || crypto.randomBytes(24).toString('base64url') });
  console.log('Seeded demo data');
}

// SUPER_ADMIN_EMAIL + SUPER_ADMIN_PASSWORD create the platform owner account when there is none.
const { SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD } = process.env;
if (SUPER_ADMIN_EMAIL && SUPER_ADMIN_PASSWORD && !q.get("SELECT 1 FROM users WHERE role = 'super_admin'")) {
  insert('users', { university_id: null, name: 'Platform Owner', email: SUPER_ADMIN_EMAIL.trim(), password_hash: hashPassword(SUPER_ADMIN_PASSWORD), role: 'super_admin' });
  console.log(`Created platform owner ${SUPER_ADMIN_EMAIL.trim()}`);
}

const app = createApp();
app.listen(config.port, '0.0.0.0', () => {
  console.log(`University LMS API listening on http://localhost:${config.port}${config.basePath}`);
  startReminderLoop();
});
