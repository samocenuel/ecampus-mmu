import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { authenticate, hashPassword, loadUser, signToken, verifyPassword } from '../auth.js';
import { DEMO_ROLES, demoUniversity, isProtectedDemoAccount } from '../demo.js';
import { insert, q, tx } from '../db.js';
import { badRequest, forbidden, HttpError, notFound, pick, requireFields, slugify } from '../util.js';
import { CONTACT_FIELDS, cleanContacts, requestDeletion } from '../services/people.js';
import { universityPayload, validateUniversityFields } from './university.js';

const router = Router();

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw badRequest('Password must be at least 8 characters');
}

export const isEmail = (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function session(userId) {
  const user = loadUser(userId);
  const university = user.university_id ? universityPayload(q.get('SELECT * FROM universities WHERE id = ?', user.university_id)) : null;
  return { token: signToken(user), user, university };
}

/** SaaS onboarding: create a university (tenant) together with its first administrator. */
router.post('/register-university', (req, res) => {
  const uniBody = req.body?.university || {};
  const admin = req.body?.admin || {};
  requireFields(uniBody, ['name']);
  requireFields(admin, ['name', 'email', 'password']);
  if (!isEmail(admin.email)) throw badRequest('Enter a valid administrator email address');
  validatePassword(admin.password);
  const fields = validateUniversityFields(
    pick(uniBody, ['name', 'short_name', 'address', 'email', 'phone', 'website', 'primary_color', 'timezone']),
  );

  const userId = tx(() => {
    let slug = slugify(fields.short_name || fields.name) || 'university';
    for (let i = 2; q.get('SELECT 1 FROM universities WHERE slug = ?', slug); i++) slug = `${slugify(fields.short_name || fields.name)}-${i}`;
    const uniId = insert('universities', { ...fields, slug });
    return insert('users', {
      university_id: uniId,
      name: admin.name.trim(),
      email: admin.email.trim().toLowerCase(),
      password_hash: hashPassword(admin.password),
      role: 'admin',
      title: admin.title || null,
      phone: admin.phone || null,
    });
  });
  res.status(201).json(session(userId));
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw badRequest('Email and password are required');
  const row = q.get('SELECT id, password_hash, active FROM users WHERE email = ?', String(email).trim());
  if (!row || !verifyPassword(String(password), row.password_hash)) throw new HttpError(401, 'Incorrect email or password');
  if (!row.active) {
    const archived = q.get("SELECT purge_after FROM account_deletions WHERE user_id = ? AND status = 'archived'", row.id);
    throw new HttpError(
      403,
      archived
        ? `This account is archived for deletion on ${archived.purge_after}. Ask your administrator if it should be restored.`
        : 'This account has been disabled. Contact your administrator.',
    );
  }
  const user = loadUser(row.id);
  if (user.university_id) {
    const uni = q.get('SELECT active FROM universities WHERE id = ?', user.university_id);
    if (!uni?.active) throw new HttpError(403, 'This university account has been suspended');
  }
  res.json(session(row.id));
});

/** Demo roles a visitor can try without an account (empty when the demo university is absent). */
router.get('/demo', (_req, res) => {
  const uni = demoUniversity();
  const exists = (email) => q.get('SELECT 1 FROM users WHERE email = ? AND university_id = ? AND active = 1', email, uni.id);
  const roles = uni ? DEMO_ROLES.filter((r) => exists(r.email)).map(({ key, label, description }) => ({ key, label, description })) : [];
  res.json({ available: roles.length > 0, roles });
});

/** Sign in to the Demo University as one of the demo roles: no account or password needed. */
router.post('/demo', (req, res) => {
  const uni = demoUniversity();
  if (!uni) throw notFound('Demo');
  const role = DEMO_ROLES.find((r) => r.key === req.body?.role);
  if (!role) throw badRequest('Choose one of the demo roles');
  const user = q.get('SELECT id FROM users WHERE email = ? AND university_id = ? AND active = 1', role.email, uni.id);
  if (!user) throw notFound('Demo account');
  res.json({ ...session(user.id), demo: true });
});

router.get('/me', authenticate, (req, res) => {
  const { token, ...rest } = session(req.user.id);
  res.json(rest);
});

router.post('/change-password', authenticate, (req, res) => {
  if (isProtectedDemoAccount(req.user)) throw forbidden('The demo accounts are shared, so their passwords cannot be changed');
  const { current_password, new_password } = req.body || {};
  const row = q.get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
  if (!verifyPassword(String(current_password || ''), row.password_hash)) throw badRequest('Current password is incorrect');
  validatePassword(new_password);
  if (String(current_password) === String(new_password)) throw badRequest('Choose a password different from the current one');
  q.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', hashPassword(new_password), req.user.id);
  res.json({ ok: true, user: loadUser(req.user.id) });
});

/**
 * People keep their own contacts up to date (photo via /me/photo). Name, title and position are
 * official records: the HoD, Dean or administrator changes them in Users.
 */
router.put('/me', authenticate, (req, res) => {
  const body = req.body || {};
  for (const k of ['name', 'title', 'designation']) {
    if (body[k] === undefined) continue;
    const now = String(req.user[k] || '').trim();
    if (String(body[k] || '').trim() !== now) throw forbidden('Your name, title and position are updated by your HoD, Dean or administrator');
  }
  const data = cleanContacts(pick(body, CONTACT_FIELDS));
  const keys = Object.keys(data);
  if (keys.length) q.run(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => data[k]), req.user.id);
  res.json({ user: loadUser(req.user.id) });
});

