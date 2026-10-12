import { createApp } from './app.js';
import { config } from './config.js';
import { q } from './db.js';
import { startReminderLoop } from './services/schedule.js';

// SEED_DEMO=true loads the demo university into an empty database (used by the hosted demo).
if (process.env.SEED_DEMO === 'true' && !q.get('SELECT 1 FROM universities LIMIT 1')) {
  const { seedDemo } = await import('./seed.js');
  seedDemo();
  console.log('Seeded demo data');
}

const app = createApp();
app.listen(config.port, '0.0.0.0', () => {
  console.log(`University LMS API listening on http://localhost:${config.port}`);
  startReminderLoop();
});
