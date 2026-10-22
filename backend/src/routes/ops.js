// Teaching operations: cancelling and rescheduling lectures, the academic calendar, leave (HoD
// checks, Dean approves) with cover lecturers, missed lectures and personal calendar links.
import crypto from 'node:crypto';
import { Router } from 'express';
import { MANAGER_ROLES, requireRole, TEACHING_ROLES } from '../auth.js';
import { config } from '../config.js';
import { insert, q, tx, update } from '../db.js';
import { canManageDepartment, facultyIdsForDean, managedDepartmentIds, placeholders } from '../scope.js';
import { notify } from '../services/notify.js';
import { clashesOn, hasEnded, noTeachingDates, occurrenceOn, occurrences, occurrencesForUser, teacherOf } from '../services/occurrences.js';
import { missedLectures, suggestSlots } from '../services/ops.js';
import { allocationContext } from '../services/timetable.js';
import { addDays, badRequest, dowOf, forbidden, HttpError, isTime, notFound, pick, requireFields, toInt, toMinutes, zonedNow } from '../util.js';

const router = Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const uniOf = (uid) => q.get('SELECT * FROM universities WHERE id = ?', uid);
const nowIn = (uid) => zonedNow(uniOf(uid)?.timezone || 'UTC');
const studentIdsOf = (classes) =>
  classes.length ? q.all(`SELECT id FROM users WHERE role = 'student' AND active = 1 AND class_id IN (${placeholders(classes.map((c) => c.id))})`, ...classes.map((c) => c.id)).map((r) => r.id) : [];

function canChange(user, occ) {
  if (teacherOf(occ.session_id, occ.date, occ.original_lecturer_id) === user.id) return true;
  return MANAGER_ROLES.includes(user.role) && canManageDepartment(user, occ.department_id);
}

// --------------------------------------------------------------- Occurrences

/** The user's dated lectures, including cancelled, moved and covered ones. */
router.get('/occurrences', (req, res) => {
  const now = nowIn(req.uid);
  const from = DATE_RE.test(req.query.from || '') ? req.query.from : now.date;
  const to = DATE_RE.test(req.query.to || '') ? req.query.to : addDays(from, 13);
  if (to < from || to > addDays(from, 120)) throw badRequest('Choose a range of up to 120 days');
  const list = occurrencesForUser(req.user, from, to, { includeInactive: true }).map((o) => {
    const reg = q.get('SELECT COUNT(*) AS n FROM attendance_registers WHERE session_id = ? AND lecture_date = ?', o.session_id, o.date).n;
    const cs = q.get('SELECT id, closed_at FROM checkin_sessions WHERE session_id = ? AND lecture_date = ?', o.session_id, o.date);
    return {
      ...o,
      ended: hasEnded(o, now),
      today: o.date === now.date,
      has_attendance: reg > 0,
      checkin: cs ? { id: cs.id, open: !cs.closed_at } : null,
      can_change: ['scheduled', 'rescheduled'].includes(o.status) && !hasEnded(o, now) && canChange(req.user, o),
      can_checkin: o.date === now.date && ['scheduled', 'rescheduled'].includes(o.status) && canChange(req.user, o)
        && now.minutes >= toMinutes(o.start_time) - 15 && now.minutes <= toMinutes(o.end_time) + 30,
    };
  });
  res.json({ from, to, today: now.date, items: list });
});

router.get('/sessions/:id/suggestions', (req, res) => {
  const date = req.query.date;
  if (!DATE_RE.test(date || '')) throw badRequest('date is required');
  const occ = occurrenceOn(req.uid, toInt(req.params.id), date);
  if (!occ) throw notFound('Lecture');
  if (!canChange(req.user, occ)) throw forbidden();
  res.json(suggestSlots(req.uid, occ, { from: req.query.from }));
});

// --------------------------------------------------------- Cancel / reschedule

