// Attendance: the class representative records who is present at a lecture,
// the lecturer approves (or rejects) the register, students see their history.
import { Router } from 'express';
import { MANAGER_ROLES, TEACHING_ROLES } from '../auth.js';
import { q, tx, update, insert } from '../db.js';
import { canManageDepartment, currentTerm, managedDepartmentIds, placeholders } from '../scope.js';
import { notify } from '../services/notify.js';
import { localToUtc, occurrenceOn, occurrences, teacherOf } from '../services/occurrences.js';
import { allocationContext, listSessions } from '../services/timetable.js';
import { addDays, badRequest, DAY_NAMES, dowOf, forbidden, HttpError, notFound, requireFields, toInt, toMinutes, zonedNow } from '../util.js';

const router = Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS_BACK = 30;

function uniNow(uid) {
  const uni = q.get('SELECT timezone FROM universities WHERE id = ?', uid);
  return zonedNow(uni?.timezone || 'UTC');
}

function loadSession(uid, sessionId) {
  const s = q.get('SELECT * FROM timetable_sessions WHERE id = ? AND university_id = ?', sessionId, uid);
  if (!s) throw notFound('Lecture session');
  const allocation = allocationContext(s.allocation_id, uid);
  const detail = listSessions(uid, s.term_id, { allocationId: s.allocation_id }).find((x) => x.id === s.id);
  return { session: s, allocation, detail };
}

/** Who may see / act on a class's register for a lecture on a date (a cover lecturer counts as the lecturer). */
function access(user, allocation, classId, sessionId, date) {
  const cls = allocation.classes.find((c) => c.id === Number(classId));
  if (!cls) throw badRequest('That class does not attend this lecture');
  const isRep = cls.class_rep_id === user.id;
  const isLecturer = teacherOf(sessionId, date, allocation.lecturer_id) === user.id;
  const isManager = MANAGER_ROLES.includes(user.role) && canManageDepartment(user, cls.department_id);
  return { cls, isRep, isLecturer, isManager, canReview: isLecturer || isManager, canView: isRep || isLecturer || isManager };
}

const registerSelect = `
  SELECT r.*, c.name AS class_name, s.day_of_week, s.start_time, s.end_time, s.allocation_id, s.term_id,
         cu.code AS course_code, cu.name AS course_name, a.lecturer_id, l.name AS lecturer_name,
         sb.name AS submitted_by_name, rv.name AS reviewed_by_name, rm.name AS room_name,
         (SELECT COUNT(*) FROM attendance_records x WHERE x.register_id = r.id) AS total,
         (SELECT COUNT(*) FROM attendance_records x WHERE x.register_id = r.id AND x.present = 1) AS present_count
    FROM attendance_registers r
    JOIN classes c ON c.id = r.class_id
    JOIN timetable_sessions s ON s.id = r.session_id
    JOIN allocations a ON a.id = s.allocation_id
    JOIN course_units cu ON cu.id = a.course_unit_id
    JOIN users l ON l.id = a.lecturer_id
    JOIN rooms rm ON rm.id = s.room_id
    LEFT JOIN users sb ON sb.id = r.submitted_by
    LEFT JOIN users rv ON rv.id = r.reviewed_by`;

/** Lectures on a date that the user can take (class rep) or review (lecturer) attendance for. */
router.get('/sessions', (req, res) => {
  const now = uniNow(req.uid);
  const date = DATE_RE.test(req.query.date || '') ? req.query.date : now.date;
  const term = currentTerm(req.uid);
  if (!term) return res.json({ date, items: [] });
  const dow = dowOf(date);
  const items = [];
  const push = (occ, cls, role) => {
    const s = { ...occ, id: occ.session_id };
    const reg = q.get(
      'SELECT id, status, review_note FROM attendance_registers WHERE session_id = ? AND class_id = ? AND lecture_date = ?',
      s.id,
      cls.id,
      date,
    );
    const started = date < now.date || (date === now.date && now.minutes >= toMinutes(s.start_time) - 15);
    const checkin = q.get('SELECT id, closed_at FROM checkin_sessions WHERE session_id = ? AND lecture_date = ?', s.id, date);
    items.push({
      session: s,
      checkin: checkin ? { id: checkin.id, open: !checkin.closed_at } : null,
      class_id: cls.id,
      class_name: cls.name,
      role,
      register: reg || null,
      can_submit: role === 'rep' && started && reg?.status !== 'approved',
      not_started: !started,
    });
  };
  for (const rc of req.user.rep_classes || []) {
    for (const o of occurrences(req.uid, { from: date, to: date, classId: rc.id })) push(o, rc, 'rep');
  }
  if (TEACHING_ROLES.includes(req.user.role)) {
    for (const o of occurrences(req.uid, { from: date, to: date, lecturerId: req.user.id })) {
      for (const c of o.classes) push(o, c, 'lecturer');
    }
  }
  items.sort((a, b) => a.session.start_time.localeCompare(b.session.start_time));
  res.json({ date, day_name: DAY_NAMES[dow], today: now.date, items });
});

