// Part-time pay claims: rates, teaching lines built from attendance, and the approval chain
// lecturer -> HoD -> Dean -> HR (Directorate) -> paid.
import { q } from '../db.js';
import { canManageDepartment, facultyIdsForDean, placeholders } from '../scope.js';
import { toMinutes } from '../util.js';

/** Where a claim is and who acts next. `next` is the status an approval moves it to. */
export const STAGES = {
  submitted: { label: 'Awaiting HoD', actor: 'hod', next: 'hod_approved', action: 'Approve' },
  hod_approved: { label: 'Awaiting Dean', actor: 'dean', next: 'dean_approved', action: 'Approve' },
  dean_approved: { label: 'Awaiting HR check', actor: 'hr', next: 'hr_verified', action: 'Verify' },
  hr_verified: { label: 'Awaiting payment', actor: 'hr', next: 'paid', action: 'Mark as paid' },
};
export const EDITABLE_STATUSES = ['draft', 'rejected'];

export const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

export const isPartTimer = (user) => user.employment_type === 'part_time' && ['lecturer', 'hod', 'dean'].includes(user.role);

export function teachingRate(facultyId) {
  return q.get("SELECT * FROM pay_rates WHERE faculty_id = ? AND kind = 'teaching' AND active = 1 ORDER BY id LIMIT 1", facultyId);
}

const APPROVED_COVER = `SELECT 1 FROM leave_covers lc JOIN leave_requests lr ON lr.id = lc.leave_id
                          WHERE lc.session_id = s.id AND lc.lecture_date = r.lecture_date AND lr.status = 'approved'`;

/**
 * Lectures the lecturer taught between two dates (their own, or as cover for a colleague on leave)
 * whose attendance was approved and that are not on another claim. A combined-class lecture counts
 * once, with every class's headcount and the number of students who confirmed it by QR check-in.
 */
export function claimableLectures(lecturerId, from, to, exceptClaimId = 0) {
  const uni = q.get('SELECT un.claims_require_checkin FROM users u JOIN universities un ON un.id = u.university_id WHERE u.id = ?', lecturerId);
  const rows = q.all(
    `SELECT s.id AS session_id, r.lecture_date AS work_date,
            COALESCE(MAX(sc.new_start), s.start_time) AS start_time, COALESCE(MAX(sc.new_end), s.end_time) AS end_time,
            cu.code AS course_unit_code, cu.name AS course_unit_name,
            GROUP_CONCAT(c.name, ', ') AS class_names,
            SUM((SELECT COUNT(*) FROM attendance_records ar WHERE ar.register_id = r.id AND ar.present = 1)) AS students_present,
            SUM((SELECT COUNT(*) FROM attendance_records ar WHERE ar.register_id = r.id)) AS students_total,
            (SELECT COUNT(*) FROM checkins ch JOIN checkin_sessions cs ON cs.id = ch.checkin_session_id
              WHERE cs.session_id = s.id AND cs.lecture_date = r.lecture_date AND ch.method = 'qr') AS self_checkins
       FROM attendance_registers r
       JOIN timetable_sessions s ON s.id = r.session_id
       JOIN allocations a ON a.id = s.allocation_id
       JOIN course_units cu ON cu.id = a.course_unit_id
       JOIN classes c ON c.id = r.class_id
       LEFT JOIN session_changes sc ON sc.session_id = s.id AND sc.action = 'move' AND sc.new_date = r.lecture_date
      WHERE r.status = 'approved' AND r.lecture_date BETWEEN ? AND ?
        AND ((a.lecturer_id = ? AND NOT EXISTS (${APPROVED_COVER})) OR EXISTS (${APPROVED_COVER} AND lc.substitute_id = ?))
        AND NOT EXISTS (SELECT 1 FROM pay_claim_lines l WHERE l.kind = 'teaching' AND l.session_id = s.id
                          AND l.work_date = r.lecture_date AND l.claim_id <> ?)
      GROUP BY s.id, r.lecture_date
      ORDER BY r.lecture_date, s.start_time`,
    from,
    to,
    lecturerId,
    lecturerId,
    exceptClaimId,
  );
  return rows
    .filter((r) => !uni?.claims_require_checkin || r.self_checkins > 0)
    .map((r) => ({ ...r, hours: round2((toMinutes(r.end_time) - toMinutes(r.start_time)) / 60) }));
}

/** The faculty's rate used for invigilation duties (marked by the Dean), if any. */
export function invigilationRate(facultyId) {
  return q.get(
    `SELECT * FROM pay_rates WHERE faculty_id = ? AND active = 1 AND kind = 'task'
        AND (code = 'invigilation' OR (code IS NULL AND lower(name) LIKE 'invigilat%')) ORDER BY code IS NULL, id LIMIT 1`,
    facultyId,
  );
}