router.get('/changes', (req, res) => {
  const now = nowIn(req.uid);
  const from = DATE_RE.test(req.query.from || '') ? req.query.from : addDays(now.date, -14);
  const to = DATE_RE.test(req.query.to || '') ? req.query.to : addDays(now.date, 60);
  const rows = q.all(
    `SELECT sc.*, cu.code AS course_code, cu.name AS course_name, cu.department_id, a.lecturer_id, u.name AS created_by_name, r.name AS new_room_name
       FROM session_changes sc JOIN timetable_sessions s ON s.id = sc.session_id JOIN allocations a ON a.id = s.allocation_id
       JOIN course_units cu ON cu.id = a.course_unit_id LEFT JOIN users u ON u.id = sc.created_by LEFT JOIN rooms r ON r.id = sc.new_room_id
      WHERE sc.university_id = ? AND (sc.original_date BETWEEN ? AND ? OR sc.new_date BETWEEN ? AND ?)
      ORDER BY COALESCE(sc.new_date, sc.original_date)`,
    req.uid,
    from,
    to,
    from,
    to,
  );
  const depts = managedDepartmentIds(req.user);
  res.json(rows.filter((r) => depts === null || depts.includes(r.department_id) || r.lecturer_id === req.user.id || r.created_by === req.user.id));
});

router.post('/changes', (req, res) => {
  requireFields(req.body, ['session_id', 'date', 'action']);
  const { action } = req.body;
  if (!['cancel', 'move'].includes(action)) throw badRequest('action must be "cancel" or "move"');
  const now = nowIn(req.uid);
  const occ = occurrenceOn(req.uid, toInt(req.body.session_id), req.body.date);
  if (!occ) throw badRequest('That lecture does not take place on that date');
  if (!canChange(req.user, occ)) throw forbidden('Only the lecturer teaching it or the HoD can change this lecture');
  if (hasEnded(occ, now)) throw badRequest('This lecture has already ended');
  if (q.get('SELECT 1 FROM attendance_registers WHERE session_id = ? AND lecture_date = ?', occ.session_id, occ.date)) {
    throw badRequest('Attendance has already been taken for this lecture');
  }
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 3) throw badRequest('Give a short reason so students know why');
  const originalDate = occ.original_date || occ.date;
  const change = { university_id: req.uid, session_id: occ.session_id, original_date: originalDate, action, reason, created_by: req.user.id, new_date: null, new_start: null, new_end: null, new_room_id: null };

  if (action === 'move') {
    const date = req.body.new_date;
    const start = req.body.new_start;
    const end = req.body.new_end || null;
    if (!DATE_RE.test(date || '') || !isTime(start)) throw badRequest('Choose the new date and start time');
    const dur = toMinutes(occ.end_time) - toMinutes(occ.start_time);
    const finish = end && isTime(end) ? end : `${String(Math.floor((toMinutes(start) + dur) / 60)).padStart(2, '0')}:${String((toMinutes(start) + dur) % 60).padStart(2, '0')}`;
    if (finish <= start) throw badRequest('The new end time must be after the start');
    if (date < now.date || (date === now.date && toMinutes(start) <= now.minutes)) throw badRequest('The new time must be in the future');
    const term = q.get('SELECT * FROM academic_terms WHERE id = ?', occ.term_id);
    if ((term.start_date && date < term.start_date) || (term.end_date && date > term.end_date)) throw badRequest('The new date is outside the term');
    const closed = noTeachingDates(req.uid, date, date).get(date);
    if (closed) throw badRequest(`No teaching on ${date}: ${closed.title}`);
    if (date !== originalDate && occurrences(req.uid, { from: date, to: date, sessionId: occ.session_id }).length) {
      throw badRequest('This lecture already takes place on that date; choose another day');
    }
    const roomId = toInt(req.body.new_room_id) || occ.room_id;
    const room = q.get('SELECT * FROM rooms WHERE id = ? AND university_id = ?', roomId, req.uid);
    if (!room) throw badRequest('Unknown room');
    const size = allocationContext(occ.allocation_id, req.uid)?.size || 0;
    if (room.capacity < size && !req.body.force) throw new HttpError(409, `${room.name} seats ${room.capacity}; the class has ${size} students`, { requires_confirmation: true, code: 'ROOM_SMALL' });
    const clashes = clashesOn(req.uid, date, start, finish, {
      roomIds: [room.id],
      personIds: [occ.lecturer_id],
      classIds: occ.classes.map((c) => c.id),
      excludeOccurrence: { session_id: occ.session_id, date: occ.date },
    });
    if (clashes.length) throw new HttpError(409, clashes[0].message, { conflicts: clashes });
    Object.assign(change, { new_date: date, new_start: start, new_end: finish, new_room_id: room.id });
  }

  const id = tx(() => {
    q.run('DELETE FROM session_changes WHERE session_id = ? AND original_date = ?', occ.session_id, originalDate);
    // A cover assigned for the old date follows the lecture to its new date.
    if (action === 'move') q.run('UPDATE leave_covers SET lecture_date = ? WHERE session_id = ? AND lecture_date = ?', change.new_date, occ.session_id, occ.date);
    return insert('session_changes', change);
  });
  const title = action === 'cancel' ? `Cancelled: ${occ.course_code} on ${occ.date}` : `Rescheduled: ${occ.course_code}`;
  const body =
    action === 'cancel'
      ? `${occ.start_time}-${occ.end_time} in ${occ.room_name} will not take place. ${reason}`
      : `Moved from ${occ.date} ${occ.start_time} to ${change.new_date} ${change.new_start}-${change.new_end}. ${reason}`;
  notify([...studentIdsOf(occ.classes), occ.lecturer_id].filter((uid) => uid !== req.user.id), { title, body, type: 'timetable', link: '/my-timetable' });
  res.status(201).json(q.get('SELECT * FROM session_changes WHERE id = ?', id));
});

