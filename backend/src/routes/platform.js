// Platform (SaaS operator) endpoints - only for super admins.
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { q, update } from '../db.js';
import { notFound, truthy } from '../util.js';
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

export default router;
