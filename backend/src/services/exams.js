// Exam timetabling, invigilators, eligibility (attendance + coursework) and coursework marks.
import ExcelJS from 'exceljs';
import { insert, q, tx } from '../db.js';
import { placeholders } from '../scope.js';
import { addDays, badRequest, dowOf, isTime, overlaps } from '../util.js';
import { examClassIds, noTeachingDates, occurrences } from './occurrences.js';

const round2 = (n) => Math.round(n * 100) / 100;

export const examSelect = `
  SELECT e.*, cu.code AS course_code, cu.name AS course_name, cu.department_id, d.name AS department_name, t.name AS term_name
    FROM exams e JOIN course_units cu ON cu.id = e.course_unit_id
    LEFT JOIN departments d ON d.id = cu.department_id
    JOIN academic_terms t ON t.id = e.term_id`;

/** Adds rooms, invigilators, classes and the number of students to exam rows. */
export function withDetails(exams) {
  for (const e of exams) {
    e.rooms = q.all(
      'SELECT r.id, r.name, r.building, r.capacity, er.seats FROM exam_rooms er JOIN rooms r ON r.id = er.room_id WHERE er.exam_id = ? ORDER BY r.capacity DESC',
      e.id,
    );
    e.invigilators = q.all(
      `SELECT u.id, u.name, u.title, ei.room_id, r.name AS room_name FROM exam_invigilators ei JOIN users u ON u.id = ei.user_id
         LEFT JOIN rooms r ON r.id = ei.room_id WHERE ei.exam_id = ? ORDER BY r.name, u.name`,
      e.id,
    );
    const classIds = examClassIds(e.term_id, e.course_unit_id);
    e.classes = classIds.length ? q.all(`SELECT id, name FROM classes WHERE id IN (${placeholders(classIds)}) ORDER BY name`, ...classIds) : [];
    e.students = classIds.length
      ? q.get(`SELECT COUNT(*) AS n FROM users WHERE role = 'student' AND active = 1 AND class_id IN (${placeholders(classIds)})`, ...classIds).n
      : 0;
  }
  return exams;
}

/** A student's exams (or a staff member's invigilation duties) between two dates. */
export function examsForUser(user, from, to) {
  if (user.role === 'student') {
    if (!user.class_id) return [];
    const rows = q.all(
      `${examSelect} WHERE e.university_id = ? AND e.exam_date BETWEEN ? AND ?
         AND e.course_unit_id IN (SELECT a.course_unit_id FROM allocations a JOIN allocation_classes ac ON ac.allocation_id = a.id
                                   WHERE a.term_id = e.term_id AND ac.class_id = ?)
       ORDER BY e.exam_date, e.start_time`,
      user.university_id,
      from,
      to,
      user.class_id,
    );
    return withDetails(rows);
  }
  const rows = q.all(
    `${examSelect} JOIN exam_invigilators ei ON ei.exam_id = e.id AND ei.user_id = ?
       WHERE e.university_id = ? AND e.exam_date BETWEEN ? AND ? ORDER BY e.exam_date, e.start_time`,
    user.id,
    user.university_id,
    from,
    to,
  );
  return withDetails(rows).map((e) => ({ ...e, duty: true, duty_room: e.invigilators.find((i) => i.id === user.id)?.room_name || null }));
}

function studentsIn(classIds) {
  if (!classIds.length) return 0;
  return q.get(`SELECT COUNT(*) AS n FROM users WHERE role = 'student' AND active = 1 AND class_id IN (${placeholders(classIds)})`, ...classIds).n;
}

/** Seats per room: fill the largest rooms first. */
export function seatPlan(rooms, size) {
  let left = size;
  return rooms.map((r) => {
    const seats = Math.max(0, Math.min(r.capacity, left));
    left -= seats;
    return { ...r, seats };
  });
}

/** Rooms for `size` students: the smallest single room that fits, else the largest rooms combined. */
function pickRooms(free, size) {
  const single = [...free].sort((a, b) => a.capacity - b.capacity).find((r) => r.capacity >= size);
  if (single) return [single];
  const chosen = [];
  let seats = 0;
  for (const r of [...free].sort((a, b) => b.capacity - a.capacity)) {
    chosen.push(r);
    seats += r.capacity;
    if (seats >= size) return chosen;
  }
  return null;
}

