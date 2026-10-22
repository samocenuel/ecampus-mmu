// Appointing Deans and HoDs. One person leads a unit at a time: appointing someone new hands the
// role over, and the previous leader goes back to being a lecturer in the same unit. Approvals
// follow the role, so anything waiting for the old leader now waits for the new one, while past
// sign-offs keep the names of the people who made them.
import { q } from '../db.js';
import { badRequest } from '../util.js';
import { notify } from './notify.js';

const TEACHING = ['lecturer', 'hod', 'dean'];

/** A teaching staff member of the university who can be appointed to lead a unit. */
export function leaderCandidate(universityId, userId, label) {
  if (!userId) return null;
  const u = q.get('SELECT * FROM users WHERE id = ? AND university_id = ? AND active = 1', userId, universityId);
  if (!u) throw badRequest(`Selected ${label} was not found`);
  if (!TEACHING.includes(u.role)) throw badRequest(`Only teaching staff can be appointed ${label}`);
  return u;
}

/** A department a former leader can teach in: their own, or the first one of the faculty. */
function homeDepartment(user, facultyId) {
  if (user.department_id) return user.department_id;
  return q.get('SELECT id FROM departments WHERE faculty_id = ? ORDER BY name LIMIT 1', facultyId)?.id ?? null;
}

/** Previous leader back to lecturer (unless they still lead another unit in the same role). */
function stepDown(userId, role, unitName) {
  const u = q.get('SELECT * FROM users WHERE id = ?', userId);
  if (!u || u.role !== role) return;
  const stillLeads = role === 'hod' ? q.get('SELECT 1 FROM departments WHERE hod_id = ?', userId) : q.get('SELECT 1 FROM faculties WHERE dean_id = ?', userId);
  if (stillLeads) return;
  const facultyId = u.faculty_id || (u.department_id ? q.get('SELECT faculty_id FROM departments WHERE id = ?', u.department_id)?.faculty_id : null);
  q.run("UPDATE users SET role = 'lecturer', department_id = ? WHERE id = ?", homeDepartment(u, facultyId), userId);
  notify(userId, { title: `Handed over: ${unitName}`, body: `A new ${role === 'hod' ? 'Head of Department' : 'Dean'} has been appointed. You now have a lecturer account.`, type: 'security' });
}

/** Make `userId` HoD of the department; returns the previous HoD's id (if any). */
export function appointHod(department, userId) {
  const previous = department.hod_id && department.hod_id !== userId ? department.hod_id : null;
  if (!userId) {
    q.run('UPDATE departments SET hod_id = NULL WHERE id = ?', department.id);
    if (previous) stepDown(previous, 'hod', department.name);
    return previous;
  }
  const user = q.get('SELECT * FROM users WHERE id = ?', userId);
  if (user.role === 'dean') throw badRequest(`${user.name} is a Dean; appoint a lecturer as Head of Department`);
  // Someone leads one department at a time.
  for (const other of q.all('SELECT id, name FROM departments WHERE hod_id = ? AND id <> ?', userId, department.id)) {
    q.run('UPDATE departments SET hod_id = NULL WHERE id = ?', other.id);
  }
  q.run('UPDATE departments SET hod_id = ? WHERE id = ?', userId, department.id);
  q.run("UPDATE users SET role = 'hod', department_id = ?, faculty_id = ? WHERE id = ?", department.id, department.faculty_id, userId);
  if (previous) stepDown(previous, 'hod', department.name);
  if (department.hod_id !== userId) {
    notify(userId, { title: `Appointed Head of Department: ${department.name}`, body: 'You now approve attendance, allocations, leave and pay claims for the department.', type: 'security' });
  }
  return previous;
}

/** Make `userId` Dean of the faculty; returns the previous Dean's id (if any). */
export function appointDean(faculty, userId) {
  const previous = faculty.dean_id && faculty.dean_id !== userId ? faculty.dean_id : null;
  if (!userId) {
    q.run('UPDATE faculties SET dean_id = NULL WHERE id = ?', faculty.id);
    if (previous) stepDown(previous, 'dean', faculty.name);
    return previous;
  }
  for (const other of q.all('SELECT id FROM faculties WHERE dean_id = ? AND id <> ?', userId, faculty.id)) {
    q.run('UPDATE faculties SET dean_id = NULL WHERE id = ?', other.id);
  }
  // A Dean does not also head a department.
  q.run('UPDATE departments SET hod_id = NULL WHERE hod_id = ?', userId);
  q.run('UPDATE faculties SET dean_id = ? WHERE id = ?', userId, faculty.id);
  q.run("UPDATE users SET role = 'dean', faculty_id = ? WHERE id = ?", faculty.id, userId);
  if (previous) stepDown(previous, 'dean', faculty.name);
  if (faculty.dean_id !== userId) {
    notify(userId, { title: `Appointed Dean: ${faculty.name}`, body: 'You now oversee the faculty, sign off pay claims as Vote Controller and appoint its Heads of Department.', type: 'security' });
  }
  return previous;
}

/**
 * Keep leadership consistent when an account's role is edited directly: losing the HoD or Dean
 * role clears the unit's leader; gaining it for a unit appoints the person (handing it over).
 */
export function syncLeadership(before, after) {
  if (before.role === 'hod' && after.role !== 'hod') q.run('UPDATE departments SET hod_id = NULL WHERE hod_id = ?', before.id);
  if (before.role === 'dean' && after.role !== 'dean') q.run('UPDATE faculties SET dean_id = NULL WHERE dean_id = ?', before.id);
  if (after.role === 'hod' && after.department_id && (before.role !== 'hod' || before.department_id !== after.department_id)) {
    const dept = q.get('SELECT * FROM departments WHERE id = ?', after.department_id);
    if (dept && dept.hod_id !== before.id) appointHod(dept, before.id);
  }
  if (after.role === 'dean' && after.faculty_id && (before.role !== 'dean' || before.faculty_id !== after.faculty_id)) {
    const fac = q.get('SELECT * FROM faculties WHERE id = ?', after.faculty_id);
    if (fac && fac.dean_id !== before.id) appointDean(fac, before.id);
  }
}
