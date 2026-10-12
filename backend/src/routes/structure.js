// Faculties (led by a Dean) and their departments (led by a Head of Department).
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { insert, q, tx, update } from '../db.js';
import { facultyIdsForDean } from '../scope.js';
import { badRequest, forbidden, notFound, pick, requireFields, toInt } from '../util.js';

const router = Router();

function getFaculty(uid, id) {
  const f = q.get('SELECT * FROM faculties WHERE id = ? AND university_id = ?', id, uid);
  if (!f) throw notFound('Faculty');
  return f;
}

function getDepartment(uid, id) {
  const d = q.get('SELECT * FROM departments WHERE id = ? AND university_id = ?', id, uid);
  if (!d) throw notFound('Department');
  return d;
}

/** Validates that `userId` can lead a unit: must belong to this university and hold `role`. */
function checkLeader(uid, userId, role, label) {
  if (!userId) return null;
  const u = q.get('SELECT id, role FROM users WHERE id = ? AND university_id = ? AND active = 1', userId, uid);
  if (!u) throw badRequest(`Selected ${label} was not found`);
  if (u.role !== role) throw badRequest(`Only users with the ${label} role can be appointed ${label}`);
  return u.id;
}

const facultySelect = `
  SELECT f.*, u.name AS dean_name, u.email AS dean_email,
         (SELECT COUNT(*) FROM departments d WHERE d.faculty_id = f.id) AS department_count
    FROM faculties f LEFT JOIN users u ON u.id = f.dean_id`;

router.get('/faculties', (req, res) => {
  res.json(q.all(`${facultySelect} WHERE f.university_id = ? ORDER BY f.name`, req.uid));
});

router.post('/faculties', requireRole('admin'), (req, res) => {
  requireFields(req.body, ['name']);
  const deanId = checkLeader(req.uid, toInt(req.body.dean_id), 'dean', 'Dean');
  const id = tx(() => {
    const fid = insert('faculties', { university_id: req.uid, name: req.body.name.trim(), code: req.body.code || null, dean_id: deanId });
    if (deanId) q.run('UPDATE users SET faculty_id = ? WHERE id = ?', fid, deanId);
    return fid;
  });
  res.status(201).json(q.get(`${facultySelect} WHERE f.id = ?`, id));
});

router.put('/faculties/:id', requireRole('admin'), (req, res) => {
  const f = getFaculty(req.uid, req.params.id);
  const data = pick(req.body, ['name', 'code']);
  if (req.body.dean_id !== undefined) data.dean_id = checkLeader(req.uid, toInt(req.body.dean_id), 'dean', 'Dean');
  tx(() => {
    update('faculties', f.id, data);
    if (data.dean_id) q.run('UPDATE users SET faculty_id = ? WHERE id = ?', f.id, data.dean_id);
  });
  res.json(q.get(`${facultySelect} WHERE f.id = ?`, f.id));
});

router.delete('/faculties/:id', requireRole('admin'), (req, res) => {
  const f = getFaculty(req.uid, req.params.id);
  q.run('DELETE FROM faculties WHERE id = ?', f.id);
  res.json({ ok: true });
});

const departmentSelect = `
  SELECT d.*, f.name AS faculty_name, h.name AS hod_name, h.email AS hod_email,
         (SELECT COUNT(*) FROM programs p WHERE p.department_id = d.id) AS program_count,
         (SELECT COUNT(*) FROM users l WHERE l.department_id = d.id AND l.role IN ('lecturer','hod','dean') AND l.active = 1) AS lecturer_count
    FROM departments d
    JOIN faculties f ON f.id = d.faculty_id
    LEFT JOIN users h ON h.id = d.hod_id`;

router.get('/departments', (req, res) => {
  const facultyId = toInt(req.query.faculty_id);
  const rows = facultyId
    ? q.all(`${departmentSelect} WHERE d.university_id = ? AND d.faculty_id = ? ORDER BY d.name`, req.uid, facultyId)
    : q.all(`${departmentSelect} WHERE d.university_id = ? ORDER BY f.name, d.name`, req.uid);
  res.json(rows);
});

function assertManageFaculty(user, facultyId) {
  if (user.role === 'admin') return;
  if (user.role === 'dean' && facultyIdsForDean(user).includes(Number(facultyId))) return;
  throw forbidden('Only the Admin or the Dean of this faculty can do that');
}

router.post('/departments', requireRole('admin', 'dean'), (req, res) => {
  requireFields(req.body, ['name', 'faculty_id']);
  const faculty = getFaculty(req.uid, req.body.faculty_id);
  assertManageFaculty(req.user, faculty.id);
  const hodId = checkLeader(req.uid, toInt(req.body.hod_id), 'hod', 'HoD');
  const id = tx(() => {
    const did = insert('departments', {
      university_id: req.uid,
      faculty_id: faculty.id,
      name: req.body.name.trim(),
      code: req.body.code || null,
      hod_id: hodId,
    });
    if (hodId) q.run('UPDATE users SET department_id = ?, faculty_id = ? WHERE id = ?', did, faculty.id, hodId);
    return did;
  });
  res.status(201).json(q.get(`${departmentSelect} WHERE d.id = ?`, id));
});

router.put('/departments/:id', requireRole('admin', 'dean'), (req, res) => {
  const d = getDepartment(req.uid, req.params.id);
  assertManageFaculty(req.user, d.faculty_id);
  const data = pick(req.body, ['name', 'code']);
  if (req.body.faculty_id !== undefined) {
    const target = getFaculty(req.uid, req.body.faculty_id);
    assertManageFaculty(req.user, target.id);
    data.faculty_id = target.id;
  }
  if (req.body.hod_id !== undefined) data.hod_id = checkLeader(req.uid, toInt(req.body.hod_id), 'hod', 'HoD');
  tx(() => {
    update('departments', d.id, data);
    if (data.hod_id) q.run('UPDATE users SET department_id = ?, faculty_id = ? WHERE id = ?', d.id, data.faculty_id || d.faculty_id, data.hod_id);
  });
  res.json(q.get(`${departmentSelect} WHERE d.id = ?`, d.id));
});

router.delete('/departments/:id', requireRole('admin', 'dean'), (req, res) => {
  const d = getDepartment(req.uid, req.params.id);
  assertManageFaculty(req.user, d.faculty_id);
  q.run('DELETE FROM departments WHERE id = ?', d.id);
  res.json({ ok: true });
});

export default router;
