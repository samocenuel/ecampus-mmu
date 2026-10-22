import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { q } from './db.js';
import { isProtectedDemoAccount } from './demo.js';
import { hasInternalPartTime } from './services/workload.js';
import { HttpError, forbidden } from './util.js';

export const ROLES = ['super_admin', 'admin', 'dean', 'hod', 'lecturer', 'student', 'hr'];
export const MANAGER_ROLES = ['admin', 'dean', 'hod'];
export const STAFF_ROLES = ['admin', 'dean', 'hod', 'lecturer'];
/** Roles that can be allocated teaching load. */
export const TEACHING_ROLES = ['lecturer', 'hod', 'dean'];

export const hashPassword = (pw) => bcrypt.hashSync(pw, 10);
export const verifyPassword = (pw, hash) => bcrypt.compareSync(pw, hash);

export function signToken(user, { purpose, expiresIn } = {}) {
  const payload = { sub: user.id, uni: user.university_id, role: user.role };
  if (purpose) payload.purpose = purpose;
  return jwt.sign(payload, config.jwtSecret, { expiresIn: expiresIn || config.jwtExpiresIn });
}

/** Loads a user (without password hash) plus the classes they represent. */
export function loadUser(id) {
  const user = q.get(
    `SELECT u.*, d.name AS department_name, f.name AS faculty_name, c.name AS class_name
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN faculties f ON f.id = u.faculty_id
       LEFT JOIN classes c ON c.id = u.class_id
      WHERE u.id = ?`,
    id,
  );
  if (!user) return undefined;
  delete user.password_hash;
  user.photo_url = user.photo_path ? `/uploads/${user.photo_path}` : null;
  user.internal_part_time = user.employment_type === 'full_time' && hasInternalPartTime(user.id);
  // The shared demo accounts sign in without a password, so they are never asked to change it.
  user.must_change_password = Boolean(user.must_change_password) && !isProtectedDemoAccount(user);
  const repClasses = q.all('SELECT id, name FROM classes WHERE class_rep_id = ?', id);
  user.rep_classes = repClasses;
  user.is_class_rep = repClasses.length > 0;
  return user;
}

export function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  let token = header.startsWith('Bearer ') ? header.slice(7) : null;
  let fromQuery = false;
  if (!token && req.query?.token) {
    token = String(req.query.token);
    fromQuery = true;
  }
  if (!token) return next(new HttpError(401, 'Authentication required'));

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    return next(new HttpError(401, 'Your session has expired, please sign in again'));
  }
  // Query-string tokens are only accepted for short-lived file downloads.
  if (fromQuery ? payload.purpose !== 'download' : Boolean(payload.purpose)) {
    return next(new HttpError(401, 'Invalid token'));
  }

  const user = loadUser(payload.sub);
  if (!user || !user.active) return next(new HttpError(401, 'Account not found or disabled'));
  if (user.university_id) {
    const uni = q.get('SELECT active FROM universities WHERE id = ?', user.university_id);
    if (!uni?.active) return next(forbidden('This university account has been suspended'));
  }
  req.user = user;
  req.uid = user.university_id;
  next();
}

export const requireRole =
  (...roles) =>
  (req, _res, next) =>
    roles.includes(req.user?.role) ? next() : next(forbidden());

export const requireTenant = (req, _res, next) =>
  req.uid ? next() : next(forbidden('This action requires a university account'));
