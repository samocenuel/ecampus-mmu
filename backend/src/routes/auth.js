import crypto from 'node:crypto';
import { Router } from 'express';
import { authenticate, hashPassword, loadUser, signToken, verifyPassword } from '../auth.js';
import { DEMO_ROLES, demoUniversity, isProtectedDemoAccount } from '../demo.js';
import { insert, q, tx } from '../db.js';
import { badRequest, forbidden, HttpError, notFound, pick, requireFields, slugify } from '../util.js';
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
  if (!row.active) throw new HttpError(403, 'This account has been disabled. Contact your administrator.');
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
  q.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(new_password), req.user.id);
  res.json({ ok: true });
});

/**
 * Self-service account deletion (required by app stores). Personal data is erased and the
 * account disabled; anonymised teaching/attendance records are kept for the university's statistics.
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
  tx(() => {
    const id = req.user.id;
    q.run(
      `UPDATE users SET name = 'Deleted user', email = ?, password_hash = ?, phone = NULL, identifier = NULL,
              title = NULL, active = 0 WHERE id = ?`,
      `deleted-${id}@deleted.invalid`,
      hashPassword(crypto.randomBytes(24).toString('hex')),
      id,
    );
    q.run('UPDATE classes SET class_rep_id = NULL WHERE class_rep_id = ?', id);
    q.run('UPDATE faculties SET dean_id = NULL WHERE dean_id = ?', id);
    q.run('UPDATE departments SET hod_id = NULL WHERE hod_id = ?', id);
    q.run('DELETE FROM notifications WHERE user_id = ?', id);
    q.run('DELETE FROM notification_prefs WHERE user_id = ?', id);
  });
  res.json({ ok: true });
});

/** Short-lived token that can be put in a URL to download an export (e.g. from the mobile app). */
router.post('/download-token', authenticate, (req, res) => {
  res.json({ token: signToken(req.user, { purpose: 'download', expiresIn: '5m' }) });
});

export default router;
