import { Router } from 'express';
import { MANAGER_ROLES, TEACHING_ROLES } from '../auth.js';
import { q } from '../db.js';
import { currentTerm, managedDepartmentIds, placeholders, scopeLabel } from '../scope.js';
import { buildReport } from '../services/reports.js';
import { sessionsForUser, upcomingForUser } from '../services/schedule.js';
import { DAY_NAMES, zonedNow } from '../util.js';

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
    today_sessions: term ? sessionsForUser(user, term.id).filter((s) => s.day_of_week === now.dow) : [],
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
      out.counts.course_units = q.get(`SELECT COUNT(*) AS n FROM course_units WHERE department_id IN (${placeholders(depts)})`, ...depts).n;
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
      const due = sessionsForUser({ ...user, role: 'student' }, term.id).filter((s) => s.day_of_week === now.dow);
      out.registers_due_today = due.filter(
        (s) =>
          !q.get(
            `SELECT 1 FROM attendance_registers WHERE session_id = ? AND lecture_date = ? AND class_id IN (${placeholders(repIds)})`,
            s.id,
            now.date,
            ...repIds,
          ),
      ).length;
    }
  }
  res.json(out);
});

export default router;
