import crypto from 'node:crypto';
import { Router } from 'express';
import { hashPassword, requireRole, STAFF_ROLES } from '../auth.js';
import { insert, q, tx, update } from '../db.js';
import { isProtectedDemoAccount } from '../demo.js';
import { canManageDepartment, userScope } from '../scope.js';
import { notify } from '../services/notify.js';
import { badRequest, forbidden, notFound, pick, requireFields, toInt, truthy } from '../util.js';
import { isEmail, validatePassword } from './auth.js';

const router = Router();

/** Which account types each manager role may create or edit. */
const MANAGEABLE = {
  admin: ['admin', 'hr', 'dean', 'hod', 'lecturer', 'student'],
  dean: ['hod', 'lecturer', 'student'],
  hod: ['lecturer', 'student'],
};

export const userSelect = `
  SELECT u.id, u.university_id, u.name, u.email, u.role, u.employment_type, u.title, u.phone, u.identifier,
         u.faculty_id, u.department_id, u.class_id, u.active, u.created_at,
         CASE WHEN u.photo_path IS NOT NULL THEN '/uploads/' || u.photo_path END AS photo_url,
         (SELECT 1 FROM student_devices sd WHERE sd.user_id = u.id) IS NOT NULL AS has_device,
         f.name AS faculty_name, d.name AS department_name, c.name AS class_name,
         (SELECT COUNT(*) FROM classes rc WHERE rc.class_rep_id = u.id) > 0 AS is_class_rep
    FROM users u
    LEFT JOIN faculties f ON f.id = u.faculty_id
    LEFT JOIN departments d ON d.id = u.department_id
    LEFT JOIN classes c ON c.id = u.class_id`;

const tempPassword = () => `Temp-${crypto.randomBytes(5).toString('base64url')}`;

/** Fill in faculty/department from the class or department, and check they belong to the tenant. */
function resolveOrg(uid, data) {
  if (data.class_id) {
    const cls = q.get(
      `SELECT c.id, p.department_id, d.faculty_id FROM classes c JOIN programs p ON p.id = c.program_id
         JOIN departments d ON d.id = p.department_id WHERE c.id = ? AND c.university_id = ?`,
      data.class_id,
      uid,
    );
    if (!cls) throw badRequest('Unknown class');
    data.department_id = cls.department_id;
    data.faculty_id = cls.faculty_id;
  }
  if (data.department_id) {
    const dept = q.get('SELECT id, faculty_id FROM departments WHERE id = ? AND university_id = ?', data.department_id, uid);
    if (!dept) throw badRequest('Unknown department');
    data.faculty_id = dept.faculty_id;
  }
  if (data.faculty_id && !q.get('SELECT 1 FROM faculties WHERE id = ? AND university_id = ?', data.faculty_id, uid)) {
    throw badRequest('Unknown faculty');
  }
  return data;
}

function assertCanManage(actor, target) {
  if (!(MANAGEABLE[actor.role] || []).includes(target.role)) {
    throw forbidden(`Your role cannot manage ${target.role} accounts`);
  }
  if (actor.role === 'admin') return;
  if (!canManageDepartment(actor, target.department_id)) throw forbidden('That account is outside the unit you manage');
}

/** When a Dean/HoD is created for a unit with no leader yet, appoint them automatically. */
function autoAppoint(userId, data) {
  if (data.role === 'dean' && data.faculty_id) {
    q.run('UPDATE faculties SET dean_id = ? WHERE id = ? AND dean_id IS NULL', userId, data.faculty_id);
  }
  if (data.role === 'hod' && data.department_id) {
    q.run('UPDATE departments SET hod_id = ? WHERE id = ? AND hod_id IS NULL', userId, data.department_id);
  }
}

const EDITABLE = ['name', 'email', 'role', 'employment_type', 'title', 'phone', 'identifier', 'faculty_id', 'department_id', 'class_id'];

