// Exam timetable, invigilators, eligibility (attendance + coursework) and coursework marks.
import { Router } from 'express';
import multer from 'multer';
import { MANAGER_ROLES, requireRole } from '../auth.js';
import { insert, q, tx } from '../db.js';
import { canManageDepartment, courseUnitScope, currentTerm, resolveTerm, visibleDepartmentIds } from '../scope.js';
import { examsPdf, examsXlsx } from '../services/exporter.js';
import {
  courseworkRoster, courseworkTemplate, eligibility, examSelect, examsForUser, generateExams, readMarksFile, saveMarks, seatPlan, withDetails,
} from '../services/exams.js';
import { notify } from '../services/notify.js';
import { clashesOn, examClassIds } from '../services/occurrences.js';
import { addDays, badRequest, forbidden, HttpError, isTime, notFound, requireFields, slugify, toInt, zonedNow } from '../util.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const unitOf = (uid, id) => q.get('SELECT * FROM course_units WHERE id = ? AND university_id = ?', id, uid);
const teaches = (userId, termId, unitId) => Boolean(q.get('SELECT 1 FROM allocations WHERE lecturer_id = ? AND term_id = ? AND course_unit_id = ?', userId, termId, unitId));

/** Units visible to managers: owned by, or taught to, their departments. */
function visibleUnitIds(user) {
  const depts = visibleDepartmentIds(user);
  if (depts === null) return null;
  const scope = courseUnitScope('cu', depts);
  return q.all(`SELECT cu.id FROM course_units cu WHERE cu.university_id = ? AND ${scope.sql}`, user.university_id, ...scope.params).map((r) => r.id);
}

function canSeeUnit(user, unit, termId) {
  if (user.role === 'admin') return true;
  if (teaches(user.id, termId, unit.id)) return true;
  if (MANAGER_ROLES.includes(user.role)) return visibleUnitIds(user).includes(unit.id);
  return false;
}

/** The lecturer(s) teaching a unit and managers of its owning department enter coursework. */
function canEditMarks(user, unit, termId) {
  if (user.role === 'admin') return true;
  if (teaches(user.id, termId, unit.id)) return true;
  return MANAGER_ROLES.includes(user.role) && canManageDepartment(user, unit.department_id);
}

function loadExam(req) {
  const e = q.get(`${examSelect} WHERE e.id = ? AND e.university_id = ?`, toInt(req.params.id), req.uid);
  if (!e) throw notFound('Exam');
  return e;
}

router.get('/', (req, res) => {
  const term = resolveTerm(req.uid, toInt(req.query.term_id));
  if (!term) return res.json({ term: null, exams: [] });
  if (req.user.role === 'student' || req.user.role === 'hr') throw forbidden('See "My exams"');
  let rows = q.all(`${examSelect} WHERE e.university_id = ? AND e.term_id = ? ORDER BY e.exam_date, e.start_time, cu.code`, req.uid, term.id);
  if (req.user.role !== 'admin') {
    const visible = MANAGER_ROLES.includes(req.user.role) ? new Set(visibleUnitIds(req.user)) : new Set();
    rows = rows.filter(
      (e) => visible.has(e.course_unit_id) || teaches(req.user.id, term.id, e.course_unit_id) || q.get('SELECT 1 FROM exam_invigilators WHERE exam_id = ? AND user_id = ?', e.id, req.user.id),
    );
  }
  res.json({ term, exams: withDetails(rows), can_manage: req.user.role === 'admin' });
});

/** A student's exams with their eligibility, or a staff member's invigilation duties. */
router.get('/mine', (req, res) => {
  const term = currentTerm(req.uid);
  const today = zonedNow(q.get('SELECT timezone FROM universities WHERE id = ?', req.uid).timezone).date;
  const from = term?.start_date || addDays(today, -30);
  const to = addDays(term?.end_date || today, 60);
  const exams = examsForUser(req.user, from, to);
  if (req.user.role === 'student') {
    for (const e of exams) {
      const mine = eligibility(e).students.find((s) => s.id === req.user.id);
      e.eligibility = mine ? { eligible: mine.eligible, reasons: mine.reasons, attendance: mine.attendance, coursework: mine.coursework, override: mine.override } : null;
    }
  }
  res.json({ exams, thresholds: q.get('SELECT exam_min_attendance, coursework_min_percent FROM universities WHERE id = ?', req.uid) });
});