router.delete('/changes/:id', (req, res) => {
  const c = q.get('SELECT * FROM session_changes WHERE id = ? AND university_id = ?', toInt(req.params.id), req.uid);
  if (!c) throw notFound('Change');
  const s = q.get('SELECT s.*, a.lecturer_id, cu.department_id, cu.code FROM timetable_sessions s JOIN allocations a ON a.id = s.allocation_id JOIN course_units cu ON cu.id = a.course_unit_id WHERE s.id = ?', c.session_id);
  const allowed = s.lecturer_id === req.user.id || c.created_by === req.user.id || (MANAGER_ROLES.includes(req.user.role) && canManageDepartment(req.user, s.department_id));
  if (!allowed) throw forbidden();
  const held = q.get('SELECT 1 FROM attendance_registers WHERE session_id = ? AND lecture_date = ?', c.session_id, c.new_date || c.original_date);
  if (held) throw badRequest('Attendance was taken for the rescheduled lecture, so the change cannot be undone');
  q.run('DELETE FROM session_changes WHERE id = ?', c.id);
  const classes = allocationContext(s.allocation_id, req.uid)?.classes || [];
  notify(studentIdsOf(classes), { title: `Back to normal: ${s.code} on ${c.original_date}`, body: 'The lecture takes place at its usual time and room.', type: 'timetable', link: '/my-timetable' });
  res.json({ ok: true });
});

// ----------------------------------------------------------- Academic calendar

const EVENT_FIELDS = ['title', 'kind', 'start_date', 'end_date', 'no_teaching'];

function cleanEvent(body) {
  const data = pick(body, EVENT_FIELDS);
  if (data.title !== undefined) data.title = String(data.title).trim();
  if (data.no_teaching !== undefined) data.no_teaching = data.no_teaching ? 1 : 0;
  if (data.start_date !== undefined && !DATE_RE.test(data.start_date)) throw badRequest('Start date must be YYYY-MM-DD');
  if (data.end_date !== undefined && !DATE_RE.test(data.end_date)) throw badRequest('End date must be YYYY-MM-DD');
  if (data.start_date && data.end_date && data.end_date < data.start_date) throw badRequest('The end date is before the start date');
  return data;
}

router.get('/calendar-events', (req, res) => {
  res.json(q.all('SELECT * FROM calendar_events WHERE university_id = ? ORDER BY start_date', req.uid));
});

router.post('/calendar-events', requireRole('admin'), (req, res) => {
  requireFields(req.body, ['title', 'start_date']);
  const data = cleanEvent({ end_date: req.body.start_date, no_teaching: true, kind: 'holiday', ...req.body });
  const id = insert('calendar_events', { ...data, university_id: req.uid });
  res.status(201).json(q.get('SELECT * FROM calendar_events WHERE id = ?', id));
});

