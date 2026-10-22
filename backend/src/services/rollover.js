// The academic calendar rolls over by itself:
// - the current term follows the dates (a term becomes current on its start date);
// - on the first day of a new academic year's Semester 1 every class moves up a year, classes in
//   their final year are marked completed, and each programme opens a new Year 1 class on its
//   latest curriculum version;
// - each semester's teaching starts from last year's: the same course units with the same
//   lecturers are copied as draft allocations for the HoD to confirm.
import { insert, q, tx } from '../db.js';
import { addDays, zonedNow } from '../util.js';
import { latestVersion, refreshVersionStatuses } from './curriculum.js';
import { notify } from './notify.js';

/** "2026/2027" -> "2025/2026" (and back with step +1). */
export function shiftYear(academicYear, step) {
  const m = /^(\d{4})\/(\d{4})$/.exec(academicYear || '');
  if (!m) return null;
  return `${Number(m[1]) + step}/${Number(m[2]) + step}`;
}

/** Whole academic years from `from` to `to` ("2026/2027" to "2027/2028" is 1). */
const yearsBetween = (from, to) => (/^\d{4}/.test(from || '') && /^\d{4}/.test(to || '') ? Number(to.slice(0, 4)) - Number(from.slice(0, 4)) : 0);

const adminIds = (uid) => q.all("SELECT id FROM users WHERE university_id = ? AND role = 'admin' AND active = 1", uid).map((r) => r.id);

/** Make the term that has started most recently the current one. */
function followCurrentTerm(uid, today) {
  const started = q.get('SELECT * FROM academic_terms WHERE university_id = ? AND start_date IS NOT NULL AND start_date <= ? ORDER BY start_date DESC, id DESC LIMIT 1', uid, today);
  if (!started || started.is_current) return null;
  const current = q.get('SELECT * FROM academic_terms WHERE university_id = ? AND is_current = 1', uid);
  // Only move forward: a newer term started since the current one was set.
  if (current?.start_date && current.start_date >= started.start_date) return null;
  tx(() => {
    q.run('UPDATE academic_terms SET is_current = 0 WHERE university_id = ?', uid);
    q.run('UPDATE academic_terms SET is_current = 1 WHERE id = ?', started.id);
  });
  return started;
}

const renameYear = (name, year) => (/year\s*\d+/i.test(name) ? name.replace(/(year\s*)\d+/i, `$1${year}`) : name);

/**
 * Move every running class up a year for `academicYear`. Finalists are completed (kept for history,
 * their students keep their records); each programme that had a Year 1 class gets a new one.
 */
export function promoteClasses(uid, academicYear) {
  const classes = q.all(
    `SELECT c.*, p.duration_years, p.code AS program_code, p.id AS pid FROM classes c JOIN programs p ON p.id = c.program_id
      WHERE c.university_id = ? AND c.status = 'active' ORDER BY c.year_of_study DESC`,
    uid,
  );
  const intakes = new Map();
  let promoted = 0;
  let completed = 0;
  let opened = 0;
  tx(() => {
    for (const c of classes) {
      if (c.year_of_study === 1 && !intakes.has(c.pid)) intakes.set(c.pid, c);
      if (c.year_of_study >= (c.duration_years || 3)) {
        const end = academicYear.slice(0, 4);
        q.run(
          "UPDATE classes SET status = 'completed', completed_at = datetime('now'), class_rep_id = NULL, name = ? WHERE id = ?",
          `${c.name} (completed ${end})`,
          c.id,
        );
        completed++;
      } else {
        q.run('UPDATE classes SET year_of_study = ?, academic_year = ?, name = ? WHERE id = ?', c.year_of_study + 1, academicYear, renameYear(c.name, c.year_of_study + 1), c.id);
        promoted++;
      }
    }
    for (const [pid, previous] of intakes) {
      const version = latestVersion(pid);
      insert('classes', {
        university_id: uid,
        program_id: pid,
        name: renameYear(previous.name, 1),
        year_of_study: 1,
        academic_year: academicYear,
        intake_year: academicYear,
        expected_size: previous.expected_size,
        curriculum_version_id: version?.id ?? null,
      });
      opened++;
    }
    q.run('UPDATE universities SET progressed_year = ? WHERE id = ?', academicYear, uid);
    refreshVersionStatuses(uid);
  });
  return { promoted, completed, opened };
}