/** The register sheet: every student in the class with their present flag. */
router.get('/sessions/:sessionId/sheet', (req, res) => {
  const date = req.query.date;
  if (!DATE_RE.test(date || '')) throw badRequest('date (YYYY-MM-DD) is required');
  const { allocation, detail } = loadSession(req.uid, toInt(req.params.sessionId));
  const a = access(req.user, allocation, toInt(req.query.class_id), detail.id, date);
  if (!a.canView) throw forbidden();
  const register = q.get(
    `${registerSelect} WHERE r.session_id = ? AND r.class_id = ? AND r.lecture_date = ?`,
    detail.id,
    a.cls.id,
    date,
  );
  const students = q.all(
    `SELECT u.id, u.name, u.identifier, COALESCE(ar.present, 0) AS present, ar.method
       FROM users u LEFT JOIN attendance_records ar ON ar.student_id = u.id AND ar.register_id = ?
      WHERE u.class_id = ? AND u.role = 'student' AND u.active = 1 ORDER BY u.name`,
    register?.id ?? -1,
    a.cls.id,
  );
  res.json({
    session: detail,
    class: { id: a.cls.id, name: a.cls.name },
    date,
    register: register || null,
    students,
    can_edit: a.isRep && register?.status !== 'approved',
    can_review: a.canReview && register?.status === 'submitted',
  });
});

/** Class representative submits (or re-submits) the list of students present. */
router.post('/registers', (req, res) => {
  requireFields(req.body, ['session_id', 'class_id', 'date']);
  const { date } = req.body;
  if (!DATE_RE.test(date)) throw badRequest('date must be YYYY-MM-DD');
  const { session, allocation, detail } = loadSession(req.uid, toInt(req.body.session_id));
  const a = access(req.user, allocation, toInt(req.body.class_id), session.id, date);
  if (!a.isRep) throw forbidden('Only the class representative can submit attendance for this class');

  const now = uniNow(req.uid);
  const occ = occurrenceOn(req.uid, session.id, date);
  if (!occ) throw badRequest(`This lecture does not take place on ${date} (it may have been cancelled or moved)`);
  if (date > now.date) throw badRequest('You cannot record attendance for a future lecture');
  if (date === now.date && now.minutes < toMinutes(occ.start_time) - 15) {
    throw badRequest(`Attendance opens 15 minutes before the lecture starts (${occ.start_time})`);
  }
  if (date < addDays(now.date, -MAX_DAYS_BACK)) throw badRequest(`Attendance can only be recorded within ${MAX_DAYS_BACK} days`);
  const term = q.get('SELECT * FROM academic_terms WHERE id = ?', session.term_id);
  if ((term.start_date && date < term.start_date) || (term.end_date && date > term.end_date)) {
    throw badRequest('That date is outside the academic term');
  }

  const students = q.all("SELECT id FROM users WHERE class_id = ? AND role = 'student' AND active = 1", a.cls.id).map((r) => r.id);
  const present = new Set([].concat(req.body.present_student_ids || []).map(Number));
  const strangers = [...present].filter((id) => !students.includes(id));
  if (strangers.length) throw badRequest('Some selected students are not in this class');

  const existing = q.get(
    'SELECT * FROM attendance_registers WHERE session_id = ? AND class_id = ? AND lecture_date = ?',
    session.id,
    a.cls.id,
    date,
  );
  if (existing?.status === 'approved') throw new HttpError(409, 'This register has already been approved by the lecturer');

  const registerId = tx(() => {
    let id = existing?.id;
    const fields = {
      topic: req.body.topic || null,
      note: req.body.note || null,
      status: 'submitted',
      submitted_by: req.user.id,
      submitted_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      reviewed_by: null,
      reviewed_at: null,
      review_note: null,
    };
    if (id) update('attendance_registers', id, fields);
    else id = insert('attendance_registers', { university_id: req.uid, session_id: session.id, class_id: a.cls.id, lecture_date: date, ...fields });
    q.run('DELETE FROM attendance_records WHERE register_id = ?', id);
    for (const sid of students) {
      q.run('INSERT INTO attendance_records (register_id, student_id, present, method) VALUES (?, ?, ?, ?)', id, sid, present.has(sid) ? 1 : 0, present.has(sid) ? 'rep' : null);
    }
    return id;
  });

  notify(teacherOf(session.id, date, allocation.lecturer_id), {
    title: `Attendance to approve: ${detail.course_code}`,
    body: `${req.user.name} submitted ${present.size}/${students.length} present for ${a.cls.name} on ${date}.`,
    type: 'attendance',
    link: `/attendance/registers/${registerId}`,
  });
  res.status(existing ? 200 : 201).json(q.get(`${registerSelect} WHERE r.id = ?`, registerId));
});