/** Exams the lecturer invigilated in the period that are not on another of their claims. */
export function claimableInvigilation(lecturerId, from, to, exceptClaimId = 0) {
  return q
    .all(
      `SELECT e.id AS exam_id, e.exam_date AS work_date, e.start_time, e.end_time, cu.code AS course_unit_code, cu.name AS course_unit_name, r.name AS room_name
         FROM exam_invigilators ei JOIN exams e ON e.id = ei.exam_id JOIN course_units cu ON cu.id = e.course_unit_id
         LEFT JOIN rooms r ON r.id = ei.room_id
        WHERE ei.user_id = ? AND e.exam_date BETWEEN ? AND ?
          AND NOT EXISTS (SELECT 1 FROM pay_claim_lines l JOIN pay_claims pc ON pc.id = l.claim_id
                           WHERE l.exam_id = e.id AND pc.lecturer_id = ? AND l.claim_id <> ?)
        ORDER BY e.exam_date, e.start_time`,
      lecturerId,
      from,
      to,
      lecturerId,
      exceptClaimId,
    )
    .map((x) => ({ ...x, hours: round2((toMinutes(x.end_time) - toMinutes(x.start_time)) / 60) }));
}

/** Lectures in the period still waiting for the lecturer to approve their attendance register. */
export function pendingLectureCount(lecturerId, from, to) {
  return q.get(
    `SELECT COUNT(DISTINCT s.id || '@' || r.lecture_date) AS n FROM attendance_registers r
       JOIN timetable_sessions s ON s.id = r.session_id JOIN allocations a ON a.id = s.allocation_id
      WHERE a.lecturer_id = ? AND r.status = 'submitted' AND r.lecture_date BETWEEN ? AND ?`,
    lecturerId,
    from,
    to,
  ).n;
}

/**
 * Replace a claim's automatic lines (lectures taught and exams invigilated) with what is currently
 * claimable in its period, priced at today's rates.
 */
