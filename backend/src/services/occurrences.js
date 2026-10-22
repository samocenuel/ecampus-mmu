// Dated lecture occurrences: the weekly timetable applied to real dates, after the academic
// calendar (no teaching on holidays), cancellations and moves, and cover lecturers for staff
// on approved leave. Attendance, reminders, check-in, calendars and claims all use this.
import { q } from '../db.js';
import { placeholders } from '../scope.js';
import { addDays, dowOf, overlaps, toMinutes, zonedNow } from '../util.js';
import { listSessions } from './timetable.js';

export const ACTIVE = new Set(['scheduled', 'rescheduled']);

/** Dates in [from, to] on which no lectures are held (holidays, recess, exam weeks...). */
export function noTeachingDates(universityId, from, to) {
  const out = new Map();
  for (const e of q.all(
    'SELECT * FROM calendar_events WHERE university_id = ? AND no_teaching = 1 AND start_date <= ? AND end_date >= ?',
    universityId,
    to,
    from,
  )) {
    for (let d = e.start_date < from ? from : e.start_date; d <= e.end_date && d <= to; d = addDays(d, 1)) {
      if (!out.has(d)) out.set(d, e);
    }
  }
  return out;
}

function termsBetween(universityId, from, to, termId) {
  if (termId) return q.all('SELECT * FROM academic_terms WHERE id = ? AND university_id = ?', termId, universityId);
  return q.all(
    `SELECT * FROM academic_terms WHERE university_id = ?
        AND (start_date IS NULL OR start_date <= ?) AND (end_date IS NULL OR end_date >= ?)`,
    universityId,
    to,
    from,
  );
}

/**
 * Lecture occurrences between two dates (inclusive). Filters: lecturerId (the lecturer actually
 * teaching, so covers count), classId / classIds, departmentIds, roomId, sessionId, termId.
 * With includeInactive, cancelled, moved-away and covered-by-someone-else occurrences are
 * returned too (with their status) so timetables can show them.
 */
