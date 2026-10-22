// Programmes, course units (incl. cross-cutting units), classes, rooms and academic terms.
import { Router } from 'express';
import { MANAGER_ROLES, requireRole } from '../auth.js';
import { insert, q, tx, update } from '../db.js';
import { assertManageDepartment, canManageDepartment, courseUnitScope, managedDepartmentIds, placeholders, visibleDepartmentIds } from '../scope.js';
import { crossCuttingUnitCount } from '../services/allocation-rules.js';
import { ensureVersion, latestVersion, refreshVersionStatuses } from '../services/curriculum.js';
import { notify } from '../services/notify.js';
import { badRequest, forbidden, needsConfirmation, notFound, pick, requireFields, toInt, truthy } from '../util.js';

const router = Router();

const one = (sql, what, ...params) => {
  const row = q.get(sql, ...params);
  if (!row) throw notFound(what);
  return row;
};

// ---------------------------------------------------------------- Programmes

const programSelect = `
  SELECT p.*, d.name AS department_name, d.faculty_id, f.name AS faculty_name,
         (SELECT COUNT(*) FROM program_course_units x WHERE x.version_id = (SELECT MAX(v.id) FROM curriculum_versions v WHERE v.program_id = p.id AND v.status <> 'retired')) AS course_unit_count,
         (SELECT COUNT(*) FROM classes c WHERE c.program_id = p.id) AS class_count
    FROM programs p JOIN departments d ON d.id = p.department_id JOIN faculties f ON f.id = d.faculty_id`;

router.get('/programs', (req, res) => {
  const where = ['p.university_id = ?'];
  const params = [req.uid];
  const depts = visibleDepartmentIds(req.user);
  if (depts !== null) {
    where.push(`p.department_id IN (${placeholders(depts)})`);
    params.push(...depts);
  }
  if (req.query.department_id) {
    where.push('p.department_id = ?');
    params.push(toInt(req.query.department_id));
  }
  if (req.query.faculty_id) {
    where.push('d.faculty_id = ?');
    params.push(toInt(req.query.faculty_id));
  }
  res.json(q.all(`${programSelect} WHERE ${where.join(' AND ')} ORDER BY p.code`, ...params));
});

router.get('/programs/:id', (req, res) => {
  const program = one(`${programSelect} WHERE p.id = ? AND p.university_id = ?`, 'Programme', req.params.id, req.uid);
  const depts = visibleDepartmentIds(req.user);
  if (depts !== null && !depts.includes(program.department_id)) throw notFound('Programme');
  program.versions = versionsOf(program.id);
  const latest = latestVersion(program.id);
  const version = (toInt(req.query.version_id) && program.versions.find((v) => v.id === toInt(req.query.version_id))) || program.versions.find((v) => v.id === latest?.id) || null;
  program.version = version;
  program.course_units = version
    ? q.all(
        `SELECT cu.*, pcu.year_of_study, pcu.semester,
                (SELECT COUNT(DISTINCT o.program_id) FROM program_course_units o WHERE o.course_unit_id = cu.id) AS program_count
           FROM program_course_units pcu JOIN course_units cu ON cu.id = pcu.course_unit_id
          WHERE pcu.version_id = ? ORDER BY pcu.year_of_study, pcu.semester, cu.code`,
        version.id,
      )
    : [];
  program.classes = q.all(
    `SELECT c.*, v.name AS curriculum_version_name FROM classes c LEFT JOIN curriculum_versions v ON v.id = c.curriculum_version_id
      WHERE c.program_id = ? ORDER BY c.status = 'completed', c.year_of_study, c.name`,
    program.id,
  );
  res.json(program);
});

const PROGRAM_FIELDS = ['department_id', 'name', 'code', 'level', 'duration_years', 'coursework_max'];

/** A programme's curriculum versions with how many units and running classes each has. */
function versionsOf(programId) {
  return q.all(
    `SELECT v.*, (SELECT COUNT(*) FROM program_course_units x WHERE x.version_id = v.id) AS unit_count,
            (SELECT COUNT(*) FROM classes c WHERE c.curriculum_version_id = v.id AND c.status = 'active') AS class_count
       FROM curriculum_versions v WHERE v.program_id = ? ORDER BY v.id DESC`,
    programId,
  );
}

