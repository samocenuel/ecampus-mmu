// Public check of a printed requisition form: scanning its QR code (or typing its code) shows the
// lecturer, the amount, the approval status and the sign-off footprints held by the system.
import { Router } from 'express';
import { q } from '../db.js';
import { STAGES } from '../services/pay.js';
import { formatCode, normaliseCode, publicBase, signOffs } from '../services/requisition.js';
import { notFound } from '../util.js';
import { universityPayload } from './university.js';

const router = Router();
const LABELS = { draft: 'Draft', rejected: 'Returned for correction', paid: 'Paid', ...Object.fromEntries(Object.entries(STAGES).map(([k, v]) => [k, v.label])) };

router.get('/:code', (req, res) => {
  const code = normaliseCode(req.params.code);
  const claim =
    code.length === 10 &&
    q.get(
      `SELECT pc.*, u.name AS lecturer_name, u.title AS lecturer_title, d.name AS department_name, f.name AS faculty_name,
              v.code AS vote_code, v.name AS vote_name
         FROM pay_claims pc JOIN users u ON u.id = pc.lecturer_id
         LEFT JOIN departments d ON d.id = pc.department_id LEFT JOIN faculties f ON f.id = pc.faculty_id
         LEFT JOIN pay_votes v ON v.id = pc.vote_id
        WHERE pc.verify_code = ?`,
      code,
    );
  if (!claim || claim.status === 'draft') throw notFound('Requisition');
  const uni = universityPayload(q.get('SELECT * FROM universities WHERE id = ?', claim.university_id));
  res.set('Cache-Control', 'no-store');
  res.json({
    code: formatCode(code),
    university: { name: uni.name, short_name: uni.short_name, logo_url: uni.logo_url, primary_color: uni.primary_color },
    requisition: {
      id: claim.id,
      title: claim.title,
      lecturer: [claim.lecturer_title, claim.lecturer_name].filter(Boolean).join(' '),
      department: claim.department_name,
      faculty: claim.faculty_name,
      period_start: claim.period_start,
      period_end: claim.period_end,
      amount: claim.total,
      currency: claim.currency,
      status: claim.status,
      // Approval status: HR's final approval reads "Approved for payment"; a recorded payment is shown separately.
      status_label: ['hr_verified', 'paid'].includes(claim.status) ? 'Approved for payment' : LABELS[claim.status] || claim.status,
      paid: claim.status === 'paid',
      cleared: ['hr_verified', 'paid'].includes(claim.status),
      paid_at: claim.paid_at,
      vote: claim.vote_code ? `${claim.vote_code} - ${claim.vote_name}` : null,
    },
    sign_offs: Object.values(signOffs(claim)),
    completed_url: `${publicBase(req)}/claims?view=completed`,
  });
});

export default router;
