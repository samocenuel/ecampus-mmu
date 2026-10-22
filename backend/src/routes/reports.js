import { Router } from 'express';
import { requireRole, STAFF_ROLES } from '../auth.js';
import { q } from '../db.js';
import { resolveTerm, scopeLabel } from '../scope.js';
import { reportPdf, reportXlsx } from '../services/exporter.js';
import { buildReport, parseReportFilters, reportOptions } from '../services/reports.js';
import { slugify, toInt } from '../util.js';

const router = Router();
router.use(requireRole(...STAFF_ROLES));

router.get('/overview', (req, res) => {
  const term = resolveTerm(req.uid, toInt(req.query.term_id));
  res.json(buildReport(req.user, term, parseReportFilters(req.query)));
});

/** What the user can filter on: their departments, programmes, classes, course units and lecturers. */
router.get('/options', (req, res) => {
  const term = resolveTerm(req.uid, toInt(req.query.term_id));
  res.json(reportOptions(req.user, term));
});

/** The report as Excel (default) or PDF, with the same filters and sections as the screen. */
router.get('/export', async (req, res) => {
  const term = resolveTerm(req.uid, toInt(req.query.term_id));
  const university = q.get('SELECT * FROM universities WHERE id = ?', req.uid);
  const report = buildReport(req.user, term, parseReportFilters(req.query));
  const pdf = req.query.format === 'pdf';
  const buf = pdf ? await reportPdf(university, report) : await reportXlsx(university, report);
  const name = `report-${slugify([scopeLabel(req.user), ...report.filters.labels.slice(0, 2)].join(' '))}-${slugify(term?.name || 'all')}.${pdf ? 'pdf' : 'xlsx'}`;
  res.setHeader('Content-Type', pdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(buf);
});

export default router;
