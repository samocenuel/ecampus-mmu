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

// ---------------------------------------------------------------- What each role may see
//
// Admin: the whole university.  Dean: their faculty and every department in it.
// HoD: their own department.  Lecturer / student: their own department.
// Course units are visible to a department when it owns them OR they are taught to one
// of its programmes (cross-cutting units coming in from other departments).

/** Department ids whose records the user may see; `null` means the whole university. */
export function visibleDepartmentIds(user) {
  if (user.role === 'admin') return null;
  if (user.role === 'dean' || user.role === 'hod') return managedDepartmentIds(user);
  return user.department_id ? [user.department_id] : [];
}

/** Faculty ids the user may see; `null` means all. */
export function visibleFacultyIds(user) {
  if (user.role === 'admin') return null;
  if (user.role === 'dean') return facultyIdsForDean(user);
  const depts = visibleDepartmentIds(user);
  if (!depts.length) return user.faculty_id ? [user.faculty_id] : [];
  return q.all(`SELECT DISTINCT faculty_id FROM departments WHERE id IN (${placeholders(depts)})`, ...depts).map((r) => r.faculty_id);
}

/** SQL condition (and params) for course units owned by, or taught to programmes of, `depts`. */
export function courseUnitScope(alias, depts) {
  const ph = placeholders(depts);
  return {
    sql: `(${alias}.department_id IN (${ph}) OR ${alias}.id IN (
            SELECT pcu.course_unit_id FROM program_course_units pcu JOIN programs pp ON pp.id = pcu.program_id
             WHERE pp.department_id IN (${ph})))`,
    params: [...depts, ...depts],
  };
}

/** SQL condition for users the actor may see in staff lists (`alias` is the users table). */
export function userScope(actor, alias = 'u') {
  if (actor.role === 'admin') return { sql: '1 = 1', params: [] };
  if (actor.role === 'dean' || actor.role === 'hod') {
    const depts = managedDepartmentIds(actor);
    const facs = actor.role === 'dean' ? facultyIdsForDean(actor) : [];
    const parts = [`${alias}.id = ?`, `${alias}.department_id IN (${placeholders(depts)})`];
    const params = [actor.id, ...depts];
    if (facs.length) {
      parts.push(`(${alias}.department_id IS NULL AND ${alias}.faculty_id IN (${placeholders(facs)}))`);
      params.push(...facs);
    }
    return { sql: `(${parts.join(' OR ')})`, params };
  }
  if (actor.role === 'lecturer') {
    // Only the students of classes they teach this term, plus themselves.
    return {
      sql: `(${alias}.id = ? OR ${alias}.class_id IN (
              SELECT ac.class_id FROM allocation_classes ac JOIN allocations a ON a.id = ac.allocation_id
               WHERE a.lecturer_id = ?))`,
      params: [actor.id, actor.id],
    };
  }
  return { sql: `${alias}.id = ?`, params: [actor.id] };
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
