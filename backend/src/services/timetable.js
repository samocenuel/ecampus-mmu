import { q, tx, insert } from '../db.js';
import { badRequest, DAY_NAMES, isTime, overlaps, toHHMM, toMinutes } from '../util.js';
import { placeholders } from '../scope.js';

const studentCountSql = `(SELECT COUNT(*) FROM users s WHERE s.class_id = c.id AND s.role = 'student' AND s.active = 1)`;

/** Allocation with its course unit, classes and combined class size. */
export function allocationContext(allocationId, universityId) {
  const a = q.get(
    `SELECT a.*, cu.code, cu.name AS course_name, cu.is_cross_cutting, cu.department_id,
            cu.preferred_room_type, u.name AS lecturer_name
       FROM allocations a
       JOIN course_units cu ON cu.id = a.course_unit_id
       JOIN users u ON u.id = a.lecturer_id
      WHERE a.id = ? AND a.university_id = ?`,
    allocationId,
    universityId,
  );
  if (!a) return null;
  a.classes = q.all(
    `SELECT c.id, c.name, c.expected_size, c.class_rep_id, p.department_id, ${studentCountSql} AS enrolled
       FROM allocation_classes ac
       JOIN classes c ON c.id = ac.class_id
       JOIN programs p ON p.id = c.program_id
      WHERE ac.allocation_id = ?
      ORDER BY c.name`,
    allocationId,
  );
  a.class_ids = a.classes.map((c) => c.id);
  a.size = a.classes.reduce((sum, c) => sum + Math.max(c.expected_size || 0, c.enrolled || 0), 0);
  return a;
}

function classesByAllocation(allocationIds) {
  const map = new Map();
  if (!allocationIds.length) return map;
  const rows = q.all(
    `SELECT ac.allocation_id, c.id, c.name, c.class_rep_id
       FROM allocation_classes ac JOIN classes c ON c.id = ac.class_id
      WHERE ac.allocation_id IN (${placeholders(allocationIds)})
      ORDER BY c.name`,
    ...allocationIds,
  );
  for (const r of rows) {
    if (!map.has(r.allocation_id)) map.set(r.allocation_id, []);
    map.get(r.allocation_id).push({ id: r.id, name: r.name, class_rep_id: r.class_rep_id });
  }
  return map;
}

/** Weekly sessions of a term, optionally filtered by class, lecturer, room or department. */
export function listSessions(universityId, termId, filters = {}) {
  const where = ['s.university_id = ?', 's.term_id = ?'];
  const params = [universityId, termId];
  if (filters.classId) {
    where.push('s.allocation_id IN (SELECT allocation_id FROM allocation_classes WHERE class_id = ?)');
    params.push(filters.classId);
  }
  if (filters.classIds) {
    where.push(`s.allocation_id IN (SELECT allocation_id FROM allocation_classes WHERE class_id IN (${placeholders(filters.classIds)}))`);
    params.push(...filters.classIds);
  }
  if (filters.lecturerId) {
    where.push('a.lecturer_id = ?');
    params.push(filters.lecturerId);
  }
  if (filters.roomId) {
    where.push('s.room_id = ?');
    params.push(filters.roomId);
  }
  if (filters.allocationId) {
    where.push('s.allocation_id = ?');
    params.push(filters.allocationId);
  }
  if (filters.departmentIds) {
    const ph = placeholders(filters.departmentIds);
    where.push(`(cu.department_id IN (${ph}) OR s.allocation_id IN (
        SELECT ac.allocation_id FROM allocation_classes ac
          JOIN classes c ON c.id = ac.class_id JOIN programs p ON p.id = c.program_id
         WHERE p.department_id IN (${ph})))`);
    params.push(...filters.departmentIds, ...filters.departmentIds);
  }
  if (filters.day) {
    where.push('s.day_of_week = ?');
    params.push(filters.day);
  }
  const rows = q.all(
    `SELECT s.id, s.term_id, s.allocation_id, s.room_id, s.day_of_week, s.start_time, s.end_time, s.generated,
            a.lecturer_id, a.hours_per_week, cu.id AS course_unit_id, cu.code AS course_code,
            cu.name AS course_name, cu.is_cross_cutting, cu.department_id,
            u.name AS lecturer_name, u.title AS lecturer_title,
            r.name AS room_name, r.building AS room_building, r.capacity AS room_capacity
       FROM timetable_sessions s
       JOIN allocations a ON a.id = s.allocation_id
       JOIN course_units cu ON cu.id = a.course_unit_id
       JOIN users u ON u.id = a.lecturer_id
       JOIN rooms r ON r.id = s.room_id
      WHERE ${where.join(' AND ')}
      ORDER BY s.day_of_week, s.start_time, cu.code`,
    ...params,
  );
  const classMap = classesByAllocation([...new Set(rows.map((r) => r.allocation_id))]);
  return rows.map((r) => ({ ...r, day_name: DAY_NAMES[r.day_of_week], classes: classMap.get(r.allocation_id) || [] }));
}

