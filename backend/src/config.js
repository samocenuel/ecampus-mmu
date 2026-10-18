import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isProduction = process.env.NODE_ENV === 'production';
const dbFile = process.env.DB_FILE || path.join(root, 'data', 'app.db');

/**
 * JWT signing secret. In production without JWT_SECRET, a random secret is generated once
 * and kept beside the database (readable only by this account), so tokens are never signed
 * with a known default.
 */
function jwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (!isProduction || dbFile === ':memory:') return 'dev-only-secret-change-me';
  const file = path.join(path.dirname(dbFile), '.jwt-secret');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved.length >= 32) return saved;
  } catch {
    // not created yet
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  console.log(`[config] Generated a JWT signing secret in ${file}`);
  return secret;
}

export const config = {
  port: Number(process.env.PORT || 4000),
  jwtSecret: jwtSecret(),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  dbFile,
  uploadDir: process.env.UPLOAD_DIR || path.join(root, 'uploads'),
  webDist: process.env.WEB_DIST || path.join(root, '..', 'web', 'dist'),
  // Flutter web build of the mobile app (flutter build web --base-href /m/), served at /m/.
  mobileWebDist: process.env.MOBILE_WEB_DIST || path.join(root, '..', 'mobile', 'build', 'web'),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  // URL prefix when hosted under a sub-path, e.g. BASE_PATH=/ecampus for https://example.com/ecampus.
  basePath: (process.env.BASE_PATH || '').replace(/\/+$/, ''),
  reminderIntervalMs: Number(process.env.REMINDER_INTERVAL_MS || 60_000),
  isProduction,
};
