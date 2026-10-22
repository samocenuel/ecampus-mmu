// Teaching-load allocation: assigning a lecturer to teach a course unit to one
// or more classes in a term. Cross-cutting units must be allocated first.
import { Router } from 'express';
import { MANAGER_ROLES, requireRole, TEACHING_ROLES } from '../auth.js';
import { insert, q, tx, update } from '../db.js';
import { canManageDepartment, managedDepartmentIds, placeholders, resolveTerm, visibleDepartmentIds } from '../scope.js';
import { allocationRequirements, crossCuttingUnitCount, pendingCrossCutting } from '../services/allocation-rules.js';
import { notify } from '../services/notify.js';
import { allocationContext, checkSession } from '../services/timetable.js';
import { workloadCheck, workloads } from '../services/workload.js';
import { badRequest, forbidden, HttpError, needsConfirmation, notFound, requireFields, toInt, truthy } from '../util.js';

const router = Router();

function listAllocations(uid, where, params) {
  const rows = q.all(
    `SELECT a.*, cu.code, cu.name AS course_name, cu.is_cross_cutting, cu.department_id, cu.credit_units,
            u.name AS lecturer_name, u.title AS lecturer_title, t.name AS term_name,
            (SELECT COALESCE(SUM(
               (CAST(substr(s.end_time, 1, 2) AS INTEGER) * 60 + CAST(substr(s.end_time, 4, 2) AS INTEGER)) -
               (CAST(substr(s.start_time, 1, 2) AS INTEGER) * 60 + CAST(substr(s.start_time, 4, 2) AS INTEGER))), 0)
               FROM timetable_sessions s WHERE s.allocation_id = a.id) / 60.0 AS scheduled_hours
       FROM allocations a
       JOIN course_units cu ON cu.id = a.course_unit_id
       JOIN users u ON u.id = a.lecturer_id
       JOIN academic_terms t ON t.id = a.term_id
      WHERE a.university_id = ? ${where.length ? `AND ${where.join(' AND ')}` : ''}
      ORDER BY cu.is_cross_cutting DESC, cu.code`,
    uid,
    ...params,
  );
  const ids = rows.map((r) => r.id);
  const classes = ids.length
    ? q.all(
        `SELECT ac.allocation_id, c.id, c.name, p.code AS program_code FROM allocation_classes ac
           JOIN classes c ON c.id = ac.class_id JOIN programs p ON p.id = c.program_id
          WHERE ac.allocation_id IN (${placeholders(ids)}) ORDER BY c.name`,
        ...ids,
      )
    : [];
  return rows.map((r) => ({ ...r, classes: classes.filter((c) => c.allocation_id === r.id).map(({ allocation_id, ...c }) => c) }));
}

router.get('/', (req, res) => {
  const term = resolveTerm(req.uid, toInt(req.query.term_id));
  if (!term) return res.json([]);
  const where = ['a.term_id = ?'];
  const params = [term.id];
  if (req.user.role === 'lecturer' || truthy(req.query.mine)) {
    where.push('a.lecturer_id = ?');
    params.push(req.user.id);
  } else if (req.user.role === 'student') {
    throw forbidden();
  } else {
    const depts = visibleDepartmentIds(req.user);
    if (depts !== null) {
      // Units the department owns, or units taught to its classes.
      const ph = placeholders(depts);
      where.push(`(cu.department_id IN (${ph}) OR a.id IN (
        SELECT ac.allocation_id FROM allocation_classes ac JOIN classes c ON c.id = ac.class_id
          JOIN programs p ON p.id = c.program_id WHERE p.department_id IN (${ph})))`);
      params.push(...depts, ...depts);
    }
  }
  for (const [k, col] of [['lecturer_id', 'a.lecturer_id'], ['course_unit_id', 'a.course_unit_id'], ['department_id', 'cu.department_id']]) {
    if (req.query[k]) {
      where.push(`${col} = ?`);
      params.push(toInt(req.query[k]));
    }
  }
  if (req.query.class_id) {
    where.push('a.id IN (SELECT allocation_id FROM allocation_classes WHERE class_id = ?)');
    params.push(toInt(req.query.class_id));
  }
  res.json(listAllocations(req.uid, where, params));
});