router.post('/generate', requireRole('admin'), (req, res) => {
  const term = resolveTerm(req.uid, toInt(req.body?.term_id));
  if (!term) throw badRequest('Create an academic term first');
  const result = generateExams(req.uid, term.id, {
    startDate: req.body.start_date,
    endDate: req.body.end_date,
    slots: req.body.slots,
    clear: Boolean(req.body.clear),
    perInvigilator: toInt(req.body.students_per_invigilator) || 50,
    userId: req.user.id,
  });
  res.json(result);
});

function validateSlot(uid, exam, { date, start, end, roomIds, invigilatorIds = [] }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !isTime(start) || !isTime(end) || start >= end) throw badRequest('Give a date, start and end time');
  if (!roomIds.length) throw badRequest('Choose at least one room');
  const classIds = examClassIds(exam.term_id, exam.course_unit_id);
  const clashes = clashesOn(uid, date, start, end, { roomIds, classIds, personIds: invigilatorIds, excludeExamId: exam.id ?? null });
  if (clashes.length) throw new HttpError(409, clashes[0].message, { conflicts: clashes });
}

function saveRooms(examId, roomIds, size) {
  const rooms = roomIds.map((id) => q.get('SELECT * FROM rooms WHERE id = ?', id)).filter(Boolean).sort((a, b) => b.capacity - a.capacity);
  q.run('DELETE FROM exam_rooms WHERE exam_id = ?', examId);
  for (const r of seatPlan(rooms, size)) insert('exam_rooms', { exam_id: examId, room_id: r.id, seats: r.seats });
}

const sizeOf = (termId, unitId) => {
  const ids = examClassIds(termId, unitId);
  return ids.length ? q.get(`SELECT COUNT(*) AS n FROM users WHERE role = 'student' AND active = 1 AND class_id IN (${ids.map(() => '?').join(',')})`, ...ids).n : 0;
};

router.post('/', requireRole('admin'), (req, res) => {
  requireFields(req.body, ['term_id', 'course_unit_id', 'exam_date', 'start_time', 'end_time']);
  const term = resolveTerm(req.uid, toInt(req.body.term_id));
  const unit = unitOf(req.uid, toInt(req.body.course_unit_id));
  if (!unit) throw badRequest('Unknown course unit');
  const roomIds = [].concat(req.body.room_ids || []).map(Number);
  const draft = { term_id: term.id, course_unit_id: unit.id };
  validateSlot(req.uid, draft, { date: req.body.exam_date, start: req.body.start_time, end: req.body.end_time, roomIds });
  const id = tx(() => {
    const examId = insert('exams', { university_id: req.uid, ...draft, exam_date: req.body.exam_date, start_time: req.body.start_time, end_time: req.body.end_time, notes: req.body.notes || null, created_by: req.user.id });
    saveRooms(examId, roomIds, sizeOf(term.id, unit.id));
    return examId;
  });
  res.status(201).json(withDetails([q.get(`${examSelect} WHERE e.id = ?`, id)])[0]);
});

router.put('/:id', requireRole('admin'), (req, res) => {
  const e = loadExam(req);
  const date = req.body.exam_date ?? e.exam_date;
  const start = req.body.start_time ?? e.start_time;
  const end = req.body.end_time ?? e.end_time;
  const roomIds = req.body.room_ids ? [].concat(req.body.room_ids).map(Number) : q.all('SELECT room_id FROM exam_rooms WHERE exam_id = ?', e.id).map((r) => r.room_id);
  const invigilatorIds = q.all('SELECT user_id FROM exam_invigilators WHERE exam_id = ?', e.id).map((r) => r.user_id);
  validateSlot(req.uid, e, { date, start, end, roomIds, invigilatorIds });
  tx(() => {
    q.run('UPDATE exams SET exam_date = ?, start_time = ?, end_time = ?, notes = ? WHERE id = ?', date, start, end, req.body.notes ?? e.notes, e.id);
    if (req.body.room_ids) {
      saveRooms(e.id, roomIds, sizeOf(e.term_id, e.course_unit_id));
      q.run(`UPDATE exam_invigilators SET room_id = NULL WHERE exam_id = ? AND room_id NOT IN (${roomIds.map(() => '?').join(',')})`, e.id, ...roomIds);
    }
  });
  const fresh = withDetails([q.get(`${examSelect} WHERE e.id = ?`, e.id)])[0];
  if (date !== e.exam_date || start !== e.start_time) {
    notify(fresh.invigilators.map((i) => i.id), { title: `Exam moved: ${e.course_code}`, body: `Now ${date} ${start}-${end}`, type: 'exam', link: '/exams' });
  }
  res.json(fresh);
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const e = loadExam(req);
  q.run('DELETE FROM exams WHERE id = ?', e.id);
  res.json({ ok: true });
});