function versionOf(program, versionId) {
  if (!versionId) return ensureVersion(program);
  const v = q.get('SELECT * FROM curriculum_versions WHERE id = ? AND program_id = ?', toInt(versionId), program.id);
  if (!v) throw badRequest('That curriculum version does not belong to this programme');
  if (v.status === 'retired') throw badRequest(`${v.name} is retired; edit a current version`);
  return v;
}

/** List a programme's curriculum versions. */
router.get('/programs/:id/versions', (req, res) => {
  const program = one('SELECT * FROM programs WHERE id = ? AND university_id = ?', 'Programme', req.params.id, req.uid);
  res.json(versionsOf(program.id));
});

/**
 * A new curriculum version, starting as a copy of the latest one. New intakes follow it; classes
 * already running keep their version until they finish.
 */
router.post('/programs/:id/versions', requireRole(...MANAGER_ROLES), (req, res) => {
  requireFields(req.body, ['name']);
  const program = one('SELECT * FROM programs WHERE id = ? AND university_id = ?', 'Programme', req.params.id, req.uid);
  assertManageDepartment(req.user, program.department_id);
  const year = String(req.body.starts_academic_year || '').trim() || null;
  if (year && !/^\d{4}\/\d{4}$/.test(year)) throw badRequest('Academic year must look like 2027/2028');
  const from = latestVersion(program.id);
  const id = tx(() => {
    const vid = insert('curriculum_versions', { university_id: req.uid, program_id: program.id, name: String(req.body.name).trim(), starts_academic_year: year, status: 'active', created_by: req.user.id });
    if (from && req.body.copy !== false) {
      q.run(
        `INSERT INTO program_course_units (program_id, version_id, course_unit_id, year_of_study, semester)
           SELECT program_id, ?, course_unit_id, year_of_study, semester FROM program_course_units WHERE version_id = ?`,
        vid,
        from.id,
      );
    }
    refreshVersionStatuses(req.uid);
    return vid;
  });
  res.status(201).json(versionsOf(program.id).find((v) => v.id === id));
});

router.put('/curriculum-versions/:id', requireRole(...MANAGER_ROLES), (req, res) => {
  const v = one('SELECT * FROM curriculum_versions WHERE id = ? AND university_id = ?', 'Curriculum version', req.params.id, req.uid);
  const program = q.get('SELECT * FROM programs WHERE id = ?', v.program_id);
  assertManageDepartment(req.user, program.department_id);
  const data = pick(req.body, ['name', 'starts_academic_year', 'status']);
  if (data.status !== undefined && !['active', 'phasing_out', 'retired'].includes(data.status)) throw badRequest('Status must be active, phasing_out or retired');
  if (data.status === 'retired' && q.get("SELECT 1 FROM classes WHERE curriculum_version_id = ? AND status = 'active'", v.id)) {
    throw badRequest('Classes still follow this version; it retires by itself when they finish');
  }
  if (data.starts_academic_year && !/^\d{4}\/\d{4}$/.test(data.starts_academic_year)) throw badRequest('Academic year must look like 2027/2028');
  update('curriculum_versions', v.id, data);
  res.json(versionsOf(program.id).find((x) => x.id === v.id));
});

/** Coursework total per programme (e.g. 40), set by the HoD; marks are converted to it. */
function checkCourseworkMax(data) {
  if (data.coursework_max === undefined) return;
  const n = Number(data.coursework_max);
  if (!(n > 0 && n <= 100)) throw badRequest('Coursework total must be between 1 and 100');
  data.coursework_max = n;
}

