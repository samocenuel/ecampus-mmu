// Part-time pay: rates set by the Dean, claims raised by part-time lecturers and approved by
// the HoD, the Dean and HR (Directorate), who also records the payment.
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { insert, q, tx } from '../db.js';
import { facultyIdsForDean, placeholders } from '../scope.js';
import { claimsXlsx } from '../services/exporter.js';
import { notify } from '../services/notify.js';
import {
  canAct, claimableLectures, claimScope, claimSelect, claimSummary, EDITABLE_STATUSES, isPartTimer, nextActors, pendingLectureCount,
  recalcTotal, refreshTeachingLines, repriceTaskLines, round2, STAGES, teachingRate,
} from '../services/pay.js';
import { badRequest, forbidden, notFound, pick, requireFields, slugify, toInt, zonedNow } from '../util.js';

const router = Router();
// Actions like "submit" may be posted without a body.
router.use((req, _res, next) => {
  req.body ??= {};
  next();
});

const STATUS_LABELS = {
  draft: 'Draft',
  rejected: 'Returned for correction',
  paid: 'Paid',
  ...Object.fromEntries(Object.entries(STAGES).map(([k, v]) => [k, v.label])),
};
const STAGE_NAMES = { submitted: 'HoD', hod_approved: 'Dean', dean_approved: 'HR', hr_verified: 'Payment' };
const UNITS = ['hour', 'script', 'student', 'visit', 'day', 'item'];
const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

// ------------------------------------------------------------------- Rates

/** Faculties whose rates the user may change: a Dean their own, an Admin any. */
function assertManageRates(user, facultyId) {
  if (user.role === 'admin') {
    if (!q.get('SELECT 1 FROM faculties WHERE id = ? AND university_id = ?', facultyId, user.university_id)) throw badRequest('Unknown faculty');
    return;
  }
  if (user.role !== 'dean' || !facultyIdsForDean(user).includes(Number(facultyId))) {
    throw forbidden('Only the Dean of this faculty can set its rates');
  }
}

function cleanRate(body) {
  const data = pick(body, ['faculty_id', 'kind', 'name', 'unit', 'amount', 'description', 'active']);
  if (data.faculty_id !== undefined) data.faculty_id = toInt(data.faculty_id);
  if (data.kind !== undefined && !['teaching', 'task'].includes(data.kind)) throw badRequest('Rate kind must be teaching or task');
  if (data.unit !== undefined && !UNITS.includes(data.unit)) throw badRequest(`Unit must be one of: ${UNITS.join(', ')}`);
  if (data.amount !== undefined) {
    data.amount = Number(data.amount);
    if (!(data.amount >= 0) || data.amount > 1e9) throw badRequest('Enter a valid amount');
  }
  if (data.name !== undefined) data.name = String(data.name).trim();
  if (data.active !== undefined) data.active = data.active ? 1 : 0;
  if (data.kind === 'teaching') data.unit = 'hour';
  return data;
}

router.get('/rates', (req, res) => {
  const where = ['r.university_id = ?'];
  const params = [req.uid];
  if (req.user.role === 'dean') {
    const facs = facultyIdsForDean(req.user);
    where.push(`r.faculty_id IN (${placeholders(facs)})`);
    params.push(...facs);
  } else if (!['admin', 'hr'].includes(req.user.role)) {
    where.push('r.faculty_id = ?');
    params.push(req.user.faculty_id);
  }
  if (req.query.faculty_id) {
    where.push('r.faculty_id = ?');
    params.push(toInt(req.query.faculty_id));
  }
  if (req.query.active !== undefined) where.push('r.active = 1');
  res.json(
    q.all(
      `SELECT r.*, f.name AS faculty_name, u.name AS updated_by_name FROM pay_rates r JOIN faculties f ON f.id = r.faculty_id
         LEFT JOIN users u ON u.id = r.updated_by WHERE ${where.join(' AND ')} ORDER BY f.name, r.kind = 'task', r.name`,
      ...params,
    ),
  );
});