router.post('/:id/invigilators', requireRole('admin'), (req, res) => {
  const e = loadExam(req);
  const person = q.get("SELECT * FROM users WHERE id = ? AND university_id = ? AND active = 1 AND role IN ('lecturer','hod','dean','admin')", toInt(req.body?.user_id), req.uid);
  if (!person) throw badRequest('Choose a staff member');
  const roomId = toInt(req.body.room_id);
  if (roomId && !q.get('SELECT 1 FROM exam_rooms WHERE exam_id = ? AND room_id = ?', e.id, roomId)) throw badRequest('That room is not used for this exam');
  const clashes = clashesOn(req.uid, e.exam_date, e.start_time, e.end_time, { personIds: [person.id], excludeExamId: e.id });
  if (clashes.length) throw new HttpError(409, clashes[0].message);
  q.run('INSERT OR REPLACE INTO exam_invigilators (exam_id, user_id, room_id) VALUES (?, ?, ?)', e.id, person.id, roomId || null);
  notify(person.id, { title: 'Invigilation duty', body: `${e.course_code} exam, ${e.exam_date} ${e.start_time}-${e.end_time}`, type: 'exam', link: '/exams' });
  res.status(201).json(withDetails([q.get(`${examSelect} WHERE e.id = ?`, e.id)])[0]);
});

router.delete('/:id/invigilators/:userId', requireRole('admin'), (req, res) => {
  const e = loadExam(req);
  q.run('DELETE FROM exam_invigilators WHERE exam_id = ? AND user_id = ?', e.id, toInt(req.params.userId));
  res.json(withDetails([q.get(`${examSelect} WHERE e.id = ?`, e.id)])[0]);
});