/**
 * Check a proposed session against the term's timetable. Hard `conflicts`
 * (room / lecturer / class double-booking) block saving; `warnings` (capacity,
 * outside teaching hours) can be overridden by the user.
 */
export function checkSession({ universityId, allocation, roomId, day, start, end, excludeSessionId = null, lecturerId, classIds }) {
  if (!isTime(start) || !isTime(end)) throw badRequest('Times must use the HH:MM 24-hour format');
  if (toMinutes(start) >= toMinutes(end)) throw badRequest('End time must be after the start time');
  day = Number(day);
  if (!(day >= 1 && day <= 7)) throw badRequest('day_of_week must be between 1 (Monday) and 7 (Sunday)');

  const uni = q.get('SELECT * FROM universities WHERE id = ?', universityId);
  const room = q.get('SELECT * FROM rooms WHERE id = ? AND university_id = ?', roomId, universityId);
  if (!room) throw badRequest('Unknown room');
  lecturerId = Number(lecturerId ?? allocation.lecturer_id);
  classIds = (classIds ?? allocation.class_ids).map(Number);

  const conflicts = [];
  const warnings = [];
  const teachingDays = uni.teaching_days.split(',').map(Number);
  if (!teachingDays.includes(day)) warnings.push(`${DAY_NAMES[day]} is not a teaching day`);
  if (start < uni.day_start || end > uni.day_end) warnings.push(`Outside teaching hours (${uni.day_start}-${uni.day_end})`);
  if (uni.lunch_start && uni.lunch_end && overlaps(start, end, uni.lunch_start, uni.lunch_end)) {
    warnings.push(`Overlaps the lunch break (${uni.lunch_start}-${uni.lunch_end})`);
  }
  if (!room.active) warnings.push(`${room.name} is marked as unavailable`);
  if (allocation.size > room.capacity) {
    warnings.push(`${room.name} seats ${room.capacity} but the combined class size is ${allocation.size}`);
  }

  const clashes = q.all(
    `SELECT s.id, s.room_id, s.start_time, s.end_time, s.allocation_id, a.lecturer_id,
            cu.code, cu.name AS course_name, r.name AS room_name, u.name AS lecturer_name
       FROM timetable_sessions s
       JOIN allocations a ON a.id = s.allocation_id
       JOIN course_units cu ON cu.id = a.course_unit_id
       JOIN rooms r ON r.id = s.room_id
       JOIN users u ON u.id = a.lecturer_id
      WHERE s.term_id = ? AND s.day_of_week = ? AND s.start_time < ? AND s.end_time > ? AND s.id != ?`,
    allocation.term_id,
    day,
    end,
    start,
    excludeSessionId ?? -1,
  );
  const classMap = classesByAllocation([...new Set(clashes.map((c) => c.allocation_id))]);
  for (const c of clashes) {
    const when = `${DAY_NAMES[day]} ${c.start_time}-${c.end_time}`;
    const what = `${c.code} ${c.course_name}`;
    if (c.room_id === Number(roomId)) {
      conflicts.push({ type: 'room', session_id: c.id, message: `${c.room_name} is already booked ${when} for ${what}` });
    }
    if (c.lecturer_id === lecturerId) {
      conflicts.push({ type: 'lecturer', session_id: c.id, message: `${c.lecturer_name} is already teaching ${what} on ${when}` });
    }
    const shared = (classMap.get(c.allocation_id) || []).filter((cl) => classIds.includes(cl.id));
    if (shared.length) {
      conflicts.push({
        type: 'class',
        session_id: c.id,
        message: `${shared.map((s) => s.name).join(', ')} already ${shared.length > 1 ? 'have' : 'has'} ${what} on ${when}`,
      });
    }
  }
  return { conflicts, warnings, room };
}

