import { config } from '../config.js';
import { q } from '../db.js';
import { currentTerm, placeholders } from '../scope.js';
import { addDays, dowOf, toMinutes, zonedNow } from '../util.js';
import { notify } from './notify.js';
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
  const term = currentTerm(user.university_id);
  const prefs = notificationPrefs(user.id);
  const base = { timezone: uni?.timezone || 'UTC', enabled: Boolean(prefs.enabled), minutes_before: prefs.minutes_before, items: [] };
  if (!term) return base;
  const sessions = sessionsForUser(user, term.id);
  const now = zonedNow(base.timezone);
  for (let i = 0; i < days; i++) {
    const date = addDays(now.date, i);
    if (term.start_date && date < term.start_date) continue;
    if (term.end_date && date > term.end_date) break;
    const dow = dowOf(date);
    for (const s of sessions) {
      if (s.day_of_week !== dow) continue;
      if (i === 0 && toMinutes(s.end_time) <= now.minutes) continue;
      base.items.push({
        session_id: s.id,
        date,
        start_time: s.start_time,
        end_time: s.end_time,
        starts_at_local: `${date}T${s.start_time}:00`,
        in_progress: i === 0 && toMinutes(s.start_time) <= now.minutes,
        course_code: s.course_code,
        course_name: s.course_name,
        room_name: s.room_name,
        room_building: s.room_building,
        lecturer_name: s.lecturer_name,
        classes: s.classes,
      });
    }
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

    for (const s of listSessions(uni.id, term.id, { day: now.dow })) {
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
          dedupeKey: `reminder:${s.id}:${now.date}`,
        });
      }
    }
  }
  return sent;
}

export function startReminderLoop() {
  const tick = () => {
    try {
      runReminders();
    } catch (err) {
      console.error('[reminders]', err);
    }
  };
  tick();
  setInterval(tick, config.reminderIntervalMs).unref();
}