/** What the curriculum requires this term and how much of it is allocated (cross-cutting first). */
router.get('/requirements', requireRole(...MANAGER_ROLES), (req, res) => {
  const term = resolveTerm(req.uid, toInt(req.query.term_id));
  const reqs = allocationRequirements(req.uid, term, visibleDepartmentIds(req.user));
  res.json({ term, ...reqs, cross_cutting_units_defined: crossCuttingUnitCount(req.uid) });
});

function validateAllocation(req, { courseUnitId, lecturerId, classIds, termId, excludeAllocationId = null }) {
  const cu = q.get('SELECT * FROM course_units WHERE id = ? AND university_id = ?', courseUnitId, req.uid);
  if (!cu) throw badRequest('Unknown course unit');
  const lecturer = q.get(
    `SELECT id, name, title, role, employment_type, workload_min, workload_max, university_id FROM users
      WHERE id = ? AND university_id = ? AND active = 1 AND role IN (${placeholders(TEACHING_ROLES)})`,
    lecturerId,
    req.uid,
    ...TEACHING_ROLES,
  );
  if (!lecturer) throw badRequest('Choose an active lecturer');
  if (!classIds.length) throw badRequest('Select at least one class');
  const classes = q.all(
    `SELECT c.id, c.name, p.department_id FROM classes c JOIN programs p ON p.id = c.program_id
      WHERE c.university_id = ? AND c.id IN (${placeholders(classIds)})`,
    req.uid,
    ...classIds,
  );
  if (classes.length !== classIds.length) throw badRequest('One or more classes were not found');
  if (classes.length > 1 && !cu.is_cross_cutting) {
    const programs = new Set(q.all(`SELECT program_id FROM classes WHERE id IN (${placeholders(classIds)})`, ...classIds).map((r) => r.program_id));
    if (programs.size > 1) throw badRequest(`${cu.code} is not cross-cutting, so it cannot be taught to classes from different programmes together`);
  }

  // Managers may allocate units their unit owns, or teaching for their own classes.
  const ok = cu.department_id
    ? canManageDepartment(req.user, cu.department_id) || classes.every((c) => canManageDepartment(req.user, c.department_id))
    : req.user.role === 'admin' || classes.every((c) => canManageDepartment(req.user, c.department_id));
  if (!ok) throw forbidden('That course unit and classes are outside the unit you manage');

  const dup = q.get(
    `SELECT c.name FROM allocations a JOIN allocation_classes ac ON ac.allocation_id = a.id JOIN classes c ON c.id = ac.class_id
      WHERE a.term_id = ? AND a.course_unit_id = ? AND ac.class_id IN (${placeholders(classIds)}) AND a.id != ?`,
    termId,
    cu.id,
    ...classIds,
    excludeAllocationId ?? -1,
  );
  if (dup) throw new HttpError(409, `${cu.code} is already allocated to ${dup.name} this term`);
  return { cu, lecturer, classes };
}

/**
 * Above the lecturer's maximum load the HoD must override: the extra hours become internal
 * part-time load (paid through pay claims), or the unit can be offered as an internal part-time call.
 */
function checkWorkload(req, lecturer, termId, hours, excludeId = null) {
  const load = workloadCheck(lecturer, termId, hours, excludeId);
  if (load.over_max && !truthy(req.body.override_workload)) {
    const name = [lecturer.title, lecturer.name].filter(Boolean).join(' ');
    throw new HttpError(
      409,
      `${name} would teach ${load.after} h a week, above their ${load.max} h maximum. Override to give the extra ${load.excess} h as ${load.part_time ? 'extra part-time hours' : 'internal part-time load'}, choose someone else, or call for internal part-timers.`,
      { code: 'WORKLOAD_OVER_MAX', workload: load },
    );
  }
  return { load, partTimeHours: load.over_max && !load.part_time ? load.excess : 0 };
}

