// Scoped reporting: Admins see the whole university, Deans their faculty's
// departments, HoDs their department, lecturers their own teaching. Filters narrow
// the report further (department, programme, year, class, course unit, lecturer, dates)
// and choose which sections to include, for the screen and for PDF / Excel exports.
import { q } from '../db.js';
import { managedDepartmentIds, placeholders, scopeLabel } from '../scope.js';
import { addDays, toMinutes, zonedNow } from '../util.js';
import { allocationRequirements } from './allocation-rules.js';
import { missedLectures } from './ops.js';
import { limitsFor } from './workload.js';

const AT_RISK_THRESHOLD = 75;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const pct = (num, den) => (den ? Math.round((num / den) * 1000) / 10 : null);
const hours = (mins) => Math.round((mins / 60) * 10) / 10;

/** Report sections, in the order they appear on screen and in exports. */
export const REPORT_SECTIONS = {
  summary: 'Summary',
  allocation: 'Allocation progress',
  departments: 'Departments',
  workload: 'Lecturer workload',
  course_attendance: 'Attendance by course unit',
  class_attendance: 'Attendance by class',
  at_risk: 'Students at risk',
  missed: 'Lectures with no attendance',
  rooms: 'Room utilisation',
};

const id = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Reads report filters from a query string; anything missing or invalid is ignored. */
export function parseReportFilters(query = {}) {
  const sections = String(query.sections || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => REPORT_SECTIONS[s]);
  let from = DATE_RE.test(query.from || '') ? query.from : null;
  let to = DATE_RE.test(query.to || '') ? query.to : null;
  if (from && to && to < from) [from, to] = [to, from];
  const threshold = Number(query.threshold);
  return {
    faculty_id: id(query.faculty_id),
    department_id: id(query.department_id),
    program_id: id(query.program_id),
    year_of_study: id(query.year_of_study),
    class_id: id(query.class_id),
    course_unit_id: id(query.course_unit_id),
    lecturer_id: id(query.lecturer_id),
    from,
    to,
    threshold: Number.isFinite(threshold) && threshold > 0 && threshold <= 100 ? threshold : AT_RISK_THRESHOLD,
    sections: sections.length ? sections : Object.keys(REPORT_SECTIONS),
  };
}