const photoDir = path.join(config.uploadDir, 'photos');
const PHOTO_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(photoDir, { recursive: true });
      cb(null, photoDir);
    },
    filename: (req, file, cb) => cb(null, `user-${req.user.id}-${Date.now()}${PHOTO_EXT[file.mimetype]}`),
  }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => (PHOTO_EXT[file.mimetype] ? cb(null, true) : cb(badRequest('The photo must be a PNG, JPEG or WebP image'))),
});

const removePhoto = (photoPath) => photoPath && fs.rm(path.join(config.uploadDir, photoPath), { force: true }, () => {});

router.post('/me/photo', authenticate, photoUpload.single('photo'), (req, res) => {
  if (!req.file) throw badRequest('Attach an image in the "photo" field');
  const old = q.get('SELECT photo_path FROM users WHERE id = ?', req.user.id)?.photo_path;
  q.run('UPDATE users SET photo_path = ? WHERE id = ?', `photos/${req.file.filename}`, req.user.id);
  removePhoto(old);
  res.json({ user: loadUser(req.user.id) });
});

router.delete('/me/photo', authenticate, (req, res) => {
  const old = q.get('SELECT photo_path FROM users WHERE id = ?', req.user.id)?.photo_path;
  q.run('UPDATE users SET photo_path = NULL WHERE id = ?', req.user.id);
  removePhoto(old);
  res.json({ user: loadUser(req.user.id) });
});

/** The person's latest account deletion request, if any. */
router.get('/delete-account', authenticate, (req, res) => {
  const r = q.get("SELECT id, status, reason, requested_at, decided_at, decision_note, purge_after FROM account_deletions WHERE user_id = ? ORDER BY id DESC LIMIT 1", req.user.id);
  const days = q.get('SELECT account_archive_days FROM universities WHERE id = ?', req.uid)?.account_archive_days ?? 30;
  res.json({ request: r || null, archive_days: days });
});

/**
 * Self-service account deletion (required by app stores): a request the university's administrator
 * approves. The account is then archived (disabled, restorable) for the archive period and erased after.
 */
router.post('/delete-account', authenticate, (req, res) => {
  if (isProtectedDemoAccount(req.user)) throw forbidden('The demo accounts are shared, so they cannot be deleted');
  const row = q.get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
  if (!verifyPassword(String(req.body?.password || ''), row.password_hash)) throw badRequest('Password is incorrect');
  if (req.user.role === 'super_admin') throw badRequest('The platform owner account cannot be deleted here');
  if (req.user.role === 'admin') {
    const others = q.get(
      "SELECT COUNT(*) AS n FROM users WHERE university_id = ? AND role = 'admin' AND active = 1 AND id != ?",
      req.uid,
      req.user.id,
    ).n;
    if (!others) throw badRequest('You are the only administrator. Appoint another administrator before deleting your account.');
  }
  const request = requestDeletion(req.user, req.user, req.body?.reason);
  res.status(201).json({ ok: true, request });
});

/** Withdraws a request the administrator has not decided yet. */
router.delete('/delete-account', authenticate, (req, res) => {
  const changed = q.run("UPDATE account_deletions SET status = 'cancelled', decided_at = datetime('now') WHERE user_id = ? AND status = 'pending'", req.user.id).changes;
  if (!changed) throw notFound('Pending deletion request');
  res.json({ ok: true });
});

/** Short-lived token that can be put in a URL to download an export (e.g. from the mobile app). */
router.post('/download-token', authenticate, (req, res) => {
  res.json({ token: signToken(req.user, { purpose: 'download', expiresIn: '5m' }) });
});

export default router;
