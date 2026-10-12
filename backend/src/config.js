import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  port: Number(process.env.PORT || 4000),
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  dbFile: process.env.DB_FILE || path.join(root, 'data', 'app.db'),
  uploadDir: process.env.UPLOAD_DIR || path.join(root, 'uploads'),
  webDist: process.env.WEB_DIST || path.join(root, '..', 'web', 'dist'),
  // Flutter web build of the mobile app (flutter build web --base-href /m/), served at /m/.
  mobileWebDist: process.env.MOBILE_WEB_DIST || path.join(root, '..', 'mobile', 'build', 'web'),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  reminderIntervalMs: Number(process.env.REMINDER_INTERVAL_MS || 60_000),
  isProduction: process.env.NODE_ENV === 'production',
};

if (config.isProduction && config.jwtSecret === 'dev-only-secret-change-me') {
  console.warn('[config] JWT_SECRET is not set - set a strong secret in production.');
}
