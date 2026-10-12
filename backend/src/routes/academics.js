// Programmes, course units (incl. cross-cutting units), classes, rooms and academic terms.
import { Router } from 'express';
import { MANAGER_ROLES, requireRole } from '../auth.js';
import { insert, q, tx, update } from '../db.js';
import { assertManageDepartment, managedDepartmentIds, placeholders } from '../scope.js';
import { crossCuttingUnitCount } from '../services/allocation-rules.js';
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
         (SELECT COUNT(*) FROM program_course_units x WHERE x.program_id = p.id) AS course_unit_count,
         (SELECT COUNT(*) FROM classes c WHERE c.program_id = p.id) AS class_count
    FROM programs p JOIN departments d ON d.id = p.department_id JOIN faculties f ON f.id = d.faculty_id`;

router.get('/programs', (req, res) => {
  const where = ['p.university_id = ?'];
  const params = [req.uid];
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
  program.course_units = q.all(
    `SELECT cu.*, pcu.year_of_study, pcu.semester,
            (SELECT COUNT(*) FROM program_course_units o WHERE o.course_unit_id = cu.id) AS program_count
       FROM program_course_units pcu JOIN course_units cu ON cu.id = pcu.course_unit_id
      WHERE pcu.program_id = ? ORDER BY pcu.year_of_study, pcu.semester, cu.code`,
    program.id,
  );
  program.classes = q.all('SELECT * FROM classes WHERE program_id = ? ORDER BY year_of_study, name', program.id);
  res.json(program);
});

const PROGRAM_FIELDS = ['department_id', 'name', 'code', 'level', 'duration_years'];

router.post('/programs', requireRole(...MANAGER_ROLES), (req, res) => {
  requireFields(req.body, ['department_id', 'name', 'code']);
  const data = pick(req.body, PROGRAM_FIELDS);
  one('SELECT id FROM departments WHERE id = ? AND university_id = ?', 'Department', data.department_id, req.uid);
  assertManageDepartment(req.user, data.department_id);
  data.code = String(data.code).trim().toUpperCase();
  const id = insert('programs', { ...data, university_id: req.uid });
  res.status(201).json(q.get(`${programSelect} WHERE p.id = ?`, id));
});

router.put('/programs/:id', requireRole(...MANAGER_ROLES), (req, res) => {
  const p = one('SELECT * FROM programs WHERE id = ? AND university_id = ?', 'Programme', req.params.id, req.uid);
  assertManageDepartment(req.user, p.department_id);
  const data = pick(req.body, PROGRAM_FIELDS);
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

function linkCourseUnit(program, courseUnit, yearOfStudy, semester) {
  const year = toInt(yearOfStudy) || 1;
  const sem = toInt(semester) || 1;
  if (year < 1 || year > (program.duration_years || 7)) throw badRequest(`Year of study must be between 1 and ${program.duration_years}`);
  if (![1, 2, 3].includes(sem)) throw badRequest('Semester must be 1, 2 or 3');
  assertLinkable(courseUnit, program.id);
  q.run(
    `INSERT INTO program_course_units (program_id, course_unit_id, year_of_study, semester) VALUES (?, ?, ?, ?)
       ON CONFLICT (program_id, course_unit_id) DO UPDATE SET year_of_study = excluded.year_of_study, semester = excluded.semester`,
    program.id,
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
  linkCourseUnit(program, cu, req.body.year_of_study, req.body.semester);
  res.status(201).json({ ok: true });
});

router.delete('/programs/:id/course-units/:cuId', requireRole(...MANAGER_ROLES), (req, res) => {
  const program = one('SELECT * FROM programs WHERE id = ? AND university_id = ?', 'Programme', req.params.id, req.uid);
  assertManageDepartment(req.user, program.department_id);
  q.run('DELETE FROM program_course_units WHERE program_id = ? AND course_unit_id = ?', program.id, req.params.cuId);
  res.json({ ok: true });
});

// -------------------------------------------------------------- Course units

const courseUnitSelect = `
  SELECT cu.*, d.name AS department_name,
         (SELECT COUNT(*) FROM program_course_units x WHERE x.course_unit_id = cu.id) AS program_count
    FROM course_units cu LEFT JOIN departments d ON d.id = cu.department_id`;

function withPrograms(units) {
  const ids = units.map((u) => u.id);
  if (!ids.length) return units;
  const links = q.all(
    `SELECT pcu.course_unit_id, pcu.year_of_study, pcu.semester, p.id, p.code, p.name
       FROM program_course_units pcu JOIN programs p ON p.id = pcu.program_id
      WHERE pcu.course_unit_id IN (${placeholders(ids)}) ORDER BY p.code`,
    ...ids,
  );
  return units.map((u) => ({
    ...u,
    programs: links
      .filter((l) => l.course_unit_id === u.id)
      .map(({ id, code, name, year_of_study, semester }) => ({ id, code, name, year_of_study, semester })),
  }));
}

router.get('/course-units', (req, res) => {
  const where = ['cu.university_id = ?'];
  const params = [req.uid];
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
  res.json(withPrograms(units));
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
  res.status(201).json(withPrograms([q.get(`${courseUnitSelect} WHERE cu.id = ?`, id)])[0]);
});

router.put('/course-units/:id', requireRole(...MANAGER_ROLES), (req, res) => {
  const cu = one('SELECT * FROM course_units WHERE id = ? AND university_id = ?', 'Course unit', req.params.id, req.uid);
  assertManageCourseUnit(req.user, cu.department_id);
  const data = cleanCourseUnit(req.uid, req.body);
  if ('department_id' in data) assertManageCourseUnit(req.user, data.department_id);
  if (data.is_cross_cutting === 0 && cu.is_cross_cutting) {
    const n = q.get('SELECT COUNT(*) AS n FROM program_course_units WHERE course_unit_id = ?', cu.id).n;
    if (n > 1) throw badRequest(`${cu.code} is used by ${n} programmes, so it must stay cross-cutting`);
  }
  update('course_units', cu.id, data);
  res.json(withPrograms([q.get(`${courseUnitSelect} WHERE cu.id = ?`, cu.id)])[0]);
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
         r.name AS class_rep_name, r.email AS class_rep_email,
         (SELECT COUNT(*) FROM users s WHERE s.class_id = c.id AND s.role = 'student' AND s.active = 1) AS student_count
    FROM classes c JOIN programs p ON p.id = c.program_id JOIN departments d ON d.id = p.department_id
    LEFT JOIN users r ON r.id = c.class_rep_id`;