/**
 * Greedy timetable generator. Cross-cutting course units are placed first
 * (they involve several programmes and are the hardest to fit), then larger
 * classes. Each allocation's weekly hours are split into blocks of up to two
 * hours, spread across different days, and given the smallest free room that
 * seats the combined class. Existing sessions are respected.
 */
export function generateTimetable(universityId, termId, { clearExisting = false } = {}) {
  const uni = q.get('SELECT * FROM universities WHERE id = ?', universityId);
  const days = uni.teaching_days
    .split(',')
    .map(Number)
    .filter((d) => d >= 1 && d <= 7);
  const dayStart = toMinutes(uni.day_start);
  const dayEnd = toMinutes(uni.day_end);
  const lunch = uni.lunch_start && uni.lunch_end ? [toMinutes(uni.lunch_start), toMinutes(uni.lunch_end)] : null;

  return tx(() => {
    let removed = 0;
    if (clearExisting) {
      // Sessions that already have attendance registers are kept so history is never lost.
      removed = Number(
        q.run(
          `DELETE FROM timetable_sessions WHERE university_id = ? AND term_id = ?
             AND id NOT IN (SELECT session_id FROM attendance_registers)`,
          universityId,
          termId,
        ).changes,
      );
    }

    const rooms = q.all('SELECT * FROM rooms WHERE university_id = ? AND active = 1 ORDER BY capacity, name', universityId);
    const allocations = q
      // Draft allocations (copied from last year) are placed once the HoD confirms them.
      .all("SELECT id FROM allocations WHERE university_id = ? AND term_id = ? AND status = 'confirmed'", universityId, termId)
      .map((r) => allocationContext(r.id, universityId));
    allocations.sort(
      (a, b) =>
        b.is_cross_cutting - a.is_cross_cutting ||
        b.classes.length - a.classes.length ||
        b.size - a.size ||
        b.hours_per_week - a.hours_per_week ||
        a.code.localeCompare(b.code),
    );
    const byId = new Map(allocations.map((a) => [a.id, a]));

    const busy = new Map();
    const slotKey = (kind, id, day) => `${kind}:${id}:${day}`;
    const isFree = (kind, id, day, s, e) => !(busy.get(slotKey(kind, id, day)) || []).some(([a, b]) => s < b && e > a);
    const occupy = (kind, id, day, s, e) => {
      const k = slotKey(kind, id, day);
      if (!busy.has(k)) busy.set(k, []);
      busy.get(k).push([s, e]);
    };
    const scheduled = new Map();
    const usedDays = new Map();
    const book = (alloc, day, s, e, roomId) => {
      occupy('room', roomId, day, s, e);
      occupy('lecturer', alloc.lecturer_id, day, s, e);
      for (const c of alloc.class_ids) occupy('class', c, day, s, e);
      scheduled.set(alloc.id, (scheduled.get(alloc.id) || 0) + (e - s));
      if (!usedDays.has(alloc.id)) usedDays.set(alloc.id, new Set());
      usedDays.get(alloc.id).add(day);
    };

    for (const s of q.all('SELECT * FROM timetable_sessions WHERE term_id = ?', termId)) {
      const alloc = byId.get(s.allocation_id);
      if (alloc) book(alloc, s.day_of_week, toMinutes(s.start_time), toMinutes(s.end_time), s.room_id);
    }

    const classLoad = (classIds, day) =>
      classIds.reduce(
        (sum, c) => sum + (busy.get(slotKey('class', c, day)) || []).reduce((acc, [a, b]) => acc + (b - a), 0),
        0,
      );
    // How many sessions (university-wide) already run in a slot - used to spread teaching out.
    const concurrency = (day, s, e) => {
      let n = 0;
      for (const r of rooms) if (!isFree('room', r.id, day, s, e)) n++;
      return n;
    };

    let placed = 0;
    const unplaced = [];
    for (const alloc of allocations) {
      let remaining = alloc.hours_per_week * 60 - (scheduled.get(alloc.id) || 0);
      if (remaining <= 0) continue;
      if (!alloc.class_ids.length) {
        unplaced.push({ allocation_id: alloc.id, code: alloc.code, course_name: alloc.course_name, hours: remaining / 60, reason: 'No classes attached to this allocation' });
        continue;
      }
      while (remaining > 0) {
        const len = Math.min(120, remaining);
        const used = usedDays.get(alloc.id) || new Set();
        // Score every feasible slot: avoid repeating a day for the same unit, keep each
        // class's days balanced, avoid crowding one hour, and mildly prefer mornings.
        let slot = null;
        for (const day of days) {
          const dayPenalty = (used.has(day) ? 1000 : 0) + (classLoad(alloc.class_ids, day) / 60) * 12;
          for (let t = dayStart; t + len <= dayEnd; t += 60) {
            if (lunch && t < lunch[1] && t + len > lunch[0]) continue;
            if (!isFree('lecturer', alloc.lecturer_id, day, t, t + len)) continue;
            if (!alloc.class_ids.every((c) => isFree('class', c, day, t, t + len))) continue;
            const fits = rooms.filter((r) => r.capacity >= alloc.size && isFree('room', r.id, day, t, t + len));
            // Use the requested room type when possible; otherwise keep scarce labs for units that need them.
            const room = alloc.preferred_room_type
              ? fits.find((r) => r.room_type === alloc.preferred_room_type) || fits[0]
              : fits.find((r) => r.room_type !== 'lab') || fits[0];
            if (!room) continue;
            const score = dayPenalty + concurrency(day, t, t + len) * 8 + ((t - dayStart) / 60) * 1.5;
            if (!slot || score < slot.score) slot = { day, t, room, score };
          }
        }
        if (!slot) {
          unplaced.push({
            allocation_id: alloc.id,
            code: alloc.code,
            course_name: alloc.course_name,
            hours: remaining / 60,
            reason: rooms.some((r) => r.capacity >= alloc.size)
              ? 'No free slot where the lecturer, classes and a room are all available'
              : `No room is large enough for ${alloc.size} students`,
          });
          break;
        }
        insert('timetable_sessions', {
          university_id: universityId,
          term_id: termId,
          allocation_id: alloc.id,
          room_id: slot.room.id,
          day_of_week: slot.day,
          start_time: toHHMM(slot.t),
          end_time: toHHMM(slot.t + len),
          generated: 1,
        });
        book(alloc, slot.day, slot.t, slot.t + len, slot.room.id);
        placed++;
        remaining -= len;
      }
    }

    const total = q.get('SELECT COUNT(*) AS n FROM timetable_sessions WHERE term_id = ?', termId).n;
    return { placed, removed, unplaced, total_sessions: total, allocations: allocations.length };
  });
}
