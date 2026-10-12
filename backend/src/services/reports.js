// Scoped reporting: Admins see the whole university, Deans their faculty's
// departments, HoDs their department, lecturers their own teaching.
import { q } from '../db.js';
import { managedDepartmentIds, placeholders, scopeLabel } from '../scope.js';
import { toMinutes } from '../util.js';
import { allocationRequirements } from './allocation-rules.js';

const AT_RISK_THRESHOLD = 75;
const pct = (num, den) => (den ? Math.round((num / den) * 1000) / 10 : null);
const hours = (mins) => Math.round((mins / 60) * 10) / 10;

export function buildReport(user, term) {
  const uid = user.university_id;
  const isLecturer = user.role === 'lecturer';
  const managed = managedDepartmentIds(user);
  const deptIds = managed === null ? q.all('SELECT id FROM departments WHERE university_id = ?', uid).map((r) => r.id) : managed;
  const inDepts = placeholders(deptIds);

  const departments = isLecturer
    ? []
    : q.all(
        `SELECT d.id, d.name, d.code, f.name AS faculty_name, h.name AS hod_name
           FROM departments d JOIN faculties f ON f.id = d.faculty_id LEFT JOIN users h ON h.id = d.hod_id
          WHERE d.id IN (${inDepts}) ORDER BY f.name, d.name`,
        ...deptIds,
      );
  const programs = isLecturer ? [] : q.all(`SELECT id, code, name, department_id FROM programs WHERE department_id IN (${inDepts})`, ...deptIds);
  const programIds = programs.map((p) => p.id);
  const classes = isLecturer
    ? []
    : q.all(
        `SELECT c.id, c.name, c.year_of_study, c.program_id, p.code AS program, p.department_id,
                (SELECT COUNT(*) FROM users s WHERE s.class_id = c.id AND s.role = 'student' AND s.active = 1) AS students
           FROM classes c JOIN programs p ON p.id = c.program_id
          WHERE c.program_id IN (${placeholders(programIds)}) ORDER BY c.name`,
        ...programIds,
      );
  const classIds = classes.map((c) => c.id);

  // Allocations in scope for the term.
  let allocations = [];
  if (term) {
    allocations = isLecturer
      ? q.all(
          `SELECT a.*, cu.code, cu.name, cu.department_id, cu.is_cross_cutting, u.name AS lecturer
             FROM allocations a JOIN course_units cu ON cu.id = a.course_unit_id JOIN users u ON u.id = a.lecturer_id
            WHERE a.term_id = ? AND a.lecturer_id = ?`,
          term.id,
          user.id,
        )
      : q.all(
          `SELECT a.*, cu.code, cu.name, cu.department_id, cu.is_cross_cutting, u.name AS lecturer
             FROM allocations a JOIN course_units cu ON cu.id = a.course_unit_id JOIN users u ON u.id = a.lecturer_id
            WHERE a.term_id = ? AND (cu.department_id IN (${inDepts})
               OR a.id IN (SELECT allocation_id FROM allocation_classes WHERE class_id IN (${placeholders(classIds)}))
               ${managed === null ? 'OR cu.department_id IS NULL' : ''})`,
          term.id,
          ...deptIds,
          ...classIds,
        );
  }
  const allocIds = allocations.map((a) => a.id);
  const allocClasses = allocIds.length
    ? q.all(
        `SELECT ac.allocation_id, c.id, c.name FROM allocation_classes ac JOIN classes c ON c.id = ac.class_id
          WHERE ac.allocation_id IN (${placeholders(allocIds)})`,
        ...allocIds,
      )
    : [];
  const sessions = allocIds.length
    ? q.all(`SELECT id, allocation_id, room_id, start_time, end_time FROM timetable_sessions WHERE allocation_id IN (${placeholders(allocIds)})`, ...allocIds)
    : [];
  const sessionMins = (s) => toMinutes(s.end_time) - toMinutes(s.start_time);

  // Lecturer workload.
  const lecturers = isLecturer
    ? [q.get('SELECT u.id, u.name, u.title, u.department_id, d.name AS department FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.id = ?', user.id)]
    : q.all(
        `SELECT u.id, u.name, u.title, u.department_id, d.name AS department FROM users u LEFT JOIN departments d ON d.id = u.department_id
          WHERE u.university_id = ? AND u.active = 1 AND u.role IN ('lecturer','hod','dean')
            AND (u.department_id IN (${inDepts}) ${managed === null ? 'OR u.department_id IS NULL' : ''})
          ORDER BY u.name`,
        uid,
        ...deptIds,
      );
  const allocById = new Map(allocations.map((a) => [a.id, a]));
  const workload = lecturers.map((l) => {
    const mine = allocations.filter((a) => a.lecturer_id === l.id);
    const scheduled = sessions.filter((s) => allocById.get(s.allocation_id)?.lecturer_id === l.id).reduce((m, s) => m + sessionMins(s), 0);
    return {
      id: l.id,
      name: [l.title, l.name].filter(Boolean).join(' '),
      department_id: l.department_id,
      department: l.department || '-',
      units: mine.length,
      allocated_hours: mine.reduce((h, a) => h + a.hours_per_week, 0),
      scheduled_hours: hours(scheduled),
    };
  });

  // Attendance (only approved registers count towards rates).
  const registers = allocIds.length
    ? q.all(
        `SELECT r.id, r.status, r.class_id, s.allocation_id,
                (SELECT COUNT(*) FROM attendance_records ar WHERE ar.register_id = r.id) AS total,
                (SELECT COUNT(*) FROM attendance_records ar WHERE ar.register_id = r.id AND ar.present = 1) AS present
           FROM attendance_registers r JOIN timetable_sessions s ON s.id = r.session_id
          WHERE s.allocation_id IN (${placeholders(allocIds)})`,
        ...allocIds,
      )
    : [];
  const approved = registers.filter((r) => r.status === 'approved');
  const rate = (list) => pct(list.reduce((n, r) => n + r.present, 0), list.reduce((n, r) => n + r.total, 0));

  const byCourse = allocations.map((a) => {
    const regs = approved.filter((r) => r.allocation_id === a.id);
    return {
      allocation_id: a.id,
      code: a.code,
      name: a.name,
      is_cross_cutting: a.is_cross_cutting,
      lecturer: a.lecturer,
      classes: allocClasses.filter((c) => c.allocation_id === a.id).map((c) => c.name).join(', '),
      registers: regs.length,
      rate: rate(regs),
    };
  });

  const reportClassIds = isLecturer ? [...new Set(allocClasses.map((c) => c.id))] : classIds;
  const reportClasses = isLecturer
    ? q.all(
        `SELECT c.id, c.name, p.code AS program, (SELECT COUNT(*) FROM users s WHERE s.class_id = c.id AND s.role = 'student' AND s.active = 1) AS students
           FROM classes c JOIN programs p ON p.id = c.program_id WHERE c.id IN (${placeholders(reportClassIds)})`,
        ...reportClassIds,
      )
    : classes;
  const byClass = reportClasses.map((c) => {
    const regs = approved.filter((r) => r.class_id === c.id);
    return { id: c.id, name: c.name, program: c.program, students: c.students, registers: regs.length, rate: rate(regs) };
  });

  const approvedIds = approved.map((r) => r.id);
  const atRisk = approvedIds.length
    ? q
        .all(
          `SELECT u.id, u.name, u.identifier, c.name AS class_name, COUNT(*) AS total, SUM(ar.present) AS attended
             FROM attendance_records ar JOIN users u ON u.id = ar.student_id LEFT JOIN classes c ON c.id = u.class_id
            WHERE ar.register_id IN (${placeholders(approvedIds)})
            GROUP BY u.id ORDER BY (1.0 * SUM(ar.present) / COUNT(*)), u.name`,
          ...approvedIds,
        )
        .map((s) => ({ ...s, rate: pct(s.attended, s.total) }))
        .filter((s) => s.rate < AT_RISK_THRESHOLD)
    : [];

  // Room utilisation (rooms are a shared university resource).
  const uni = q.get('SELECT * FROM universities WHERE id = ?', uid);
  const teachingDays = uni.teaching_days.split(',').length;
  const lunchMins = uni.lunch_start && uni.lunch_end ? toMinutes(uni.lunch_end) - toMinutes(uni.lunch_start) : 0;
  const weeklyMins = teachingDays * (toMinutes(uni.day_end) - toMinutes(uni.day_start) - lunchMins);
  const roomSessions = term ? q.all('SELECT room_id, start_time, end_time FROM timetable_sessions WHERE term_id = ?', term.id) : [];
  const rooms = isLecturer
    ? []
    : q.all('SELECT id, name, building, capacity, room_type FROM rooms WHERE university_id = ? AND active = 1 ORDER BY name', uid).map((r) => {
        const booked = roomSessions.filter((s) => s.room_id === r.id).reduce((m, s) => m + sessionMins(s), 0);
        return { ...r, booked_hours: hours(booked), utilisation: pct(booked, weeklyMins) ?? 0 };
      });

  // Department breakdown for Deans and Admins.
  const deptBreakdown = departments.map((d) => {
    const dClasses = classes.filter((c) => c.department_id === d.id);
    const dClassIds = new Set(dClasses.map((c) => c.id));
    const dRegs = approved.filter((r) => dClassIds.has(r.class_id));
    return {
      ...d,
      programs: programs.filter((p) => p.department_id === d.id).length,
      classes: dClasses.length,
      students: dClasses.reduce((n, c) => n + c.students, 0),
      lecturers: workload.filter((w) => w.department_id === d.id).length,
      allocations: allocations.filter((a) => a.department_id === d.id).length,
      attendance_rate: rate(dRegs),
    };
  });

  // Allocation progress restricted to the classes in scope.
  const req = allocationRequirements(uid, term);
  const inScope = (c) => managed === null || deptIds.includes(c.program_department_id);
  const pairs = (units) => units.flatMap((u) => u.classes.filter(inScope));
  const ccPairs = pairs(req.cross_cutting);
  const otherPairs = pairs(req.program_specific);

  const facultyCount =
    user.role === 'admin'
      ? q.get('SELECT COUNT(*) AS n FROM faculties WHERE university_id = ?', uid).n
      : new Set(departments.map((d) => d.faculty_name)).size;

  return {
    scope: scopeLabel(user),
    role: user.role,
    term: term ? { id: term.id, name: term.name } : null,
    counts: {
      faculties: facultyCount,
      departments: departments.length,
      programs: programs.length,
      classes: reportClasses.length,
      students: reportClasses.reduce((n, c) => n + c.students, 0),
      lecturers: lecturers.length,
      course_units_allocated: allocations.length,
      cross_cutting_allocated: allocations.filter((a) => a.is_cross_cutting).length,
      weekly_sessions: sessions.length,
      weekly_teaching_hours: hours(sessions.reduce((m, s) => m + sessionMins(s), 0)),
    },
    allocation: {
      cross_cutting_pairs: ccPairs.length,
      cross_cutting_allocated: ccPairs.filter((c) => c.allocation_id).length,
      other_pairs: otherPairs.length,
      other_allocated: otherPairs.filter((c) => c.allocation_id).length,
    },
    workload,
    attendance: {
      average_rate: rate(approved),
      approved_registers: approved.length,
      pending_registers: registers.filter((r) => r.status === 'submitted').length,
      rejected_registers: registers.filter((r) => r.status === 'rejected').length,
      at_risk_threshold: AT_RISK_THRESHOLD,
      by_course: byCourse,
      by_class: byClass,
      at_risk: atRisk,
    },
    rooms,
    departments: deptBreakdown,
  };
}
