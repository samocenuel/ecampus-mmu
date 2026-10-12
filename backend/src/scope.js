// Organisational scoping: an Admin manages the whole university, a Dean the
// departments of their faculty, and a HoD their own department.
import { q } from './db.js';
import { forbidden } from './util.js';

export const placeholders = (ids) => (ids.length ? ids.map(() => '?').join(', ') : 'NULL');

export function facultyIdsForDean(user) {
  return q
    .all('SELECT id FROM faculties WHERE university_id = ? AND (dean_id = ? OR id = ?)', user.university_id, user.id, user.faculty_id)
    .map((r) => r.id);
}

export function departmentIdsForHod(user) {
  return q
    .all('SELECT id FROM departments WHERE university_id = ? AND (hod_id = ? OR id = ?)', user.university_id, user.id, user.department_id)
    .map((r) => r.id);
}

/** Department ids the user may manage; `null` means every department in the university. */
export function managedDepartmentIds(user) {
  if (user.role === 'admin') return null;
  if (user.role === 'dean') {
    const facs = facultyIdsForDean(user);
    if (!facs.length) return [];
    return q.all(`SELECT id FROM departments WHERE faculty_id IN (${placeholders(facs)})`, ...facs).map((r) => r.id);
  }
  if (user.role === 'hod') return departmentIdsForHod(user);
  return [];
}

export function canManageDepartment(user, departmentId) {
  const ids = managedDepartmentIds(user);
  if (ids === null) return true;
  return departmentId != null && ids.includes(Number(departmentId));
}

export function assertManageDepartment(user, departmentId) {
  if (!canManageDepartment(user, departmentId)) throw forbidden('That department is outside the unit you manage');
}

/** Human readable label of the unit a user oversees, used in report headers. */
export function scopeLabel(user) {
  if (user.role === 'admin') return 'Entire university';
  if (user.role === 'dean') {
    const facs = facultyIdsForDean(user);
    const names = facs.length ? q.all(`SELECT name FROM faculties WHERE id IN (${placeholders(facs)})`, ...facs) : [];
    return names.map((n) => n.name).join(', ') || 'No faculty assigned';
  }
  if (user.role === 'hod') {
    const deps = departmentIdsForHod(user);
    const names = deps.length ? q.all(`SELECT name FROM departments WHERE id IN (${placeholders(deps)})`, ...deps) : [];
    return names.map((n) => n.name).join(', ') || 'No department assigned';
  }
  if (user.role === 'student') return user.class_name || 'My classes';
  return 'My teaching';
}

export function currentTerm(universityId) {
  return (
    q.get('SELECT * FROM academic_terms WHERE university_id = ? AND is_current = 1 ORDER BY id DESC LIMIT 1', universityId) ||
    q.get('SELECT * FROM academic_terms WHERE university_id = ? ORDER BY id DESC LIMIT 1', universityId)
  );
}

/** Resolve the term from a request (explicit term_id or the current term) and check tenancy. */
export function resolveTerm(universityId, termId) {
  if (termId) {
    const term = q.get('SELECT * FROM academic_terms WHERE id = ? AND university_id = ?', termId, universityId);
    if (!term) throw forbidden('Unknown academic term');
    return term;
  }
  return currentTerm(universityId);
}
