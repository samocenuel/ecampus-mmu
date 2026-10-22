// Teaching workload limits. Full-time staff have a minimum and maximum number of teaching hours a
// week (university defaults, or personal limits set by the HoD / Dean). Allocating beyond the
// maximum needs an override: the extra hours become internal part-time load, claimable like a
// part-time lecturer's. Units nobody can take within their maximum can be offered to full-time
// staff as an internal part-time call.
import { q } from '../db.js';
import { placeholders } from '../scope.js';

const round1 = (n) => Math.round(Number(n || 0) * 10) / 10;

/** The lecturer's weekly limits: personal ones if set, otherwise the university's defaults. */
export function limitsFor(user, uni = q.get('SELECT workload_min_hours, workload_max_hours FROM universities WHERE id = ?', user.university_id)) {
  const partTime = user.employment_type === 'part_time';
  return {
    min: user.workload_min ?? (partTime ? 0 : uni?.workload_min_hours ?? 10),
    max: user.workload_max ?? uni?.workload_max_hours ?? 20,
    part_time: partTime,
  };
}

/** Weekly hours the lecturer is allocated this term (drafts included: they are the planned load). */
export function termLoad(lecturerId, termId, excludeAllocationId = null) {
  const r = q.get(
    'SELECT COALESCE(SUM(hours_per_week), 0) AS hours, COALESCE(SUM(part_time_hours), 0) AS part_time FROM allocations WHERE lecturer_id = ? AND term_id = ? AND id != ?',
    lecturerId,
    termId,
    excludeAllocationId ?? -1,
  );
  return { hours: round1(r.hours), part_time_hours: round1(r.part_time) };
}

/**
 * What adding `hours` a week to the lecturer's load does: the load after, and how much of it would
 * be above their maximum (internal part-time hours for full-time staff).
 */
export function workloadCheck(lecturer, termId, hours, excludeAllocationId = null) {
  const limits = limitsFor(lecturer);
  const current = termLoad(lecturer.id, termId, excludeAllocationId);
  const after = round1(current.hours + hours);
  return {
    lecturer_id: lecturer.id,
    current: current.hours,
    after,
    ...limits,
    over_max: after > limits.max,
    // Only the part of this allocation above the maximum (all of it if they were already at the maximum).
    excess: round1(Math.min(hours, Math.max(0, after - limits.max))),
  };
}

/** Each teaching staff member's load against their limits for a term (for allocation and reports). */
export function workloads(universityId, termId, userIds = null) {
  const uni = q.get('SELECT workload_min_hours, workload_max_hours FROM universities WHERE id = ?', universityId);
  const users = q.all(
    `SELECT id, name, title, role, employment_type, department_id, workload_min, workload_max, university_id FROM users
      WHERE university_id = ? AND active = 1 AND role IN ('lecturer','hod','dean') ${userIds ? `AND id IN (${placeholders(userIds)})` : ''}`,
    universityId,
    ...(userIds || []),
  );
  const loads = new Map(
    q
      .all('SELECT lecturer_id, SUM(hours_per_week) AS hours, SUM(part_time_hours) AS pt FROM allocations WHERE term_id = ? GROUP BY lecturer_id', termId ?? -1)
      .map((r) => [r.lecturer_id, r]),
  );
  return users.map((u) => {
    const l = limitsFor(u, uni);
    const hours = round1(loads.get(u.id)?.hours || 0);
    return {
      id: u.id,
      name: [u.title, u.name].filter(Boolean).join(' '),
      department_id: u.department_id,
      employment_type: u.employment_type,
      min: l.min,
      max: l.max,
      hours,
      part_time_hours: round1(loads.get(u.id)?.pt || 0),
      status: hours > l.max ? 'over' : hours < l.min ? 'under' : 'ok',
      spare: round1(Math.max(0, l.max - hours)),
    };
  });
}

/** Full-time teaching staff who have (or had) internal part-time load can raise pay claims for it. */
export const hasInternalPartTime = (userId) => Boolean(q.get('SELECT 1 FROM allocations WHERE lecturer_id = ? AND part_time_hours > 0 LIMIT 1', userId));