/**
 * Copy last year's allocations for the same semester into `term` as drafts: each class is matched
 * by programme and year of study (so this year's Year 2 takes what last year's Year 2 took), and
 * only units its curriculum version lists for that year and semester are carried over.
 */
export function carryOverAllocations(uid, term) {
  const previous = q.get(
    'SELECT * FROM academic_terms WHERE university_id = ? AND semester = ? AND academic_year = ? ORDER BY id DESC LIMIT 1',
    uid,
    term.semester,
    shiftYear(term.academic_year, -1),
  );
  let created = 0;
  if (previous) {
    const current = q.all(
      "SELECT c.id, c.program_id, c.year_of_study, c.curriculum_version_id FROM classes c WHERE c.university_id = ? AND c.status = 'active'",
      uid,
    );
    const bySlot = new Map(current.map((c) => [`${c.program_id}:${c.year_of_study}`, c]));
    const taught = new Set(
      q.all('SELECT a.course_unit_id, ac.class_id FROM allocations a JOIN allocation_classes ac ON ac.allocation_id = a.id WHERE a.term_id = ?', term.id).map((r) => `${r.course_unit_id}:${r.class_id}`),
    );
    const old = q.all(
      `SELECT a.*, u.active AS lecturer_active, u.role AS lecturer_role FROM allocations a JOIN users u ON u.id = a.lecturer_id WHERE a.term_id = ?`,
      previous.id,
    );
    tx(() => {
      for (const a of old) {
        if (!a.lecturer_active || !['lecturer', 'hod', 'dean'].includes(a.lecturer_role)) continue;
        // The year each class was in when it took the unit: from its own curriculum, otherwise by the years since.
        const slots = q
          .all(
            'SELECT c.program_id, c.year_of_study, c.academic_year, c.status, c.curriculum_version_id FROM allocation_classes ac JOIN classes c ON c.id = ac.class_id WHERE ac.allocation_id = ?',
            a.id,
          )
          .map((c) => {
            const listed = q.get('SELECT year_of_study FROM program_course_units WHERE version_id = ? AND course_unit_id = ?', c.curriculum_version_id, a.course_unit_id);
            const since = c.status === 'active' ? yearsBetween(previous.academic_year, c.academic_year) : 0;
            return { program_id: c.program_id, year_of_study: listed ? listed.year_of_study : c.year_of_study - since };
          });
        const classIds = [];
        for (const s of slots) {
          // Last year's Year N was promoted, so this year's Year N is a different class.
          const now = bySlot.get(`${s.program_id}:${s.year_of_study}`);
          if (!now || taught.has(`${a.course_unit_id}:${now.id}`)) continue;
          const inCurriculum = q.get(
            'SELECT 1 FROM program_course_units WHERE version_id = ? AND course_unit_id = ? AND year_of_study = ? AND semester = ?',
            now.curriculum_version_id,
            a.course_unit_id,
            now.year_of_study,
            term.semester,
          );
          if (inCurriculum) classIds.push(now.id);
        }
        if (!classIds.length) continue;
        const id = insert('allocations', {
          university_id: uid,
          term_id: term.id,
          course_unit_id: a.course_unit_id,
          lecturer_id: a.lecturer_id,
          hours_per_week: a.hours_per_week,
          part_time_hours: a.part_time_hours || 0,
          notes: a.notes,
          status: 'draft',
          carried_from: a.id,
        });
        for (const cid of classIds) {
          q.run('INSERT INTO allocation_classes (allocation_id, class_id) VALUES (?, ?)', id, cid);
          taught.add(`${a.course_unit_id}:${cid}`);
        }
        created++;
      }
    });
  }
  q.run("UPDATE academic_terms SET carried_over_at = datetime('now') WHERE id = ?", term.id);
  if (created) {
    const hods = q.all('SELECT DISTINCT hod_id AS id FROM departments WHERE university_id = ? AND hod_id IS NOT NULL', uid).map((r) => r.id);
    notify([...hods, ...adminIds(uid)], {
      title: `Draft allocations for ${term.name}`,
      body: `${created} course unit allocation${created === 1 ? ' was' : 's were'} copied from last year with the same lecturers. Confirm or change them in Load allocation.`,
      type: 'allocation',
      link: '/allocation',
      dedupeKey: `carry:${term.id}`,
    });
  }
  return created;
}

