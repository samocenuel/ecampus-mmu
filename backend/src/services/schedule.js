import { config } from '../config.js';
import { q } from '../db.js';
import { currentTerm, placeholders } from '../scope.js';
import { addDays, dowOf, toMinutes, zonedNow } from '../util.js';
import { autoCloseCheckins } from './checkin.js';
import { notify } from './notify.js';
import { localToUtc, occurrences, occurrencesForUser } from './occurrences.js';
import { runMissedLectureAlerts } from './ops.js';
import { researchEventsFor, participantsOf } from './research.js';
import { runAccountPurge } from './people.js';
import { rolloverAll } from './rollover.js';
import { listSessions } from './timetable.js';

/** Weekly sessions relevant to a user: what they teach (staff) or attend (students). */
export function sessionsForUser(user, termId) {
  if (!termId) return [];
  if (user.role === 'student') return user.class_id ? listSessions(user.university_id, termId, { classId: user.class_id }) : [];
  if (['lecturer', 'hod', 'dean'].includes(user.role)) return listSessions(user.university_id, termId, { lecturerId: user.id });
  return [];
}

export function notificationPrefs(userId) {
  return (
    q.get('SELECT enabled, minutes_before, research_enabled, research_day_before, research_minutes_before FROM notification_prefs WHERE user_id = ?', userId) || {
      enabled: 1,
      minutes_before: 15,
      research_enabled: 1,
      research_day_before: 1,
      research_minutes_before: 60,
    }
  );
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
  base.research_enabled = Boolean(prefs.research_enabled);
  base.research_day_before = Boolean(prefs.research_day_before);
  base.research_minutes_before = prefs.research_minutes_before;
  base.events = researchEventsFor(user, now.date, addDays(now.date, days - 1)).map((e) => ({
    type: e.type,
    project_id: e.project.id,
    title: e.title,
    work_title: e.project.title,
    starts_at_local: `${e.at.slice(0, 10)}T${e.at.slice(11, 16) || '09:00'}:00`,
    venue: e.venue || null,
  }));
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

/**
 * Reminders for concept presentations and defences: the day before and shortly before, as each
 * participant chose under Notifications. Each fires once per person per event and time, so a
 * rescheduled event reminds again for its new time.
 */
export function runResearchReminders(at = new Date()) {
  for (const uni of q.all('SELECT id, timezone FROM universities WHERE active = 1')) {
    const today = zonedNow(uni.timezone || 'UTC', at).date;
    const anyone = { university_id: uni.id, role: 'admin', id: 0 };
    for (const e of researchEventsFor(anyone, today, addDays(today, 1))) {
      const start = localToUtc(e.at.slice(0, 10), e.at.slice(11, 16) || '09:00', uni.timezone || 'UTC');
      const left = (start.getTime() - at.getTime()) / 60000;
      if (left <= 0) continue;
      for (const uid of participantsOf(e.project)) {
        const prefs = notificationPrefs(uid);
        if (!prefs.research_enabled) continue;
        const when = `${e.at.slice(11, 16)}${e.venue ? ` in ${e.venue}` : ''}`;
        if (left <= prefs.research_minutes_before) {
          notify(uid, { title: `Starting soon: ${e.title}`, body: `${when}. ${e.project.title}`, type: 'research', link: `/research/${e.project.id}`, dedupeKey: `research:${e.type}:${e.project.id}:${e.at}:soon` });
        } else if (prefs.research_day_before && left <= 1440) {
          notify(uid, { title: `Tomorrow: ${e.title}`, body: `${e.at.slice(0, 10)} ${when}. ${e.project.title}`, type: 'research', link: `/research/${e.project.id}`, dedupeKey: `research:${e.type}:${e.project.id}:${e.at}:day` });
        }
      }
    }
  }
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
      if (ticks % 10 === 0) runMissedLectureAlerts();
    } catch (err) {
      console.error('[operations]', err);
    }
    // Terms follow their dates, classes move up at the start of a new academic year, and each
    // semester's allocations are drafted from last year (checked at start-up, then hourly).
    if (ticks % 60 === 0) rolloverAll();
    // Archived accounts are erased once their archive period ends (checked hourly).
    if (ticks % 60 === 0) {
      try {
        runAccountPurge();
      } catch (err) {
        console.error('[account purge]', err);
      }
    }
    try {
      runResearchReminders();
    } catch (err) {
      console.error('[research reminders]', err);
    }
    ticks++;
  };
  tick();
  setInterval(tick, config.reminderIntervalMs).unref();
}
