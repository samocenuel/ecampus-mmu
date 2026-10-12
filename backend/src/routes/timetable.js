import { Router } from 'express';
import { MANAGER_ROLES, requireRole } from '../auth.js';
import { insert, q, update } from '../db.js';
import { canManageDepartment, managedDepartmentIds, placeholders, resolveTerm } from '../scope.js';
import { timetablePdf, timetableXlsx } from '../services/exporter.js';
import { notify } from '../services/notify.js';
import { sessionsForUser } from '../services/schedule.js';
import { allocationContext, checkSession, generateTimetable, listSessions } from '../services/timetable.js';
import { badRequest, forbidden, HttpError, isTime, needsConfirmation, notFound, requireFields, slugify, toInt, truthy } from '../util.js';
import { universityPayload } from './university.js';

const router = Router();

/** Works out which timetable a request is for, applying role restrictions. */
function resolveView(req) {
  const uid = req.uid;
  const term = resolveTerm(uid, toInt(req.query.term_id));
  const user = req.user;
  const f = {
    classId: toInt(req.query.class_id),
    lecturerId: toInt(req.query.lecturer_id),
    roomId: toInt(req.query.room_id),
    departmentId: toInt(req.query.department_id),
  };
  const mine = truthy(req.query.mine) || user.role === 'student' || (user.role === 'lecturer' && !f.classId && !f.lecturerId && !f.roomId && !f.departmentId);
  if (user.role === 'student' && (f.lecturerId || f.roomId || f.departmentId || (f.classId && f.classId !== user.class_id))) {
    throw forbidden('Students can only view their own class timetable');
  }

  let title = 'Master timetable';
  let showClasses = true;
  let sessions = [];
  if (!term) return { term, sessions, title, showClasses };
  if (mine) {
    sessions = sessionsForUser(user, term.id);
    title = user.role === 'student' ? `Class timetable - ${user.class_name || ''}` : `Teaching timetable - ${user.title ? `${user.title} ` : ''}${user.name}`;
    showClasses = user.role !== 'student';
  } else if (f.classId) {
    const cls = q.get('SELECT name FROM classes WHERE id = ? AND university_id = ?', f.classId, uid);
    if (!cls) throw notFound('Class');
    sessions = listSessions(uid, term.id, { classId: f.classId });
    title = `Class timetable - ${cls.name}`;
    showClasses = false;
  } else if (f.lecturerId) {
    const l = q.get('SELECT name, title FROM users WHERE id = ? AND university_id = ?', f.lecturerId, uid);
    if (!l) throw notFound('Lecturer');
    sessions = listSessions(uid, term.id, { lecturerId: f.lecturerId });
    title = `Teaching timetable - ${l.title ? `${l.title} ` : ''}${l.name}`;
  } else if (f.roomId) {
    const r = q.get('SELECT name, building FROM rooms WHERE id = ? AND university_id = ?', f.roomId, uid);
    if (!r) throw notFound('Room');
    sessions = listSessions(uid, term.id, { roomId: f.roomId });
    title = `Room timetable - ${r.name}${r.building ? ` (${r.building})` : ''}`;
  } else if (f.departmentId) {
    const d = q.get('SELECT name FROM departments WHERE id = ? AND university_id = ?', f.departmentId, uid);
    if (!d) throw notFound('Department');
    sessions = listSessions(uid, term.id, { departmentIds: [f.departmentId] });
    title = `Department timetable - ${d.name}`;
  } else {
    const scope = managedDepartmentIds(user);
    sessions = scope === null || !MANAGER_ROLES.includes(user.role) ? listSessions(uid, term.id) : listSessions(uid, term.id, { departmentIds: scope });
  }
  return { term, sessions, title, showClasses };
}

