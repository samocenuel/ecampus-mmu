// QR check-in. The lecturer's screen shows a code that changes every STEP_SECONDS; a student's
// app scans it. Each phone checks in one student per lecture and each student is tied to one
// registered phone (one automatic change per term). Closing a check-in writes the registers.
import crypto from 'node:crypto';
import { insert, q, tx } from '../db.js';
import { currentTerm, placeholders } from '../scope.js';
import { addDays, HttpError } from '../util.js';
import { notify } from './notify.js';
import { occurrenceOn, teacherOf } from './occurrences.js';

export const STEP_SECONDS = 15;
const PREFIX = 'EC1';
const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const stepAt = (ms) => Math.floor(ms / 1000 / STEP_SECONDS);
const sign = (secret, id, step) => crypto.createHmac('sha256', secret).update(`${id}.${step}`).digest('base64url').slice(0, 16);

/** The text encoded in the QR code right now. */
export function currentCode(cs, at = Date.now()) {
  const step = stepAt(at);
  return { code: `${PREFIX}.${cs.id}.${step}.${sign(cs.secret, cs.id, step)}`, expires_in: STEP_SECONDS - (Math.floor(at / 1000) % STEP_SECONDS) };
}

export function parseCode(code) {
  const parts = String(code || '').trim().split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const id = Number(parts[1]);
  const step = Number(parts[2]);
  if (!Number.isInteger(id) || !Number.isInteger(step)) return null;
  return { id, step, sig: parts[3] };
}

/** Distance in metres between two coordinates. */
export function distanceM(lat1, lon1, lat2, lon2) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(a));
}

export function flag(universityId, checkinSessionId, studentId, deviceId, kind, detail) {
  insert('checkin_flags', { university_id: universityId, checkin_session_id: checkinSessionId, student_id: studentId, device_id: deviceId || null, kind, detail: detail || null });
}

export function loadCheckin(universityId, id) {
  const cs = q.get('SELECT * FROM checkin_sessions WHERE id = ? AND university_id = ?', id, universityId);
  if (!cs) throw new HttpError(404, 'Check-in not found');
  return cs;
}

/** Opens (or returns the open) check-in for a lecture occurrence. */
export function startCheckin(user, occ) {
  const existing = q.get('SELECT * FROM checkin_sessions WHERE session_id = ? AND lecture_date = ?', occ.session_id, occ.date);
  if (existing) {
    if (existing.closed_at) q.run('UPDATE checkin_sessions SET closed_at = NULL, closed_by = NULL WHERE id = ?', existing.id);
    return q.get('SELECT * FROM checkin_sessions WHERE id = ?', existing.id);
  }
  const id = insert('checkin_sessions', {
    university_id: user.university_id,
    session_id: occ.session_id,
    lecture_date: occ.date,
    secret: crypto.randomBytes(32).toString('hex'),
    started_by: user.id,
  });
  return q.get('SELECT * FROM checkin_sessions WHERE id = ?', id);
}

/**
 * Validates a student's scan and records it. `scannedAt` lets a phone that was offline send the
 * scan later; the code must still have been valid at that moment.
 */