router.post('/', requireRole(...MANAGER_ROLES), (req, res) => {
  requireFields(req.body, ['course_unit_id', 'lecturer_id', 'class_ids']);
  const term = resolveTerm(req.uid, toInt(req.body.term_id));
  if (!term) throw badRequest('Create an academic term first');
  const classIds = [...new Set([].concat(req.body.class_ids).map(Number).filter(Boolean))];
  const { cu, lecturer, classes } = validateAllocation(req, {
    courseUnitId: toInt(req.body.course_unit_id),
    lecturerId: toInt(req.body.lecturer_id),
    classIds,
    termId: term.id,
  });

  // Policy: allocate cross-cutting units first; warn before allocating anything else.
  if (!cu.is_cross_cutting && !truthy(req.body.force)) {
    if (crossCuttingUnitCount(req.uid) === 0) {
      throw needsConfirmation(
        'No cross-cutting course units exist yet. Create and allocate cross-cutting units before programme-specific units. Continue anyway?',
        'CROSS_CUTTING_FIRST',
      );
    }
    const pending = pendingCrossCutting(req.uid, term, managedDepartmentIds(req.user));
    if (pending.length) {
      throw needsConfirmation(
        `${pending.length} cross-cutting course unit(s) still need lecturers this term. Cross-cutting units should be allocated before programme-specific units. Allocate ${cu.code} anyway?`,
        'CROSS_CUTTING_PENDING',
        { pending },
      );
    }
  }

  const hours = toInt(req.body.hours_per_week) || cu.hours_per_week;
  const { partTimeHours } = checkWorkload(req, lecturer, term.id, hours);
  const id = tx(() => {
    const aid = insert('allocations', {
      university_id: req.uid,
      term_id: term.id,
      course_unit_id: cu.id,
      lecturer_id: lecturer.id,
      hours_per_week: hours,
      part_time_hours: partTimeHours,
      notes: req.body.notes || null,
      created_by: req.user.id,
    });
    for (const c of classIds) q.run('INSERT INTO allocation_classes (allocation_id, class_id) VALUES (?, ?)', aid, c);
    return aid;
  });
  notify(lecturer.id, {
    title: `New teaching allocation: ${cu.code}`,
    body: `${cu.name} for ${classes.map((c) => c.name).join(', ')} (${hours} hrs/week, ${term.name})${partTimeHours ? `. ${partTimeHours} h a week of it is internal part-time load you can claim.` : ''}`,
    type: 'allocation',
    link: '/my-timetable',
  });
  res.status(201).json(listAllocations(req.uid, ['a.id = ?'], [id])[0]);
});

router.put('/:id', requireRole(...MANAGER_ROLES), (req, res) => {
  const existing = allocationContext(toInt(req.params.id), req.uid);
  if (!existing) throw notFound('Allocation');
  const lecturerId = toInt(req.body.lecturer_id) || existing.lecturer_id;
  const classIds = req.body.class_ids
    ? [...new Set([].concat(req.body.class_ids).map(Number).filter(Boolean))]
    : existing.class_ids;
  const { lecturer } = validateAllocation(req, { courseUnitId: existing.course_unit_id, lecturerId, classIds, termId: existing.term_id, excludeAllocationId: existing.id });
  const hours = toInt(req.body.hours_per_week) || existing.hours_per_week;
  // Re-check the load only when the lecturer or the hours change.
  const partTimeHours =
    lecturerId !== existing.lecturer_id || hours !== existing.hours_per_week
      ? checkWorkload(req, lecturer, existing.term_id, hours, existing.id).partTimeHours
      : existing.part_time_hours || 0;

  // Re-check every scheduled session against the new lecturer / classes.
  const sessions = q.all('SELECT * FROM timetable_sessions WHERE allocation_id = ?', existing.id);
  const conflicts = sessions.flatMap(
    (s) =>
      checkSession({
        universityId: req.uid,
        allocation: existing,
        roomId: s.room_id,
        day: s.day_of_week,
        start: s.start_time,
        end: s.end_time,
        excludeSessionId: s.id,
        lecturerId,
        classIds,
      }).conflicts,
  );
  if (conflicts.length) {
    throw new HttpError(409, 'This change would create timetable clashes', { code: 'TIMETABLE_CONFLICT', conflicts });
  }

  tx(() => {
    // Editing a draft copied from last year means the HoD has reviewed it.
    update('allocations', existing.id, {
      status: 'confirmed',
      lecturer_id: lecturerId,
      hours_per_week: hours,
      part_time_hours: partTimeHours,
      notes: req.body.notes !== undefined ? req.body.notes : existing.notes,
    });
    if (req.body.class_ids) {
      q.run('DELETE FROM allocation_classes WHERE allocation_id = ?', existing.id);
      for (const c of classIds) q.run('INSERT INTO allocation_classes (allocation_id, class_id) VALUES (?, ?)', existing.id, c);
    }
  });
  if (lecturerId !== existing.lecturer_id) {
    notify(lecturerId, {
      title: `New teaching allocation: ${existing.code}`,
      body: `${existing.course_name} has been allocated to you.`,
      type: 'allocation',
      link: '/my-timetable',
    });
  }
  res.json(listAllocations(req.uid, ['a.id = ?'], [existing.id])[0]);
});