router.get('/', (req, res) => {
  const { term, sessions, title } = resolveView(req);
  const uni = universityPayload(q.get('SELECT * FROM universities WHERE id = ?', req.uid));
  res.json({
    term,
    title,
    sessions,
    settings: {
      teaching_days: uni.teaching_days,
      day_start: uni.day_start,
      day_end: uni.day_end,
      lunch_start: uni.lunch_start,
      lunch_end: uni.lunch_end,
      timezone: uni.timezone,
    },
  });
});

router.get('/export', async (req, res) => {
  const format = String(req.query.format || 'pdf').toLowerCase();
  if (!['pdf', 'xlsx', 'excel'].includes(format)) throw badRequest('format must be pdf or xlsx');
  const { term, sessions, title, showClasses } = resolveView(req);
  if (!term) throw badRequest('No academic term exists yet');
  const university = q.get('SELECT * FROM universities WHERE id = ?', req.uid);
  const subtitle = `${term.name}${term.start_date ? ` (${term.start_date} to ${term.end_date || '...'})` : ''}`;
  const name = `${slugify(title) || 'timetable'}-${slugify(term.name)}`;
  if (format === 'pdf') {
    const buf = await timetablePdf({ university, title, subtitle, sessions, showClasses });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.pdf"`);
    return res.send(buf);
  }
  const buf = await timetableXlsx({ university, title, subtitle, sessions, showClasses });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
  res.send(buf);
});

function loadAllocationForEdit(req, allocationId) {
  const allocation = allocationContext(toInt(allocationId), req.uid);
  if (!allocation) throw badRequest('Unknown allocation');
  const ok = allocation.department_id
    ? canManageDepartment(req.user, allocation.department_id) || allocation.classes.every((c) => canManageDepartment(req.user, c.department_id))
    : req.user.role === 'admin' || allocation.classes.every((c) => canManageDepartment(req.user, c.department_id));
  if (!ok) throw forbidden('That allocation is outside the unit you manage');
  return allocation;
}

function sessionInput(body) {
  requireFields(body, ['room_id', 'day_of_week', 'start_time', 'end_time']);
  return { roomId: toInt(body.room_id), day: toInt(body.day_of_week), start: body.start_time, end: body.end_time };
}

/** Dry-run collision check used by the editors before saving. */
router.post('/check', requireRole(...MANAGER_ROLES), (req, res) => {
  requireFields(req.body, ['allocation_id']);
  const allocation = loadAllocationForEdit(req, req.body.allocation_id);
  const input = sessionInput(req.body);
  const { conflicts, warnings } = checkSession({ universityId: req.uid, allocation, ...input, excludeSessionId: toInt(req.body.exclude_session_id) });
  res.json({ ok: conflicts.length === 0, conflicts, warnings });
});

function saveChecked(req, allocation, input, excludeSessionId) {
  const { conflicts, warnings } = checkSession({ universityId: req.uid, allocation, ...input, excludeSessionId });
  if (conflicts.length) {
    throw new HttpError(409, 'This slot clashes with the existing timetable', { code: 'TIMETABLE_CONFLICT', conflicts, warnings });
  }
  if (warnings.length && !truthy(req.body.force)) {
    throw needsConfirmation(`Please confirm: ${warnings.join('; ')}`, 'TIMETABLE_WARNING', { warnings });
  }
}

router.post('/sessions', requireRole(...MANAGER_ROLES), (req, res) => {
  requireFields(req.body, ['allocation_id']);
  const allocation = loadAllocationForEdit(req, req.body.allocation_id);
  const input = sessionInput(req.body);
  saveChecked(req, allocation, input, null);
  const id = insert('timetable_sessions', {
    university_id: req.uid,
    term_id: allocation.term_id,
    allocation_id: allocation.id,
    room_id: input.roomId,
    day_of_week: input.day,
    start_time: input.start,
    end_time: input.end,
  });
  res.status(201).json(listSessions(req.uid, allocation.term_id, {}).find((s) => s.id === id));
});

