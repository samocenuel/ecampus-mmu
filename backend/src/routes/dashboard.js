import { Router } from 'express';
import { MANAGER_ROLES, TEACHING_ROLES } from '../auth.js';
import { q } from '../db.js';
import { courseUnitScope, currentTerm, managedDepartmentIds, placeholders, scopeLabel } from '../scope.js';
import { occurrences, occurrencesForUser } from '../services/occurrences.js';
import { missedLectures } from '../services/ops.js';
import { claimSummary, isPartTimer } from '../services/pay.js';
import { buildReport } from '../services/reports.js';
import { upcomingForUser } from '../services/schedule.js';
import { addDays, DAY_NAMES, zonedNow } from '../util.js';

const router = Router();

router.get('/', (req, res) => {
  const user = req.user;
  const uni = q.get('SELECT timezone FROM universities WHERE id = ?', req.uid);
  const now = zonedNow(uni.timezone);
  const term = currentTerm(req.uid);
  const out = {
    role: user.role,
    scope: scopeLabel(user),
    term,
    today: now.date,
    day_name: DAY_NAMES[now.dow],
    // Today's lectures after moves, cancellations, holidays and covers (id = timetable session id).
    today_sessions: occurrencesForUser(user, now.date, now.date).map((o) => ({ ...o, id: o.session_id })),
    upcoming: upcomingForUser(user, 7).items.slice(0, 6),
    unread_notifications: q.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', user.id).n,
  };

  if (MANAGER_ROLES.includes(user.role) || user.role === 'lecturer') {
    const report = buildReport(user, term);
    out.counts = report.counts;
    out.allocation = report.allocation;
    out.attendance = { average_rate: report.attendance.average_rate, pending_registers: report.attendance.pending_registers, at_risk: report.attendance.at_risk.length };
    if (user.role === 'admin') {
      out.counts.rooms = q.get('SELECT COUNT(*) AS n FROM rooms WHERE university_id = ? AND active = 1', req.uid).n;
      out.counts.cross_cutting_units = q.get('SELECT COUNT(*) AS n FROM course_units WHERE university_id = ? AND is_cross_cutting = 1', req.uid).n;
      out.counts.course_units = q.get('SELECT COUNT(*) AS n FROM course_units WHERE university_id = ?', req.uid).n;
    } else if (MANAGER_ROLES.includes(user.role)) {
      const depts = managedDepartmentIds(user);
      const scope = courseUnitScope('cu', depts);
      out.counts.course_units = q.get(`SELECT COUNT(*) AS n FROM course_units cu WHERE ${scope.sql}`, ...scope.params).n;
    }
  }

  if (TEACHING_ROLES.includes(user.role)) {
    out.my_pending_approvals = q.get(
      `SELECT COUNT(*) AS n FROM attendance_registers r JOIN timetable_sessions s ON s.id = r.session_id
         JOIN allocations a ON a.id = s.allocation_id WHERE a.lecturer_id = ? AND r.status = 'submitted'`,
      user.id,
    ).n;
    out.my_weekly_hours = term
      ? q.get('SELECT COALESCE(SUM(hours_per_week), 0) AS h FROM allocations WHERE lecturer_id = ? AND term_id = ?', user.id, term.id).h
      : 0;
  }

  if (isPartTimer(user) || ['admin', 'dean', 'hod', 'hr'].includes(user.role)) out.claims = claimSummary(user);
  if (MANAGER_ROLES.includes(user.role) || TEACHING_ROLES.includes(user.role)) {
    const from = addDays(now.date, -13);
    const opts = user.role === 'admin' ? {} : MANAGER_ROLES.includes(user.role) ? { departmentIds: managedDepartmentIds(user) } : { lecturerId: user.id };
    out.missed_lectures = missedLectures(req.uid, { from, to: now.date, ...opts }).length;
  }

  if (user.role === 'student') {
    const row = q.get(
      `SELECT COUNT(*) AS total, COALESCE(SUM(ar.present), 0) AS attended FROM attendance_records ar
         JOIN attendance_registers r ON r.id = ar.register_id WHERE ar.student_id = ? AND r.status = 'approved'`,
      user.id,
    );
    out.attendance = { ...row, rate: row.total ? Math.round((row.attended / row.total) * 1000) / 10 : null };
    out.is_class_rep = user.is_class_rep;
    if (user.is_class_rep && term) {
      const repIds = user.rep_classes.map((c) => c.id);
      const due = occurrences(req.uid, { from: now.date, to: now.date, classIds: repIds });
      out.registers_due_today = due.filter(
        (o) =>
          !q.get(
            `SELECT 1 FROM attendance_registers WHERE session_id = ? AND lecture_date = ? AND class_id IN (${placeholders(repIds)})`,
            o.session_id,
            now.date,
            ...repIds,
          ) && !q.get('SELECT 1 FROM checkin_sessions WHERE session_id = ? AND lecture_date = ?', o.session_id, now.date),
      ).length;
    }
  }
  res.json(out);
});

export default router;