const canManageAllocation = (user, a) =>
  a.department_id ? canManageDepartment(user, a.department_id) : user.role === 'admin' || a.classes.every((c) => canManageDepartment(user, c.department_id));

function confirmDraft(user, a) {
  q.run("UPDATE allocations SET status = 'confirmed' WHERE id = ?", a.id);
  notify(a.lecturer_id, {
    title: `Teaching allocation confirmed: ${a.code}`,
    body: `${a.course_name} for ${a.classes.map((c) => c.name).join(', ')}.`,
    type: 'allocation',
    link: '/my-timetable',
  });
}

/** Confirm one draft allocation (copied from last year) as it is. */
router.post('/:id/confirm', requireRole(...MANAGER_ROLES), (req, res) => {
  const a = allocationContext(toInt(req.params.id), req.uid);
  if (!a) throw notFound('Allocation');
  if (!canManageAllocation(req.user, a)) throw forbidden();
  if (a.status !== 'draft') throw badRequest('This allocation is already confirmed');
  confirmDraft(req.user, a);
  res.json(listAllocations(req.uid, ['a.id = ?'], [a.id])[0]);
});

/** Confirm every draft allocation of a term that the user manages. */
router.post('/confirm-drafts', requireRole(...MANAGER_ROLES), (req, res) => {
  const term = resolveTerm(req.uid, req.body?.term_id);
  if (!term) throw badRequest('Choose a term');
  let confirmed = 0;
  tx(() => {
    for (const { id } of q.all("SELECT id FROM allocations WHERE term_id = ? AND status = 'draft'", term.id)) {
      const a = allocationContext(id, req.uid);
      if (!canManageAllocation(req.user, a)) continue;
      confirmDraft(req.user, a);
      confirmed++;
    }
  });
  res.json({ ok: true, confirmed });
});

/** Teaching staff load against their minimum and maximum this term. */
router.get('/workloads', requireRole(...MANAGER_ROLES), (req, res) => {
  const term = resolveTerm(req.uid, toInt(req.query.term_id));
  const uni = q.get('SELECT workload_min_hours, workload_max_hours FROM universities WHERE id = ?', req.uid);
  res.json({ term, default_min: uni.workload_min_hours, default_max: uni.workload_max_hours, items: term ? workloads(req.uid, term.id) : [] });
});

// ------------------------------------------------------------------ Internal part-time calls

const callSelect = `
  SELECT pc.*, cu.code, cu.name AS course_name, cu.department_id AS unit_department_id, t.name AS term_name,
         u.name AS created_by_name, f.name AS filled_by_name
    FROM part_time_calls pc JOIN course_units cu ON cu.id = pc.course_unit_id JOIN academic_terms t ON t.id = pc.term_id
    LEFT JOIN users u ON u.id = pc.created_by LEFT JOIN users f ON f.id = pc.filled_by`;

function callView(user, c) {
  const classIds = JSON.parse(c.class_ids);
  const classes = classIds.length ? q.all(`SELECT id, name FROM classes WHERE id IN (${placeholders(classIds)})`, ...classIds) : [];
  const responses = q.all(
    `SELECT r.user_id, r.note, r.created_at, u.name, u.title, d.name AS department_name FROM part_time_call_responses r
       JOIN users u ON u.id = r.user_id LEFT JOIN departments d ON d.id = u.department_id WHERE r.call_id = ? ORDER BY r.id`,
    c.id,
  );
  const manager = MANAGER_ROLES.includes(user.role) && (!c.department_id || canManageDepartment(user, c.department_id));
  const load = manager ? new Map(workloads(user.university_id, c.term_id, responses.map((r) => r.user_id)).map((w) => [w.id, w])) : new Map();
  return {
    ...c,
    classes,
    responded: responses.some((r) => r.user_id === user.id),
    response_count: responses.length,
    responses: manager ? responses.map((r) => ({ ...r, workload: load.get(r.user_id) || null })) : [],
    can_manage: manager,
  };
}

