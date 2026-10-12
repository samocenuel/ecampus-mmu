import { Router } from 'express';
import { requireRole, STAFF_ROLES } from '../auth.js';
import { q } from '../db.js';
import { resolveTerm, scopeLabel } from '../scope.js';
import { reportXlsx } from '../services/exporter.js';
import { buildReport } from '../services/reports.js';
import { slugify, toInt } from '../util.js';

const router = Router();
router.use(requireRole(...STAFF_ROLES));

router.get('/overview', (req, res) => {
  const term = resolveTerm(req.uid, toInt(req.query.term_id));
  res.json(buildReport(req.user, term));
});

router.get('/export', async (req, res) => {
  const term = resolveTerm(req.uid, toInt(req.query.term_id));
  const university = q.get('SELECT * FROM universities WHERE id = ?', req.uid);
  const buf = await reportXlsx(university, buildReport(req.user, term));
  const name = `report-${slugify(scopeLabel(req.user))}-${slugify(term?.name || 'all')}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(buf);
});

export default router;