router.put('/sessions/:id', requireRole(...MANAGER_ROLES), (req, res) => {
  const session = q.get('SELECT * FROM timetable_sessions WHERE id = ? AND university_id = ?', req.params.id, req.uid);
  if (!session) throw notFound('Session');
  const allocation = loadAllocationForEdit(req, session.allocation_id);
  const input = {
    roomId: toInt(req.body.room_id) || session.room_id,
    day: toInt(req.body.day_of_week) || session.day_of_week,
    start: req.body.start_time || session.start_time,
    end: req.body.end_time || session.end_time,
  };
  saveChecked(req, allocation, input, session.id);
  update('timetable_sessions', session.id, {
    room_id: input.roomId,
    day_of_week: input.day,
    start_time: input.start,
    end_time: input.end,
    generated: 0,
  });
  notify(allocation.lecturer_id, {
    title: `Timetable change: ${allocation.code}`,
    body: `${allocation.course_name} moved to ${['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][input.day]} ${input.start}-${input.end}`,
    type: 'timetable',
    link: '/my-timetable',
  });
  res.json(listSessions(req.uid, allocation.term_id, {}).find((s) => s.id === session.id));
});

router.delete('/sessions/:id', requireRole(...MANAGER_ROLES), (req, res) => {
  const session = q.get('SELECT * FROM timetable_sessions WHERE id = ? AND university_id = ?', req.params.id, req.uid);
  if (!session) throw notFound('Session');
  loadAllocationForEdit(req, session.allocation_id);
  const registers = q.get('SELECT COUNT(*) AS n FROM attendance_registers WHERE session_id = ?', session.id).n;
  if (registers && !truthy(req.query.force)) {
    throw needsConfirmation(
      `This session has ${registers} attendance register(s). Deleting it also deletes that attendance history. Continue?`,
      'SESSION_HAS_ATTENDANCE',
    );
  }
  q.run('DELETE FROM timetable_sessions WHERE id = ?', session.id);
  res.json({ ok: true });
});

/** Automatically place every unscheduled allocation of a term (Admin only - rooms are shared). */
router.post('/generate', requireRole('admin'), (req, res) => {
  const term = resolveTerm(req.uid, toInt(req.body?.term_id));
  if (!term) throw badRequest('Create an academic term first');
  if (!q.get('SELECT 1 FROM rooms WHERE university_id = ? AND active = 1', req.uid)) throw badRequest('Add at least one room first');
  const result = generateTimetable(req.uid, term.id, { clearExisting: truthy(req.body?.clear_existing) });
  const lecturers = q.all('SELECT DISTINCT lecturer_id FROM allocations WHERE term_id = ?', term.id).map((r) => r.lecturer_id);
  notify(lecturers, {
    title: `Timetable published for ${term.name}`,
    body: 'Your teaching timetable has been generated. Open "My timetable" to view it.',
    type: 'timetable',
    link: '/my-timetable',
  });
  res.json({ term, ...result });
});

/** Rooms free for a whole slot, optionally with a minimum capacity. */
router.get('/free-rooms', requireRole(...MANAGER_ROLES), (req, res) => {
  const term = resolveTerm(req.uid, toInt(req.query.term_id));
  const { day, start, end } = req.query;
  if (!term || !day || !isTime(start) || !isTime(end)) throw badRequest('term, day, start and end are required');
  const busy = q
    .all('SELECT room_id FROM timetable_sessions WHERE term_id = ? AND day_of_week = ? AND start_time < ? AND end_time > ?', term.id, toInt(day), end, start)
    .map((r) => r.room_id);
  const rooms = q.all(
    `SELECT * FROM rooms WHERE university_id = ? AND active = 1 AND capacity >= ? AND id NOT IN (${placeholders(busy)}) ORDER BY capacity, name`,
    req.uid,
    toInt(req.query.min_capacity) || 0,
    ...busy,
  );
  res.json(rooms);
});

export default router;