/** Teaching staff who can be offered a call: full-time, in the unit's department (or the classes' departments). */
function callAudience(c, departmentIds) {
  if (!departmentIds.length) return [];
  return q
    .all(
      `SELECT id FROM users WHERE university_id = ? AND active = 1 AND employment_type = 'full_time' AND role IN ('lecturer','hod','dean')
        AND department_id IN (${placeholders(departmentIds)})`,
      c.university_id,
      ...departmentIds,
    )
    .map((r) => r.id);
}

router.get('/part-time-calls', (req, res) => {
  if (!['admin', 'dean', 'hod', 'lecturer'].includes(req.user.role)) throw forbidden();
  const term = resolveTerm(req.uid, toInt(req.query.term_id));
  const rows = q.all(`${callSelect} WHERE pc.university_id = ? ${term ? 'AND pc.term_id = ?' : ''} ORDER BY pc.status = 'open' DESC, pc.id DESC`, req.uid, ...(term ? [term.id] : []));
  const depts = visibleDepartmentIds(req.user);
  const visible = rows.filter((c) =>
    MANAGER_ROLES.includes(req.user.role)
      ? depts === null || !c.department_id || depts.includes(c.department_id)
      : c.status === 'open' ? !c.department_id || c.department_id === req.user.department_id : c.filled_by === req.user.id,
  );
  res.json(visible.map((c) => callView(req.user, c)));
});

/** The HoD offers a unit to full-time staff as internal part-time load. */
router.post('/part-time-calls', requireRole(...MANAGER_ROLES), (req, res) => {
  requireFields(req.body, ['course_unit_id', 'class_ids']);
  const term = resolveTerm(req.uid, toInt(req.body.term_id));
  if (!term) throw badRequest('Create an academic term first');
  const classIds = [...new Set([].concat(req.body.class_ids).map(Number).filter(Boolean))];
  const cu = q.get('SELECT * FROM course_units WHERE id = ? AND university_id = ?', toInt(req.body.course_unit_id), req.uid);
  if (!cu) throw badRequest('Unknown course unit');
  if (!classIds.length) throw badRequest('Select at least one class');
  const classes = q.all(
    `SELECT c.id, c.name, p.department_id FROM classes c JOIN programs p ON p.id = c.program_id WHERE c.university_id = ? AND c.id IN (${placeholders(classIds)})`,
    req.uid,
    ...classIds,
  );
  if (classes.length !== classIds.length) throw badRequest('One or more classes were not found');
  const ok = cu.department_id ? canManageDepartment(req.user, cu.department_id) || classes.every((c) => canManageDepartment(req.user, c.department_id)) : req.user.role === 'admin' || classes.every((c) => canManageDepartment(req.user, c.department_id));
  if (!ok) throw forbidden('That course unit and classes are outside the unit you manage');
  if (q.get("SELECT 1 FROM part_time_calls WHERE term_id = ? AND course_unit_id = ? AND status = 'open'", term.id, cu.id)) throw badRequest(`There is already an open call for ${cu.code}`);
  const hours = Number(req.body.hours_per_week) || cu.hours_per_week;
  const departmentId = cu.department_id || classes[0].department_id;
  const id = insert('part_time_calls', {
    university_id: req.uid,
    term_id: term.id,
    course_unit_id: cu.id,
    class_ids: JSON.stringify(classIds),
    hours_per_week: hours,
    department_id: departmentId,
    note: String(req.body.note || '').trim().slice(0, 1000) || null,
    created_by: req.user.id,
  });
  const c = q.get(`${callSelect} WHERE pc.id = ?`, id);
  const audience = callAudience(c, [...new Set([departmentId, ...classes.map((x) => x.department_id)].filter(Boolean))]).filter((u) => u !== req.user.id);
  notify(audience, {
    title: `Internal part-time teaching: ${cu.code}`,
    body: `${cu.name} for ${classes.map((x) => x.name).join(', ')}, ${hours} h a week this term, paid as part-time load. Respond in Load allocation if you can take it.`,
    type: 'allocation',
    link: '/part-time-calls',
  });
  res.status(201).json({ ...callView(req.user, c), notified: audience.length });
});

const loadCall = (req) => {
  const c = q.get(`${callSelect} WHERE pc.id = ? AND pc.university_id = ?`, toInt(req.params.id), req.uid);
  if (!c) throw notFound('Part-time call');
  return c;
};