function normalise(body) {
  const data = pick(body, EDITABLE);
  for (const k of ['faculty_id', 'department_id', 'class_id']) if (k in data) data[k] = toInt(data[k]);
  if (data.email !== undefined) {
    data.email = String(data.email).trim().toLowerCase();
    if (!isEmail(data.email)) throw badRequest('Enter a valid email address');
  }
  if (data.name !== undefined) data.name = String(data.name).trim();
  if (data.employment_type !== undefined && !['full_time', 'part_time'].includes(data.employment_type)) {
    throw badRequest('Employment type must be full_time or part_time');
  }
  if (data.role !== undefined && !['admin', 'hr', 'dean', 'hod', 'lecturer', 'student'].includes(data.role)) {
    throw badRequest('Invalid role');
  }
  if (data.role && data.role !== 'student') data.class_id = null;
  // HR designates sit in the Directorate, outside faculties; students are never part-time staff.
  if (data.role === 'hr') Object.assign(data, { faculty_id: null, department_id: null });
  if (data.role === 'student' || data.role === 'hr' || data.role === 'admin') data.employment_type = 'full_time';
  return data;
}

router.get('/', requireRole(...STAFF_ROLES), (req, res) => {
  // Everyone sees only the people attached to them (see scope.js userScope).
  const scope = userScope(req.user);
  const where = ['u.university_id = ?', scope.sql];
  const params = [req.uid, ...scope.params];
  const roles = String(req.query.roles || req.query.role || '')
    .split(',')
    .filter(Boolean);
  if (roles.length) {
    where.push(`u.role IN (${roles.map(() => '?').join(', ')})`);
    params.push(...roles);
  }
  for (const k of ['department_id', 'faculty_id', 'class_id']) {
    if (req.query[k]) {
      where.push(`u.${k} = ?`);
      params.push(toInt(req.query[k]));
    }
  }
  if (req.query.active !== undefined) {
    where.push('u.active = ?');
    params.push(truthy(req.query.active) ? 1 : 0);
  }
  if (req.query.q) {
    where.push('(u.name LIKE ? OR u.email LIKE ? OR u.identifier LIKE ?)');
    const like = `%${req.query.q}%`;
    params.push(like, like, like);
  }
  const limit = Math.min(toInt(req.query.limit) || 2000, 5000);
  res.json(q.all(`${userSelect} WHERE ${where.join(' AND ')} ORDER BY u.role, u.name LIMIT ${limit}`, ...params));
});

router.get('/:id', requireRole(...STAFF_ROLES), (req, res) => {
  const scope = userScope(req.user);
  const user = q.get(`${userSelect} WHERE u.id = ? AND u.university_id = ? AND ${scope.sql}`, req.params.id, req.uid, ...scope.params);
  if (!user) throw notFound('User');
  res.json(user);
});

/** Lets a student who changed phones check in from the new one. */
router.post('/:id/reset-device', requireRole('admin', 'dean', 'hod'), (req, res) => {
  const target = q.get(`${userSelect} WHERE u.id = ? AND u.university_id = ?`, req.params.id, req.uid);
  if (!target) throw notFound('User');
  if (target.role !== 'student') throw badRequest('Only students register a phone for check-in');
  assertCanManage(req.user, target);
  q.run('DELETE FROM student_devices WHERE user_id = ?', target.id);
  notify(target.id, { title: 'Phone reset for check-in', body: 'The next phone you check in with becomes your registered phone.', type: 'security' });
  res.json({ ok: true });
});

/** A new temporary password for someone who forgot theirs, shown once; they choose their own at next sign-in. */
router.post('/:id/reset-password', requireRole('admin', 'dean', 'hod'), (req, res) => {
  const target = q.get('SELECT * FROM users WHERE id = ? AND university_id = ?', req.params.id, req.uid);
  if (!target) throw notFound('User');
  if (target.id === req.user.id) throw badRequest('Change your own password from your profile');
  assertCanManage(req.user, target);
  if (isProtectedDemoAccount(target)) throw forbidden('The shared demo accounts sign in without a password, so theirs cannot be reset');
  const password = tempPassword();
  q.run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', hashPassword(password), target.id);
  res.json({ ok: true, name: target.name, email: target.email, temporary_password: password });
});

router.post('/', requireRole('admin', 'dean', 'hod'), (req, res) => {
  requireFields(req.body, ['name', 'email', 'role']);
  const data = resolveOrg(req.uid, normalise(req.body));
  assertCanManage(req.user, data);
  let password = req.body.password;
  const generated = !password;
  if (generated) password = tempPassword();
  validatePassword(password);

  const id = tx(() => {
    // Whoever created the account knows the password, so the owner replaces it at first sign-in.
    const uid = insert('users', { ...data, university_id: req.uid, password_hash: hashPassword(password), must_change_password: 1 });
    autoAppoint(uid, data);
    return uid;
  });
  const user = q.get(`${userSelect} WHERE u.id = ?`, id);
  res.status(201).json(generated ? { ...user, temporary_password: password } : user);
});