/** Departments, programmes, classes, course units and lecturers the user can filter on. */
export function reportOptions(user, term) {
  const uid = user.university_id;
  if (user.role === 'lecturer') {
    const mine = term
      ? q.all(
          `SELECT DISTINCT cu.id AS cu_id, cu.code, cu.name AS cu_name, c.id AS class_id, c.name AS class_name, c.year_of_study, p.id AS program_id, p.code AS program_code, p.name AS program_name
             FROM allocations a JOIN course_units cu ON cu.id = a.course_unit_id
             LEFT JOIN allocation_classes ac ON ac.allocation_id = a.id LEFT JOIN classes c ON c.id = ac.class_id LEFT JOIN programs p ON p.id = c.program_id
            WHERE a.term_id = ? AND a.lecturer_id = ?`,
          term.id,
          user.id,
        )
      : [];
    const uniq = (rows, key) => [...new Map(rows.filter((r) => r[key]).map((r) => [r[key], r])).values()];
    return {
      faculties: [],
      departments: [],
      programs: uniq(mine, 'program_id').map((r) => ({ id: r.program_id, code: r.program_code, name: r.program_name })),
      classes: uniq(mine, 'class_id').map((r) => ({ id: r.class_id, name: r.class_name, year_of_study: r.year_of_study, program_id: r.program_id })),
      course_units: uniq(mine, 'cu_id').map((r) => ({ id: r.cu_id, code: r.code, name: r.cu_name })),
      lecturers: [],
      sections: REPORT_SECTIONS,
    };
  }
  const managed = managedDepartmentIds(user);
  const deptIds = managed === null ? q.all('SELECT id FROM departments WHERE university_id = ?', uid).map((r) => r.id) : managed;
  const inDepts = placeholders(deptIds);
  const departments = q.all(
    `SELECT d.id, d.name, d.code, d.faculty_id FROM departments d WHERE d.id IN (${inDepts}) ORDER BY d.name`,
    ...deptIds,
  );
  const facultyIds = [...new Set(departments.map((d) => d.faculty_id))];
  return {
    faculties: q.all(`SELECT id, name, code FROM faculties WHERE id IN (${placeholders(facultyIds)}) ORDER BY name`, ...facultyIds),
    departments,
    programs: q.all(`SELECT id, code, name, department_id FROM programs WHERE department_id IN (${inDepts}) ORDER BY code`, ...deptIds),
    classes: q.all(
      `SELECT c.id, c.name, c.year_of_study, c.program_id FROM classes c JOIN programs p ON p.id = c.program_id
        WHERE p.department_id IN (${inDepts}) AND COALESCE(c.status, 'active') = 'active' ORDER BY c.name`,
      ...deptIds,
    ),
    course_units: q.all(
      `SELECT id, code, name, department_id, is_cross_cutting FROM course_units
        WHERE university_id = ? AND (department_id IN (${inDepts}) ${managed === null ? 'OR department_id IS NULL' : ''}) ORDER BY code`,
      uid,
      ...deptIds,
    ),
    lecturers: q.all(
      `SELECT id, name, title, department_id FROM users
        WHERE university_id = ? AND active = 1 AND role IN ('lecturer','hod','dean')
          AND (department_id IN (${inDepts}) ${managed === null ? 'OR department_id IS NULL' : ''}) ORDER BY name`,
      uid,
      ...deptIds,
    ),
    sections: REPORT_SECTIONS,
  };
}

/** Human-readable list of the filters applied, for headings and exports. */
function filterLabels(uid, f) {
  const out = [];
  const name = (sql, v, fmt) => {
    const r = v && q.get(sql, v, uid);
    if (r) out.push(fmt(r));
  };
  name('SELECT name FROM faculties WHERE id = ? AND university_id = ?', f.faculty_id, (r) => `Faculty: ${r.name}`);
  name('SELECT name FROM departments WHERE id = ? AND university_id = ?', f.department_id, (r) => `Department: ${r.name}`);
  name('SELECT code, name FROM programs WHERE id = ? AND university_id = ?', f.program_id, (r) => `Programme: ${r.code}`);
  if (f.year_of_study) out.push(`Year ${f.year_of_study}`);
  name('SELECT name FROM classes WHERE id = ? AND university_id = ?', f.class_id, (r) => `Class: ${r.name}`);
  name('SELECT code FROM course_units WHERE id = ? AND university_id = ?', f.course_unit_id, (r) => `Course unit: ${r.code}`);
  name('SELECT name, title FROM users WHERE id = ? AND university_id = ?', f.lecturer_id, (r) => `Lecturer: ${[r.title, r.name].filter(Boolean).join(' ')}`);
  if (f.from || f.to) out.push(`Lectures ${f.from || 'start of term'} to ${f.to || 'today'}`);
  if (f.threshold !== AT_RISK_THRESHOLD) out.push(`At risk below ${f.threshold}%`);
  return out;
}