export function occurrences(universityId, { from, to, termId, lecturerId, classId, classIds, departmentIds, roomId, sessionId, includeInactive = false } = {}) {
  const out = [];
  const terms = termsBetween(universityId, from, to, termId);
  if (!terms.length) return out;
  const blocked = noTeachingDates(universityId, from, to);
  const rooms = new Map(q.all('SELECT id, name, building, capacity FROM rooms WHERE university_id = ?', universityId).map((r) => [r.id, r]));

  const changes = q.all(
    `SELECT * FROM session_changes WHERE university_id = ?
        AND ((original_date BETWEEN ? AND ?) OR (new_date BETWEEN ? AND ?))`,
    universityId,
    from,
    to,
    from,
    to,
  );
  const changeOf = new Map(changes.map((c) => [`${c.session_id}|${c.original_date}`, c]));
  // Covers come from approved leave, keyed by the date the lecture actually happens.
  const covers = new Map(
    q
      .all(
        `SELECT lc.session_id, lc.lecture_date, lc.substitute_id, u.name AS substitute_name, u.title AS substitute_title
           FROM leave_covers lc JOIN leave_requests lr ON lr.id = lc.leave_id JOIN users u ON u.id = lc.substitute_id
          WHERE lr.university_id = ? AND lr.status = 'approved' AND lc.lecture_date BETWEEN ? AND ?`,
        universityId,
        from,
        to,
      )
      .map((c) => [`${c.session_id}|${c.lecture_date}`, c]),
  );

  for (const term of terms) {
    const filters = {};
    if (classId) filters.classId = classId;
    if (classIds) filters.classIds = classIds;
    if (departmentIds) filters.departmentIds = departmentIds;
    let sessions = listSessions(universityId, term.id, filters);
    if (lecturerId) {
      const coveredByMe = new Set([...covers.values()].filter((c) => c.substitute_id === Number(lecturerId)).map((c) => c.session_id));
      sessions = sessions.filter((s) => s.lecturer_id === Number(lecturerId) || coveredByMe.has(s.id));
    }
    if (sessionId) sessions = sessions.filter((s) => s.id === Number(sessionId));
    if (!sessions.length) continue;
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const first = term.start_date && term.start_date > from ? term.start_date : from;
    const last = term.end_date && term.end_date < to ? term.end_date : to;

    const make = (s, date, extra = {}) => {
      const room = rooms.get(extra.room_id ?? s.room_id) || {};
      const cover = covers.get(`${s.id}|${date}`);
      return {
        key: `${s.id}:${date}`,
        session_id: s.id,
        allocation_id: s.allocation_id,
        term_id: s.term_id,
        date,
        day_of_week: dowOf(date),
        start_time: s.start_time,
        end_time: s.end_time,
        room_id: s.room_id,
        course_unit_id: s.course_unit_id,
        course_code: s.course_code,
        course_name: s.course_name,
        is_cross_cutting: s.is_cross_cutting,
        department_id: s.department_id,
        classes: s.classes,
        original_lecturer_id: s.lecturer_id,
        original_lecturer_name: s.lecturer_name,
        lecturer_id: cover ? cover.substitute_id : s.lecturer_id,
        lecturer_name: cover ? cover.substitute_name : s.lecturer_name,
        lecturer_title: cover ? cover.substitute_title : s.lecturer_title,
        covered: Boolean(cover),
        status: 'scheduled',
        ...extra,
        room_name: room.name,
        room_building: room.building,
        room_capacity: room.capacity,
      };
    };

    for (let date = first; date <= last; date = addDays(date, 1)) {
      const dow = dowOf(date);
      const closed = blocked.get(date);
      for (const s of sessions) {
        if (s.day_of_week !== dow) continue;
        const change = changeOf.get(`${s.id}|${date}`);
        if (change?.action === 'move') {
          if (includeInactive) out.push(make(s, date, { status: 'moved', change_id: change.id, change_reason: change.reason, moved_to: { date: change.new_date, start_time: change.new_start, end_time: change.new_end } }));
          continue;
        }
        if (change?.action === 'cancel') {
          if (includeInactive) out.push(make(s, date, { status: 'cancelled', change_id: change.id, change_reason: change.reason }));
          continue;
        }
        if (closed) {
          if (includeInactive) out.push(make(s, date, { status: 'no_teaching', change_reason: closed.title }));
          continue;
        }
        out.push(make(s, date));
      }
    }
    // Lectures moved into the range (from any original date).
    for (const c of changes) {
      if (c.action !== 'move' || !c.new_date || c.new_date < first || c.new_date > last) continue;
      const s = byId.get(c.session_id);
      if (!s) continue;
      out.push(
        make(s, c.new_date, {
          status: 'rescheduled',
          start_time: c.new_start,
          end_time: c.new_end,
          room_id: c.new_room_id ?? s.room_id,
          change_id: c.id,
          change_reason: c.reason,
          original_date: c.original_date,
        }),
      );
    }
  }

  let list = out;
  if (lecturerId) {
    const me = Number(lecturerId);
    list = list.filter((o) => o.lecturer_id === me || (includeInactive && o.original_lecturer_id === me));
    if (includeInactive) for (const o of list) if (o.covered && o.original_lecturer_id === me && o.lecturer_id !== me) o.status = 'covered';
  }
  if (roomId) list = list.filter((o) => o.room_id === Number(roomId));
  return list.sort((a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time) || a.course_code.localeCompare(b.course_code));
}

/** The active occurrence of a session on a date (after moves, cancellations and holidays), or null. */
export function occurrenceOn(universityId, sessionId, date) {
  return occurrences(universityId, { from: date, to: date, sessionId }).find((o) => o.session_id === Number(sessionId) && o.date === date) || null;
}

/** Who teaches a session on a date: the cover lecturer if one was assigned for approved leave. */
export function teacherOf(sessionId, date, defaultLecturerId) {
  const cover = q.get(
    `SELECT lc.substitute_id FROM leave_covers lc JOIN leave_requests lr ON lr.id = lc.leave_id
      WHERE lc.session_id = ? AND lc.lecture_date = ? AND lr.status = 'approved'`,
    sessionId,
    date,
  );
  return cover ? cover.substitute_id : defaultLecturerId;
}

