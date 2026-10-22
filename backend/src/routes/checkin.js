// QR check-in: lecturers open a check-in and show the rotating code; students scan it.
import { Router } from 'express';
import { MANAGER_ROLES } from '../auth.js';
import { q } from '../db.js';
import { canManageDepartment, placeholders } from '../scope.js';
import { closeCheckin, currentCode, flag, loadCheckin, manualMarksThisTerm, markManually, scan, startCheckin } from '../services/checkin.js';
import { occurrenceOn, occurrences, teacherOf } from '../services/occurrences.js';
import { badRequest, forbidden, notFound, requireFields, toInt, toMinutes, zonedNow } from '../util.js';

const router = Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const uniNow = (uid) => zonedNow(q.get('SELECT timezone FROM universities WHERE id = ?', uid)?.timezone || 'UTC');

/** Teacher of the occurrence (lecturer or cover) or a manager of the unit's department. */
function canRun(user, occ) {
  if (teacherOf(occ.session_id, occ.date, occ.original_lecturer_id) === user.id) return true;
  return MANAGER_ROLES.includes(user.role) && canManageDepartment(user, occ.department_id);
}

function context(req, id) {
  const cs = loadCheckin(req.uid, id);
  const occ = occurrenceOn(req.uid, cs.session_id, cs.lecture_date);
  if (!occ) throw notFound('Lecture');
  const manage = canRun(req.user, occ);
  const repOf = new Set((req.user.rep_classes || []).map((c) => c.id));
  const isRep = occ.classes.some((c) => repOf.has(c.id));
  return { cs, occ, manage, isRep };
}

/** Open check-ins relevant to the user right now (students: their lectures; staff: theirs). */
router.get('/active', (req, res) => {
  const now = uniNow(req.uid);
  const opts = req.user.role === 'student' ? { classId: req.user.class_id } : { lecturerId: req.user.id };
  if (req.user.role === 'student' && !req.user.class_id) return res.json([]);
  const today = occurrences(req.uid, { from: now.date, to: now.date, ...opts });
  const open = q.all('SELECT * FROM checkin_sessions WHERE university_id = ? AND lecture_date = ? AND closed_at IS NULL', req.uid, now.date);
  const byKey = new Map(open.map((c) => [`${c.session_id}:${c.lecture_date}`, c]));
  res.json(
    today
      .filter((o) => byKey.has(o.key))
      .map((o) => {
        const cs = byKey.get(o.key);
        const mine = req.user.role === 'student' ? q.get('SELECT method FROM checkins WHERE checkin_session_id = ? AND student_id = ?', cs.id, req.user.id) : null;
        return { checkin_id: cs.id, occurrence: o, checked_in: Boolean(mine), method: mine?.method || null };
      }),
  );
});

router.post('/start', (req, res) => {
  requireFields(req.body, ['session_id']);
  const now = uniNow(req.uid);
  const date = DATE_RE.test(req.body.date || '') ? req.body.date : now.date;
  if (date !== now.date) throw badRequest('Check-in can only be opened on the day of the lecture');
  const occ = occurrenceOn(req.uid, toInt(req.body.session_id), date);
  if (!occ) throw badRequest('That lecture does not take place today');
  if (!canRun(req.user, occ)) throw forbidden('Only the lecturer teaching this lecture can open check-in');
  if (now.minutes < toMinutes(occ.start_time) - 15) throw badRequest(`Check-in opens 15 minutes before the lecture (${occ.start_time})`);
  if (now.minutes > toMinutes(occ.end_time) + 30) throw badRequest('This lecture ended more than 30 minutes ago');
  const cs = startCheckin(req.user, occ);
  res.status(201).json({ id: cs.id, occurrence: occ });
});

router.post('/scan', (req, res) => {
  const b = req.body || {};
  res.json(
    scan(req.user, {
      code: b.code,
      deviceId: b.device_id,
      scannedAt: b.scanned_at,
      latitude: b.latitude == null ? null : Number(b.latitude),
      longitude: b.longitude == null ? null : Number(b.longitude),
    }),
  );
});

