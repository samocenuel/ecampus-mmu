// Load-allocation rules: which (course unit, class) pairs must be taught in a
// term, and the "cross-cutting units first" policy.
import { q } from '../db.js';

/**
 * Every (course unit, class) pair the curriculum requires in `term`: a class
 * takes the units its programme lists for the class's year of study and the
 * term's semester. Units are grouped and annotated with allocation progress.
 */
/**
 * What the curriculum needs this term. With `departmentIds`, only pairs that concern those
 * departments: units they own (every class taking them) and units taught to their classes.
 */
export function allocationRequirements(universityId, term, departmentIds = null) {
  if (!term) return { units: [], cross_cutting: [], program_specific: [], summary: emptySummary() };
  const allNeeds = q.all(
    `SELECT cu.id AS course_unit_id, cu.code, cu.name, cu.is_cross_cutting, cu.hours_per_week, cu.credit_units,
            cu.department_id, c.id AS class_id, c.name AS class_name, p.id AS program_id, p.code AS program_code,
            p.department_id AS program_department_id
       FROM program_course_units pcu
       JOIN course_units cu ON cu.id = pcu.course_unit_id
       JOIN classes c ON c.program_id = pcu.program_id AND c.year_of_study = pcu.year_of_study
                     AND c.curriculum_version_id = pcu.version_id AND c.status = 'active'
       JOIN programs p ON p.id = c.program_id
      WHERE cu.university_id = ? AND pcu.semester = ?
      ORDER BY cu.is_cross_cutting DESC, cu.code, c.name`,
    universityId,
    term.semester,
  );
  const needs = departmentIds === null
    ? allNeeds
    : allNeeds.filter((n) => departmentIds.includes(n.department_id) || departmentIds.includes(n.program_department_id));
  const allocated = q.all(
    `SELECT a.id AS allocation_id, a.course_unit_id, ac.class_id, u.name AS lecturer_name, a.status AS allocation_status
       FROM allocations a
       JOIN allocation_classes ac ON ac.allocation_id = a.id
       JOIN users u ON u.id = a.lecturer_id
      WHERE a.term_id = ?`,
    term.id,
  );
  const allocMap = new Map(allocated.map((r) => [`${r.course_unit_id}:${r.class_id}`, r]));

  const units = new Map();
  for (const n of needs) {
    if (!units.has(n.course_unit_id)) {
      units.set(n.course_unit_id, {
        course_unit_id: n.course_unit_id,
        code: n.code,
        name: n.name,
        is_cross_cutting: n.is_cross_cutting,
        hours_per_week: n.hours_per_week,
        credit_units: n.credit_units,
        department_id: n.department_id,
        classes: [],
        allocated_count: 0,
        total: 0,
      });
    }
    const unit = units.get(n.course_unit_id);
    if (unit.classes.some((c) => c.class_id === n.class_id)) continue;
    const a = allocMap.get(`${n.course_unit_id}:${n.class_id}`);
    unit.classes.push({
      class_id: n.class_id,
      class_name: n.class_name,
      program_id: n.program_id,
      program_code: n.program_code,
      program_department_id: n.program_department_id,
      allocation_id: a?.allocation_id ?? null,
      lecturer_name: a?.lecturer_name ?? null,
      draft: a?.allocation_status === 'draft',
    });
    unit.total++;
    if (a) unit.allocated_count++;
  }

  const list = [...units.values()].map((u) => ({ ...u, fully_allocated: u.allocated_count === u.total }));
  const cross = list.filter((u) => u.is_cross_cutting);
  const other = list.filter((u) => !u.is_cross_cutting);
  const sum = (arr, key) => arr.reduce((s, u) => s + u[key], 0);
  return {
    units: list,
    cross_cutting: cross,
    program_specific: other,
    summary: {
      cross_cutting_units: cross.length,
      cross_cutting_pairs: sum(cross, 'total'),
      cross_cutting_allocated: sum(cross, 'allocated_count'),
      other_units: other.length,
      other_pairs: sum(other, 'total'),
      other_allocated: sum(other, 'allocated_count'),
      cross_cutting_complete: cross.every((u) => u.fully_allocated),
    },
  };
}

const emptySummary = () => ({
  cross_cutting_units: 0,
  cross_cutting_pairs: 0,
  cross_cutting_allocated: 0,
  other_units: 0,
  other_pairs: 0,
  other_allocated: 0,
  cross_cutting_complete: true,
});

/**
 * Cross-cutting units that still have classes without a lecturer this term.
 * `departmentIds` (null = whole university) limits this to classes of those departments.
 */
export function pendingCrossCutting(universityId, term, departmentIds = null) {
  return allocationRequirements(universityId, term)
    .cross_cutting.map((u) => ({
      course_unit_id: u.course_unit_id,
      code: u.code,
      name: u.name,
      pending_classes: u.classes
        .filter((c) => !c.allocation_id && (departmentIds === null || departmentIds.includes(c.program_department_id)))
        .map((c) => c.class_name),
    }))
    .filter((u) => u.pending_classes.length);
}

export const crossCuttingUnitCount = (universityId) =>
  q.get('SELECT COUNT(*) AS n FROM course_units WHERE university_id = ? AND is_cross_cutting = 1', universityId).n;