/**
 * Generates the exam timetable for a term: every allocated course unit gets one exam slot with no
 * class sitting two exams in a day, rooms large enough and never double-booked, lectures that day
 * respected, and invigilators (about one per `perInvigilator` students per room) who are free.
 */
export function generateExams(universityId, termId, { startDate, endDate, slots, clear = false, perInvigilator = 50, userId = null }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(endDate || '') || startDate > endDate) {
    throw badRequest('Choose the first and last day of the exam period');
  }
  slots = (slots?.length ? slots : [['09:00', '12:00'], ['14:00', '17:00']]).map(([s, e]) => {
    if (!isTime(s) || !isTime(e) || s >= e) throw badRequest('Each exam slot needs a start and end time (HH:MM)');
    return [s, e];
  });
  const uni = q.get('SELECT * FROM universities WHERE id = ?', universityId);
  const term = q.get('SELECT * FROM academic_terms WHERE id = ? AND university_id = ?', termId, universityId);
  if (!term) throw badRequest('Unknown academic term');
  const teaching = String(uni.teaching_days).split(',').map(Number);
  const blocked = noTeachingDates(universityId, startDate, endDate);
  const dates = [];
  for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
    const ev = blocked.get(d);
    if (teaching.includes(dowOf(d)) && (!ev || ev.kind === 'exams' || ev.kind === 'reading')) dates.push(d);
  }
  if (!dates.length) throw badRequest('There are no usable days in that period (check teaching days and holidays)');

  return tx(() => {
    if (clear) q.run('DELETE FROM exams WHERE term_id = ? AND university_id = ?', termId, universityId);
    const rooms = q.all('SELECT * FROM rooms WHERE university_id = ? AND active = 1', universityId);
    const staff = q.all(
      `SELECT u.id, u.name, u.department_id, d.faculty_id FROM users u LEFT JOIN departments d ON d.id = u.department_id
        WHERE u.university_id = ? AND u.active = 1 AND u.role IN ('lecturer', 'hod')`,
      universityId,
    );
    const duties = new Map(staff.map((s) => [s.id, 0]));
    const busyRooms = new Map();
    const busyPeople = new Map();
    const examDay = new Map();
    const key = (d, i) => `${d}|${i}`;
    const add = (map, k, v) => {
      if (!map.has(k)) map.set(k, new Set());
      map.get(k).add(v);
    };
    // Lectures still running in the exam period block their rooms, lecturers and classes.
    const lectureClasses = new Map();
    for (const d of dates) {
      for (const o of occurrences(universityId, { from: d, to: d })) {
        slots.forEach(([s, e], i) => {
          if (!overlaps(s, e, o.start_time, o.end_time)) return;
          add(busyRooms, key(d, i), o.room_id);
          add(busyPeople, key(d, i), o.lecturer_id);
          for (const c of o.classes) add(lectureClasses, key(d, i), c.id);
        });
      }
    }
    const keep = q.all('SELECT * FROM exams WHERE term_id = ? AND university_id = ?', termId, universityId);
    for (const e of keep) {
      const i = slots.findIndex(([s, en]) => overlaps(s, en, e.start_time, e.end_time));
      for (const c of examClassIds(termId, e.course_unit_id)) add(examDay, e.exam_date, c);
      if (i < 0) continue;
      for (const r of q.all('SELECT room_id FROM exam_rooms WHERE exam_id = ?', e.id)) add(busyRooms, key(e.exam_date, i), r.room_id);
      for (const p of q.all('SELECT user_id FROM exam_invigilators WHERE exam_id = ?', e.id)) {
        add(busyPeople, key(e.exam_date, i), p.user_id);
        duties.set(p.user_id, (duties.get(p.user_id) || 0) + 1);
      }
    }
    const scheduled = new Set(keep.map((e) => e.course_unit_id));

    const units = q
      .all(
        `SELECT DISTINCT cu.id, cu.code, cu.name, cu.department_id, d.faculty_id FROM allocations a
           JOIN course_units cu ON cu.id = a.course_unit_id LEFT JOIN departments d ON d.id = cu.department_id
          WHERE a.term_id = ? AND a.university_id = ?`,
        termId,
        universityId,
      )
      .filter((u) => !scheduled.has(u.id))
      .map((u) => {
        const classIds = examClassIds(termId, u.id);
        const enrolled = studentsIn(classIds);
        const expected = classIds.length ? q.get(`SELECT COALESCE(SUM(expected_size), 0) AS n FROM classes WHERE id IN (${placeholders(classIds)})`, ...classIds).n : 0;
        return { ...u, classIds, size: enrolled || expected };
      })
      .filter((u) => u.classIds.length)
      .sort((a, b) => b.classIds.length - a.classIds.length || b.size - a.size || a.code.localeCompare(b.code));

    let placed = 0;
    const unplaced = [];
    const warnings = [];
    for (const u of units) {
      let done = false;
      for (const d of dates) {
        if (done) break;
        if (u.classIds.some((c) => examDay.get(d)?.has(c))) continue;
        for (let i = 0; i < slots.length && !done; i++) {
          const k = key(d, i);
          if (u.classIds.some((c) => lectureClasses.get(k)?.has(c))) continue;
          const free = rooms.filter((r) => !busyRooms.get(k)?.has(r.id));
          const chosen = pickRooms(free, u.size);
          if (!chosen) continue;
          const plan = seatPlan(chosen.sort((a, b) => b.capacity - a.capacity), u.size);
          const id = insert('exams', { university_id: universityId, term_id: termId, course_unit_id: u.id, exam_date: d, start_time: slots[i][0], end_time: slots[i][1], created_by: userId });
          for (const r of plan) {
            insert('exam_rooms', { exam_id: id, room_id: r.id, seats: r.seats });
            add(busyRooms, k, r.id);
            const need = Math.max(1, Math.ceil(r.seats / perInvigilator));
            const candidates = staff
              .filter((s) => !busyPeople.get(k)?.has(s.id))
              .sort(
                (a, b) =>
                  (a.department_id === u.department_id ? 0 : 1) - (b.department_id === u.department_id ? 0 : 1) ||
                  (a.faculty_id === u.faculty_id ? 0 : 1) - (b.faculty_id === u.faculty_id ? 0 : 1) ||
                  duties.get(a.id) - duties.get(b.id) ||
                  a.name.localeCompare(b.name),
              )
              .slice(0, need);
            if (candidates.length < need) warnings.push(`${u.code}: only ${candidates.length} of ${need} invigilators free for ${r.name}`);
            for (const c of candidates) {
              insert('exam_invigilators', { exam_id: id, user_id: c.id, room_id: r.id });
              add(busyPeople, k, c.id);
              duties.set(c.id, duties.get(c.id) + 1);
            }
          }
          for (const c of u.classIds) add(examDay, d, c);
          placed++;
          done = true;
        }
      }
      if (!done) {
        unplaced.push({
          course_unit_id: u.id,
          code: u.code,
          name: u.name,
          reason: rooms.reduce((t, r) => t + r.capacity, 0) < u.size ? `Rooms cannot seat ${u.size} students at once` : 'No free slot for all its classes and enough rooms; lengthen the period or add slots',
        });
      }
    }
    return { placed, unplaced, warnings, total: q.get('SELECT COUNT(*) AS n FROM exams WHERE term_id = ?', termId).n };
  });
}