export function refreshTeachingLines(claim) {
  const rate = teachingRate(claim.faculty_id);
  q.run("DELETE FROM pay_claim_lines WHERE claim_id = ? AND (kind = 'teaching' OR exam_id IS NOT NULL)", claim.id);
  const inv = invigilationRate(claim.faculty_id);
  if (inv) {
    for (const x of claimableInvigilation(claim.lecturer_id, claim.period_start, claim.period_end, claim.id)) {
      q.run(
        `INSERT INTO pay_claim_lines (claim_id, kind, rate_id, rate_name, unit, unit_price, quantity, amount, work_date, start_time, end_time,
                                      exam_id, course_unit_code, course_unit_name, description)
         VALUES (?, 'task', ?, ?, 'hour', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        claim.id, inv.id, inv.name, inv.amount, x.hours, round2(inv.amount * x.hours), x.work_date, x.start_time, x.end_time,
        x.exam_id, x.course_unit_code, x.course_unit_name, 'Invigilation: ' + x.course_unit_code + ' exam' + (x.room_name ? ', ' + x.room_name : ''),
      );
    }
  }
  for (const l of claimableLectures(claim.lecturer_id, claim.period_start, claim.period_end, claim.id)) {
    const price = rate ? rate.amount : 0;
    q.run(
      `INSERT INTO pay_claim_lines (claim_id, kind, rate_id, rate_name, unit, unit_price, quantity, amount, work_date,
                                    start_time, end_time, session_id, course_unit_code, course_unit_name, class_names,
                                    students_present, students_total, self_checkins)
       VALUES (?, 'teaching', ?, ?, 'hour', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      claim.id, rate?.id ?? null, rate?.name || 'Teaching', price, l.hours, round2(price * l.hours), l.work_date,
      l.start_time, l.end_time, l.session_id, l.course_unit_code, l.course_unit_name, l.class_names,
      l.students_present, l.students_total, l.self_checkins,
    );
  }
  return recalcTotal(claim.id);
}

/** Re-price task lines from their rates (used on submission so approvers see current prices). */
export function repriceTaskLines(claimId) {
  for (const l of q.all("SELECT l.id, l.quantity, r.amount, r.name, r.unit FROM pay_claim_lines l JOIN pay_rates r ON r.id = l.rate_id WHERE l.claim_id = ? AND l.kind = 'task'", claimId)) {
    q.run('UPDATE pay_claim_lines SET unit_price = ?, amount = ?, rate_name = ?, unit = ? WHERE id = ?', l.amount, round2(l.amount * l.quantity), l.name, l.unit, l.id);
  }
}

export function recalcTotal(claimId) {
  const total = round2(q.get('SELECT COALESCE(SUM(amount), 0) AS t FROM pay_claim_lines WHERE claim_id = ?', claimId).t);
  q.run("UPDATE pay_claims SET total = ?, updated_at = datetime('now') WHERE id = ?", total, claimId);
  return total;
}

/** SQL condition for the claims a user may see (drafts stay private to the lecturer). */
export function claimScope(user, alias = 'pc') {
  if (['admin', 'hr'].includes(user.role)) return { sql: `(${alias}.status <> 'draft' OR ${alias}.lecturer_id = ?)`, params: [user.id] };
  if (user.role === 'dean') {
    const facs = facultyIdsForDean(user);
    return { sql: `(${alias}.lecturer_id = ? OR (${alias}.status <> 'draft' AND ${alias}.faculty_id IN (${placeholders(facs)})))`, params: [user.id, ...facs] };
  }
  if (user.role === 'hod') {
    const depts = q.all('SELECT id FROM departments WHERE university_id = ? AND (hod_id = ? OR id = ?)', user.university_id, user.id, user.department_id).map((r) => r.id);
    return { sql: `(${alias}.lecturer_id = ? OR (${alias}.status <> 'draft' AND ${alias}.department_id IN (${placeholders(depts)})))`, params: [user.id, ...depts] };
  }
  return { sql: `${alias}.lecturer_id = ?`, params: [user.id] };
}

/** May `user` take the next step on `claim`? A department without a HoD is approved by its Dean. */
export function canAct(user, claim) {
  const stage = STAGES[claim.status];
  if (!stage || user.id === claim.lecturer_id) return false;
  if (stage.actor === 'hr') return user.role === 'hr' || user.role === 'admin';
  if (stage.actor === 'dean') return user.role === 'dean' && canManageDepartment(user, claim.department_id);
  if (user.role === 'hod') return canManageDepartment(user, claim.department_id);
  if (user.role === 'dean') {
    const hasHod = q.get('SELECT hod_id FROM departments WHERE id = ?', claim.department_id)?.hod_id;
    return !hasHod && canManageDepartment(user, claim.department_id);
  }
  return false;
}

/** Users to notify when a claim reaches `status`. */
export function nextActors(claim, status) {
  const stage = STAGES[status];
  if (!stage) return [];
  if (stage.actor === 'hr') return q.all("SELECT id FROM users WHERE university_id = ? AND role = 'hr' AND active = 1", claim.university_id).map((r) => r.id);
  if (stage.actor === 'dean') return [q.get('SELECT f.dean_id AS id FROM faculties f WHERE f.id = ?', claim.faculty_id)?.id];
  const dept = q.get('SELECT d.hod_id, f.dean_id FROM departments d JOIN faculties f ON f.id = d.faculty_id WHERE d.id = ?', claim.department_id);
  return [dept?.hod_id || dept?.dean_id];
}

/** Numbers for the dashboard and menu badges. */
export function claimSummary(user) {
  const scope = claimScope(user);
  const rows = q.all(`${claimSelect} WHERE pc.university_id = ? AND ${scope.sql}`, user.university_id, ...scope.params);
  const mine = rows.filter((c) => c.lecturer_id === user.id);
  const queue = rows.filter((c) => canAct(user, c));
  return {
    part_timer: isPartTimer(user),
    awaiting_me: queue.length,
    awaiting_me_total: round2(queue.reduce((t, c) => t + c.total, 0)),
    mine: {
      open: mine.filter((c) => c.status !== 'paid').length,
      returned: mine.filter((c) => c.status === 'rejected').length,
      paid_total: round2(mine.filter((c) => c.status === 'paid').reduce((t, c) => t + c.total, 0)),
    },
    awaiting_payment: ['hr', 'admin'].includes(user.role) ? rows.filter((c) => c.status === 'hr_verified').length : undefined,
    currency: q.get('SELECT currency FROM universities WHERE id = ?', user.university_id)?.currency || 'UGX',
  };
}

export const claimSelect = `
  SELECT pc.*, u.name AS lecturer_name, u.title AS lecturer_title, u.email AS lecturer_email, u.identifier AS lecturer_identifier,
         d.name AS department_name, f.name AS faculty_name,
         (SELECT COALESCE(SUM(quantity), 0) FROM pay_claim_lines l WHERE l.claim_id = pc.id AND l.kind = 'teaching') AS teaching_hours,
         (SELECT COUNT(*) FROM pay_claim_lines l WHERE l.claim_id = pc.id AND l.kind = 'teaching') AS lecture_count,
         (SELECT COUNT(*) FROM pay_claim_lines l WHERE l.claim_id = pc.id AND l.kind = 'task') AS task_count
    FROM pay_claims pc
    JOIN users u ON u.id = pc.lecturer_id
    LEFT JOIN departments d ON d.id = pc.department_id
    LEFT JOIN faculties f ON f.id = pc.faculty_id`;