router.post('/programs', requireRole(...MANAGER_ROLES), (req, res) => {
  requireFields(req.body, ['department_id', 'name', 'code']);
  const data = pick(req.body, PROGRAM_FIELDS);
  checkCourseworkMax(data);
  one('SELECT id FROM departments WHERE id = ? AND university_id = ?', 'Department', data.department_id, req.uid);
  assertManageDepartment(req.user, data.department_id);
  data.code = String(data.code).trim().toUpperCase();
  const id = tx(() => {
    const pid = insert('programs', { ...data, university_id: req.uid });
    ensureVersion({ id: pid, university_id: req.uid });
    return pid;
  });
  res.status(201).json(q.get(`${programSelect} WHERE p.id = ?`, id));
});

router.put('/programs/:id', requireRole(...MANAGER_ROLES), (req, res) => {
  const p = one('SELECT * FROM programs WHERE id = ? AND university_id = ?', 'Programme', req.params.id, req.uid);
  assertManageDepartment(req.user, p.department_id);
  const data = pick(req.body, PROGRAM_FIELDS);
  checkCourseworkMax(data);
  if (data.department_id) {
    one('SELECT id FROM departments WHERE id = ? AND university_id = ?', 'Department', data.department_id, req.uid);
    assertManageDepartment(req.user, data.department_id);
  }
  if (data.code) data.code = String(data.code).trim().toUpperCase();
  update('programs', p.id, data);
  res.json(q.get(`${programSelect} WHERE p.id = ?`, p.id));
});

router.delete('/programs/:id', requireRole(...MANAGER_ROLES), (req, res) => {
  const p = one('SELECT * FROM programs WHERE id = ? AND university_id = ?', 'Programme', req.params.id, req.uid);
  assertManageDepartment(req.user, p.department_id);
  q.run('DELETE FROM programs WHERE id = ?', p.id);
  res.json({ ok: true });
});

/** A non cross-cutting unit may belong to one programme only. */
function assertLinkable(courseUnit, programId) {
  if (courseUnit.is_cross_cutting) return;
  const other = q.get(
    `SELECT p.code FROM program_course_units pcu JOIN programs p ON p.id = pcu.program_id
      WHERE pcu.course_unit_id = ? AND pcu.program_id != ?`,
    courseUnit.id,
    programId,
  );
  if (other) {
    throw badRequest(
      `${courseUnit.code} already belongs to ${other.code}. Mark it as cross-cutting to share it across programmes.`,
    );
  }
}

function linkCourseUnit(program, courseUnit, yearOfStudy, semester, versionId = null) {
  const year = toInt(yearOfStudy) || 1;
  const sem = toInt(semester) || 1;
  if (year < 1 || year > (program.duration_years || 7)) throw badRequest(`Year of study must be between 1 and ${program.duration_years}`);
  if (![1, 2, 3].includes(sem)) throw badRequest('Semester must be 1, 2 or 3');
  assertLinkable(courseUnit, program.id);
  const version = versionOf(program, versionId);
  q.run(
    `INSERT INTO program_course_units (program_id, version_id, course_unit_id, year_of_study, semester) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (version_id, course_unit_id) DO UPDATE SET year_of_study = excluded.year_of_study, semester = excluded.semester`,
    program.id,
    version.id,
    courseUnit.id,
    year,
    sem,
  );
}

router.post('/programs/:id/course-units', requireRole(...MANAGER_ROLES), (req, res) => {
  requireFields(req.body, ['course_unit_id']);
  const program = one('SELECT * FROM programs WHERE id = ? AND university_id = ?', 'Programme', req.params.id, req.uid);
  assertManageDepartment(req.user, program.department_id);
  const cu = one('SELECT * FROM course_units WHERE id = ? AND university_id = ?', 'Course unit', req.body.course_unit_id, req.uid);
  linkCourseUnit(program, cu, req.body.year_of_study, req.body.semester, req.body.version_id);
  res.status(201).json({ ok: true });
});

router.delete('/programs/:id/course-units/:cuId', requireRole(...MANAGER_ROLES), (req, res) => {
  const program = one('SELECT * FROM programs WHERE id = ? AND university_id = ?', 'Programme', req.params.id, req.uid);
  assertManageDepartment(req.user, program.department_id);
  const version = versionOf(program, req.query.version_id);
  q.run('DELETE FROM program_course_units WHERE version_id = ? AND course_unit_id = ?', version.id, req.params.cuId);
  res.json({ ok: true });
});