/** Attendance and coursework status of every student who should sit an exam. */
export function eligibility(exam) {
  const uni = q.get('SELECT exam_min_attendance, coursework_min_percent FROM universities WHERE id = ?', exam.university_id);
  const classIds = examClassIds(exam.term_id, exam.course_unit_id);
  if (!classIds.length) return { thresholds: uni, students: [] };
  const students = q.all(
    `SELECT u.id, u.name, u.identifier, c.id AS class_id, c.name AS class_name, p.code AS program_code, p.coursework_max, p.department_id
       FROM users u JOIN classes c ON c.id = u.class_id JOIN programs p ON p.id = c.program_id
      WHERE u.role = 'student' AND u.active = 1 AND u.class_id IN (${placeholders(classIds)}) ORDER BY c.name, u.name`,
    ...classIds,
  );
  const att = new Map(
    q
      .all(
        `SELECT ar.student_id, COUNT(*) AS total, SUM(ar.present) AS attended FROM attendance_records ar
           JOIN attendance_registers r ON r.id = ar.register_id JOIN timetable_sessions s ON s.id = r.session_id
           JOIN allocations a ON a.id = s.allocation_id
          WHERE a.course_unit_id = ? AND s.term_id = ? AND r.status = 'approved' GROUP BY ar.student_id`,
        exam.course_unit_id,
        exam.term_id,
      )
      .map((r) => [r.student_id, r]),
  );
  const unitHasRegisters = att.size > 0;
  const marks = new Map(q.all('SELECT * FROM coursework_marks WHERE term_id = ? AND course_unit_id = ?', exam.term_id, exam.course_unit_id).map((m) => [m.student_id, m]));
  const overrides = new Map(
    q.all('SELECT o.*, u.name AS granted_by_name FROM exam_overrides o LEFT JOIN users u ON u.id = o.granted_by WHERE o.exam_id = ?', exam.id).map((o) => [o.student_id, o]),
  );
  return {
    thresholds: uni,
    students: students.map((s) => {
      const a = att.get(s.id);
      const rate = a?.total ? round2((a.attended / a.total) * 100) : unitHasRegisters ? 0 : null;
      const attendanceOk = rate === null || rate >= uni.exam_min_attendance;
      const m = marks.get(s.id);
      const cwPercent = m ? round2((m.mark / m.max_mark) * 100) : null;
      const courseworkOk = cwPercent !== null && cwPercent >= uni.coursework_min_percent;
      const reasons = [];
      if (!attendanceOk) reasons.push(`Attendance ${rate}% (needs ${uni.exam_min_attendance}%)`);
      if (cwPercent === null) reasons.push('No coursework mark');
      else if (!courseworkOk) reasons.push(`Coursework ${round2(m.mark)}/${round2(m.max_mark)} (needs ${uni.coursework_min_percent}%)`);
      const override = overrides.get(s.id) || null;
      return {
        ...s,
        attendance: { rate, attended: a?.attended ?? 0, total: a?.total ?? 0, ok: attendanceOk, recorded: rate !== null },
        coursework: m ? { mark: round2(m.mark), max: round2(m.max_mark), percent: cwPercent, ok: courseworkOk } : null,
        override: override ? { reason: override.reason, by: override.granted_by_name, at: override.created_at } : null,
        eligible: Boolean(override) || (attendanceOk && courseworkOk),
        reasons,
      };
    }),
  };
}