router.get('/export', async (req, res) => {
  if (req.user.role === 'student' || req.user.role === 'hr') throw forbidden();
  const term = resolveTerm(req.uid, toInt(req.query.term_id));
  if (!term) throw badRequest('No academic term');
  const rows = withDetails(q.all(`${examSelect} WHERE e.university_id = ? AND e.term_id = ? ORDER BY e.exam_date, e.start_time, cu.code`, req.uid, term.id));
  const university = q.get('SELECT * FROM universities WHERE id = ?', req.uid);
  const title = `Examination timetable - ${term.name}`;
  const pdf = req.query.format === 'pdf';
  const buf = pdf ? await examsPdf(university, title, rows) : await examsXlsx(university, title, rows);
  res.setHeader('Content-Type', pdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${slugify(title)}.${pdf ? 'pdf' : 'xlsx'}"`);
  res.send(buf);
});

// ------------------------------------------------------------- Coursework

router.get('/coursework/units', (req, res) => {
  const term = resolveTerm(req.uid, toInt(req.query.term_id));
  if (!term) return res.json([]);
  const units = q.all(
    `SELECT DISTINCT cu.id, cu.code, cu.name, cu.department_id FROM allocations a JOIN course_units cu ON cu.id = a.course_unit_id
      WHERE a.term_id = ? AND a.university_id = ? ORDER BY cu.code`,
    term.id,
    req.uid,
  );
  res.json(
    units
      .filter((u) => canEditMarks(req.user, u, term.id))
      .map((u) => {
        const roster = courseworkRoster(term.id, u.id);
        return { ...u, students: roster.length, marked: roster.filter((s) => s.mark != null).length };
      }),
  );
});

function marksContext(req, source) {
  const term = resolveTerm(req.uid, toInt(source.term_id));
  if (!term) throw badRequest('No academic term');
  const unit = unitOf(req.uid, toInt(source.course_unit_id));
  if (!unit) throw notFound('Course unit');
  if (!canEditMarks(req.user, unit, term.id)) throw forbidden('Only the lecturer of this course unit (or its HoD) can enter coursework marks');
  return { term, unit };
}

router.get('/coursework', (req, res) => {
  const { term, unit } = marksContext(req, req.query);
  res.json({ term, unit, students: courseworkRoster(term.id, unit.id) });
});

router.get('/coursework/template', async (req, res) => {
  const { term, unit } = marksContext(req, req.query);
  const university = q.get('SELECT * FROM universities WHERE id = ?', req.uid);
  const buf = await courseworkTemplate(university, unit, term, courseworkRoster(term.id, unit.id));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="coursework-${slugify(unit.code)}-${slugify(term.name)}.xlsx"`);
  res.send(buf);
});

router.post('/coursework/upload', upload.single('file'), async (req, res) => {
  const { term, unit } = marksContext(req, req.body || {});
  if (!req.file) throw badRequest('Attach the filled-in Excel template');
  const rows = await readMarksFile(req.file.buffer);
  const result = saveMarks({ universityId: req.uid, termId: term.id, courseUnitId: unit.id, outOf: req.body.out_of, rows, userId: req.user.id });
  res.json({ ...result, students: courseworkRoster(term.id, unit.id) });
});

// ------------------------------------------------------------- Eligibility

router.get('/:id/eligibility', (req, res) => {
  const e = loadExam(req);
  const unit = unitOf(req.uid, e.course_unit_id);
  if (!canSeeUnit(req.user, unit, e.term_id)) throw forbidden();
  const result = eligibility(e);
  const canOverride = (s) => ['hod', 'dean', 'admin'].includes(req.user.role) && (canManageDepartment(req.user, s.department_id) || canManageDepartment(req.user, unit.department_id));
  res.json({ exam: withDetails([e])[0], ...result, students: result.students.map((s) => ({ ...s, can_override: canOverride(s) })) });
});

router.post('/:id/overrides', (req, res) => {
  const e = loadExam(req);
  if (!['hod', 'dean', 'admin'].includes(req.user.role)) throw forbidden('Only the HoD or Dean can override exam eligibility');
  const student = q.get(
    `SELECT u.*, p.department_id AS program_department_id FROM users u JOIN classes c ON c.id = u.class_id JOIN programs p ON p.id = c.program_id
      WHERE u.id = ? AND u.university_id = ?`,
    toInt(req.body?.student_id),
    req.uid,
  );
  if (!student || !examClassIds(e.term_id, e.course_unit_id).includes(student.class_id)) throw badRequest('That student does not sit this exam');
  if (!canManageDepartment(req.user, student.program_department_id) && !canManageDepartment(req.user, e.department_id)) throw forbidden('That student is outside the unit you manage');
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 5) throw badRequest('Give the reason for the override (e.g. medical leave, with evidence)');
  q.run(
    `INSERT INTO exam_overrides (university_id, exam_id, student_id, reason, granted_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (exam_id, student_id) DO UPDATE SET reason = excluded.reason, granted_by = excluded.granted_by, created_at = datetime('now')`,
    req.uid,
    e.id,
    student.id,
    reason,
    req.user.id,
  );
  notify(student.id, { title: `Cleared to sit ${e.course_code}`, body: `Your eligibility for the ${e.course_code} exam was approved by ${req.user.name}.`, type: 'exam', link: '/exams' });
  res.status(201).json({ ok: true });
});

router.delete('/:id/overrides/:studentId', (req, res) => {
  const e = loadExam(req);
  if (!['hod', 'dean', 'admin'].includes(req.user.role)) throw forbidden();
  q.run('DELETE FROM exam_overrides WHERE exam_id = ? AND student_id = ?', e.id, toInt(req.params.studentId));
  res.json({ ok: true });
});

export default router;