/** A full-time lecturer offers to take the unit. */
router.post('/part-time-calls/:id/respond', requireRole(...TEACHING_ROLES), (req, res) => {
  const c = loadCall(req);
  if (c.status !== 'open') throw badRequest('This call is closed');
  if (req.user.employment_type !== 'full_time') throw badRequest('Internal part-time calls are for full-time staff');
  q.run(
    'INSERT INTO part_time_call_responses (call_id, user_id, note) VALUES (?, ?, ?) ON CONFLICT (call_id, user_id) DO UPDATE SET note = excluded.note',
    c.id,
    req.user.id,
    String(req.body?.note || '').trim().slice(0, 500) || null,
  );
  notify(c.created_by, { title: `${req.user.name} can take ${c.code}`, body: 'Internal part-time call: assign the unit in Load allocation.', type: 'allocation', link: '/part-time-calls' });
  res.json(callView(req.user, loadCall(req)));
});

router.delete('/part-time-calls/:id/respond', requireRole(...TEACHING_ROLES), (req, res) => {
  const c = loadCall(req);
  q.run('DELETE FROM part_time_call_responses WHERE call_id = ? AND user_id = ?', c.id, req.user.id);
  res.json(callView(req.user, loadCall(req)));
});

/** The HoD gives the unit to one respondent: an allocation that is all internal part-time load. */
router.post('/part-time-calls/:id/assign', requireRole(...MANAGER_ROLES), (req, res) => {
  const c = loadCall(req);
  if (!callView(req.user, c).can_manage) throw forbidden();
  if (c.status !== 'open') throw badRequest('This call is already closed');
  const userId = toInt(req.body?.user_id);
  if (!q.get('SELECT 1 FROM part_time_call_responses WHERE call_id = ? AND user_id = ?', c.id, userId)) throw badRequest('Choose one of the lecturers who responded');
  const classIds = JSON.parse(c.class_ids);
  const { lecturer } = validateAllocation(req, { courseUnitId: c.course_unit_id, lecturerId: userId, classIds, termId: c.term_id });
  const aid = tx(() => {
    const id = insert('allocations', {
      university_id: req.uid,
      term_id: c.term_id,
      course_unit_id: c.course_unit_id,
      lecturer_id: lecturer.id,
      hours_per_week: c.hours_per_week,
      part_time_hours: c.hours_per_week,
      notes: 'Internal part-time load (call #' + c.id + ')',
      created_by: req.user.id,
    });
    for (const cl of classIds) q.run('INSERT INTO allocation_classes (allocation_id, class_id) VALUES (?, ?)', id, cl);
    q.run("UPDATE part_time_calls SET status = 'filled', allocation_id = ?, filled_by = ?, closed_at = datetime('now') WHERE id = ?", id, lecturer.id, c.id);
    return id;
  });
  notify(lecturer.id, {
    title: `Internal part-time teaching: ${c.code} is yours`,
    body: `${c.course_name}, ${c.hours_per_week} h a week this term. Claim the lectures in Pay claims once attendance is approved.`,
    type: 'allocation',
    link: '/my-timetable',
  });
  const others = q.all('SELECT user_id FROM part_time_call_responses WHERE call_id = ? AND user_id != ?', c.id, lecturer.id).map((r) => r.user_id);
  notify(others, { title: `${c.code} has been assigned`, body: 'Thank you for responding to the internal part-time call.', type: 'allocation', link: '/part-time-calls' });
  res.json({ call: callView(req.user, loadCall(req)), allocation: listAllocations(req.uid, ['a.id = ?'], [aid])[0] });
});

router.post('/part-time-calls/:id/close', requireRole(...MANAGER_ROLES), (req, res) => {
  const c = loadCall(req);
  if (!callView(req.user, c).can_manage) throw forbidden();
  q.run("UPDATE part_time_calls SET status = 'closed', closed_at = datetime('now') WHERE id = ? AND status = 'open'", c.id);
  res.json(callView(req.user, loadCall(req)));
});

router.delete('/:id', requireRole(...MANAGER_ROLES), (req, res) => {
  const existing = allocationContext(toInt(req.params.id), req.uid);
  if (!existing) throw notFound('Allocation');
  const ok = existing.department_id
    ? canManageDepartment(req.user, existing.department_id)
    : req.user.role === 'admin' || existing.classes.every((c) => canManageDepartment(req.user, c.department_id));
  if (!ok) throw forbidden();
  q.run('DELETE FROM allocations WHERE id = ?', existing.id);
  res.json({ ok: true });
});

export default router;