// ---------------------------------------------------------------- Coursework

/** Students who take a course unit in a term, with their programme's coursework total and mark. */
export function courseworkRoster(termId, courseUnitId) {
  const classIds = examClassIds(termId, courseUnitId);
  if (!classIds.length) return [];
  return q.all(
    `SELECT u.id, u.name, u.identifier, c.name AS class_name, p.code AS program_code, p.name AS program_name, p.coursework_max,
            cm.raw_mark, cm.out_of, cm.mark, cm.max_mark, cm.uploaded_at
       FROM users u JOIN classes c ON c.id = u.class_id JOIN programs p ON p.id = c.program_id
       LEFT JOIN coursework_marks cm ON cm.student_id = u.id AND cm.term_id = ? AND cm.course_unit_id = ?
      WHERE u.role = 'student' AND u.active = 1 AND u.class_id IN (${placeholders(classIds)})
      ORDER BY c.name, u.name`,
    termId,
    courseUnitId,
    ...classIds,
  );
}

export async function courseworkTemplate(university, unit, term, roster) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Coursework');
  ws.addRow([`${university.name} - coursework marks`]).font = { bold: true, size: 13 };
  ws.addRow([`${unit.code} ${unit.name} · ${term.name}`]);
  ws.addRow(['Enter each mark in the Mark column. When you upload, say what the marks are out of (e.g. 100); eCampus converts them to each programme\'s coursework total.']).font = { italic: true, color: { argb: 'FF667085' } };
  const head = ws.addRow(['Reg No', 'Student name', 'Class', 'Programme', 'Coursework total', 'Mark']);
  head.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${(university.primary_color || '#1E5AA8').replace('#', '')}` } };
  });
  for (const s of roster) ws.addRow([s.identifier || '', s.name, s.class_name, s.program_code, s.coursework_max, s.raw_mark ?? null]);
  [16, 28, 18, 12, 16, 10].forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });
  ws.getColumn(6).eachCell((c, row) => {
    if (row > 4) c.protection = { locked: false };
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Reads an uploaded template: returns [{ row, reg_no, raw }] for rows that have a mark. */
export async function readMarksFile(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw badRequest('Upload the Excel (.xlsx) template downloaded from eCampus');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw badRequest('The file has no worksheet');
  let headerRow = 0;
  let regCol = 0;
  let markCol = 0;
  const text = (v) => (v && typeof v === 'object' ? (v.result ?? v.text ?? v.richText?.map((t) => t.text).join('') ?? '') : (v ?? ''));
  for (let r = 1; r <= Math.min(ws.rowCount, 15) && !headerRow; r++) {
    ws.getRow(r).eachCell((cell, col) => {
      const t = String(text(cell.value)).trim().toLowerCase();
      if (/^reg(istration)?\.?\s*(no|number)\.?$/.test(t) || t === 'reg no' || t === 'regno') regCol = col;
      if (t === 'mark' || t === 'marks' || t === 'score') markCol = col;
    });
    if (regCol && markCol) headerRow = r;
    else {
      regCol = 0;
      markCol = 0;
    }
  }
  if (!headerRow) throw badRequest('The file needs a "Reg No" column and a "Mark" column');
  const rows = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const reg = String(text(row.getCell(regCol).value)).trim();
    const rawCell = text(row.getCell(markCol).value);
    if (!reg && (rawCell === '' || rawCell === null)) continue;
    rows.push({ row: r, reg_no: reg, raw: rawCell === '' || rawCell === null ? null : rawCell });
  }
  return rows;
}

/** Saves marks out of `outOf`, converted to each student's programme coursework total. */
export function saveMarks({ universityId, termId, courseUnitId, outOf, rows, userId }) {
  outOf = Number(outOf);
  if (!(outOf > 0) || outOf > 1000) throw badRequest('Say what the marks are out of (for example 100)');
  const roster = courseworkRoster(termId, courseUnitId);
  const byReg = new Map(roster.filter((s) => s.identifier).map((s) => [s.identifier.trim().toLowerCase(), s]));
  const errors = [];
  let updated = 0;
  let skipped = 0;
  tx(() => {
    for (const r of rows) {
      const s = byReg.get(String(r.reg_no).trim().toLowerCase());
      if (!s) {
        errors.push({ row: r.row, reg_no: r.reg_no, error: 'No student with this Reg No takes this course unit' });
        continue;
      }
      if (r.raw === null) {
        skipped++;
        continue;
      }
      const raw = Number(String(r.raw).replace(',', '.'));
      if (!Number.isFinite(raw) || raw < 0 || raw > outOf) {
        errors.push({ row: r.row, reg_no: r.reg_no, error: `Mark must be a number from 0 to ${outOf}` });
        continue;
      }
      const max = Number(s.coursework_max) || 40;
      q.run(
        `INSERT INTO coursework_marks (university_id, term_id, course_unit_id, student_id, raw_mark, out_of, mark, max_mark, uploaded_by, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT (term_id, course_unit_id, student_id) DO UPDATE SET raw_mark = excluded.raw_mark, out_of = excluded.out_of,
           mark = excluded.mark, max_mark = excluded.max_mark, uploaded_by = excluded.uploaded_by, uploaded_at = excluded.uploaded_at`,
        universityId,
        termId,
        courseUnitId,
        s.id,
        raw,
        outOf,
        round2((raw / outOf) * max),
        max,
        userId,
      );
      updated++;
    }
  });
  return { updated, skipped, errors, out_of: outOf };
}