/** Occurrences a user is involved in: what they teach (including covers) or attend as a student. */
export function occurrencesForUser(user, from, to, opts = {}) {
  if (user.role === 'student') return user.class_id ? occurrences(user.university_id, { from, to, classId: user.class_id, ...opts }) : [];
  if (['lecturer', 'hod', 'dean'].includes(user.role)) return occurrences(user.university_id, { from, to, lecturerId: user.id, ...opts });
  return [];
}

/** Exams on a date with the classes sitting them, their rooms and invigilators. */
export function examsOn(universityId, date, excludeExamId = null) {
  const exams = q.all(
    `SELECT e.*, cu.code AS course_code, cu.name AS course_name FROM exams e JOIN course_units cu ON cu.id = e.course_unit_id
      WHERE e.university_id = ? AND e.exam_date = ? AND e.id <> ?`,
    universityId,
    date,
    excludeExamId ?? -1,
  );
  for (const e of exams) {
    e.class_ids = examClassIds(e.term_id, e.course_unit_id);
    e.room_ids = q.all('SELECT room_id FROM exam_rooms WHERE exam_id = ?', e.id).map((r) => r.room_id);
    e.invigilator_ids = q.all('SELECT user_id FROM exam_invigilators WHERE exam_id = ?', e.id).map((r) => r.user_id);
  }
  return exams;
}

/** Classes that sit a course unit's exam: every class it is taught to that term. */
export function examClassIds(termId, courseUnitId) {
  return q
    .all(
      `SELECT DISTINCT ac.class_id FROM allocations a JOIN allocation_classes ac ON ac.allocation_id = a.id
        WHERE a.term_id = ? AND a.course_unit_id = ?`,
      termId,
      courseUnitId,
    )
    .map((r) => r.class_id);
}

/**
 * Hard clashes for something happening on `date` from `start` to `end`: rooms, people (as the
 * lecturer of a lecture or an invigilator) and classes, against lectures and exams that day.
 */
export function clashesOn(universityId, date, start, end, { roomIds = [], personIds = [], classIds = [], excludeOccurrence = null, excludeExamId = null } = {}) {
  const messages = [];
  const rooms = new Set(roomIds.map(Number));
  const people = new Set(personIds.map(Number));
  const classes = new Set(classIds.map(Number));
  for (const o of occurrences(universityId, { from: date, to: date })) {
    if (excludeOccurrence && o.session_id === excludeOccurrence.session_id && o.date === excludeOccurrence.date) continue;
    if (!overlaps(start, end, o.start_time, o.end_time)) continue;
    const what = `${o.course_code} (${o.start_time}-${o.end_time})`;
    if (rooms.has(o.room_id)) messages.push({ type: 'room', message: `${o.room_name} is in use for ${what}` });
    if (people.has(o.lecturer_id)) messages.push({ type: 'person', message: `${o.lecturer_name} is teaching ${what}` });
    const shared = o.classes.filter((c) => classes.has(c.id));
    if (shared.length) messages.push({ type: 'class', message: `${shared.map((c) => c.name).join(', ')} ${shared.length > 1 ? 'have' : 'has'} ${what}` });
  }
  for (const e of examsOn(universityId, date, excludeExamId)) {
    if (!overlaps(start, end, e.start_time, e.end_time)) continue;
    const what = `the ${e.course_code} exam (${e.start_time}-${e.end_time})`;
    if (e.room_ids.some((r) => rooms.has(r))) messages.push({ type: 'room', message: `A room is booked for ${what}` });
    if (e.invigilator_ids.some((p) => people.has(p))) messages.push({ type: 'person', message: `An invigilator is already on ${what}` });
    if (e.class_ids.some((c) => classes.has(c))) messages.push({ type: 'class', message: `A class is sitting ${what}` });
  }
  return messages;
}

/** The UTC instant of a local date and time in a time zone. */
export function localToUtc(date, hhmm, timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const local = zonedNow(timeZone, new Date(guess));
  const [ly, lm, ld] = local.date.split('-').map(Number);
  const offset = Date.UTC(ly, lm - 1, ld) + local.minutes * 60000 - guess;
  return new Date(guess - offset);
}

/** True once an occurrence's end time has passed in the university's time zone. */
export function hasEnded(occ, now) {
  return occ.date < now.date || (occ.date === now.date && toMinutes(occ.end_time) <= now.minutes);
}

export { placeholders };