router.put('/calendar-events/:id', requireRole('admin'), (req, res) => {
  const ev = q.get('SELECT * FROM calendar_events WHERE id = ? AND university_id = ?', req.params.id, req.uid);
  if (!ev) throw notFound('Calendar event');
  const data = cleanEvent({ ...ev, ...req.body });
  update('calendar_events', ev.id, data);
  res.json(q.get('SELECT * FROM calendar_events WHERE id = ?', ev.id));
});

router.delete('/calendar-events/:id', requireRole('admin'), (req, res) => {
  q.run('DELETE FROM calendar_events WHERE id = ? AND university_id = ?', req.params.id, req.uid);
  res.json({ ok: true });
});

// ------------------------------------------------------------------- Leave

const LEAVE_LABEL = { submitted: 'Awaiting HoD check', hod_checked: 'Awaiting Dean approval', approved: 'Approved', rejected: 'Not approved', cancelled: 'Cancelled' };
const leaveSelect = `
  SELECT lr.*, u.name AS lecturer_name, u.title AS lecturer_title, u.role AS lecturer_role, d.name AS department_name,
         h.name AS hod_name, dn.name AS dean_name
    FROM leave_requests lr JOIN users u ON u.id = lr.lecturer_id
    LEFT JOIN departments d ON d.id = lr.department_id
    LEFT JOIN users h ON h.id = lr.hod_by LEFT JOIN users dn ON dn.id = lr.dean_by`;

/** Who acts on a leave request at its current stage. */
function leaveStage(lr) {
  const dept = q.get('SELECT d.hod_id, f.dean_id FROM departments d JOIN faculties f ON f.id = d.faculty_id WHERE d.id = ?', lr.department_id) || {};
  if (lr.status === 'submitted') return { actor: 'hod', userIds: [dept.hod_id && dept.hod_id !== lr.lecturer_id ? dept.hod_id : dept.dean_id].filter(Boolean) };
  if (lr.status === 'hod_checked') {
    const dean = dept.dean_id && dept.dean_id !== lr.lecturer_id ? [dept.dean_id] : q.all("SELECT id FROM users WHERE university_id = ? AND role = 'admin' AND active = 1", lr.university_id).map((r) => r.id);
    return { actor: 'dean', userIds: dean };
  }
  return { actor: null, userIds: [] };
}

function canActOnLeave(user, lr) {
  if (user.id === lr.lecturer_id) return false;
  const stage = leaveStage(lr);
  if (stage.actor === 'hod') return stage.userIds.includes(user.id) || (user.role === 'hod' && canManageDepartment(user, lr.department_id));
  if (stage.actor === 'dean') return stage.userIds.includes(user.id) || (user.role === 'dean' && canManageDepartment(user, lr.department_id)) || user.role === 'admin';
  return false;
}

const canSeeLeave = (user, lr) => user.id === lr.lecturer_id || user.role === 'admin' || (MANAGER_ROLES.includes(user.role) && canManageDepartment(user, lr.department_id));
const canAssignCovers = (user, lr) => user.role === 'admin' || (['hod', 'dean'].includes(user.role) && canManageDepartment(user, lr.department_id) && user.id !== lr.lecturer_id);
const describeLeave = (lr, user) => ({ ...lr, status_label: LEAVE_LABEL[lr.status], can_act: canActOnLeave(user, lr), can_assign_covers: canAssignCovers(user, lr) && ['submitted', 'hod_checked', 'approved'].includes(lr.status) });

router.get('/leave', (req, res) => {
  const rows = q.all(`${leaveSelect} WHERE lr.university_id = ? ORDER BY lr.start_date DESC, lr.id DESC LIMIT 300`, req.uid);
  let list = rows.filter((lr) => canSeeLeave(req.user, lr) || canActOnLeave(req.user, lr)).map((lr) => describeLeave(lr, req.user));
  if (req.query.view === 'mine') list = list.filter((lr) => lr.lecturer_id === req.user.id);
  if (req.query.view === 'review') list = list.filter((lr) => lr.can_act);
  res.json(list);
});