router.get('/classes', (req, res) => {
  const where = ['c.university_id = ?'];
  const params = [req.uid];
  if (req.query.program_id) {
    where.push('c.program_id = ?');
    params.push(toInt(req.query.program_id));
  }
  if (req.query.department_id) {
    where.push('p.department_id = ?');
    params.push(toInt(req.query.department_id));
  }
  if (truthy(req.query.mine)) {
    const ids = managedDepartmentIds(req.user);
    if (ids !== null) {
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
  res.json(
    q.all(
      `SELECT id, name, email, identifier, phone, active, (id = ?) AS is_class_rep FROM users
        WHERE class_id = ? AND role = 'student' AND active = 1 ORDER BY name`,
      cls.class_rep_id,
      cls.id,
    ),
  );
});

const CLASS_FIELDS = ['program_id', 'name', 'year_of_study', 'academic_year', 'expected_size'];

router.post('/classes', requireRole(...MANAGER_ROLES), (req, res) => {
  requireFields(req.body, ['program_id', 'name']);
  const data = pick(req.body, CLASS_FIELDS);
  const program = one('SELECT * FROM programs WHERE id = ? AND university_id = ?', 'Programme', data.program_id, req.uid);
  assertManageDepartment(req.user, program.department_id);
  const id = insert('classes', { ...data, university_id: req.uid });
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
  update('classes', cls.id, data);
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
