// Teaching operations: missed-lecture detection and free slots for rescheduling.
import { q } from '../db.js';
import { addDays, dowOf, overlaps, toHHMM, toMinutes, zonedNow } from '../util.js';
import { notify } from './notify.js';
import { examsOn, hasEnded, noTeachingDates, occurrences } from './occurrences.js';
import { allocationContext } from './timetable.js';

/** Lectures that have ended with no attendance taken (no register for any class and no check-in). */
export function missedLectures(universityId, { from, to, departmentIds = null, lecturerId = null }) {
  const uni = q.get('SELECT timezone FROM universities WHERE id = ?', universityId);
  const now = zonedNow(uni?.timezone || 'UTC');
  const opts = { from, to };
  if (departmentIds) opts.departmentIds = departmentIds;
  if (lecturerId) opts.lecturerId = lecturerId;
  const list = occurrences(universityId, opts).filter((o) => hasEnded(o, now));
  if (!list.length) return [];
  const taken = new Set(
    q
      .all(
        `SELECT session_id || '|' || lecture_date AS k FROM attendance_registers WHERE university_id = ? AND lecture_date BETWEEN ? AND ?
         UNION SELECT session_id || '|' || lecture_date FROM checkin_sessions WHERE university_id = ? AND lecture_date BETWEEN ? AND ?`,
        universityId,
        from,
        to,
        universityId,
        from,
        to,
      )
      .map((r) => r.k),
  );
  return list.filter((o) => !taken.has(`${o.session_id}|${o.date}`));
}

/**
 * Notifies the HoD (or Dean) and the lecturer when a lecture that ended 30 minutes ago has no
 * attendance. Checks today only, so turning the feature on never sends a backlog.
 */
export function runMissedLectureAlerts(at = new Date()) {
  let sent = 0;
  for (const uni of q.all('SELECT id, timezone FROM universities WHERE active = 1')) {
    const now = zonedNow(uni.timezone, at);
    for (const o of missedLectures(uni.id, { from: now.date, to: now.date })) {
      if (now.minutes < toMinutes(o.end_time) + 30) continue;
      const lead = q.get(
        'SELECT d.hod_id, f.dean_id FROM departments d JOIN faculties f ON f.id = d.faculty_id WHERE d.id = ?',
        o.department_id,
      );
      const body = `${o.course_code} ${o.course_name}, ${o.start_time}-${o.end_time} in ${o.room_name} (${o.lecturer_name}): no attendance was taken.`;
      sent += notify([lead?.hod_id || lead?.dean_id].filter(Boolean), {
        title: 'Lecture with no attendance',
        body,
        type: 'missed',
        link: '/reports?tab=missed',
        dedupeKey: `missed:${o.session_id}:${o.date}`,
      });
      sent += notify(o.lecturer_id, {
        title: `No attendance for ${o.course_code} today`,
        body: 'If the lecture took place, ask the class rep to submit the register, or reschedule it if it did not.',
        type: 'missed',
        link: '/my-timetable',
        dedupeKey: `missed-lecturer:${o.session_id}:${o.date}`,
      });
    }
  }
  return sent;
}

/** Free slots (date, time, room) for moving an occurrence, over the next teaching days. */
export function suggestSlots(universityId, occ, { from, days = 14, limit = 8 } = {}) {
  const uni = q.get('SELECT * FROM universities WHERE id = ?', universityId);
  const now = zonedNow(uni.timezone);
  const teaching = String(uni.teaching_days).split(',').map(Number);
  const dur = toMinutes(occ.end_time) - toMinutes(occ.start_time);
  const start0 = toMinutes(uni.day_start);
  const end0 = toMinutes(uni.day_end);
  const term = q.get('SELECT * FROM academic_terms WHERE id = ?', occ.term_id);
  const alloc = allocationContext(occ.allocation_id, universityId);
  const size = alloc?.size || 0;
  const classIds = new Set(occ.classes.map((c) => c.id));
  const rooms = q.all('SELECT * FROM rooms WHERE university_id = ? AND active = 1 AND capacity >= ? ORDER BY capacity, name', universityId, size);
  const first = from && from > now.date ? from : now.date;
  const blocked = noTeachingDates(universityId, first, addDays(first, days));
  const out = [];
  for (let i = 0; i <= days && out.length < limit; i++) {
    const date = addDays(first, i);
    if (term?.end_date && date > term.end_date) break;
    if (!teaching.includes(dowOf(date)) || blocked.has(date)) continue;
    const day = occurrences(universityId, { from: date, to: date }).filter((o) => !(o.session_id === occ.session_id && o.date === occ.date));
    const exams = examsOn(universityId, date);
    for (let t = start0; t + dur <= end0 && out.length < limit; t += 60) {
      const s = toHHMM(t);
      const e = toHHMM(t + dur);
      if (date === now.date && t <= now.minutes + 30) continue;
      if (uni.lunch_start && uni.lunch_end && overlaps(s, e, uni.lunch_start, uni.lunch_end)) continue;
      const busy = day.filter((o) => overlaps(s, e, o.start_time, o.end_time));
      const busyExams = exams.filter((x) => overlaps(s, e, x.start_time, x.end_time));
      if (busy.some((o) => o.lecturer_id === occ.lecturer_id || o.classes.some((c) => classIds.has(c.id)))) continue;
      if (busyExams.some((x) => x.invigilator_ids.includes(occ.lecturer_id) || x.class_ids.some((c) => classIds.has(c)))) continue;
      const taken = new Set([...busy.map((o) => o.room_id), ...busyExams.flatMap((x) => x.room_ids)]);
      const free = rooms.filter((r) => !taken.has(r.id));
      const room = free.find((r) => r.id === occ.room_id) || free[0];
      if (!room) continue;
      out.push({ date, start_time: s, end_time: e, room_id: room.id, room_name: room.name, room_building: room.building, room_capacity: room.capacity });
    }
  }
  return out;
}