/** Registers visible to the user: lecturers see their lectures, managers their unit, reps their class. */
router.get('/registers', (req, res) => {
  const where = ['r.university_id = ?'];
  const params = [req.uid];
  const user = req.user;
  if (user.role === 'admin') {
    // everything
  } else if (MANAGER_ROLES.includes(user.role)) {
    const depts = managedDepartmentIds(user);
    where.push(`(a.lecturer_id = ? OR c.program_id IN (SELECT id FROM programs WHERE department_id IN (${placeholders(depts)})))`);
    params.push(user.id, ...depts);
  } else if (user.role === 'lecturer') {
    where.push(`(a.lecturer_id = ? OR EXISTS (SELECT 1 FROM leave_covers lc JOIN leave_requests lr ON lr.id = lc.leave_id
                 WHERE lc.session_id = r.session_id AND lc.lecture_date = r.lecture_date AND lc.substitute_id = ? AND lr.status = 'approved'))`);
    params.push(user.id, user.id);
  } else if (user.is_class_rep) {
    where.push(`r.class_id IN (${placeholders(user.rep_classes.map((c) => c.id))})`);
    params.push(...user.rep_classes.map((c) => c.id));
  } else {
    throw forbidden('Use "My attendance" to see your attendance history');
  }
  if (req.query.status) {
    where.push('r.status = ?');
    params.push(req.query.status);
  }
  if (req.query.class_id) {
    where.push('r.class_id = ?');
    params.push(toInt(req.query.class_id));
  }
  if (req.query.term_id) {
    where.push('s.term_id = ?');
    params.push(toInt(req.query.term_id));
  }
  const limit = Math.min(toInt(req.query.limit) || 200, 1000);
  res.json(q.all(`${registerSelect} WHERE ${where.join(' AND ')} ORDER BY r.lecture_date DESC, s.start_time DESC LIMIT ${limit}`, ...params));
});

function loadRegister(req) {
  const reg = q.get(`${registerSelect} WHERE r.id = ? AND r.university_id = ?`, req.params.id, req.uid);
  if (!reg) throw notFound('Register');
  const allocation = allocationContext(reg.allocation_id, req.uid);
  return { reg, allocation, access: access(req.user, allocation, reg.class_id, reg.session_id, reg.lecture_date) };
}

router.get('/registers/:id', (req, res) => {
  const { reg, access: a } = loadRegister(req);
  if (!a.canView) throw forbidden();
  const students = q.all(
    `SELECT u.id, u.name, u.identifier, ar.present, ar.method FROM attendance_records ar JOIN users u ON u.id = ar.student_id
      WHERE ar.register_id = ? ORDER BY ar.present DESC, u.name`,
    reg.id,
  );
  res.json({ ...reg, students, can_review: a.canReview && reg.status === 'submitted', can_edit: a.isRep && reg.status !== 'approved' });
});

router.post('/registers/:id/review', (req, res) => {
  const { reg, access: a } = loadRegister(req);
  if (!a.canReview) throw forbidden('Only the lecturer (or a manager of this unit) can approve this register');
  const action = req.body?.action;
  if (!['approve', 'reject'].includes(action)) throw badRequest('action must be "approve" or "reject"');
  if (reg.status !== 'submitted') throw new HttpError(409, `This register is already ${reg.status}`);
  if (action === 'reject' && !req.body.note) throw badRequest('Give a reason when rejecting a register');
  update('attendance_registers', reg.id, {
    status: action === 'approve' ? 'approved' : 'rejected',
    reviewed_by: req.user.id,
    reviewed_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    review_note: req.body.note || null,
  });
  notify(reg.submitted_by, {
    title: `Attendance ${action === 'approve' ? 'approved' : 'rejected'}: ${reg.course_code}`,
    body:
      action === 'approve'
        ? `${req.user.name} approved the register for ${reg.class_name} on ${reg.lecture_date}.`
        : `${req.user.name} rejected the register for ${reg.class_name} on ${reg.lecture_date}: ${req.body.note}`,
    type: 'attendance',
    link: `/attendance/registers/${reg.id}`,
  });
  res.json(q.get(`${registerSelect} WHERE r.id = ?`, reg.id));
});

