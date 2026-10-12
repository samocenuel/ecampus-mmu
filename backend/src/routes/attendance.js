// Attendance: the class representative records who is present at a lecture,
// the lecturer approves (or rejects) the register, students see their history.
import { Router } from 'express';
import { MANAGER_ROLES, TEACHING_ROLES } from '../auth.js';
import { q, tx, update, insert } from '../db.js';
import { canManageDepartment, currentTerm, managedDepartmentIds, placeholders } from '../scope.js';
import { notify } from '../services/notify.js';
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

/** Who may see / act on a class's register for a session. */
function access(user, allocation, classId) {
  const cls = allocation.classes.find((c) => c.id === Number(classId));
  if (!cls) throw badRequest('That class does not attend this lecture');
  const isRep = cls.class_rep_id === user.id;
  const isLecturer = allocation.lecturer_id === user.id;
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
  const push = (s, cls, role) => {
    const reg = q.get(
      'SELECT id, status, review_note FROM attendance_registers WHERE session_id = ? AND class_id = ? AND lecture_date = ?',
      s.id,
      cls.id,
      date,
    );
    const started = date < now.date || (date === now.date && now.minutes >= toMinutes(s.start_time) - 15);
    items.push({
      session: s,
      class_id: cls.id,
      class_name: cls.name,
      role,
      register: reg || null,
      can_submit: role === 'rep' && started && reg?.status !== 'approved',
      not_started: !started,
    });
  };
  for (const rc of req.user.rep_classes || []) {
    for (const s of listSessions(req.uid, term.id, { classId: rc.id, day: dow })) push(s, rc, 'rep');
  }
  if (TEACHING_ROLES.includes(req.user.role)) {
    for (const s of listSessions(req.uid, term.id, { lecturerId: req.user.id, day: dow })) {
      for (const c of s.classes) push(s, c, 'lecturer');
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
  const a = access(req.user, allocation, toInt(req.query.class_id));
  if (!a.canView) throw forbidden();
  const register = q.get(
    `${registerSelect} WHERE r.session_id = ? AND r.class_id = ? AND r.lecture_date = ?`,
    detail.id,
    a.cls.id,
    date,
  );
  const students = q.all(
    `SELECT u.id, u.name, u.identifier, COALESCE(ar.present, 0) AS present
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
  const a = access(req.user, allocation, toInt(req.body.class_id));
  if (!a.isRep) throw forbidden('Only the class representative can submit attendance for this class');

  const now = uniNow(req.uid);
  if (dowOf(date) !== session.day_of_week) throw badRequest(`This lecture takes place on ${DAY_NAMES[session.day_of_week]}s`);
  if (date > now.date) throw badRequest('You cannot record attendance for a future lecture');
  if (date === now.date && now.minutes < toMinutes(session.start_time) - 15) {
    throw badRequest(`Attendance opens 15 minutes before the lecture starts (${session.start_time})`);
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
      q.run('INSERT INTO attendance_records (register_id, student_id, present) VALUES (?, ?, ?)', id, sid, present.has(sid) ? 1 : 0);
    }
    return id;
  });

  notify(allocation.lecturer_id, {
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
    where.push('a.lecturer_id = ?');
    params.push(user.id);
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
  return { reg, allocation, access: access(req.user, allocation, reg.class_id) };
}

router.get('/registers/:id', (req, res) => {
  const { reg, access: a } = loadRegister(req);
  if (!a.canView) throw forbidden();
  const students = q.all(
    `SELECT u.id, u.name, u.identifier, ar.present FROM attendance_records ar JOIN users u ON u.id = ar.student_id
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
    `SELECT r.id AS register_id, r.lecture_date, r.status, r.topic, ar.present, s.start_time, s.end_time,
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

export default router;