router.get('/:id', (req, res) => {
  const { cs, occ, manage, isRep } = context(req, toInt(req.params.id));
  if (!manage && !isRep) throw forbidden();
  const classIds = occ.classes.map((c) => c.id);
  const expected = q.get(`SELECT COUNT(*) AS n FROM users WHERE role = 'student' AND active = 1 AND class_id IN (${placeholders(classIds)})`, ...classIds).n;
  const entries = q.all(
    `SELECT ch.student_id, ch.method, ch.reason, ch.scanned_at, ch.created_at, u.name, u.identifier, c.name AS class_name, m.name AS marked_by_name
       FROM checkins ch JOIN users u ON u.id = ch.student_id JOIN classes c ON c.id = ch.class_id LEFT JOIN users m ON m.id = ch.marked_by
      WHERE ch.checkin_session_id = ? ORDER BY ch.created_at DESC`,
    cs.id,
  );
  const flags = manage
    ? q.all(
        `SELECT f.kind, f.detail, f.created_at, u.name, u.identifier FROM checkin_flags f LEFT JOIN users u ON u.id = f.student_id
          WHERE f.checkin_session_id = ? ORDER BY f.id DESC LIMIT 50`,
        cs.id,
      )
    : [];
  res.json({
    id: cs.id,
    open: !cs.closed_at,
    started_at: cs.started_at,
    closed_at: cs.closed_at,
    occurrence: occ,
    expected,
    counts: { total: entries.length, qr: entries.filter((e) => e.method === 'qr').length, manual: entries.filter((e) => e.method === 'manual').length },
    entries,
    flags,
    can_manage: manage,
    can_mark: manage || isRep,
  });
});

router.get('/:id/code', (req, res) => {
  const { cs, manage } = context(req, toInt(req.params.id));
  if (!manage) throw forbidden();
  if (cs.closed_at) throw badRequest('This check-in is closed');
  res.json(currentCode(cs));
});

/** Students of the lecture's classes not yet checked in (for manual marking). */
router.get('/:id/students', (req, res) => {
  const { cs, occ, manage, isRep } = context(req, toInt(req.params.id));
  if (!manage && !isRep) throw forbidden();
  const repOf = new Set((req.user.rep_classes || []).map((c) => c.id));
  const classIds = occ.classes.map((c) => c.id).filter((id) => manage || repOf.has(id));
  const rows = q.all(
    `SELECT u.id, u.name, u.identifier, c.name AS class_name FROM users u JOIN classes c ON c.id = u.class_id
      WHERE u.role = 'student' AND u.active = 1 AND u.class_id IN (${placeholders(classIds)})
        AND u.id NOT IN (SELECT student_id FROM checkins WHERE checkin_session_id = ?)
      ORDER BY u.name`,
    ...classIds,
    cs.id,
  );
  res.json(rows);
});

router.post('/:id/manual', (req, res) => {
  const { cs, occ, manage, isRep } = context(req, toInt(req.params.id));
  const student = q.get('SELECT * FROM users WHERE id = ? AND university_id = ?', toInt(req.body?.student_id), req.uid);
  if (!student) throw notFound('Student');
  const repOf = new Set((req.user.rep_classes || []).map((c) => c.id));
  if (!manage && !(isRep && repOf.has(student.class_id))) throw forbidden('Only the lecturer or the class representative can mark students manually');
  if (cs.closed_at && !manage) throw badRequest('This check-in is closed');
  const result = markManually(req.user, cs, student.id, req.body?.reason);
  // A late manual mark after closing updates the register too.
  if (cs.closed_at) closeCheckin(q.get('SELECT * FROM checkin_sessions WHERE id = ?', cs.id), req.user.id);
  res.status(201).json({ ok: true, manual_marks_this_term: result.count, limit: result.limit, over_limit: result.limit > 0 && result.count > result.limit, occurrence: occ.key });
});

router.delete('/:id/entries/:studentId', (req, res) => {
  const { cs, manage } = context(req, toInt(req.params.id));
  if (!manage) throw forbidden();
  const removed = q.run('DELETE FROM checkins WHERE checkin_session_id = ? AND student_id = ?', cs.id, toInt(req.params.studentId)).changes;
  if (!removed) throw notFound('Check-in');
  flag(req.uid, cs.id, toInt(req.params.studentId), null, 'removed', `Removed by ${req.user.name}`);
  if (cs.closed_at) closeCheckin(cs, req.user.id);
  res.json({ ok: true });
});

/** Five random students who checked in by phone, for the lecturer to call out. */
router.post('/:id/rollcall', (req, res) => {
  const { cs, manage } = context(req, toInt(req.params.id));
  if (!manage) throw forbidden();
  res.json(
    q.all(
      `SELECT u.id, u.name, u.identifier, c.name AS class_name FROM checkins ch JOIN users u ON u.id = ch.student_id
         JOIN classes c ON c.id = ch.class_id WHERE ch.checkin_session_id = ? AND ch.method = 'qr' ORDER BY random() LIMIT 5`,
      cs.id,
    ),
  );
});

router.post('/:id/close', (req, res) => {
  const { cs, manage } = context(req, toInt(req.params.id));
  if (!manage) throw forbidden();
  res.json({ ok: true, ...closeCheckin(cs, req.user.id) });
});

export { manualMarksThisTerm };
export default router;