function history(studentId, termId) {
  const params = [studentId];
  let termFilter = '';
  if (termId) {
    termFilter = 'AND s.term_id = ?';
    params.push(termId);
  }
  const records = q.all(
    `SELECT r.id AS register_id, r.lecture_date, r.status, r.topic, ar.present, ar.method, r.source, s.start_time, s.end_time, s.id AS session_id,
            (SELECT status FROM attendance_corrections ac WHERE ac.register_id = r.id AND ac.student_id = ar.student_id) AS correction_status,
            cu.id AS course_unit_id, cu.code AS course_code, cu.name AS course_name, l.name AS lecturer_name
       FROM attendance_records ar
       JOIN attendance_registers r ON r.id = ar.register_id
       JOIN timetable_sessions s ON s.id = r.session_id
       JOIN allocations a ON a.id = s.allocation_id
       JOIN course_units cu ON cu.id = a.course_unit_id
       JOIN users l ON l.id = a.lecturer_id
      WHERE ar.student_id = ? ${termFilter}
      ORDER BY r.lecture_date DESC, s.start_time DESC`,
    ...params,
  );
  const byCourse = new Map();
  for (const r of records) {
    if (!byCourse.has(r.course_unit_id)) {
      byCourse.set(r.course_unit_id, { course_unit_id: r.course_unit_id, code: r.course_code, name: r.course_name, lecturer_name: r.lecturer_name, attended: 0, total: 0, pending: 0 });
    }
    const c = byCourse.get(r.course_unit_id);
    if (r.status === 'approved') {
      c.total++;
      c.attended += r.present;
    } else if (r.status === 'submitted') c.pending++;
  }
  const courses = [...byCourse.values()].map((c) => ({ ...c, rate: c.total ? Math.round((c.attended / c.total) * 1000) / 10 : null }));
  const attended = courses.reduce((n, c) => n + c.attended, 0);
  const total = courses.reduce((n, c) => n + c.total, 0);
  return { summary: { attended, total, rate: total ? Math.round((attended / total) * 1000) / 10 : null }, courses, records };
}

router.get('/my-history', (req, res) => {
  if (req.user.role !== 'student') throw forbidden('Only students have an attendance history');
  res.json(history(req.user.id, toInt(req.query.term_id)));
});

router.get('/students/:id/history', (req, res) => {
  if (!['admin', 'dean', 'hod', 'lecturer'].includes(req.user.role)) throw forbidden();
  const student = q.get(
    `SELECT u.id, u.name, u.identifier, u.email, c.name AS class_name, p.department_id FROM users u
       LEFT JOIN classes c ON c.id = u.class_id LEFT JOIN programs p ON p.id = c.program_id
      WHERE u.id = ? AND u.university_id = ? AND u.role = 'student'`,
    req.params.id,
    req.uid,
  );
  if (!student) throw notFound('Student');
  if (MANAGER_ROLES.includes(req.user.role) && !canManageDepartment(req.user, student.department_id)) throw forbidden();
  res.json({ student, ...history(student.id, toInt(req.query.term_id)) });
});

// ------------------------------------------------- Corrections (missed check-in)

const correctionSelect = `
  SELECT ac.*, u.name AS student_name, u.identifier AS student_identifier, r.lecture_date, r.session_id, r.class_id,
         c.name AS class_name, cu.code AS course_code, cu.name AS course_name, s.start_time, s.end_time, a.lecturer_id,
         a.id AS allocation_id, rv.name AS reviewed_by_name
    FROM attendance_corrections ac
    JOIN users u ON u.id = ac.student_id
    JOIN attendance_registers r ON r.id = ac.register_id
    JOIN classes c ON c.id = r.class_id
    JOIN timetable_sessions s ON s.id = r.session_id
    JOIN allocations a ON a.id = s.allocation_id
    JOIN course_units cu ON cu.id = a.course_unit_id
    LEFT JOIN users rv ON rv.id = ac.reviewed_by`;

