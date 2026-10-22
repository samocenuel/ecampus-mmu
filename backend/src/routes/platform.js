// Platform (SaaS operator) endpoints - only for super admins.
import { Router } from 'express';
import crypto from 'node:crypto';
import { hashPassword, requireRole } from '../auth.js';
import { q, update } from '../db.js';
import { isProtectedDemoAccount } from '../demo.js';
import { badRequest, forbidden, notFound, truthy } from '../util.js';
import { universityPayload } from './university.js';

const router = Router();
router.use(requireRole('super_admin'));

router.get('/universities', (_req, res) => {
  const rows = q.all(
    `SELECT u.*,
            (SELECT COUNT(*) FROM users x WHERE x.university_id = u.id AND x.role = 'student') AS students,
            (SELECT COUNT(*) FROM users x WHERE x.university_id = u.id AND x.role IN ('lecturer','hod','dean')) AS lecturers,
            (SELECT COUNT(*) FROM faculties f WHERE f.university_id = u.id) AS faculties
       FROM universities u ORDER BY u.created_at DESC`,
  );
  res.json(rows.map(universityPayload));
});

router.put('/universities/:id', (req, res) => {
  const uni = q.get('SELECT id FROM universities WHERE id = ?', req.params.id);
  if (!uni) throw notFound('University');
  if (req.body?.active !== undefined) update('universities', uni.id, { active: truthy(req.body.active) ? 1 : 0 });
  res.json(universityPayload(q.get('SELECT * FROM universities WHERE id = ?', uni.id)));
});

router.get('/universities/:id/admins', (req, res) => {
  res.json(
    q.all(
      "SELECT id, name, email, active, must_change_password, created_at FROM users WHERE university_id = ? AND role = 'admin' ORDER BY name",
      req.params.id,
    ).map((u) => ({ ...u, must_change_password: Boolean(u.must_change_password), demo: isProtectedDemoAccount({ ...u, university_id: Number(req.params.id) }) })),
  );
});

/** Reset a university administrator who is locked out; they choose a new password at next sign-in. */
router.post('/users/:id/reset-password', (req, res) => {
  const user = q.get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!user) throw notFound('User');
  if (user.role !== 'admin') throw badRequest('The platform owner resets university administrators; they reset everyone else');
  if (isProtectedDemoAccount(user)) throw forbidden('The shared demo accounts sign in without a password');
  const password = `Temp-${crypto.randomBytes(5).toString('base64url')}`;
  q.run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', hashPassword(password), user.id);
  res.json({ ok: true, name: user.name, email: user.email, temporary_password: password });
});

export default router;
