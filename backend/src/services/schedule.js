import { config } from '../config.js';
import { q } from '../db.js';
import { currentTerm, placeholders } from '../scope.js';
import { addDays, dowOf, toMinutes, zonedNow } from '../util.js';
import { autoCloseCheckins } from './checkin.js';
import { notify } from './notify.js';
import { occurrences, occurrencesForUser } from './occurrences.js';
import { runMissedLectureAlerts } from './ops.js';
import { listSessions } from './timetable.js';

/** Weekly sessions relevant to a user: what they teach (staff) or attend (students). */
export function sessionsForUser(user, termId) {
  if (!termId) return [];
  if (user.role === 'student') return user.class_id ? listSessions(user.university_id, termId, { classId: user.class_id }) : [];
  if (['lecturer', 'hod', 'dean'].includes(user.role)) return listSessions(user.university_id, termId, { lecturerId: user.id });
  return [];
}

export function notificationPrefs(userId) {
  return q.get('SELECT enabled, minutes_before FROM notification_prefs WHERE user_id = ?', userId) || { enabled: 1, minutes_before: 15 };
}

/** Concrete lecture occurrences for the next `days` days, in the university's local time. */
export function upcomingForUser(user, days = 7) {
  const uni = q.get('SELECT timezone FROM universities WHERE id = ?', user.university_id);
  const prefs = notificationPrefs(user.id);
  const base = { timezone: uni?.timezone || 'UTC', enabled: Boolean(prefs.enabled), minutes_before: prefs.minutes_before, items: [] };
  const now = zonedNow(base.timezone);
  for (const o of occurrencesForUser(user, now.date, addDays(now.date, days - 1))) {
    if (o.date === now.date && toMinutes(o.end_time) <= now.minutes) continue;
    base.items.push({
      session_id: o.session_id,
      date: o.date,
      start_time: o.start_time,
      end_time: o.end_time,
      starts_at_local: `${o.date}T${o.start_time}:00`,
      in_progress: o.date === now.date && toMinutes(o.start_time) <= now.minutes,
      course_code: o.course_code,
      course_name: o.course_name,
      room_name: o.room_name,
      room_building: o.room_building,
      lecturer_name: o.lecturer_name,
      classes: o.classes,
      status: o.status,
      covered: o.covered,
      original_date: o.original_date || null,
    });
  }
  return base;
}

/**
 * Create "lecture starting soon" notifications for lecturers and students
 * according to each user's reminder preference. Idempotent per user, session
 * and date, so it is safe to run every minute.
 */
export function runReminders(at = new Date()) {
  let sent = 0;
  for (const uni of q.all('SELECT id, timezone FROM universities WHERE active = 1')) {
    const term = q.get('SELECT * FROM academic_terms WHERE university_id = ? AND is_current = 1', uni.id);
    if (!term) continue;
    const now = zonedNow(uni.timezone, at);
    if ((term.start_date && now.date < term.start_date) || (term.end_date && now.date > term.end_date)) continue;

    for (const s of occurrences(uni.id, { from: now.date, to: now.date })) {
      const until = toMinutes(s.start_time) - now.minutes;
      if (until <= 0 || until > 120) continue;
      const classIds = s.classes.map((c) => c.id);
      const people = q.all(
        `SELECT u.id, COALESCE(np.enabled, 1) AS enabled, COALESCE(np.minutes_before, 15) AS minutes_before
           FROM users u LEFT JOIN notification_prefs np ON np.user_id = u.id
          WHERE u.active = 1 AND (u.id = ? OR (u.role = 'student' AND u.class_id IN (${placeholders(classIds)})))`,
        s.lecturer_id,
        ...classIds,
      );
      for (const p of people) {
        if (!p.enabled || until > p.minutes_before) continue;
        sent += notify(p.id, {
          title: `${s.course_code} starts in ${until} min`,
          body: `${s.course_name} - ${s.start_time} to ${s.end_time} in ${s.room_name}${s.room_building ? `, ${s.room_building}` : ''}`,
          type: 'reminder',
          link: '/my-timetable',
          dedupeKey: `reminder:${s.session_id}:${now.date}`,
        });
      }
    }
  }
  return sent;
}

export function startReminderLoop() {
  let ticks = 0;
  const tick = () => {
    try {
      runReminders();
    } catch (err) {
      console.error('[reminders]', err);
    }
    try {
      for (const uni of q.all('SELECT id, timezone FROM universities WHERE active = 1')) autoCloseCheckins(uni.id, zonedNow(uni.timezone));
      if (ticks++ % 10 === 0) runMissedLectureAlerts();
    } catch (err) {
      console.error('[operations]', err);
    }
  };
  tick();
  setInterval(tick, config.reminderIntervalMs).unref();
}