// -------------------------------------------------------------- Course units

const courseUnitSelect = `
  SELECT cu.*, d.name AS department_name,
         (SELECT COUNT(DISTINCT x.program_id) FROM program_course_units x WHERE x.course_unit_id = cu.id) AS program_count
    FROM course_units cu LEFT JOIN departments d ON d.id = cu.department_id`;

function withPrograms(units) {
  const ids = units.map((u) => u.id);
  if (!ids.length) return units;
  const links = q.all(
    `SELECT pcu.course_unit_id, pcu.year_of_study, pcu.semester, p.id, p.code, p.name, p.department_id
       FROM program_course_units pcu JOIN programs p ON p.id = pcu.program_id
      WHERE pcu.course_unit_id IN (${placeholders(ids)})
        AND pcu.version_id = (SELECT MAX(v.id) FROM curriculum_versions v WHERE v.program_id = pcu.program_id AND v.status <> 'retired')
      ORDER BY p.code`,
    ...ids,
  );
  return units.map((u) => ({
    ...u,
    programs: links
      .filter((l) => l.course_unit_id === u.id)
      .map(({ id, code, name, department_id, year_of_study, semester }) => ({ id, code, name, department_id, year_of_study, semester })),
  }));
}

/**
 * Adds how each unit relates to the user's departments and whether they may change it:
 * 'own' (owned and taught only here), 'out' (owned here, also taught to other departments' programmes)
 * or 'in' (owned elsewhere, taught to one of our programmes).
 */
function describeUnits(user, units) {
  const depts = visibleDepartmentIds(user);
  const mine = (deptId) => (depts === null ? true : depts.includes(deptId));
  return withPrograms(units).map((u) => {
    const programDepts = (u.programs || []).map((p) => p.department_id);
    let sharing = 'own';
    if (depts === null) sharing = programDepts.some((d) => d !== u.department_id) ? 'out' : 'own';
    else if (!mine(u.department_id)) sharing = 'in';
    else if (programDepts.some((d) => !mine(d))) sharing = 'out';
    const canManage = MANAGER_ROLES.includes(user.role) && (u.department_id ? canManageDepartment(user, u.department_id) : user.role === 'admin');
    return { ...u, sharing, can_manage: canManage };
  });
}

router.get('/course-units', (req, res) => {
  const where = ['cu.university_id = ?'];
  const params = [req.uid];
  // A department sees the units it owns and the cross-cutting units taught to its programmes.
  const depts = visibleDepartmentIds(req.user);
  if (depts !== null) {
    const scope = courseUnitScope('cu', depts);
    where.push(scope.sql);
    params.push(...scope.params);
  }
  if (req.query.department_id) {
    where.push('cu.department_id = ?');
    params.push(toInt(req.query.department_id));
  }
  if (req.query.cross_cutting !== undefined) {
    where.push('cu.is_cross_cutting = ?');
    params.push(truthy(req.query.cross_cutting) ? 1 : 0);
  }
  if (req.query.program_id) {
    where.push('cu.id IN (SELECT course_unit_id FROM program_course_units WHERE program_id = ?)');
    params.push(toInt(req.query.program_id));
  }
  if (req.query.q) {
    where.push('(cu.code LIKE ? OR cu.name LIKE ?)');
    params.push(`%${req.query.q}%`, `%${req.query.q}%`);
  }
  const units = q.all(`${courseUnitSelect} WHERE ${where.join(' AND ')} ORDER BY cu.is_cross_cutting DESC, cu.code`, ...params);
  let rows = describeUnits(req.user, units);
  if (['own', 'in', 'out'].includes(req.query.sharing)) rows = rows.filter((u) => u.sharing === req.query.sharing);
  res.json(rows);
});

const CU_FIELDS = ['code', 'name', 'credit_units', 'hours_per_week', 'description', 'is_cross_cutting', 'department_id', 'preferred_room_type'];