export function scan(student, { code, deviceId, scannedAt, latitude, longitude }) {
  const reject = (status, message, kind, cs) => {
    if (kind) flag(student.university_id, cs?.id ?? null, student.id, deviceId, kind, message);
    throw new HttpError(status, message, { code: kind || 'invalid' });
  };
  if (student.role !== 'student') throw new HttpError(403, 'Only students check in to lectures');
  if (!deviceId || String(deviceId).length < 8 || String(deviceId).length > 128) throw new HttpError(400, 'This app version cannot check in; please update eCampus');
  const parsed = parseCode(code);
  if (!parsed) throw new HttpError(400, 'That QR code is not an eCampus check-in code');
  const cs = q.get('SELECT * FROM checkin_sessions WHERE id = ? AND university_id = ?', parsed.id, student.university_id);
  if (!cs) throw new HttpError(400, 'That check-in code is not for your university');

  const now = Date.now();
  let at = scannedAt ? Date.parse(scannedAt) : now;
  if (!Number.isFinite(at) || at > now + 60_000) at = now;
  const startedMs = Date.parse(`${cs.started_at.replace(' ', 'T')}Z`);
  const closedMs = cs.closed_at ? Date.parse(`${cs.closed_at.replace(' ', 'T')}Z`) : null;
  if (at < startedMs - 30_000 || (closedMs && at > closedMs + 30_000)) reject(400, 'This check-in is closed', 'closed', cs);
  if (now - at > 6 * 3600_000) reject(400, 'This scan is too old to be accepted', 'expired', cs);
  const step = stepAt(at);
  if (Math.abs(parsed.step - step) > 1 || sign(cs.secret, cs.id, parsed.step) !== parsed.sig) {
    reject(400, 'The code has changed; scan the screen again', 'expired_code', cs);
  }

  const occ = occurrenceOn(student.university_id, cs.session_id, cs.lecture_date);
  const cls = occ?.classes.find((c) => c.id === student.class_id);
  if (!occ || !cls) reject(403, 'Your class does not attend this lecture', 'not_in_class', cs);

  const uni = q.get('SELECT * FROM universities WHERE id = ?', student.university_id);
  if (uni.checkin_radius_m > 0 && uni.checkin_latitude != null && uni.checkin_longitude != null) {
    if (latitude == null || longitude == null) reject(400, 'Turn on location to check in: your university checks you are on campus');
    const d = distanceM(Number(latitude), Number(longitude), uni.checkin_latitude, uni.checkin_longitude);
    if (d > uni.checkin_radius_m) reject(403, `You appear to be ${Math.round(d)} m from campus; check in from the lecture room`, 'outside_area', cs);
  }

  const already = q.get('SELECT * FROM checkins WHERE checkin_session_id = ? AND student_id = ?', cs.id, student.id);
  if (already) return { ok: true, already: true, course_code: occ.course_code, class_name: cls.name };

  // One registered phone per student; one automatic change per term.
  const term = currentTerm(student.university_id);
  const owner = q.get('SELECT user_id FROM student_devices WHERE device_id = ?', deviceId);
  if (owner && owner.user_id !== student.id) reject(403, 'This phone is registered to another student', 'device_belongs_to_other', cs);
  const mine = q.get('SELECT * FROM student_devices WHERE user_id = ?', student.id);
  let changed = false;
  if (!mine) {
    insert('student_devices', { user_id: student.id, device_id: deviceId });
  } else if (mine.device_id !== deviceId) {
    if (term && mine.changed_in_term_id === term.id) {
      reject(403, 'Your account is registered to another phone. Ask your HoD or administrator to reset it if you changed phones.', 'device_other_account', cs);
    }
    q.run("UPDATE student_devices SET device_id = ?, registered_at = datetime('now'), changed_in_term_id = ? WHERE user_id = ?", deviceId, term?.id ?? null, student.id);
    changed = true;
  }
  if (q.get("SELECT 1 FROM checkins WHERE checkin_session_id = ? AND device_id = ? AND method = 'qr'", cs.id, deviceId)) {
    reject(409, 'This phone has already checked in a student for this lecture', 'device_used', cs);
  }

  insert('checkins', {
    checkin_session_id: cs.id,
    student_id: student.id,
    class_id: cls.id,
    method: 'qr',
    device_id: deviceId,
    latitude: latitude ?? null,
    longitude: longitude ?? null,
    scanned_at: new Date(at).toISOString().replace('T', ' ').slice(0, 19),
  });
  // A scan made before closing but sent later (phone was offline) still updates the register.
  if (cs.closed_at) closeCheckin(cs);
  if (changed) {
    notify(student.id, {
      title: 'eCampus registered your new phone',
      body: 'Check-ins now work from this phone only. If this was not you, contact your HoD.',
      type: 'security',
    });
  }
  return { ok: true, course_code: occ.course_code, course_name: occ.course_name, class_name: cls.name, phone_changed: changed };
}

/** Manual marks a student has had this term (lecturer or class rep, e.g. a flat battery). */
export function manualMarksThisTerm(student) {
  const term = currentTerm(student.university_id);
  if (!term) return 0;
  return q.get(
    `SELECT COUNT(*) AS n FROM checkins ch JOIN checkin_sessions cs ON cs.id = ch.checkin_session_id
      WHERE ch.student_id = ? AND ch.method = 'manual' AND cs.lecture_date BETWEEN ? AND ?`,
    student.id,
    term.start_date || '0000-01-01',
    term.end_date || '9999-12-31',
  ).n;
}

