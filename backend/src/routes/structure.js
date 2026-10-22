// Faculties (led by a Dean) and their departments (led by a Head of Department).
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { insert, q, tx, update } from '../db.js';
import { facultyIdsForDean, placeholders, visibleDepartmentIds, visibleFacultyIds } from '../scope.js';
import { appointDean, appointHod, leaderCandidate } from '../services/leadership.js';
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

const facultySelect = `
  SELECT f.*, u.name AS dean_name, u.email AS dean_email,
         (SELECT COUNT(*) FROM departments d WHERE d.faculty_id = f.id) AS department_count
    FROM faculties f LEFT JOIN users u ON u.id = f.dean_id`;

router.get('/faculties', (req, res) => {
  const facs = visibleFacultyIds(req.user);
  if (facs === null) return res.json(q.all(`${facultySelect} WHERE f.university_id = ? ORDER BY f.name`, req.uid));
  res.json(q.all(`${facultySelect} WHERE f.university_id = ? AND f.id IN (${placeholders(facs)}) ORDER BY f.name`, req.uid, ...facs));
});

const handedOver = (previousId) => (previousId ? q.get('SELECT id, name FROM users WHERE id = ?', previousId) : null);

/** The administrator appoints Deans; appointing a new one hands the faculty over. */
router.post('/faculties', requireRole('admin'), (req, res) => {
  requireFields(req.body, ['name']);
  const dean = leaderCandidate(req.uid, toInt(req.body.dean_id), 'Dean');
  const id = tx(() => {
    const fid = insert('faculties', { university_id: req.uid, name: req.body.name.trim(), code: req.body.code || null });
    if (dean) appointDean(getFaculty(req.uid, fid), dean.id);
    return fid;
  });
  res.status(201).json(q.get(`${facultySelect} WHERE f.id = ?`, id));
});

router.put('/faculties/:id', requireRole('admin'), (req, res) => {
  const f = getFaculty(req.uid, req.params.id);
  const data = pick(req.body, ['name', 'code']);
  const dean = req.body.dean_id !== undefined ? leaderCandidate(req.uid, toInt(req.body.dean_id), 'Dean') : undefined;
  const previous = tx(() => {
    update('faculties', f.id, data);
    return dean !== undefined ? appointDean(getFaculty(req.uid, f.id), dean?.id ?? null) : null;
  });
  res.json({ ...q.get(`${facultySelect} WHERE f.id = ?`, f.id), handed_over_from: handedOver(previous) });
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
  const where = ['d.university_id = ?'];
  const params = [req.uid];
  const facultyId = toInt(req.query.faculty_id);
  if (facultyId) {
    where.push('d.faculty_id = ?');
    params.push(facultyId);
  }
  const depts = visibleDepartmentIds(req.user);
  if (depts !== null) {
    where.push(`d.id IN (${placeholders(depts)})`);
    params.push(...depts);
  }
  res.json(q.all(`${departmentSelect} WHERE ${where.join(' AND ')} ORDER BY f.name, d.name`, ...params));
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
  const hod = leaderCandidate(req.uid, toInt(req.body.hod_id), 'Head of Department');
  if (hod) assertCanLead(req.user, hod, faculty.id);
  const id = tx(() => {
    const did = insert('departments', { university_id: req.uid, faculty_id: faculty.id, name: req.body.name.trim(), code: req.body.code || null });
    if (hod) appointHod(getDepartment(req.uid, did), hod.id);
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
  const hod = req.body.hod_id !== undefined ? leaderCandidate(req.uid, toInt(req.body.hod_id), 'Head of Department') : undefined;
  if (hod) assertCanLead(req.user, hod, data.faculty_id || d.faculty_id);
  const previous = tx(() => {
    update('departments', d.id, data);
    return hod !== undefined ? appointHod(getDepartment(req.uid, d.id), hod?.id ?? null) : null;
  });
  res.json({ ...q.get(`${departmentSelect} WHERE d.id = ?`, d.id), handed_over_from: handedOver(previous) });
});

/** A Dean appoints Heads of Department from the staff of their own faculty. */
function assertCanLead(actor, candidate, facultyId) {
  if (actor.role === 'admin') return;
  const candidateFaculty = candidate.department_id ? q.get('SELECT faculty_id FROM departments WHERE id = ?', candidate.department_id)?.faculty_id : candidate.faculty_id;
  if (candidateFaculty && candidateFaculty !== Number(facultyId)) throw forbidden(`${candidate.name} works in another faculty`);
}

router.delete('/departments/:id', requireRole('admin', 'dean'), (req, res) => {
  const d = getDepartment(req.uid, req.params.id);
  assertManageFaculty(req.user, d.faculty_id);
  q.run('DELETE FROM departments WHERE id = ?', d.id);
  res.json({ ok: true });
});

export default router;