function cleanCourseUnit(uid, body) {
  const data = pick(body, CU_FIELDS);
  if (data.code !== undefined) data.code = String(data.code).trim().toUpperCase();
  if (data.is_cross_cutting !== undefined) data.is_cross_cutting = truthy(data.is_cross_cutting) ? 1 : 0;
  if (data.department_id !== undefined) {
    data.department_id = toInt(data.department_id);
    if (data.department_id) one('SELECT id FROM departments WHERE id = ? AND university_id = ?', 'Department', data.department_id, uid);
  }
  for (const k of ['credit_units', 'hours_per_week']) {
    if (data[k] !== undefined) {
      data[k] = toInt(data[k]);
      if (!(data[k] >= 1 && data[k] <= 20)) throw badRequest(`${k.replace(/_/g, ' ')} must be between 1 and 20`);
    }
  }
  if (data.preferred_room_type === '') data.preferred_room_type = null;
  return data;
}

/** Cross-cutting units are shared by programmes across departments, so only Admins (or Deans) create unowned ones. */
function assertManageCourseUnit(user, departmentId) {
  if (departmentId) return assertManageDepartment(user, departmentId);
  if (user.role !== 'admin') throw forbidden('Choose the department that owns this course unit');
}

router.post('/course-units', requireRole(...MANAGER_ROLES), (req, res) => {
  requireFields(req.body, ['code', 'name']);
  const data = cleanCourseUnit(req.uid, req.body);
  assertManageCourseUnit(req.user, data.department_id);
  const programs = Array.isArray(req.body.programs) ? req.body.programs : [];

  // Policy: cross-cutting units are created (and allocated) before programme-specific ones.
  if (!data.is_cross_cutting && !truthy(req.body.force) && crossCuttingUnitCount(req.uid) === 0) {
    throw needsConfirmation(
      'No cross-cutting course units have been created yet. Cross-cutting units (e.g. Communication Skills, ' +
        'Entrepreneurship) are shared across programmes and should be set up first so they can be allocated first. ' +
        'Create this programme-specific unit anyway?',
      'CROSS_CUTTING_FIRST',
    );
  }
  if (!data.is_cross_cutting && programs.length > 1) {
    throw badRequest('Only cross-cutting course units can be shared by more than one programme');
  }

  const id = tx(() => {
    const cuId = insert('course_units', { ...data, university_id: req.uid });
    const cu = q.get('SELECT * FROM course_units WHERE id = ?', cuId);
    for (const link of programs) {
      const program = one('SELECT * FROM programs WHERE id = ? AND university_id = ?', 'Programme', link.program_id, req.uid);
      linkCourseUnit(program, cu, link.year_of_study, link.semester);
    }
    return cuId;
  });
  res.status(201).json(describeUnits(req.user, [q.get(`${courseUnitSelect} WHERE cu.id = ?`, id)])[0]);
});

router.put('/course-units/:id', requireRole(...MANAGER_ROLES), (req, res) => {
  const cu = one('SELECT * FROM course_units WHERE id = ? AND university_id = ?', 'Course unit', req.params.id, req.uid);
  assertManageCourseUnit(req.user, cu.department_id);
  const data = cleanCourseUnit(req.uid, req.body);
  if ('department_id' in data) assertManageCourseUnit(req.user, data.department_id);
  if (data.is_cross_cutting === 0 && cu.is_cross_cutting) {
    const n = q.get('SELECT COUNT(DISTINCT program_id) AS n FROM program_course_units WHERE course_unit_id = ?', cu.id).n;
    if (n > 1) throw badRequest(`${cu.code} is used by ${n} programmes, so it must stay cross-cutting`);
  }
  update('course_units', cu.id, data);
  res.json(describeUnits(req.user, [q.get(`${courseUnitSelect} WHERE cu.id = ?`, cu.id)])[0]);
});