export function markManually(actor, cs, studentId, reason) {
  const student = q.get("SELECT * FROM users WHERE id = ? AND university_id = ? AND role = 'student' AND active = 1", studentId, actor.university_id);
  if (!student) throw new HttpError(404, 'Student not found');
  const occ = occurrenceOn(actor.university_id, cs.session_id, cs.lecture_date);
  const cls = occ?.classes.find((c) => c.id === student.class_id);
  if (!cls) throw new HttpError(400, `${student.name} is not in a class that attends this lecture`);
  if (!String(reason || '').trim()) throw new HttpError(400, 'Say why the student is marked manually (e.g. flat battery)');
  if (q.get('SELECT 1 FROM checkins WHERE checkin_session_id = ? AND student_id = ?', cs.id, student.id)) throw new HttpError(409, `${student.name} is already checked in`);
  insert('checkins', { checkin_session_id: cs.id, student_id: student.id, class_id: cls.id, method: 'manual', reason: String(reason).trim(), marked_by: actor.id });

  const uni = q.get('SELECT manual_mark_limit FROM universities WHERE id = ?', actor.university_id);
  const count = manualMarksThisTerm(student);
  if (uni.manual_mark_limit > 0 && count > uni.manual_mark_limit) {
    const hod = q.get(
      `SELECT d.hod_id FROM classes c JOIN programs p ON p.id = c.program_id JOIN departments d ON d.id = p.department_id WHERE c.id = ?`,
      student.class_id,
    )?.hod_id;
    notify(hod, {
      title: 'Frequent manual attendance marks',
      body: `${student.name} (${student.identifier || 'no reg. no.'}) has been marked present manually ${count} times this term (limit ${uni.manual_mark_limit}).`,
      type: 'attendance',
      link: `/users`,
      dedupeKey: `manual:${student.id}:${count}`,
    });
  }
  return { count, limit: uni.manual_mark_limit };
}

/** Writes each class's register from the check-ins and closes the check-in. */
export function closeCheckin(cs, actorId = null) {
  const occ = occurrenceOn(cs.university_id, cs.session_id, cs.lecture_date);
  return tx(() => {
    q.run('UPDATE checkin_sessions SET closed_at = COALESCE(closed_at, ?), closed_by = COALESCE(closed_by, ?) WHERE id = ?', nowSql(), actorId, cs.id);
    if (!occ) return { registers: 0 };
    const marks = new Map(q.all('SELECT student_id, method FROM checkins WHERE checkin_session_id = ?', cs.id).map((c) => [c.student_id, c.method]));
    const reviewer = actorId || teacherOf(cs.session_id, cs.lecture_date, occ.lecturer_id);
    let registers = 0;
    for (const cls of occ.classes) {
      const students = q.all("SELECT id FROM users WHERE class_id = ? AND role = 'student' AND active = 1", cls.id).map((r) => r.id);
      const selfCount = students.filter((id) => marks.get(id) === 'qr').length;
      let reg = q.get('SELECT * FROM attendance_registers WHERE session_id = ? AND class_id = ? AND lecture_date = ?', cs.session_id, cls.id, cs.lecture_date);
      const earlier = new Map(reg ? q.all('SELECT student_id, present, method FROM attendance_records WHERE register_id = ?', reg.id).map((r) => [r.student_id, r]) : []);
      const fields = {
        status: 'approved',
        source: 'qr',
        self_checkins: selfCount,
        reviewed_by: reviewer,
        reviewed_at: nowSql(),
        review_note: reg?.review_note || 'Recorded by QR check-in',
      };
      if (reg) {
        q.run(
          `UPDATE attendance_registers SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
          ...Object.values(fields),
          reg.id,
        );
      } else {
        const id = insert('attendance_registers', {
          university_id: cs.university_id,
          session_id: cs.session_id,
          class_id: cls.id,
          lecture_date: cs.lecture_date,
          submitted_by: cs.started_by,
          ...fields,
        });
        reg = { id };
      }
      q.run('DELETE FROM attendance_records WHERE register_id = ?', reg.id);
      for (const sid of students) {
        const m = marks.get(sid);
        const old = earlier.get(sid);
        const present = m ? 1 : old?.present ? 1 : 0;
        q.run('INSERT INTO attendance_records (register_id, student_id, present, method) VALUES (?, ?, ?, ?)', reg.id, sid, present, m || (old?.present ? old.method || 'rep' : null));
      }
      registers++;
    }
    return { registers };
  });
}

/** Closes check-ins left open an hour after their lecture ended. */
export function autoCloseCheckins(universityId, now) {
  let closed = 0;
  for (const cs of q.all('SELECT * FROM checkin_sessions WHERE university_id = ? AND closed_at IS NULL AND lecture_date <= ?', universityId, now.date)) {
    const occ = occurrenceOn(universityId, cs.session_id, cs.lecture_date);
    const [h, m] = (occ?.end_time || '00:00').split(':').map(Number);
    if (cs.lecture_date < now.date || now.minutes >= h * 60 + m + 60) {
      closeCheckin(cs, null);
      closed++;
    }
  }
  return closed;
}

export { addDays, placeholders };