router.post('/leave', (req, res) => {
  if (!TEACHING_ROLES.includes(req.user.role)) throw forbidden('Leave requests are for teaching staff');
  requireFields(req.body, ['start_date', 'end_date', 'reason']);
  const { start_date: from, end_date: to } = req.body;
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) throw badRequest('Choose valid leave dates');
  const now = nowIn(req.uid);
  if (from < now.date) throw badRequest('Leave cannot start in the past');
  if (to > addDays(from, 60)) throw badRequest('Short-term leave is up to 60 days');
  const reason = String(req.body.reason).trim();
  if (reason.length < 5) throw badRequest('Give the reason for your leave');
  const departmentId = req.user.department_id || null;
  if (!departmentId && req.user.role !== 'dean') throw badRequest('Your account has no department yet');
  const status = req.user.role === 'hod' || req.user.role === 'dean' ? 'hod_checked' : 'submitted';
  const id = insert('leave_requests', {
    university_id: req.uid,
    lecturer_id: req.user.id,
    department_id: departmentId,
    faculty_id: req.user.faculty_id || null,
    start_date: from,
    end_date: to,
    reason,
    status,
    hod_note: status === 'hod_checked' ? `Raised by the ${req.user.role === 'hod' ? 'HoD' : 'Dean'}` : null,
  });
  const lr = q.get(`${leaveSelect} WHERE lr.id = ?`, id);
  const lectures = occurrences(req.uid, { from, to, lecturerId: req.user.id }).length;
  notify(leaveStage(lr).userIds, {
    title: `Leave request: ${req.user.name}`,
    body: `${from} to ${to} (${lectures} lecture${lectures === 1 ? '' : 's'} affected). ${reason}`,
    type: 'leave',
    link: `/leave/${id}`,
  });
  res.status(201).json(describeLeave(lr, req.user));
});

router.get('/leave/:id', (req, res) => {
  const lr = q.get(`${leaveSelect} WHERE lr.id = ? AND lr.university_id = ?`, toInt(req.params.id), req.uid);
  if (!lr || !(canSeeLeave(req.user, lr) || canActOnLeave(req.user, lr))) throw notFound('Leave request');
  const covers = new Map(
    q
      .all('SELECT lc.*, u.name AS substitute_name FROM leave_covers lc JOIN users u ON u.id = lc.substitute_id WHERE lc.leave_id = ?', lr.id)
      .map((c) => [`${c.session_id}|${c.lecture_date}`, c]),
  );
  const lectures = occurrences(req.uid, { from: lr.start_date, to: lr.end_date, lecturerId: lr.lecturer_id, includeInactive: true })
    .filter((o) => o.original_lecturer_id === lr.lecturer_id)
    .map((o) => ({ ...o, cover: covers.get(`${o.session_id}|${o.date}`) || null }));
  const assign = canAssignCovers(req.user, lr);
  if (assign) {
    // Colleagues in the same department, then the faculty, who are free at that time.
    const staff = q.all(
      `SELECT u.id, u.name, u.title, u.department_id FROM users u JOIN departments d ON d.id = u.department_id
        WHERE u.university_id = ? AND u.active = 1 AND u.role IN ('lecturer','hod','dean') AND u.id <> ? AND d.faculty_id = (SELECT faculty_id FROM departments WHERE id = ?)
        ORDER BY u.department_id = ? DESC, u.name`,
      req.uid,
      lr.lecturer_id,
      lr.department_id,
      lr.department_id,
    );
    for (const o of lectures) {
      if (!['scheduled', 'rescheduled', 'covered'].includes(o.status)) continue;
      o.candidates = staff
        .filter((s) => !clashesOn(req.uid, o.date, o.start_time, o.end_time, { personIds: [s.id], excludeOccurrence: { session_id: o.session_id, date: o.date } }).length)
        .map((s) => ({ id: s.id, name: s.name, title: s.title, same_department: s.department_id === lr.department_id }));
    }
  }
  res.json({ ...describeLeave(lr, req.user), lectures });
});