router.post('/rates', requireRole('admin', 'dean'), (req, res) => {
  requireFields(req.body, ['faculty_id', 'name', 'amount']);
  const data = cleanRate({ kind: 'task', unit: 'hour', ...req.body });
  assertManageRates(req.user, data.faculty_id);
  if (data.kind === 'teaching' && teachingRate(data.faculty_id)) {
    throw badRequest('This faculty already has a teaching rate. Edit it instead.');
  }
  const id = insert('pay_rates', { ...data, university_id: req.uid, updated_by: req.user.id });
  res.status(201).json(q.get('SELECT * FROM pay_rates WHERE id = ?', id));
});

router.put('/rates/:id', requireRole('admin', 'dean'), (req, res) => {
  const rate = q.get('SELECT * FROM pay_rates WHERE id = ? AND university_id = ?', req.params.id, req.uid);
  if (!rate) throw notFound('Rate');
  assertManageRates(req.user, rate.faculty_id);
  const data = cleanRate(req.body);
  delete data.faculty_id;
  delete data.kind;
  if (rate.kind === 'teaching') data.unit = 'hour';
  const keys = Object.keys(data);
  if (keys.length) {
    q.run(
      `UPDATE pay_rates SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
      ...keys.map((k) => data[k]),
      req.user.id,
      rate.id,
    );
  }
  res.json(q.get('SELECT * FROM pay_rates WHERE id = ?', rate.id));
});

router.delete('/rates/:id', requireRole('admin', 'dean'), (req, res) => {
  const rate = q.get('SELECT * FROM pay_rates WHERE id = ? AND university_id = ?', req.params.id, req.uid);
  if (!rate) throw notFound('Rate');
  assertManageRates(req.user, rate.faculty_id);
  // Claims keep the name and price they were made with.
  q.run('DELETE FROM pay_rates WHERE id = ?', rate.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ Claims

function loadClaim(req) {
  const scope = claimScope(req.user);
  const claim = q.get(`${claimSelect} WHERE pc.id = ? AND pc.university_id = ? AND ${scope.sql}`, req.params.id, req.uid, ...scope.params);
  if (!claim) throw notFound('Claim');
  return claim;
}

function assertEditable(req, claim) {
  if (claim.lecturer_id !== req.user.id) throw forbidden('Only the lecturer who raised this claim can change it');
  if (!EDITABLE_STATUSES.includes(claim.status)) throw badRequest('This claim has been submitted and can no longer be changed');
}

const describe = (claim, user) => ({
  ...claim,
  status_label: STATUS_LABELS[claim.status],
  can_act: canAct(user, claim),
  next_action: canAct(user, claim) ? STAGES[claim.status].action : null,
  can_edit: claim.lecturer_id === user.id && EDITABLE_STATUSES.includes(claim.status),
});

function event(claimId, actorId, action, stage, note) {
  insert('pay_claim_events', { claim_id: claimId, actor_id: actorId, action, stage: stage || null, note: note || null });
}

router.get('/', (req, res) => {
  const scope = claimScope(req.user);
  const where = ['pc.university_id = ?', scope.sql];
  const params = [req.uid, ...scope.params];
  if (req.query.view === 'mine') {
    where.push('pc.lecturer_id = ?');
    params.push(req.user.id);
  }
  if (req.query.status) {
    const statuses = String(req.query.status).split(',').filter((s) => STATUS_LABELS[s]);
    where.push(`pc.status IN (${placeholders(statuses)})`);
    params.push(...statuses);
  }
  let rows = q.all(`${claimSelect} WHERE ${where.join(' AND ')} ORDER BY pc.updated_at DESC, pc.id DESC LIMIT 1000`, ...params).map((c) => describe(c, req.user));
  if (req.query.view === 'queue') rows = rows.filter((c) => c.can_act);
  res.json(rows);
});

router.get('/summary', (req, res) => res.json(claimSummary(req.user)));

/** What a new claim for this period would contain. */
router.get('/preview', (req, res) => {
  const { from, to } = req.query;
  if (!isDate(from) || !isDate(to) || from > to) throw badRequest('Choose a valid period');
  const lectures = claimableLectures(req.user.id, from, to);
  const rate = teachingRate(req.user.faculty_id);
  res.json({
    lectures,
    hours: round2(lectures.reduce((t, l) => t + l.hours, 0)),
    rate,
    pending_lectures: pendingLectureCount(req.user.id, from, to),
  });
});

router.post('/', (req, res) => {
  if (!isPartTimer(req.user)) throw forbidden('Only part-time lecturers raise pay claims');
  if (!req.user.department_id || !req.user.faculty_id) throw badRequest('Your account has no department yet; ask your HoD');
  const { period_start: from, period_end: to } = req.body;
  if (!isDate(from) || !isDate(to) || from > to) throw badRequest('Choose a valid claim period');
  const uni = q.get('SELECT currency, timezone FROM universities WHERE id = ?', req.uid);
  if (from > zonedNow(uni.timezone).date) throw badRequest('The claim period cannot start in the future');
  const title = String(req.body.title || '').trim() || `${from} to ${to}`;
  const id = tx(() => {
    const claimId = insert('pay_claims', {
      university_id: req.uid, lecturer_id: req.user.id, department_id: req.user.department_id, faculty_id: req.user.faculty_id,
      title, period_start: from, period_end: to, currency: uni.currency || 'UGX',
    });
    event(claimId, req.user.id, 'created');
    refreshTeachingLines(q.get('SELECT * FROM pay_claims WHERE id = ?', claimId));
    return claimId;
  });
  res.status(201).json(describe(q.get(`${claimSelect} WHERE pc.id = ?`, id), req.user));
});

router.get('/export', requireRole('admin', 'hr', 'dean', 'hod'), async (req, res) => {
  const scope = claimScope(req.user);
  const statuses = String(req.query.status || 'hr_verified').split(',').filter((s) => STATUS_LABELS[s] && s !== 'draft');
  const claims = q
    .all(`${claimSelect} WHERE pc.university_id = ? AND ${scope.sql} AND pc.status IN (${placeholders(statuses)}) ORDER BY f.name, d.name, u.name`, req.uid, ...scope.params, ...statuses)
    .map((c) => ({ ...c, status_label: STATUS_LABELS[c.status] }));
  const ids = claims.map((c) => c.id);
  const lines = ids.length
    ? q.all(
        `SELECT l.*, l.claim_id, u.name AS lecturer_name FROM pay_claim_lines l JOIN pay_claims pc ON pc.id = l.claim_id
           JOIN users u ON u.id = pc.lecturer_id WHERE l.claim_id IN (${placeholders(ids)}) ORDER BY u.name, l.work_date, l.start_time`,
        ...ids,
      )
    : [];
  const university = q.get('SELECT * FROM universities WHERE id = ?', req.uid);
  const title = statuses.length === 1 ? `Part-time claims: ${STATUS_LABELS[statuses[0]]}` : 'Part-time claims';
  const buf = await claimsXlsx(university, title, claims, lines);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${slugify(title)}.xlsx"`);
  res.send(buf);
});

router.get('/:id', (req, res) => {
  const claim = loadClaim(req);
  const lines = q.all('SELECT * FROM pay_claim_lines WHERE claim_id = ? ORDER BY kind, work_date, start_time, id', claim.id);
  const events = q.all(
    `SELECT e.*, u.name AS actor_name, u.role AS actor_role FROM pay_claim_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.claim_id = ? ORDER BY e.id`,
    claim.id,
  );
  const out = describe(claim, req.user);
  out.lines = lines;
  out.events = events;
  out.teaching_rate = teachingRate(claim.faculty_id) || null;
  if (out.can_edit) out.pending_lectures = pendingLectureCount(claim.lecturer_id, claim.period_start, claim.period_end);
  res.json(out);
});

router.put('/:id', (req, res) => {
  const claim = loadClaim(req);
  assertEditable(req, claim);
  const title = String(req.body.title || '').trim();
  if (title) q.run("UPDATE pay_claims SET title = ?, updated_at = datetime('now') WHERE id = ?", title, claim.id);
  res.json(describe(q.get(`${claimSelect} WHERE pc.id = ?`, claim.id), req.user));
});

router.delete('/:id', (req, res) => {
  const claim = loadClaim(req);
  if (claim.lecturer_id !== req.user.id || claim.status !== 'draft') throw badRequest('Only your own draft claims can be deleted');
  q.run('DELETE FROM pay_claims WHERE id = ?', claim.id);
  res.json({ ok: true });
});

router.post('/:id/refresh', (req, res) => {
  const claim = loadClaim(req);
  assertEditable(req, claim);
  tx(() => refreshTeachingLines(claim));
  res.json({ ok: true });
});

router.post('/:id/lines', (req, res) => {
  const claim = loadClaim(req);
  assertEditable(req, claim);
  requireFields(req.body, ['rate_id', 'quantity', 'work_date']);
  const rate = q.get("SELECT * FROM pay_rates WHERE id = ? AND faculty_id = ? AND kind = 'task' AND active = 1", toInt(req.body.rate_id), claim.faculty_id);
  if (!rate) throw badRequest("Choose one of your faculty's task rates");
  const quantity = Number(req.body.quantity);
  if (!(quantity > 0) || quantity > 10000) throw badRequest('Enter a valid quantity');
  const date = req.body.work_date;
  if (!isDate(date) || date < claim.period_start || date > claim.period_end) throw badRequest('The task date must be inside the claim period');
  const description = String(req.body.description || '').trim();
  if (!description) throw badRequest('Describe the task, e.g. which course unit or students it covers');
  insert('pay_claim_lines', {
    claim_id: claim.id, kind: 'task', rate_id: rate.id, rate_name: rate.name, unit: rate.unit, unit_price: rate.amount,
    quantity, amount: round2(rate.amount * quantity), work_date: date, description,
  });
  res.status(201).json({ total: recalcTotal(claim.id) });
});

router.delete('/:id/lines/:lineId', (req, res) => {
  const claim = loadClaim(req);
  assertEditable(req, claim);
  const line = q.get('SELECT * FROM pay_claim_lines WHERE id = ? AND claim_id = ?', req.params.lineId, claim.id);
  if (!line) throw notFound('Claim line');
  q.run('DELETE FROM pay_claim_lines WHERE id = ?', line.id);
  res.json({ total: recalcTotal(claim.id) });
});

/** Who attended a claimed lecture (every class in a combined lecture). */
router.get('/:id/lines/:lineId/attendance', (req, res) => {
  const claim = loadClaim(req);
  const line = q.get("SELECT * FROM pay_claim_lines WHERE id = ? AND claim_id = ? AND kind = 'teaching'", req.params.lineId, claim.id);
  if (!line) throw notFound('Lecture');
  const registers = q.all(
    `SELECT r.id, r.status, r.topic, r.submitted_at, r.reviewed_at, c.name AS class_name, rep.name AS submitted_by_name
       FROM attendance_registers r JOIN classes c ON c.id = r.class_id LEFT JOIN users rep ON rep.id = r.submitted_by
      WHERE r.session_id = ? AND r.lecture_date = ? ORDER BY c.name`,
    line.session_id,
    line.work_date,
  );
  for (const r of registers) {
    r.students = q.all(
      `SELECT u.name, u.identifier, ar.present FROM attendance_records ar JOIN users u ON u.id = ar.student_id
        WHERE ar.register_id = ? ORDER BY ar.present DESC, u.name`,
      r.id,
    );
  }
  res.json({ line, registers });
});

router.post('/:id/submit', (req, res) => {
  const claim = loadClaim(req);
  assertEditable(req, claim);
  tx(() => {
    refreshTeachingLines(claim);
    repriceTaskLines(claim.id);
    const total = recalcTotal(claim.id);
    const lines = q.get('SELECT COUNT(*) AS n, SUM(unit_price = 0 AND kind = \'teaching\') AS unpriced FROM pay_claim_lines WHERE claim_id = ?', claim.id);
    if (!lines.n) throw badRequest('There is nothing to claim in this period yet');
    if (lines.unpriced) throw badRequest('Your Dean has not set the teaching rate for your faculty yet');
    if (!(total > 0)) throw badRequest('The claim total must be more than zero');
    q.run("UPDATE pay_claims SET status = 'submitted', returned_from = NULL, submitted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", claim.id);
    event(claim.id, req.user.id, claim.status === 'rejected' ? 'resubmitted' : 'submitted', null, req.body.note);
  });
  const fresh = q.get(`${claimSelect} WHERE pc.id = ?`, claim.id);
  notify(nextActors(fresh, 'submitted'), {
    title: 'Part-time claim to approve',
    body: `${fresh.lecturer_name}: ${fresh.title} (${fresh.currency} ${fresh.total.toLocaleString('en')})`,
    type: 'claim',
    link: `/claims/${claim.id}`,
  });
  res.json(describe(fresh, req.user));
});

router.post('/:id/approve', (req, res) => {
  const claim = loadClaim(req);
  if (!canAct(req.user, claim)) throw forbidden('This claim is not waiting for you');
  const stage = STAGES[claim.status];
  const note = String(req.body.note || '').trim();
  const reference = String(req.body.payment_reference || '').trim();
  if (stage.next === 'paid' && !reference) throw badRequest('Enter the payment reference (e.g. voucher or transfer number)');
  q.run(
    `UPDATE pay_claims SET status = ?, updated_at = datetime('now')${stage.next === 'paid' ? ", payment_reference = ?, paid_at = datetime('now')" : ''} WHERE id = ?`,
    ...(stage.next === 'paid' ? [stage.next, reference, claim.id] : [stage.next, claim.id]),
  );
  event(claim.id, req.user.id, stage.next === 'paid' ? 'paid' : stage.next === 'hr_verified' ? 'verified' : 'approved', STAGE_NAMES[claim.status], [note, reference && `Payment ref. ${reference}`].filter(Boolean).join(' · '));
  const fresh = q.get(`${claimSelect} WHERE pc.id = ?`, claim.id);
  if (stage.next === 'paid') {
    notify(claim.lecturer_id, { title: 'Claim paid', body: `${claim.title}: ${claim.currency} ${claim.total.toLocaleString('en')} (ref. ${reference})`, type: 'claim', link: `/claims/${claim.id}` });
  } else {
    notify(nextActors(fresh, stage.next), { title: stage.next === 'hr_verified' ? 'Verified claim to pay' : 'Part-time claim to approve', body: `${claim.lecturer_name}: ${claim.title}`, type: 'claim', link: `/claims/${claim.id}` });
    notify(claim.lecturer_id, { title: `Claim ${stage.next === 'hr_verified' ? 'verified by HR' : `approved by the ${STAGE_NAMES[claim.status]}`}`, body: claim.title, type: 'claim', link: `/claims/${claim.id}` });
  }
  res.json(describe(fresh, req.user));
});

router.post('/:id/reject', (req, res) => {
  const claim = loadClaim(req);
  if (!canAct(req.user, claim)) throw forbidden('This claim is not waiting for you');
  const note = String(req.body.note || '').trim();
  if (!note) throw badRequest('Say what needs correcting so the lecturer can fix it');
  q.run("UPDATE pay_claims SET status = 'rejected', returned_from = ?, updated_at = datetime('now') WHERE id = ?", STAGE_NAMES[claim.status], claim.id);
  event(claim.id, req.user.id, 'returned', STAGE_NAMES[claim.status], note);
  notify(claim.lecturer_id, { title: 'Claim returned for correction', body: `${claim.title}: ${note}`, type: 'claim', link: `/claims/${claim.id}` });
  res.json(describe(q.get(`${claimSelect} WHERE pc.id = ?`, claim.id), req.user));
});

export default router;
