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
} else if (process.env.SEED_DEMO === 'true') {
  const { upgradeDemo } = await import('./seed.js');
  upgradeDemo();
}

// SUPER_ADMIN_EMAIL + SUPER_ADMIN_PASSWORD create that platform owner account if it doesn't exist yet
// (an existing account keeps its password, so it can be changed in the app afterwards).
const ownerEmail = process.env.SUPER_ADMIN_EMAIL?.trim();
if (ownerEmail && process.env.SUPER_ADMIN_PASSWORD && !q.get('SELECT 1 FROM users WHERE email = ?', ownerEmail)) {
  // The starting password is set by whoever configures the server, so it must be replaced at first sign-in.
  insert('users', { university_id: null, name: 'Platform Owner', email: ownerEmail, password_hash: hashPassword(process.env.SUPER_ADMIN_PASSWORD), role: 'super_admin', must_change_password: 1 });
  console.log(`Created platform owner ${ownerEmail}`);
}

const app = createApp();
app.listen(config.port, '0.0.0.0', () => {
  console.log(`University LMS API listening on http://localhost:${config.port}${config.basePath}`);
  startReminderLoop();
});