router.post('/leave/:id/review', (req, res) => {
  const lr = q.get(`${leaveSelect} WHERE lr.id = ? AND lr.university_id = ?`, toInt(req.params.id), req.uid);
  if (!lr) throw notFound('Leave request');
  if (!canActOnLeave(req.user, lr)) throw forbidden('This leave request is not waiting for you');
  const action = req.body?.action;
  if (!['approve', 'reject'].includes(action)) throw badRequest('action must be "approve" or "reject"');
  const note = String(req.body.note || '').trim() || null;
  if (action === 'reject' && !note) throw badRequest('Give a reason');
  const stage = leaveStage(lr).actor;
  const at = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const next = action === 'reject' ? 'rejected' : stage === 'hod' ? 'hod_checked' : 'approved';
  if (stage === 'hod') update('leave_requests', lr.id, { status: next, hod_by: req.user.id, hod_at: at, hod_note: note });
  else update('leave_requests', lr.id, { status: next, dean_by: req.user.id, dean_at: at, dean_note: note });
  const fresh = q.get(`${leaveSelect} WHERE lr.id = ?`, lr.id);
  if (next === 'hod_checked') {
    notify(leaveStage(fresh).userIds, { title: `Leave to approve: ${lr.lecturer_name}`, body: `Checked by ${req.user.name}. ${lr.start_date} to ${lr.end_date}.`, type: 'leave', link: `/leave/${lr.id}` });
  }
  const dept = q.get('SELECT hod_id FROM departments WHERE id = ?', lr.department_id);
  notify(lr.lecturer_id, {
    title: next === 'approved' ? 'Leave approved' : next === 'rejected' ? 'Leave not approved' : 'Leave checked by your HoD',
    body: `${lr.start_date} to ${lr.end_date}${note ? `: ${note}` : ''}`,
    type: 'leave',
    link: `/leave/${lr.id}`,
  });
  if (next === 'approved' && dept?.hod_id && dept.hod_id !== lr.lecturer_id) {
    notify(dept.hod_id, { title: `Leave approved: ${lr.lecturer_name}`, body: 'Assign cover lecturers for the affected lectures.', type: 'leave', link: `/leave/${lr.id}` });
  }
  if (next === 'approved') {
    for (const c of q.all('SELECT * FROM leave_covers WHERE leave_id = ?', lr.id)) {
      notify(c.substitute_id, { title: 'You are covering a lecture', body: `${c.lecture_date}: covering for ${lr.lecturer_name}.`, type: 'leave', link: '/my-timetable' });
    }
  }
  res.json(describeLeave(fresh, req.user));
});

router.post('/leave/:id/cancel', (req, res) => {
  const lr = q.get('SELECT * FROM leave_requests WHERE id = ? AND university_id = ?', toInt(req.params.id), req.uid);
  if (!lr || lr.lecturer_id !== req.user.id) throw notFound('Leave request');
  if (['rejected', 'cancelled'].includes(lr.status)) throw badRequest(`This request is already ${lr.status}`);
  update('leave_requests', lr.id, { status: 'cancelled' });
  res.json({ ok: true });
});

