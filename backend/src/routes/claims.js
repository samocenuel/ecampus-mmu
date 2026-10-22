// Part-time pay: rates set by the Dean, claims raised by part-time lecturers and approved by
// the HoD, the Dean and HR (Directorate), who also records the payment.
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { insert, q, tx } from '../db.js';
import { facultyIdsForDean, managedDepartmentIds, placeholders } from '../scope.js';
import { claimsXlsx, payslipPdf, requisitionPdf } from '../services/exporter.js';
import { notify } from '../services/notify.js';
import { ensureVerifyCode, formatCode, publicBase, signOffs } from '../services/requisition.js';
import {
  canAct, claimableLectures, claimScope, claimSelect, claimSummary, EDITABLE_STATUSES, isPartTimer, nextActors, pendingLectureCount,
  PROGRAM_LEVELS, rateForLevels, voteCharged, recalcTotal, refreshTeachingLines, repriceTaskLines, round2, STAGES, teachingRate, teachingRates,
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
  const data = pick(body, ['faculty_id', 'kind', 'name', 'unit', 'amount', 'description', 'active', 'code', 'program_level']);
  if (data.program_level !== undefined) {
    data.program_level = data.program_level ? String(data.program_level).trim() : null;
    if (data.program_level && !PROGRAM_LEVELS.includes(data.program_level)) throw badRequest(`Programme level must be one of: ${PROGRAM_LEVELS.join(', ')}`);
  }
  if (data.code !== undefined) {
    data.code = data.code === 'invigilation' || data.code === true ? 'invigilation' : null;
    if (data.code) data.unit = 'hour';
  }
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
  if (data.kind === 'teaching' && q.get("SELECT 1 FROM pay_rates WHERE faculty_id = ? AND kind = 'teaching' AND program_level IS ?", data.faculty_id, data.program_level ?? null)) {
    throw badRequest(data.program_level ? `This faculty already has a teaching rate for ${data.program_level} programmes. Edit it instead.` : 'This faculty already has a general teaching rate. Edit it, or add a rate for a programme level.');
  }
  if (data.code) q.run('UPDATE pay_rates SET code = NULL WHERE faculty_id = ? AND code = ?', data.faculty_id, data.code);
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
  if (rate.kind === 'teaching') {
    data.unit = 'hour';
    delete data.code;
    if (data.program_level !== undefined && (data.program_level ?? null) !== (rate.program_level ?? null)
        && q.get("SELECT 1 FROM pay_rates WHERE faculty_id = ? AND kind = 'teaching' AND program_level IS ? AND id <> ?", rate.faculty_id, data.program_level ?? null, rate.id)) {
      throw badRequest(`This faculty already has a teaching rate for ${data.program_level || 'all programme levels'}`);
    }
  }
  if (data.code) q.run('UPDATE pay_rates SET code = NULL WHERE faculty_id = ? AND code = ? AND id <> ?', rate.faculty_id, data.code, rate.id);
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

// ------------------------------------------------------------------- Votes

const voteRow = (v) => {
  const charged = voteCharged(v.id);
  return { ...v, charged, balance: round2(v.amount - charged) };
};

function cleanVote(body) {
  const data = pick(body, ['code', 'name', 'amount', 'financial_year', 'active']);
  if (data.code !== undefined) {
    data.code = String(data.code).trim();
    if (!data.code || data.code.length > 40) throw badRequest('Enter the vote code (up to 40 characters)');
  }
  if (data.name !== undefined) {
    data.name = String(data.name).trim();
    if (!data.name) throw badRequest('Enter the vote name');
  }
  if (data.amount !== undefined) {
    data.amount = Number(data.amount);
    if (!(data.amount >= 0) || data.amount > 1e12) throw badRequest('Enter a valid vote amount');
  }
  if (data.financial_year !== undefined) data.financial_year = String(data.financial_year || '').trim() || null;
  if (data.active !== undefined) data.active = data.active ? 1 : 0;
  return data;
}

router.get('/votes', (req, res) => {
  if (!['admin', 'dean', 'hod', 'hr'].includes(req.user.role)) throw forbidden();
  const where = ['v.university_id = ?'];
  const params = [req.uid];
  if (req.user.role === 'dean') {
    const facs = facultyIdsForDean(req.user);
    if (!facs.length) return res.json([]);
    where.push(`v.faculty_id IN (${placeholders(facs)})`);
    params.push(...facs);
  } else if (req.user.role === 'hod') {
    where.push('v.faculty_id = ?');
    params.push(req.user.faculty_id);
  }
  if (req.query.faculty_id) {
    where.push('v.faculty_id = ?');
    params.push(toInt(req.query.faculty_id));
  }
  if (req.query.active !== undefined) where.push('v.active = 1');
  res.json(
    q
      .all(
        `SELECT v.*, f.name AS faculty_name, u.name AS created_by_name FROM pay_votes v JOIN faculties f ON f.id = v.faculty_id
           LEFT JOIN users u ON u.id = v.created_by WHERE ${where.join(' AND ')} ORDER BY f.name, v.active DESC, v.code`,
        ...params,
      )
      .map(voteRow),
  );
});

router.post('/votes', requireRole('admin', 'dean'), (req, res) => {
  requireFields(req.body, ['faculty_id', 'code', 'name', 'amount']);
  const data = cleanVote(req.body);
  const facultyId = toInt(req.body.faculty_id);
  assertManageRates(req.user, facultyId);
  if (q.get('SELECT 1 FROM pay_votes WHERE faculty_id = ? AND code = ?', facultyId, data.code)) throw badRequest(`Vote ${data.code} already exists for this faculty`);
  const id = insert('pay_votes', { ...data, university_id: req.uid, faculty_id: facultyId, created_by: req.user.id });
  res.status(201).json(voteRow(q.get('SELECT * FROM pay_votes WHERE id = ?', id)));
});

router.put('/votes/:id', requireRole('admin', 'dean'), (req, res) => {
  const vote = q.get('SELECT * FROM pay_votes WHERE id = ? AND university_id = ?', toInt(req.params.id), req.uid);
  if (!vote) throw notFound('Vote');
  assertManageRates(req.user, vote.faculty_id);
  const data = cleanVote(req.body);
  if (data.code && data.code !== vote.code && q.get('SELECT 1 FROM pay_votes WHERE faculty_id = ? AND code = ? AND id <> ?', vote.faculty_id, data.code, vote.id)) {
    throw badRequest(`Vote ${data.code} already exists for this faculty`);
  }
  const keys = Object.keys(data);
  if (keys.length) q.run(`UPDATE pay_votes SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => data[k]), vote.id);
  res.json(voteRow(q.get('SELECT * FROM pay_votes WHERE id = ?', vote.id)));
});

router.delete('/votes/:id', requireRole('admin', 'dean'), (req, res) => {
  const vote = q.get('SELECT * FROM pay_votes WHERE id = ? AND university_id = ?', toInt(req.params.id), req.uid);
  if (!vote) throw notFound('Vote');
  assertManageRates(req.user, vote.faculty_id);
  // A vote that claims were charged to is closed rather than deleted, so their requisitions keep it.
  if (q.get('SELECT 1 FROM pay_claims WHERE vote_id = ?', vote.id)) {
    q.run('UPDATE pay_votes SET active = 0 WHERE id = ?', vote.id);
    return res.json({ ok: true, closed: true });
  }
  q.run('DELETE FROM pay_votes WHERE id = ?', vote.id);
  res.json({ ok: true });
});

// ----------------------------------------------------------------- Budgets

/** The term a date falls in (claims are budgeted by the term their period starts in). */
const termAt = (uid, date) =>
  q.get('SELECT * FROM academic_terms WHERE university_id = ? AND (start_date IS NULL OR start_date <= ?) AND (end_date IS NULL OR end_date >= ?) ORDER BY start_date DESC LIMIT 1', uid, date, date);

/** A department's part-time budget for a term and what claims have committed against it. */
export function budgetFor(departmentId, termId) {
  const b = q.get('SELECT * FROM pay_budgets WHERE department_id = ? AND term_id = ?', departmentId, termId);
  const term = q.get('SELECT * FROM academic_terms WHERE id = ?', termId);
  const sums = q.get(
    `SELECT COALESCE(SUM(CASE WHEN status NOT IN ('draft','rejected') THEN total END), 0) AS committed,
            COALESCE(SUM(CASE WHEN status = 'paid' THEN total END), 0) AS paid
       FROM pay_claims WHERE department_id = ? AND period_start BETWEEN ? AND ?`,
    departmentId,
    term?.start_date || '0000-01-01',
    term?.end_date || '9999-12-31',
  );
  return { amount: b ? b.amount : null, committed: round2(sums.committed), paid: round2(sums.paid), remaining: b ? round2(b.amount - sums.committed) : null };
}

router.get('/budgets', (req, res) => {
  if (!['admin', 'dean', 'hod', 'hr'].includes(req.user.role)) throw forbidden();
  const term = toInt(req.query.term_id) ? q.get('SELECT * FROM academic_terms WHERE id = ? AND university_id = ?', toInt(req.query.term_id), req.uid) : termAt(req.uid, zonedNow(q.get('SELECT timezone FROM universities WHERE id = ?', req.uid).timezone).date);
  if (!term) return res.json({ term: null, departments: [] });
  const depts = ['admin', 'hr'].includes(req.user.role) ? null : managedDepartmentIds(req.user);
  const rows = q.all(
    `SELECT d.id, d.name, d.faculty_id, f.name AS faculty_name FROM departments d JOIN faculties f ON f.id = d.faculty_id
      WHERE d.university_id = ? ${depts ? `AND d.id IN (${placeholders(depts)})` : ''} ORDER BY f.name, d.name`,
    req.uid,
    ...(depts || []),
  );
  const canSet = (d) => req.user.role === 'admin' || (req.user.role === 'dean' && facultyIdsForDean(req.user).includes(d.faculty_id));
  res.json({ term, departments: rows.map((d) => ({ ...d, ...budgetFor(d.id, term.id), can_set: canSet(d) })) });
});

router.put('/budgets', requireRole('admin', 'dean'), (req, res) => {
  requireFields(req.body, ['department_id', 'term_id', 'amount']);
  const dept = q.get('SELECT * FROM departments WHERE id = ? AND university_id = ?', toInt(req.body.department_id), req.uid);
  if (!dept) throw notFound('Department');
  if (req.user.role === 'dean' && !facultyIdsForDean(req.user).includes(dept.faculty_id)) throw forbidden('Only the Dean of this faculty can set its budgets');
  const term = q.get('SELECT * FROM academic_terms WHERE id = ? AND university_id = ?', toInt(req.body.term_id), req.uid);
  if (!term) throw badRequest('Unknown term');
  const amount = Number(req.body.amount);
  if (!(amount >= 0) || amount > 1e12) throw badRequest('Enter a valid budget amount');
  q.run(
    `INSERT INTO pay_budgets (university_id, department_id, term_id, amount, set_by, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (department_id, term_id) DO UPDATE SET amount = excluded.amount, set_by = excluded.set_by, updated_at = excluded.updated_at`,
    req.uid,
    dept.id,
    term.id,
    amount,
    req.user.id,
  );
  res.json({ ...dept, ...budgetFor(dept.id, term.id) });
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
  if (req.query.view === 'completed') rows = rows.filter((c) => ['hr_verified', 'paid'].includes(c.status));
  res.json(rows);
});

router.get('/summary', (req, res) => res.json(claimSummary(req.user)));

/** What a new claim for this period would contain. */
router.get('/preview', (req, res) => {
  const { from, to } = req.query;
  if (!isDate(from) || !isDate(to) || from > to) throw badRequest('Choose a valid period');
  const lectures = claimableLectures(req.user.id, from, to);
  const rates = teachingRates(req.user.faculty_id);
  res.json({
    lectures,
    hours: round2(lectures.reduce((t, l) => t + l.hours, 0)),
    rate: teachingRate(req.user.faculty_id) || null,
    rates,
    estimate: round2(lectures.reduce((t, l) => t + l.hours * (rateForLevels(rates, l.levels)?.amount || 0), 0)),
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
  out.teaching_rates = teachingRates(claim.faculty_id);
  out.vote = claim.vote_id ? voteRow(q.get('SELECT * FROM pay_votes WHERE id = ?', claim.vote_id)) : null;
  out.cleared = ['hr_verified', 'paid'].includes(claim.status);
  if (claim.status !== 'draft') {
    out.verify_code = formatCode(ensureVerifyCode(claim.id));
    out.verify_url = `${publicBase(req)}/verify/${out.verify_code}`;
    out.sign_offs = signOffs(claim);
  }
  const term = termAt(req.uid, claim.period_start);
  if (term && claim.department_id && ['admin', 'dean', 'hod', 'hr'].includes(req.user.role)) {
    const b = budgetFor(claim.department_id, term.id);
    const pending = ['draft', 'rejected'].includes(claim.status) ? claim.total : 0;
    out.budget = { ...b, term_name: term.name, would_exceed: b.amount != null && b.committed + pending > b.amount };
  }
  const teaching = lines.filter((l) => l.kind === 'teaching');
  out.verification = { lectures: teaching.length, confirmed: teaching.filter((l) => l.self_checkins > 0).length };
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

/** Payslip (once paid) or claim form PDF with every line and the approval trail. */
router.get('/:id/payslip', async (req, res) => {
  const claim = loadClaim(req);
  if (claim.status === 'draft') throw badRequest('Submit the claim first');
  const lines = q.all('SELECT * FROM pay_claim_lines WHERE claim_id = ? ORDER BY work_date, start_time, id', claim.id);
  const events = q.all('SELECT e.*, u.name AS actor_name FROM pay_claim_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.claim_id = ? ORDER BY e.id', claim.id);
  const university = q.get('SELECT * FROM universities WHERE id = ?', req.uid);
  const buf = await payslipPdf(university, { ...claim, status_label: STATUS_LABELS[claim.status] }, lines, events);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${claim.status === 'paid' ? 'payslip' : 'claim'}-${claim.id}-${slugify(claim.lecturer_name)}.pdf"`);
  res.send(buf);
});

/**
 * Funds requisition form for the claim, signed off along the chain: the lecturer (claimant) submits,
 * the HoD verifies, the Dean as Vote Controller signs off against a vote, and HR gives final approval
 * and prints it. Before HR's approval it is marked "not yet cleared".
 */
router.get('/:id/requisition', async (req, res) => {
  const claim = loadClaim(req);
  if (claim.status === 'draft') throw badRequest('Submit the claim first');
  const lines = q.all('SELECT * FROM pay_claim_lines WHERE claim_id = ? ORDER BY kind, course_unit_code, work_date, start_time, id', claim.id);
  const signers = signOffs(claim);
  const code = formatCode(ensureVerifyCode(claim.id));
  const url = `${publicBase(req)}/verify/${code}`;
  const statusLabel = STATUS_LABELS[claim.status];
  const vote = claim.vote_id ? q.get('SELECT * FROM pay_votes WHERE id = ?', claim.vote_id) : null;
  const lecturer = q.get('SELECT name, title, phone, role, employment_type FROM users WHERE id = ?', claim.lecturer_id);
  const university = q.get('SELECT * FROM universities WHERE id = ?', req.uid);
  const amount = `${claim.currency} ${Number(claim.total).toLocaleString('en', { maximumFractionDigits: 2 })}`;
  // Phones show this text when the code is scanned, even offline; the link opens the live record.
  const qrText = [
    `${university.short_name || university.name} funds requisition #${claim.id}`,
    `Lecturer: ${[lecturer?.title, claim.lecturer_name].filter(Boolean).join(' ')}`,
    `Amount claimed: ${amount}`,
    `Approval status: ${statusLabel}`,
    `Verify: ${url}`,
  ].join('\n');
  const buf = await requisitionPdf(university, { ...claim, status_label: statusLabel }, lines, {
    lecturer,
    vote,
    voteBalance: vote ? round2(vote.amount - voteCharged(vote.id, claim.id)) : null,
    signers,
    cleared: ['hr_verified', 'paid'].includes(claim.status),
    verify: { code, url, qrText },
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="requisition-${claim.id}-${slugify(claim.lecturer_name)}.pdf"`);
  res.send(buf);
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
    ensureVerifyCode(claim.id);
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
  // The Dean signs off as Vote Controller and charges the claim to one of the faculty's votes.
  const vote = stage.actor === 'dean' ? q.get('SELECT * FROM pay_votes WHERE id = ? AND faculty_id = ? AND active = 1', toInt(req.body.vote_id), claim.faculty_id) : null;
  if (stage.actor === 'dean' && !vote) throw badRequest('Choose the vote this claim is charged to, or create one for the faculty');
  if (vote) q.run('UPDATE pay_claims SET vote_id = ? WHERE id = ?', vote.id, claim.id);
  q.run(
    `UPDATE pay_claims SET status = ?, updated_at = datetime('now')${stage.next === 'paid' ? ", payment_reference = ?, paid_at = datetime('now')" : ''} WHERE id = ?`,
    ...(stage.next === 'paid' ? [stage.next, reference, claim.id] : [stage.next, claim.id]),
  );
  event(claim.id, req.user.id, stage.next === 'paid' ? 'paid' : stage.next === 'hr_verified' ? 'verified' : 'approved', STAGE_NAMES[claim.status], [vote && `Vote ${vote.code}`, note, reference && `Payment ref. ${reference}`].filter(Boolean).join(' · '));
  const fresh = q.get(`${claimSelect} WHERE pc.id = ?`, claim.id);
  const budgetTerm = termAt(req.uid, claim.period_start);
  const budget = budgetTerm && claim.department_id ? budgetFor(claim.department_id, budgetTerm.id) : null;
  if (stage.next === 'paid') {
    notify(claim.lecturer_id, { title: 'Claim paid', body: `${claim.title}: ${claim.currency} ${claim.total.toLocaleString('en')} (ref. ${reference})`, type: 'claim', link: `/claims/${claim.id}` });
  } else {
    notify(nextActors(fresh, stage.next), { title: stage.next === 'hr_verified' ? 'Cleared claim to pay' : 'Part-time claim to approve', body: `${claim.lecturer_name}: ${claim.title}`, type: 'claim', link: `/claims/${claim.id}` });
    notify(claim.lecturer_id, { title: `Claim ${stage.next === 'hr_verified' ? 'given final approval by HR' : stage.actor === 'dean' ? 'signed off by the Dean' : 'verified by your HoD'}`, body: claim.title, type: 'claim', link: `/claims/${claim.id}` });
  }
  const voteLeft = vote ? round2(vote.amount - voteCharged(vote.id)) : null;
  res.json({
    ...describe(fresh, req.user),
    budget_warning: budget?.amount != null && budget.remaining < 0 ? `The department is ${fresh.currency} ${Math.abs(budget.remaining).toLocaleString('en')} over its part-time budget for ${budgetTerm.name}` : null,
    vote_warning: voteLeft !== null && voteLeft < 0 ? `Vote ${vote.code} is now ${fresh.currency} ${Math.abs(voteLeft).toLocaleString('en')} overdrawn` : null,
  });
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
