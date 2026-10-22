// Personal calendar feeds (iCalendar). Phones and Google/Outlook subscribe to a secret link, so
// the feed is public but unguessable; resetting the link stops the old one.
import { Router } from 'express';
import { loadUser } from '../auth.js';
import { q } from '../db.js';
import { examsForUser } from '../services/exams.js';
import { localToUtc, occurrencesForUser } from '../services/occurrences.js';
import { KIND_LABEL, researchEventsFor } from '../services/research.js';
import { notificationPrefs } from '../services/schedule.js';
import { addDays, zonedNow } from '../util.js';

const router = Router();

const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Folds lines longer than 75 octets as RFC 5545 requires. */
function fold(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}

export function buildIcs(name, events) {
  const now = stamp(new Date());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//eCampus//Timetable//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${esc(name)}`, 'X-PUBLISHED-TTL:PT1H', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H'];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${now}`,
      `DTSTART:${stamp(e.start)}`,
      `DTEND:${stamp(e.end)}`,
      `SUMMARY:${esc(e.summary)}`,
      ...(e.location ? [`LOCATION:${esc(e.location)}`] : []),
      ...(e.description ? [`DESCRIPTION:${esc(e.description)}`] : []),
      // Reminders, for calendar apps that honour them in subscribed calendars.
      ...(e.alarms || []).flatMap((minutes) => ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(e.summary)}`, `TRIGGER:-PT${minutes}M`, 'END:VALARM']),
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

export function feedFor(user) {
  const uni = q.get('SELECT name, short_name, timezone FROM universities WHERE id = ?', user.university_id);
  const tz = uni?.timezone || 'UTC';
  const today = zonedNow(tz).date;
  const from = addDays(today, -14);
  const to = addDays(today, 150);
  const events = occurrencesForUser(user, from, to).map((o) => ({
    uid: `lecture-${o.session_id}-${o.date}@ecampus`,
    start: localToUtc(o.date, o.start_time, tz),
    end: localToUtc(o.date, o.end_time, tz),
    summary: `${o.course_code} ${o.course_name}${o.status === 'rescheduled' ? ' (rescheduled)' : ''}`,
    location: [o.room_name, o.room_building].filter(Boolean).join(', '),
    description: [
      user.role === 'student' ? `Lecturer: ${o.lecturer_name}` : `Classes: ${o.classes.map((c) => c.name).join(', ')}`,
      o.covered ? `Cover for ${o.original_lecturer_name}` : null,
      o.change_reason ? `Note: ${o.change_reason}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
  }));
  for (const e of examsForUser(user, from, to)) {
    events.push({
      uid: `exam-${e.id}-${e.duty ? 'duty' : 'sit'}@ecampus`,
      start: localToUtc(e.exam_date, e.start_time, tz),
      end: localToUtc(e.exam_date, e.end_time, tz),
      summary: `${e.duty ? 'Invigilate: ' : 'Exam: '}${e.course_code} ${e.course_name}`,
      location: e.rooms.map((r) => r.name).join(', '),
      description: e.duty ? `Room: ${e.duty_room || e.rooms.map((r) => r.name).join(', ')}` : 'Bring your student ID.',
    });
  }
  const prefs = notificationPrefs(user.id);
  const alarms = prefs.research_enabled ? [prefs.research_day_before ? 1440 : null, prefs.research_minutes_before].filter(Boolean) : [];
  for (const e of researchEventsFor(user, from, to)) {
    const start = localToUtc(e.at.slice(0, 10), e.at.slice(11, 16) || '09:00', tz);
    events.push({
      uid: `research-${e.type}-${e.project.id}@ecampus`,
      start,
      end: new Date(start.getTime() + e.minutes * 60000),
      summary: `${e.title}`,
      location: e.venue || '',
      description: [`${KIND_LABEL[e.project.kind]}: ${e.project.title}`, e.panel ? `Panel: ${e.panel}` : null].filter(Boolean).join('\n'),
      alarms,
    });
  }
  return buildIcs(`${uni?.short_name || uni?.name || 'eCampus'} timetable`, events);
}

router.get('/:file', (req, res) => {
  const token = String(req.params.file).replace(/\.ics$/i, '');
  const row = token.length >= 20 ? q.get('SELECT id FROM users WHERE calendar_token = ? AND active = 1', token) : null;
  if (!row) return res.status(404).type('text/plain').send('Calendar not found. Copy a new link from eCampus.');
  const user = loadUser(row.id);
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Cache-Control', 'private, max-age=900');
  res.send(feedFor(user));
});

export default router;