/** Assign (or remove) a cover lecturer for one affected lecture, or cancel that lecture. */
router.put('/leave/:id/covers', (req, res) => {
  const lr = q.get(`${leaveSelect} WHERE lr.id = ? AND lr.university_id = ?`, toInt(req.params.id), req.uid);
  if (!lr) throw notFound('Leave request');
  if (!canAssignCovers(req.user, lr)) throw forbidden('Only the HoD or Dean can arrange cover');
  if (!['submitted', 'hod_checked', 'approved'].includes(lr.status)) throw badRequest(`This request is ${lr.status}`);
  requireFields(req.body, ['session_id', 'date']);
  const sessionId = toInt(req.body.session_id);
  const date = req.body.date;
  if (date < lr.start_date || date > lr.end_date) throw badRequest('That lecture is outside the leave dates');
  const occ = occurrenceOn(req.uid, sessionId, date);
  if (!occ || occ.original_lecturer_id !== lr.lecturer_id) throw badRequest('That lecture is not one of the lecturer\'s during the leave');
  if (req.body.cancel) {
    tx(() => {
      q.run('DELETE FROM leave_covers WHERE session_id = ? AND lecture_date = ?', sessionId, date);
      q.run('DELETE FROM session_changes WHERE session_id = ? AND original_date = ?', sessionId, occ.original_date || date);
      insert('session_changes', { university_id: req.uid, session_id: sessionId, original_date: occ.original_date || date, action: 'cancel', reason: 'Lecturer on leave', created_by: req.user.id });
    });
    notify(studentIdsOf(occ.classes), { title: `Cancelled: ${occ.course_code} on ${date}`, body: 'The lecturer is on leave.', type: 'timetable', link: '/my-timetable' });
    return res.json({ ok: true, cancelled: true });
  }
  const subId = toInt(req.body.substitute_id);
  if (!subId) {
    q.run('DELETE FROM leave_covers WHERE leave_id = ? AND session_id = ? AND lecture_date = ?', lr.id, sessionId, date);
    return res.json({ ok: true, removed: true });
  }
  const sub = q.get("SELECT * FROM users WHERE id = ? AND university_id = ? AND active = 1 AND role IN ('lecturer','hod','dean')", subId, req.uid);
  if (!sub || sub.id === lr.lecturer_id) throw badRequest('Choose another lecturer');
  const clashes = clashesOn(req.uid, date, occ.start_time, occ.end_time, { personIds: [sub.id], excludeOccurrence: { session_id: sessionId, date } });
  if (clashes.length) throw new HttpError(409, clashes[0].message);
  q.run(
    `INSERT INTO leave_covers (leave_id, session_id, lecture_date, substitute_id, created_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (session_id, lecture_date) DO UPDATE SET leave_id = excluded.leave_id, substitute_id = excluded.substitute_id, created_by = excluded.created_by`,
    lr.id,
    sessionId,
    date,
    sub.id,
    req.user.id,
  );
  if (lr.status === 'approved') {
    notify(sub.id, { title: 'You are covering a lecture', body: `${occ.course_code} on ${date} ${occ.start_time}-${occ.end_time} in ${occ.room_name}, for ${lr.lecturer_name}.`, type: 'leave', link: '/my-timetable' });
  }
  res.json({ ok: true, substitute: { id: sub.id, name: sub.name } });
});

// ---------------------------------------------------------- Missed lectures

router.get('/missed', (req, res) => {
  const now = nowIn(req.uid);
  const from = DATE_RE.test(req.query.from || '') ? req.query.from : addDays(now.date, -13);
  const to = DATE_RE.test(req.query.to || '') ? req.query.to : now.date;
  if (to < from || to > addDays(from, 120)) throw badRequest('Choose a range of up to 120 days');
  const user = req.user;
  let opts;
  if (user.role === 'admin') opts = {};
  else if (MANAGER_ROLES.includes(user.role)) opts = { departmentIds: managedDepartmentIds(user) };
  else if (TEACHING_ROLES.includes(user.role)) opts = { lecturerId: user.id };
  else throw forbidden();
  res.json({ from, to, items: missedLectures(req.uid, { from, to, ...opts }) });
});

// --------------------------------------------------------- Calendar links

function calendarUrl(req, token) {
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}${config.basePath}/api/calendar/${token}.ics`;
}

router.get('/calendar-link', (req, res) => {
  let token = q.get('SELECT calendar_token FROM users WHERE id = ?', req.user.id)?.calendar_token;
  if (!token) {
    token = crypto.randomBytes(24).toString('base64url');
    q.run('UPDATE users SET calendar_token = ? WHERE id = ?', token, req.user.id);
  }
  const url = calendarUrl(req, token);
  res.json({ url, webcal: url.replace(/^https?:/, 'webcal:'), google: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(url.replace(/^https?:/, 'webcal:'))}` });
});

router.post('/calendar-link/reset', (req, res) => {
  const token = crypto.randomBytes(24).toString('base64url');
  q.run('UPDATE users SET calendar_token = ? WHERE id = ?', token, req.user.id);
  const url = calendarUrl(req, token);
  res.json({ url, webcal: url.replace(/^https?:/, 'webcal:'), google: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(url.replace(/^https?:/, 'webcal:'))}` });
});

export { dowOf, facultyIdsForDean };
export default router;