/** Run everything that depends on the date for one university. Safe to call repeatedly. */
export function rollover(uid, today = null) {
  const uni = q.get('SELECT * FROM universities WHERE id = ?', uid);
  if (!uni) return null;
  const date = today || zonedNow(uni.timezone || 'UTC').date;
  const out = { current: null, promoted: null, carried: [] };
  out.current = followCurrentTerm(uid, date)?.name || null;

  if (!uni.progressed_year) {
    // First run on this university: record where classes are now; nothing moves.
    const year = q.get('SELECT academic_year FROM academic_terms WHERE university_id = ? AND is_current = 1', uid)?.academic_year;
    if (year) q.run('UPDATE universities SET progressed_year = ? WHERE id = ?', year, uid);
  } else {
    const start = q.get(
      `SELECT * FROM academic_terms WHERE university_id = ? AND semester = 1 AND academic_year > ? AND start_date IS NOT NULL AND start_date <= ?
        ORDER BY academic_year LIMIT 1`,
      uid,
      uni.progressed_year,
      date,
    );
    if (start) {
      const result = promoteClasses(uid, start.academic_year);
      out.promoted = { academic_year: start.academic_year, ...result };
      notify(adminIds(uid), {
        title: `Academic year ${start.academic_year} has started`,
        body: `${result.promoted} classes moved up a year, ${result.completed} finished their programme and ${result.opened} new Year 1 classes were opened. Add the new students to the Year 1 classes.`,
        type: 'timetable',
        link: '/setup/classes',
        dedupeKey: `year:${start.academic_year}`,
      });
    }
  }

  // Draft allocations: Semester 1 of a new year once its classes have moved up; other semesters a month ahead.
  const progressed = q.get('SELECT progressed_year FROM universities WHERE id = ?', uid).progressed_year;
  const due = q.all(
    `SELECT * FROM academic_terms WHERE university_id = ? AND carried_over_at IS NULL AND academic_year IS NOT NULL
        AND start_date IS NOT NULL AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)`,
    uid,
    addDays(date, 30),
    date,
  );
  for (const term of due) {
    if (term.academic_year > (progressed || '')) continue;
    if (q.get('SELECT 1 FROM allocations WHERE term_id = ? LIMIT 1', term.id) && !q.get("SELECT 1 FROM allocations WHERE term_id = ? AND status = 'draft' LIMIT 1", term.id)) {
      // The HoDs already allocated this term by hand; leave it alone.
      q.run("UPDATE academic_terms SET carried_over_at = datetime('now') WHERE id = ?", term.id);
      continue;
    }
    out.carried.push({ term: term.name, created: carryOverAllocations(uid, term) });
  }
  return out;
}

/** Roll over every active university (called from the scheduler). */
export function rolloverAll() {
  for (const u of q.all('SELECT id FROM universities WHERE active = 1')) {
    try {
      rollover(u.id);
    } catch (err) {
      console.error(`rollover failed for university ${u.id}:`, err);
    }
  }
}