export function buildReport(user, term, filters = parseReportFilters()) {
  const f = filters;
  const uid = user.university_id;
  const isLecturer = user.role === 'lecturer';
  const managed = managedDepartmentIds(user);
  let deptIds = managed === null ? q.all('SELECT id FROM departments WHERE university_id = ?', uid).map((r) => r.id) : managed;
  if (f.faculty_id) {
    const inFaculty = new Set(q.all('SELECT id FROM departments WHERE faculty_id = ?', f.faculty_id).map((r) => r.id));
    deptIds = deptIds.filter((d) => inFaculty.has(d));
  }
  if (f.department_id) deptIds = deptIds.filter((d) => d === f.department_id);
  const deptFiltered = Boolean(f.faculty_id || f.department_id);
  const allDepts = managed === null && !deptFiltered;
  const inDepts = placeholders(deptIds);
  const classFiltered = Boolean(f.program_id || f.year_of_study || f.class_id);
  const unitFiltered = classFiltered || Boolean(f.course_unit_id || f.lecturer_id);

  const departments = isLecturer
    ? []
    : q.all(
        `SELECT d.id, d.name, d.code, f.name AS faculty_name, h.name AS hod_name
           FROM departments d JOIN faculties f ON f.id = d.faculty_id LEFT JOIN users h ON h.id = d.hod_id
          WHERE d.id IN (${inDepts}) ORDER BY f.name, d.name`,
        ...deptIds,
      );
  let programs = isLecturer ? [] : q.all(`SELECT id, code, name, department_id FROM programs WHERE department_id IN (${inDepts})`, ...deptIds);
  if (f.program_id) programs = programs.filter((p) => p.id === f.program_id);
  const programIds = programs.map((p) => p.id);
  let classes = isLecturer
    ? []
    : q.all(
        `SELECT c.id, c.name, c.year_of_study, c.program_id, p.code AS program, p.department_id,
                (SELECT COUNT(*) FROM users s WHERE s.class_id = c.id AND s.role = 'student' AND s.active = 1) AS students
           FROM classes c JOIN programs p ON p.id = c.program_id
          WHERE c.program_id IN (${placeholders(programIds)}) ORDER BY c.name`,
        ...programIds,
      );
  if (f.year_of_study) classes = classes.filter((c) => c.year_of_study === f.year_of_study);
  if (f.class_id) classes = classes.filter((c) => c.id === f.class_id);
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
               ${allDepts ? 'OR cu.department_id IS NULL' : ''})`,
          term.id,
          ...deptIds,
          ...classIds,
        );
  }
  let allocClasses = allocations.length
    ? q.all(
        `SELECT ac.allocation_id, c.id, c.name, c.program_id, c.year_of_study FROM allocation_classes ac JOIN classes c ON c.id = ac.class_id
          WHERE ac.allocation_id IN (${placeholders(allocations.map((a) => a.id))})`,
        ...allocations.map((a) => a.id),
      )
    : [];

  // Classes that pass the programme / year / class filters (for lecturers, among the classes they teach).
  const classOk = (c) =>
    (!f.program_id || c.program_id === f.program_id) && (!f.year_of_study || c.year_of_study === f.year_of_study) && (!f.class_id || c.id === f.class_id);
  const allowedClasses = classFiltered ? new Set(isLecturer ? allocClasses.filter(classOk).map((c) => c.id) : classIds) : null;
  if (classFiltered) allocations = allocations.filter((a) => allocClasses.some((c) => c.allocation_id === a.id && allowedClasses.has(c.id)));
  if (f.course_unit_id) allocations = allocations.filter((a) => a.course_unit_id === f.course_unit_id);
  if (f.lecturer_id && !isLecturer) allocations = allocations.filter((a) => a.lecturer_id === f.lecturer_id);
  const allocIds = allocations.map((a) => a.id);
  const allocSet = new Set(allocIds);
  allocClasses = allocClasses.filter((c) => allocSet.has(c.allocation_id) && (!allowedClasses || allowedClasses.has(c.id)));

  const sessions = allocIds.length
    ? q.all(`SELECT id, allocation_id, room_id, start_time, end_time FROM timetable_sessions WHERE allocation_id IN (${placeholders(allocIds)})`, ...allocIds)
    : [];
  const sessionMins = (s) => toMinutes(s.end_time) - toMinutes(s.start_time);

  // Lecturer workload.
  let lecturers = isLecturer
    ? [q.get('SELECT u.id, u.name, u.title, u.department_id, u.employment_type, u.workload_min, u.workload_max, d.name AS department FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.id = ?', user.id)]
    : q.all(
        `SELECT u.id, u.name, u.title, u.department_id, u.employment_type, u.workload_min, u.workload_max, d.name AS department FROM users u LEFT JOIN departments d ON d.id = u.department_id
          WHERE u.university_id = ? AND u.active = 1 AND u.role IN ('lecturer','hod','dean')
            AND (u.department_id IN (${inDepts}) ${allDepts ? 'OR u.department_id IS NULL' : ''})
          ORDER BY u.name`,
        uid,
        ...deptIds,
      );
  if (!isLecturer && unitFiltered) {
    // Everyone teaching the chosen classes / units, including staff from other departments (cross-cutting units).
    const teaching = [...new Set(allocations.map((a) => a.lecturer_id))];
    if (f.lecturer_id && !teaching.includes(f.lecturer_id) && lecturers.some((l) => l.id === f.lecturer_id)) teaching.push(f.lecturer_id);
    lecturers = q.all(
      `SELECT u.id, u.name, u.title, u.department_id, u.employment_type, u.workload_min, u.workload_max, d.name AS department FROM users u LEFT JOIN departments d ON d.id = u.department_id
        WHERE u.id IN (${placeholders(teaching)}) ORDER BY u.name`,
      ...teaching,
    );
  }
  const allocById = new Map(allocations.map((a) => [a.id, a]));
  const uniLimits = q.get('SELECT workload_min_hours, workload_max_hours FROM universities WHERE id = ?', uid);
  const workload = lecturers.map((l) => {
    const limits = limitsFor(l, uniLimits);
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
      part_time_hours: Math.round(mine.reduce((h, a) => h + (a.part_time_hours || 0), 0) * 10) / 10,
      min_hours: limits.min,
      max_hours: limits.max,
      // Against the whole term load (not just the filtered units).
      status: (() => {
        const total = q.get('SELECT COALESCE(SUM(hours_per_week), 0) AS h FROM allocations WHERE lecturer_id = ? AND term_id = ?', l.id, term?.id ?? -1).h;
        return total > limits.max ? 'Over maximum' : total < limits.min ? 'Under minimum' : 'Within limits';
      })(),
    };
  });

  // Attendance (only approved registers count towards rates).
  const dateSql = `${f.from ? ' AND r.lecture_date >= ?' : ''}${f.to ? ' AND r.lecture_date <= ?' : ''}`;
  const dateArgs = [f.from, f.to].filter(Boolean);
  let registers = allocIds.length
    ? q.all(
        `SELECT r.id, r.status, r.class_id, r.lecture_date, s.allocation_id,
                (SELECT COUNT(*) FROM attendance_records ar WHERE ar.register_id = r.id) AS total,
                (SELECT COUNT(*) FROM attendance_records ar WHERE ar.register_id = r.id AND ar.present = 1) AS present
           FROM attendance_registers r JOIN timetable_sessions s ON s.id = r.session_id
          WHERE s.allocation_id IN (${placeholders(allocIds)})${dateSql}`,
        ...allocIds,
        ...dateArgs,
      )
    : [];
  if (allowedClasses) registers = registers.filter((r) => allowedClasses.has(r.class_id));
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
  let reportClasses = isLecturer
    ? q.all(
        `SELECT c.id, c.name, p.code AS program, (SELECT COUNT(*) FROM users s WHERE s.class_id = c.id AND s.role = 'student' AND s.active = 1) AS students
           FROM classes c JOIN programs p ON p.id = c.program_id WHERE c.id IN (${placeholders(reportClassIds)})`,
        ...reportClassIds,
      )
    : classes;
  // A course unit or lecturer filter narrows the classes to the ones they teach.
  if (!isLecturer && (f.course_unit_id || f.lecturer_id)) {
    const taught = new Set(allocClasses.map((c) => c.id));
    reportClasses = reportClasses.filter((c) => taught.has(c.id));
  }
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
        .filter((s) => s.rate < f.threshold)
    : [];

  // Room utilisation (rooms are a shared university resource).
  const uni = q.get('SELECT * FROM universities WHERE id = ?', uid);
  const teachingDays = uni.teaching_days.split(',').length;
  const lunchMins = uni.lunch_start && uni.lunch_end ? toMinutes(uni.lunch_end) - toMinutes(uni.lunch_start) : 0;
  const weeklyMins = teachingDays * (toMinutes(uni.day_end) - toMinutes(uni.day_start) - lunchMins);
  const roomSessions = term ? q.all('SELECT room_id, start_time, end_time FROM timetable_sessions WHERE term_id = ?', term.id) : [];
  const rooms =
    isLecturer || !f.sections.includes('rooms')
      ? []
      : q.all('SELECT id, name, building, capacity, room_type FROM rooms WHERE university_id = ? AND active = 1 ORDER BY name', uid).map((r) => {
          const booked = roomSessions.filter((s) => s.room_id === r.id).reduce((m, s) => m + sessionMins(s), 0);
          return { ...r, booked_hours: hours(booked), utilisation: pct(booked, weeklyMins) ?? 0 };
        });

  // Department breakdown for Deans and Admins.
  const deptBreakdown = departments.map((d) => {
    const dClasses = reportClasses.filter((c) => c.department_id === d.id);
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

  // Allocation progress restricted to the classes (and course unit) in scope.
  const req = allocationRequirements(uid, term);
  const inScope = (c) => (allDepts || deptIds.includes(c.program_department_id)) && (!allowedClasses || allowedClasses.has(c.class_id));
  const pairs = (units) => units.filter((u) => !f.course_unit_id || u.course_unit_id === f.course_unit_id).flatMap((u) => u.classes.filter(inScope));
  const ccPairs = isLecturer ? [] : pairs(req.cross_cutting);
  const otherPairs = isLecturer ? [] : pairs(req.program_specific);

  // Lectures with no attendance: the chosen dates, or the last 14 days.
  let missed = [];
  if (f.sections.includes('missed')) {
    const today = zonedNow(uni.timezone || 'UTC').date;
    const to = f.to && f.to < today ? f.to : today;
    let from = f.from || addDays(to, -13);
    if (from > to) from = to;
    if (from < addDays(to, -120)) from = addDays(to, -120);
    const opts = isLecturer ? { lecturerId: user.id } : managed === null && !deptFiltered ? {} : { departmentIds: deptIds };
    missed = missedLectures(uid, { from, to, ...opts })
      .filter((o) => !allowedClasses || o.classes.some((c) => allowedClasses.has(c.id)))
      .filter((o) => !f.course_unit_id || o.course_unit_id === f.course_unit_id)
      .filter((o) => isLecturer || !f.lecturer_id || o.lecturer_id === f.lecturer_id)
      .map((o) => ({
        key: `${o.session_id}|${o.date}`,
        date: o.date,
        start_time: o.start_time,
        end_time: o.end_time,
        course_code: o.course_code,
        course_name: o.course_name,
        classes: o.classes.map((c) => ({ id: c.id, name: c.name })),
        lecturer_name: o.lecturer_name,
        room_name: o.room_name,
      }));
    missed = Object.assign(missed, { from, to });
  }

  const facultyCount =
    user.role === 'admin' && !deptFiltered
      ? q.get('SELECT COUNT(*) AS n FROM faculties WHERE university_id = ?', uid).n
      : new Set(departments.map((d) => d.faculty_name)).size;

  return {
    scope: scopeLabel(user),
    role: user.role,
    term: term ? { id: term.id, name: term.name } : null,
    filters: { ...f, labels: filterLabels(uid, f) },
    sections: f.sections,
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
      at_risk_threshold: f.threshold,
      by_course: byCourse,
      by_class: byClass,
      at_risk: atRisk,
    },
    missed: { from: missed.from || null, to: missed.to || null, items: [...missed] },
    rooms,
    departments: deptBreakdown,
  };
}