router.put('/:id', requireRole('admin', 'dean', 'hod'), (req, res) => {
  const existing = q.get('SELECT * FROM users WHERE id = ? AND university_id = ?', req.params.id, req.uid);
  if (!existing) throw notFound('User');
  assertCanManage(req.user, existing);
  const data = normalise(req.body);
  if (existing.id === req.user.id && data.role && data.role !== existing.role) throw badRequest('You cannot change your own role');
  if (isProtectedDemoAccount(existing) && ((data.email && data.email !== existing.email) || (data.role && data.role !== existing.role) || req.body.active !== undefined)) {
    throw forbidden('This shared demo account keeps its email, role and status');
  }
  if ('class_id' in data || 'department_id' in data) resolveOrg(req.uid, data);
  assertCanManage(req.user, { ...existing, ...data });
  if (req.body.active !== undefined) {
    if (existing.id === req.user.id) throw badRequest('You cannot deactivate your own account');
    data.active = truthy(req.body.active) ? 1 : 0;
  }
  if (req.body.password) {
    if (isProtectedDemoAccount(existing)) throw forbidden('The shared demo accounts sign in without a password, so theirs cannot be changed');
    validatePassword(req.body.password);
    data.password_hash = hashPassword(req.body.password);
    data.must_change_password = 1;
  }
  tx(() => {
    if ('class_id' in data && data.class_id !== existing.class_id) {
      q.run('UPDATE classes SET class_rep_id = NULL WHERE class_rep_id = ?', existing.id);
    }
    update('users', existing.id, data);
    autoAppoint(existing.id, { ...existing, ...data });
  });
  res.json(q.get(`${userSelect} WHERE u.id = ?`, existing.id));
});

/** Accounts are deactivated rather than deleted so teaching and attendance history stays intact. */
router.delete('/:id', requireRole('admin', 'dean', 'hod'), (req, res) => {
  const existing = q.get('SELECT * FROM users WHERE id = ? AND university_id = ?', req.params.id, req.uid);
  if (!existing) throw notFound('User');
  if (existing.id === req.user.id) throw badRequest('You cannot deactivate your own account');
  if (isProtectedDemoAccount(existing)) throw forbidden('This shared demo account cannot be deactivated');
  assertCanManage(req.user, existing);
  q.run('UPDATE users SET active = 0 WHERE id = ?', existing.id);
  q.run('UPDATE classes SET class_rep_id = NULL WHERE class_rep_id = ?', existing.id);
  res.json({ ok: true });
});

/**
 * Bulk import from CSV text: one account per line as `name,email[,identifier][,phone]`.
 * All imported accounts share one temporary password, returned in the response.
 */
router.post('/import', requireRole('admin', 'dean', 'hod'), (req, res) => {
  requireFields(req.body, ['role', 'csv']);
  const base = resolveOrg(req.uid, {
    role: req.body.role,
    class_id: toInt(req.body.class_id),
    department_id: toInt(req.body.department_id),
    faculty_id: toInt(req.body.faculty_id),
  });
  if (base.role === 'student' && !base.class_id) throw badRequest('Choose the class the students belong to');
  assertCanManage(req.user, base);
  const password = req.body.default_password || tempPassword();
  validatePassword(password);
  const hash = hashPassword(password);

  const lines = String(req.body.csv)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length && /email/i.test(lines[0])) lines.shift();
  const created = [];
  const errors = [];
  tx(() => {
    lines.forEach((line, i) => {
      const [name, email, identifier, phone] = line.split(',').map((s) => s?.trim());
      if (!name || !isEmail(email)) {
        errors.push({ line: i + 1, error: 'Expected "name,email[,identifier][,phone]"' });
        return;
      }
      if (q.get('SELECT 1 FROM users WHERE email = ?', email)) {
        errors.push({ line: i + 1, error: `${email} already exists` });
        return;
      }
      const id = insert('users', {
        ...base,
        must_change_password: 1,
        university_id: req.uid,
        name,
        email: email.toLowerCase(),
        identifier: identifier || null,
        phone: phone || null,
        password_hash: hash,
      });
      created.push({ id, name, email });
    });
  });
  res.status(201).json({ created: created.length, users: created, errors, temporary_password: req.body.default_password ? undefined : password });
});

export default router;