router.delete('/course-units/:id', requireRole(...MANAGER_ROLES), (req, res) => {
  const cu = one('SELECT * FROM course_units WHERE id = ? AND university_id = ?', 'Course unit', req.params.id, req.uid);
  assertManageCourseUnit(req.user, cu.department_id);
  q.run('DELETE FROM course_units WHERE id = ?', cu.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------------- Classes

const classSelect = `
  SELECT c.*, p.code AS program_code, p.name AS program_name, p.department_id, d.name AS department_name,
         (SELECT v.name FROM curriculum_versions v WHERE v.id = c.curriculum_version_id) AS curriculum_version_name,
         r.name AS class_rep_name, r.email AS class_rep_email,
         (SELECT COUNT(*) FROM users s WHERE s.class_id = c.id AND s.role = 'student' AND s.active = 1) AS student_count
    FROM classes c JOIN programs p ON p.id = c.program_id JOIN departments d ON d.id = p.department_id
    LEFT JOIN users r ON r.id = c.class_rep_id`;

router.get('/classes', (req, res) => {
  const where = ['c.university_id = ?'];
  const params = [req.uid];
  // Classes that finished their programme are kept for history but left out of everyday lists.
  if (req.query.status === 'completed') where.push("c.status = 'completed'");
  else if (!truthy(req.query.include_completed)) where.push("c.status = 'active'");
  if (req.query.program_id) {
    where.push('c.program_id = ?');
    params.push(toInt(req.query.program_id));
  }
  if (req.query.department_id) {
    where.push('p.department_id = ?');
    params.push(toInt(req.query.department_id));
  }
  const ids = truthy(req.query.mine) ? managedDepartmentIds(req.user) : visibleDepartmentIds(req.user);
  if (ids !== null) {
    if (req.user.role === 'lecturer') {
      // Lecturers see their department's classes and the classes they teach.
      where.push(`(p.department_id IN (${placeholders(ids)}) OR c.id IN (
        SELECT ac.class_id FROM allocation_classes ac JOIN allocations a ON a.id = ac.allocation_id WHERE a.lecturer_id = ?))`);
      params.push(...ids, req.user.id);
    } else {
      where.push(`p.department_id IN (${placeholders(ids)})`);
      params.push(...ids);
    }
  }
  res.json(q.all(`${classSelect} WHERE ${where.join(' AND ')} ORDER BY p.code, c.year_of_study, c.name`, ...params));
});

function getClass(uid, id) {
  return one(`${classSelect} WHERE c.id = ? AND c.university_id = ?`, 'Class', id, uid);
}

/** Staff, and the class's own students, may see the class list. */
router.get('/classes/:id/students', (req, res) => {
  const cls = getClass(req.uid, req.params.id);
  if (req.user.role === 'student' && req.user.class_id !== cls.id) throw forbidden();
  if (req.user.role !== 'student') {
    const depts = visibleDepartmentIds(req.user);
    const teaches = q.get(
      'SELECT 1 FROM allocation_classes ac JOIN allocations a ON a.id = ac.allocation_id WHERE ac.class_id = ? AND a.lecturer_id = ?',
      cls.id,
      req.user.id,
    );
    if (depts !== null && !depts.includes(cls.department_id) && !teaches) throw forbidden('That class is outside your unit');
  }
  res.json(
    q.all(
      `SELECT id, name, email, identifier, phone, active, (id = ?) AS is_class_rep FROM users
        WHERE class_id = ? AND role = 'student' AND active = 1 ORDER BY name`,
      cls.class_rep_id,
      cls.id,
    ),
  );
});

const CLASS_FIELDS = ['program_id', 'name', 'year_of_study', 'academic_year', 'expected_size', 'curriculum_version_id'];

function classVersion(program, versionId) {
  if (!versionId) return latestVersion(program.id)?.id ?? ensureVersion(program).id;
  const v = q.get('SELECT * FROM curriculum_versions WHERE id = ? AND program_id = ?', toInt(versionId), program.id);
  if (!v) throw badRequest('Choose one of the programme\'s curriculum versions');
  return v.id;
}

router.post('/classes', requireRole(...MANAGER_ROLES), (req, res) => {
  requireFields(req.body, ['program_id', 'name']);
  const data = pick(req.body, CLASS_FIELDS);
  const program = one('SELECT * FROM programs WHERE id = ? AND university_id = ?', 'Programme', data.program_id, req.uid);
  assertManageDepartment(req.user, program.department_id);
  data.curriculum_version_id = classVersion(program, data.curriculum_version_id);
  const id = insert('classes', { ...data, university_id: req.uid, intake_year: data.academic_year || null });
  res.status(201).json(getClass(req.uid, id));
});

router.put('/classes/:id', requireRole(...MANAGER_ROLES), (req, res) => {
  const cls = getClass(req.uid, req.params.id);
  assertManageDepartment(req.user, cls.department_id);
  const data = pick(req.body, CLASS_FIELDS);
  if (data.program_id) {
    const program = one('SELECT * FROM programs WHERE id = ? AND university_id = ?', 'Programme', data.program_id, req.uid);
    assertManageDepartment(req.user, program.department_id);
  }
  if (data.curriculum_version_id !== undefined || data.program_id) {
    const program = q.get('SELECT * FROM programs WHERE id = ?', data.program_id || cls.program_id);
    data.curriculum_version_id = classVersion(program, data.curriculum_version_id ?? (data.program_id && data.program_id !== cls.program_id ? null : cls.curriculum_version_id));
  }
  update('classes', cls.id, data);
  refreshVersionStatuses(req.uid);
  res.json(getClass(req.uid, cls.id));
});

router.delete('/classes/:id', requireRole(...MANAGER_ROLES), (req, res) => {
  const cls = getClass(req.uid, req.params.id);
  assertManageDepartment(req.user, cls.department_id);
  q.run('DELETE FROM classes WHERE id = ?', cls.id);
  res.json({ ok: true });
});

/** Appoint (or clear with `student_id: null`) the class representative. */
router.put('/classes/:id/rep', requireRole(...MANAGER_ROLES), (req, res) => {
  const cls = getClass(req.uid, req.params.id);
  assertManageDepartment(req.user, cls.department_id);
  const studentId = toInt(req.body?.student_id);
  if (studentId) {
    const s = q.get("SELECT id FROM users WHERE id = ? AND class_id = ? AND role = 'student' AND active = 1", studentId, cls.id);
    if (!s) throw badRequest('The class representative must be an active student of this class');
  }
  update('classes', cls.id, { class_rep_id: studentId });
  if (studentId && studentId !== cls.class_rep_id) {
    notify(studentId, {
      title: 'You are now a class representative',
      body: `You have been appointed class representative for ${cls.name}. You can now take attendance during lectures.`,
      type: 'appointment',
      link: '/attendance',
    });
  }
  res.json(getClass(req.uid, cls.id));
});

// --------------------------------------------------------------------- Rooms

const ROOM_FIELDS = ['name', 'building', 'capacity', 'room_type', 'active'];

router.get('/rooms', (req, res) => {
  res.json(q.all('SELECT * FROM rooms WHERE university_id = ? ORDER BY building, name', req.uid));
});

router.post('/rooms', requireRole('admin'), (req, res) => {
  requireFields(req.body, ['name', 'capacity']);
  const data = pick(req.body, ROOM_FIELDS);
  if (data.active !== undefined) data.active = truthy(data.active) ? 1 : 0;
  const id = insert('rooms', { ...data, university_id: req.uid });
  res.status(201).json(q.get('SELECT * FROM rooms WHERE id = ?', id));
});

router.put('/rooms/:id', requireRole('admin'), (req, res) => {
  const room = one('SELECT * FROM rooms WHERE id = ? AND university_id = ?', 'Room', req.params.id, req.uid);
  const data = pick(req.body, ROOM_FIELDS);
  if (data.active !== undefined) data.active = truthy(data.active) ? 1 : 0;
  update('rooms', room.id, data);
  res.json(q.get('SELECT * FROM rooms WHERE id = ?', room.id));
});

router.delete('/rooms/:id', requireRole('admin'), (req, res) => {
  const room = one('SELECT * FROM rooms WHERE id = ? AND university_id = ?', 'Room', req.params.id, req.uid);
  q.run('DELETE FROM rooms WHERE id = ?', room.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------ Academic terms

const TERM_FIELDS = ['name', 'academic_year', 'semester', 'start_date', 'end_date'];

router.get('/terms', (req, res) => {
  res.json(q.all('SELECT * FROM academic_terms WHERE university_id = ? ORDER BY start_date DESC, id DESC', req.uid));
});

function setCurrent(uid, termId) {
  q.run('UPDATE academic_terms SET is_current = (id = ?) WHERE university_id = ?', termId, uid);
}

/**
 * A new academic year: its semesters with their start and end dates, named after the year
 * (e.g. "2027/2028 Semester 1"). When Semester 1 starts, classes move up a year by themselves.
 */
router.post('/academic-years', requireRole('admin'), (req, res) => {
  requireFields(req.body, ['academic_year', 'semesters']);
  const year = String(req.body.academic_year).trim();
  const m = /^(\d{4})\/(\d{4})$/.exec(year);
  if (!m || Number(m[2]) !== Number(m[1]) + 1) throw badRequest('Academic year must look like 2027/2028');
  const semesters = (Array.isArray(req.body.semesters) ? req.body.semesters : [])
    .map((x) => ({ semester: toInt(x.semester), start_date: x.start_date, end_date: x.end_date }))
    .sort((a, b) => a.semester - b.semester);
  if (!semesters.length) throw badRequest('Add at least one semester');
  const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  let last = null;
  for (const x of semesters) {
    if (![1, 2, 3].includes(x.semester)) throw badRequest('Semesters are numbered 1 to 3');
    if (!isDate(x.start_date) || !isDate(x.end_date) || x.start_date >= x.end_date) throw badRequest(`Semester ${x.semester} needs a start date before its end date`);
    if (last && x.start_date <= last.end_date) throw badRequest(`Semester ${x.semester} must start after Semester ${last.semester} ends`);
    if (q.get('SELECT 1 FROM academic_terms WHERE university_id = ? AND academic_year = ? AND semester = ?', req.uid, year, x.semester)) {
      throw badRequest(`${year} Semester ${x.semester} already exists`);
    }
    last = x;
  }
  const ids = tx(() =>
    semesters.map((x) =>
      insert('academic_terms', { university_id: req.uid, name: `${year} Semester ${x.semester}`, academic_year: year, semester: x.semester, start_date: x.start_date, end_date: x.end_date }),
    ),
  );
  if (!q.get('SELECT 1 FROM academic_terms WHERE university_id = ? AND is_current = 1', req.uid)) setCurrent(req.uid, ids[0]);
  res.status(201).json(q.all(`SELECT * FROM academic_terms WHERE id IN (${placeholders(ids)}) ORDER BY semester`, ...ids));
});

router.post('/terms', requireRole('admin'), (req, res) => {
  requireFields(req.body, ['name', 'semester']);
  const data = pick(req.body, TERM_FIELDS);
  if (data.start_date && data.end_date && data.start_date > data.end_date) throw badRequest('The term must end after it starts');
  const id = tx(() => {
    const tid = insert('academic_terms', { ...data, university_id: req.uid });
    const hasCurrent = q.get('SELECT 1 FROM academic_terms WHERE university_id = ? AND is_current = 1', req.uid);
    if (truthy(req.body.is_current) || !hasCurrent) setCurrent(req.uid, tid);
    return tid;
  });
  res.status(201).json(q.get('SELECT * FROM academic_terms WHERE id = ?', id));
});

router.put('/terms/:id', requireRole('admin'), (req, res) => {
  const term = one('SELECT * FROM academic_terms WHERE id = ? AND university_id = ?', 'Term', req.params.id, req.uid);
  const data = pick(req.body, TERM_FIELDS);
  tx(() => {
    update('academic_terms', term.id, data);
    if (truthy(req.body.is_current)) setCurrent(req.uid, term.id);
  });
  res.json(q.get('SELECT * FROM academic_terms WHERE id = ?', term.id));
});

router.delete('/terms/:id', requireRole('admin'), (req, res) => {
  const term = one('SELECT * FROM academic_terms WHERE id = ? AND university_id = ?', 'Term', req.params.id, req.uid);
  q.run('DELETE FROM academic_terms WHERE id = ?', term.id);
  res.json({ ok: true });
});

export default router;