/** A student who was marked absent asks for a correction within the university's window. */
router.post('/corrections', (req, res) => {
  if (req.user.role !== 'student') throw forbidden('Only students request attendance corrections');
  requireFields(req.body, ['register_id', 'note']);
  const reg = q.get(`${registerSelect} WHERE r.id = ? AND r.university_id = ?`, toInt(req.body.register_id), req.uid);
  if (!reg) throw notFound('Register');
  const record = q.get('SELECT present FROM attendance_records WHERE register_id = ? AND student_id = ?', reg.id, req.user.id);
  if (!record) throw forbidden('You are not on this register');
  if (record.present) throw badRequest('You are already marked present for this lecture');
  const uni = q.get('SELECT timezone, correction_hours FROM universities WHERE id = ?', req.uid);
  const occ = occurrenceOn(req.uid, reg.session_id, reg.lecture_date);
  const endsAt = localToUtc(reg.lecture_date, occ?.end_time || reg.end_time, uni.timezone).getTime();
  if (Date.now() > endsAt + uni.correction_hours * 3600_000) {
    throw badRequest(`Corrections can be requested up to ${uni.correction_hours} hours after the lecture`);
  }
  const note = String(req.body.note).trim();
  if (note.length < 5) throw badRequest('Explain briefly why you were not checked in');
  if (q.get('SELECT 1 FROM attendance_corrections WHERE register_id = ? AND student_id = ?', reg.id, req.user.id)) {
    throw new HttpError(409, 'You have already requested a correction for this lecture');
  }
  const id = insert('attendance_corrections', { university_id: req.uid, register_id: reg.id, student_id: req.user.id, note });
  notify(teacherOf(reg.session_id, reg.lecture_date, reg.lecturer_id), {
    title: `Attendance correction: ${reg.course_code}`,
    body: `${req.user.name} says they attended on ${reg.lecture_date}: "${note}"`,
    type: 'attendance',
    link: '/attendance?tab=corrections',
  });
  res.status(201).json(q.get(`${correctionSelect} WHERE ac.id = ?`, id));
});

router.get('/corrections', (req, res) => {
  const user = req.user;
  if (user.role === 'student') {
    return res.json(q.all(`${correctionSelect} WHERE ac.student_id = ? ORDER BY ac.id DESC`, user.id));
  }
  if (!['admin', 'dean', 'hod', 'lecturer'].includes(user.role)) throw forbidden();
  const rows = q.all(`${correctionSelect} WHERE ac.university_id = ? ${req.query.status ? 'AND ac.status = ?' : ''} ORDER BY ac.status = 'submitted' DESC, ac.id DESC LIMIT 300`, req.uid, ...(req.query.status ? [req.query.status] : []));
  const visible = rows.filter((c) => {
    const allocation = allocationContext(c.allocation_id, req.uid);
    try {
      return access(user, allocation, c.class_id, c.session_id, c.lecture_date).canReview;
    } catch {
      return false;
    }
  });
  res.json(visible);
});

router.post('/corrections/:id/review', (req, res) => {
  const c = q.get(`${correctionSelect} WHERE ac.id = ? AND ac.university_id = ?`, toInt(req.params.id), req.uid);
  if (!c) throw notFound('Correction');
  const allocation = allocationContext(c.allocation_id, req.uid);
  if (!access(req.user, allocation, c.class_id, c.session_id, c.lecture_date).canReview) throw forbidden();
  const action = req.body?.action;
  if (!['approve', 'reject'].includes(action)) throw badRequest('action must be "approve" or "reject"');
  if (c.status !== 'submitted') throw new HttpError(409, `This correction is already ${c.status}`);
  if (action === 'reject' && !String(req.body.note || '').trim()) throw badRequest('Give a reason when rejecting');
  tx(() => {
    update('attendance_corrections', c.id, {
      status: action === 'approve' ? 'approved' : 'rejected',
      reviewed_by: req.user.id,
      reviewed_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      review_note: req.body.note || null,
    });
    if (action === 'approve') q.run("UPDATE attendance_records SET present = 1, method = 'correction' WHERE register_id = ? AND student_id = ?", c.register_id, c.student_id);
  });
  notify(c.student_id, {
    title: `Attendance correction ${action === 'approve' ? 'approved' : 'rejected'}: ${c.course_code}`,
    body: action === 'approve' ? `You are now marked present for ${c.lecture_date}.` : `${req.body.note}`,
    type: 'attendance',
    link: '/attendance',
  });
  res.json(q.get(`${correctionSelect} WHERE ac.id = ?`, c.id));
});

export default router;
