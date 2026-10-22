// Seeds a demo tenant ("Demo University") with faculties, departments,
// programmes, cross-cutting and programme units, staff, students, rooms,
// allocations, a generated timetable and some attendance history.
//
//   npm run seed            -> wipes the database and seeds demo data
//
// Every demo account uses the password in DEMO_PASSWORD (see README).
import { pathToFileURL } from 'node:url';
import { hashPassword } from './auth.js';
import { db, insert, q, tx } from './db.js';
import crypto from 'node:crypto';
import { ensureVersion } from './services/curriculum.js';
import { generateExams } from './services/exams.js';
import { occurrences } from './services/occurrences.js';
import { suggestSlots } from './services/ops.js';
import { recalcTotal, refreshTeachingLines } from './services/pay.js';
import { generateTimetable } from './services/timetable.js';
import { addDays, dowOf, toMinutes, zonedNow } from './util.js';

export const DEMO_PASSWORD = 'Passw0rd!';
const TZ = 'Africa/Kampala';

// Small deterministic PRNG so the demo data is the same on every run.
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

function wipe() {
  for (const t of [
    'pay_budgets', 'exam_overrides', 'coursework_marks', 'exam_invigilators', 'exam_rooms', 'exams', 'leave_covers', 'leave_requests',
    'calendar_events', 'session_changes', 'attendance_corrections', 'checkin_flags', 'checkins', 'checkin_sessions', 'student_devices',
    'pay_claim_events', 'pay_claim_lines', 'pay_claims', 'pay_votes', 'pay_rates',
    'notifications', 'notification_prefs', 'attendance_records', 'attendance_registers', 'timetable_sessions',
    'allocation_classes', 'allocations', 'program_course_units', 'course_units', 'classes', 'curriculum_versions', 'programs',
    'departments', 'faculties', 'rooms', 'academic_terms', 'users', 'universities',
  ]) db.exec(`DELETE FROM ${t}`);
  db.exec("DELETE FROM sqlite_sequence");
}

const FIRST = ['Aisha', 'Brian', 'Catherine', 'Daniel', 'Esther', 'Francis', 'Gloria', 'Henry', 'Irene', 'Joseph', 'Kevin', 'Lydia', 'Moses', 'Naomi', 'Oscar', 'Patience', 'Ronald', 'Sharon', 'Timothy', 'Vivian', 'Winnie', 'Allan', 'Brenda', 'Collins'];
const LAST = ['Akello', 'Byamukama', 'Chebet', 'Draku', 'Ekwaru', 'Friday', 'Kabugo', 'Lubega', 'Mirembe', 'Nakimuli', 'Ochieng', 'Pande', 'Rukundo', 'Ssali', 'Tumwine', 'Wanyama', 'Zziwa', 'Asiimwe', 'Barungi', 'Kyomuhendo'];

// ownerPassword: the platform owner (super admin) password; defaults to the demo password.
export function seedDemo({ quiet = false, ownerPassword = DEMO_PASSWORD } = {}) {
  const log = (...a) => !quiet && console.log(...a);
  const hash = hashPassword(DEMO_PASSWORD);

  return tx(() => {
    wipe();

    insert('users', { university_id: null, name: 'Platform Owner', email: 'owner@lms-platform.example', password_hash: ownerPassword === DEMO_PASSWORD ? hash : hashPassword(ownerPassword), role: 'super_admin' });

    const uni = insert('universities', {
      name: 'Demo University',
      short_name: 'DU',
      slug: 'demo-university',
      address: '1 Campus Road, Example City',
      email: 'info@demo-university.example',
      phone: '+1 555 0100',
      website: 'https://demo-university.example',
      primary_color: '#0B6E4F',
      timezone: TZ,
    });

    const user = (data) => insert('users', { university_id: uni, password_hash: hash, ...data });
    user({ name: 'Alice Mbabazi', email: 'admin@demo.edu', role: 'admin', title: 'Ms.', identifier: 'ADM-001' });
    const hrId = user({ name: 'Harriet Nansubuga', email: 'hr@demo.edu', role: 'hr', title: 'Ms.', identifier: 'HR-001' });

    // --- Terms (relative to today so the demo always has a live semester) ---
    const today = zonedNow(TZ).date;
    const monday = addDays(today, 1 - dowOf(today));
    const start = addDays(monday, -8 * 7);
    const year = Number(start.slice(0, 4));
    const academicYear = Number(start.slice(5, 7)) >= 7 ? `${year}/${year + 1}` : `${year - 1}/${year}`;
    const term1 = insert('academic_terms', {
      university_id: uni, name: `${academicYear} Semester 1`, academic_year: academicYear, semester: 1,
      start_date: start, end_date: addDays(start, 17 * 7 - 3), is_current: 1,
    });
    insert('academic_terms', {
      university_id: uni, name: `${academicYear} Semester 2`, academic_year: academicYear, semester: 2,
      start_date: addDays(start, 22 * 7), end_date: addDays(start, 39 * 7 - 3), is_current: 0,
    });
    // Classes are in this academic year; they move up when the next year's Semester 1 starts.
    q.run('UPDATE universities SET progressed_year = ? WHERE id = ?', academicYear, uni);

    // --- Faculties & departments with Deans and HoDs ---
    const structure = [
      {
        faculty: ['Faculty of Science and Technology', 'FST'],
        dean: ['Prof.', 'Grace Namara', 'dean.fst@demo.edu'],
        departments: [
          { name: 'Computer Science', code: 'CS', hod: ['Dr.', 'Peter Okello', 'hod.cs@demo.edu'], staff: [['Mr.', 'Brian Kato'], ['Ms.', 'Esther Atim'], ['Dr.', 'Ivan Ssemwogerere']] },
          { name: 'Information Technology', code: 'IT', hod: ['Dr.', 'Sarah Achieng', 'hod.it@demo.edu'], staff: [['Mr.', 'Joel Byaruhanga'], ['Ms.', 'Linda Auma']] },
        ],
      },
      {
        faculty: ['Faculty of Business and Management', 'FBM'],
        dean: ['Prof.', 'David Mugisha', 'dean.fbm@demo.edu'],
        departments: [
          { name: 'Accounting and Finance', code: 'AF', hod: ['Dr.', 'Ruth Nakato', 'hod.af@demo.edu'], staff: [['Mr.', 'Henry Opio'], ['Ms.', 'Diana Kemigisha'], ['Dr.', 'Florence Namutebi']] },
          { name: 'Business Administration', code: 'BA', hod: ['Dr.', 'James Tumusiime', 'hod.ba@demo.edu'], staff: [['Ms.', 'Agnes Nabirye'], ['Mr.', 'Samuel Wekesa'], ['Ms.', 'Joan Akello'], ['Mr.', 'Patrick Mwesigwa']] },
        ],
      },
    ];
    const dept = {};
    const lecturer = {};
    let staffNo = 1;
    for (const f of structure) {
      const fid = insert('faculties', { university_id: uni, name: f.faculty[0], code: f.faculty[1] });
      const deanId = user({ title: f.dean[0], name: f.dean[1], email: f.dean[2], role: 'dean', faculty_id: fid, identifier: `STF-${String(staffNo++).padStart(3, '0')}` });
      q.run('UPDATE faculties SET dean_id = ? WHERE id = ?', deanId, fid);
      lecturer[f.dean[1]] = deanId;
      for (const d of f.departments) {
        const did = insert('departments', { university_id: uni, faculty_id: fid, name: d.name, code: d.code });
        dept[d.code] = did;
        const hodId = user({ title: d.hod[0], name: d.hod[1], email: d.hod[2], role: 'hod', faculty_id: fid, department_id: did, identifier: `STF-${String(staffNo++).padStart(3, '0')}` });
        q.run('UPDATE departments SET hod_id = ? WHERE id = ?', hodId, did);
        lecturer[d.hod[1]] = hodId;
        for (const [title, name] of d.staff) {
          const email = `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@demo.edu`;
          lecturer[name] = user({ title, name, email, role: 'lecturer', faculty_id: fid, department_id: did, identifier: `STF-${String(staffNo++).padStart(3, '0')}` });
        }
      }
    }

    // --- Rooms ---
    for (const [name, building, capacity, room_type] of [
      ['Main Hall', 'Central Block', 260, 'lecture'], ['LT 1', 'Science Block', 130, 'lecture'], ['LT 2', 'Science Block', 100, 'lecture'],
      ['LT 3', 'Business Block', 100, 'lecture'], ['LT 4', 'Business Block', 80, 'lecture'], ['Seminar Room A', 'Library', 60, 'seminar'],
      ['Seminar Room B', 'Library', 50, 'seminar'], ['Computer Lab 1', 'ICT Centre', 70, 'lab'], ['Computer Lab 2', 'ICT Centre', 60, 'lab'],
    ]) insert('rooms', { university_id: uni, name, building, capacity, room_type });

    // --- Programmes & classes ---
    const programs = {
      BSCS: ['Bachelor of Science in Computer Science', 'CS'],
      BIT: ['Bachelor of Information Technology', 'IT'],
      BCOM: ['Bachelor of Commerce (Accounting)', 'AF'],
      BBA: ['Bachelor of Business Administration', 'BA'],
    };
    const programId = {};
    const versionId = {};
    const classId = {};
    let studentNo = 0;
    for (const [code, [name, d]] of Object.entries(programs)) {
      programId[code] = insert('programs', { university_id: uni, department_id: dept[d], name, code, level: 'Bachelor', duration_years: 3 });
      versionId[code] = ensureVersion({ id: programId[code], university_id: uni }).id;
      for (const y of [1, 2]) {
        const cid = insert('classes', {
          university_id: uni, program_id: programId[code], name: `${code} Year ${y}`, year_of_study: y,
          academic_year: academicYear, expected_size: y === 1 ? 60 : 45, curriculum_version_id: versionId[code],
        });
        classId[`${code}${y}`] = cid;
        for (let i = 1; i <= 12; i++) {
          const first = FIRST[(studentNo * 7) % FIRST.length];
          const last = LAST[(studentNo * 11 + 3) % LAST.length];
          studentNo++;
          const sid = user({
            name: `${first} ${last}`,
            email: `${first}.${last}.${studentNo}`.toLowerCase() + '@students.demo.edu',
            role: 'student',
            class_id: cid,
            department_id: dept[d],
            identifier: `${year}/${code}/${String(studentNo).padStart(4, '0')}`,
          });
          if (i === 1) q.run('UPDATE classes SET class_rep_id = ? WHERE id = ?', sid, cid);
        }
      }
    }
    // Stable, easy-to-remember logins for the BSCS Year 1 class rep and a classmate.
    const bscs1 = classId.BSCS1;
    const [rep, mate] = q.all("SELECT id FROM users WHERE class_id = ? AND role = 'student' ORDER BY id LIMIT 2", bscs1);
    q.run("UPDATE users SET email = 'rep.bscs1@students.demo.edu', name = 'Aisha Akello' WHERE id = ?", rep.id);
    q.run("UPDATE users SET email = 'student.bscs1@students.demo.edu', name = 'Brian Lubega' WHERE id = ?", mate.id);

    // --- Course units: cross-cutting first, then programme-specific ---
    const cuId = {};
    const unit = (code, name, hours, opts = {}) => {
      cuId[code] = insert('course_units', {
        university_id: uni, code, name, hours_per_week: hours, credit_units: opts.cu || hours,
        is_cross_cutting: opts.cc ? 1 : 0, department_id: opts.dept ? dept[opts.dept] : null,
        preferred_room_type: opts.room || null, description: opts.desc || null,
      });
      for (const [p, y, s] of opts.programs || []) {
        q.run('INSERT INTO program_course_units (program_id, version_id, course_unit_id, year_of_study, semester) VALUES (?, ?, ?, ?, ?)', programId[p], versionId[p], cuId[code], y, s);
      }
    };
    unit('CCS1101', 'Communication Skills', 2, { cc: true, dept: 'BA', desc: 'Academic writing, presentation and interpersonal communication.', programs: [['BSCS', 1, 1], ['BIT', 1, 1], ['BCOM', 1, 1], ['BBA', 1, 1]] });
    unit('CCE1102', 'Entrepreneurship Skills', 2, { cc: true, dept: 'BA', programs: [['BIT', 1, 1], ['BCOM', 1, 1], ['BBA', 1, 1]] });
    unit('CRM2101', 'Research Methods', 3, { cc: true, dept: 'AF', programs: [['BSCS', 2, 1], ['BIT', 2, 1], ['BCOM', 2, 1], ['BBA', 2, 1]] });
    unit('CEP2102', 'Ethics and Professionalism', 2, { cc: true, dept: 'CS', programs: [['BSCS', 2, 1], ['BIT', 2, 1]] });
    unit('CIL1201', 'Information Literacy', 2, { cc: true, dept: 'IT', programs: [['BSCS', 1, 2], ['BIT', 1, 2], ['BCOM', 1, 2], ['BBA', 1, 2]] });

    unit('CSC1101', 'Programming Fundamentals', 4, { dept: 'CS', room: 'lab', programs: [['BSCS', 1, 1]] });
    unit('CSC1102', 'Discrete Mathematics', 3, { dept: 'CS', programs: [['BSCS', 1, 1]] });
    unit('CSC1103', 'Computer Organisation', 3, { dept: 'CS', programs: [['BSCS', 1, 1]] });
    unit('CSC2101', 'Data Structures and Algorithms', 4, { dept: 'CS', room: 'lab', programs: [['BSCS', 2, 1]] });
    unit('CSC2102', 'Database Systems', 3, { dept: 'CS', room: 'lab', programs: [['BSCS', 2, 1]] });
    unit('CSC2103', 'Operating Systems', 3, { dept: 'CS', programs: [['BSCS', 2, 1]] });
    unit('CSC1201', 'Object-Oriented Programming', 4, { dept: 'CS', room: 'lab', programs: [['BSCS', 1, 2]] });
    unit('BIT1101', 'Web Design and Development', 3, { dept: 'IT', room: 'lab', programs: [['BIT', 1, 1]] });
    unit('BIT1102', 'Fundamentals of IT', 3, { dept: 'IT', programs: [['BIT', 1, 1]] });
    unit('BIT2101', 'Computer Networks', 3, { dept: 'IT', room: 'lab', programs: [['BIT', 2, 1]] });
    unit('BIT2102', 'Systems Analysis and Design', 3, { dept: 'IT', programs: [['BIT', 2, 1]] });
    unit('ACC1101', 'Financial Accounting I', 4, { dept: 'AF', programs: [['BCOM', 1, 1]] });
    unit('ACC1102', 'Business Mathematics', 3, { dept: 'AF', programs: [['BCOM', 1, 1]] });
    unit('ACC2101', 'Cost Accounting', 3, { dept: 'AF', programs: [['BCOM', 2, 1]] });
    unit('ACC2102', 'Taxation', 3, { dept: 'AF', programs: [['BCOM', 2, 1]] });
    unit('BBA1101', 'Principles of Management', 3, { dept: 'BA', programs: [['BBA', 1, 1]] });
    unit('BBA1102', 'Microeconomics', 3, { dept: 'BA', programs: [['BBA', 1, 1]] });
    unit('BBA2101', 'Marketing Management', 3, { dept: 'BA', programs: [['BBA', 2, 1]] });
    unit('BBA2102', 'Human Resource Management', 3, { dept: 'BA', programs: [['BBA', 2, 1]] });

    // --- Load allocation: cross-cutting units first (combined classes), then the rest ---
    const admin = q.get("SELECT id FROM users WHERE email = 'admin@demo.edu'").id;
    const allocate = (code, lecturerName, classes) => {
      const aid = insert('allocations', {
        university_id: uni, term_id: term1, course_unit_id: cuId[code], lecturer_id: lecturer[lecturerName],
        hours_per_week: q.get('SELECT hours_per_week AS h FROM course_units WHERE id = ?', cuId[code]).h, created_by: admin,
      });
      for (const c of classes) q.run('INSERT INTO allocation_classes (allocation_id, class_id) VALUES (?, ?)', aid, classId[c]);
    };
    allocate('CCS1101', 'Joan Akello', ['BSCS1', 'BIT1', 'BCOM1', 'BBA1']);
    allocate('CCE1102', 'Patrick Mwesigwa', ['BIT1', 'BCOM1', 'BBA1']);
    allocate('CRM2101', 'Florence Namutebi', ['BSCS2', 'BIT2', 'BCOM2', 'BBA2']);
    allocate('CEP2102', 'Grace Namara', ['BSCS2', 'BIT2']);
    allocate('CSC1101', 'Brian Kato', ['BSCS1']);
    allocate('CSC1102', 'Ivan Ssemwogerere', ['BSCS1']);
    allocate('CSC1103', 'Esther Atim', ['BSCS1']);
    allocate('CSC2101', 'Peter Okello', ['BSCS2']);
    allocate('CSC2102', 'Brian Kato', ['BSCS2']);
    allocate('CSC2103', 'Ivan Ssemwogerere', ['BSCS2']);
    allocate('BIT1101', 'Joel Byaruhanga', ['BIT1']);
    allocate('BIT1102', 'Linda Auma', ['BIT1']);
    allocate('BIT2101', 'Sarah Achieng', ['BIT2']);
    allocate('BIT2102', 'Linda Auma', ['BIT2']);
    allocate('ACC1101', 'Henry Opio', ['BCOM1']);
    allocate('ACC1102', 'Diana Kemigisha', ['BCOM1']);
    allocate('ACC2101', 'Ruth Nakato', ['BCOM2']);
    allocate('BBA1101', 'Agnes Nabirye', ['BBA1']);
    allocate('BBA1102', 'Samuel Wekesa', ['BBA1']);
    allocate('BBA2101', 'James Tumusiime', ['BBA2']);
    // ACC2102 and BBA2102 are left unallocated so the allocation board shows outstanding work.

    const gen = generateTimetable(uni, term1);
    log(`Timetable: ${gen.placed} sessions placed, ${gen.unplaced.length} unplaced`);

    // --- Attendance history for the past three weeks ---
    const sessions = q.all('SELECT s.*, a.lecturer_id FROM timetable_sessions s JOIN allocations a ON a.id = s.allocation_id WHERE s.term_id = ?', term1);
    const now = zonedNow(TZ);
    let registers = 0;
    for (let back = 21; back >= 0; back--) {
      const date = addDays(now.date, -back);
      const dow = dowOf(date);
      for (const s of sessions.filter((x) => x.day_of_week === dow)) {
        if (back === 0 && toMinutes(s.end_time) > now.minutes) continue;
        for (const { class_id } of q.all('SELECT class_id FROM allocation_classes WHERE allocation_id = ?', s.allocation_id)) {
          const repId = q.get('SELECT class_rep_id AS r FROM classes WHERE id = ?', class_id).r;
          const status = back <= 3 ? 'submitted' : rand() < 0.06 ? 'rejected' : 'approved';
          const rid = insert('attendance_registers', {
            university_id: uni, session_id: s.id, class_id, lecture_date: date, status, submitted_by: repId,
            topic: 'Weekly lecture', submitted_at: `${date} ${s.end_time}:00`,
            reviewed_by: status === 'submitted' ? null : s.lecturer_id,
            reviewed_at: status === 'submitted' ? null : `${date} ${s.end_time}:00`,
            review_note: status === 'rejected' ? 'Headcount does not match - please re-check and resubmit.' : null,
          });
          const students = q.all("SELECT id FROM users WHERE class_id = ? AND role = 'student' ORDER BY id", class_id);
          students.forEach((st, i) => {
            // The last student in each class attends rarely, to populate the "at risk" report.
            const p = i === students.length - 1 ? 0.45 : 0.9;
            q.run('INSERT INTO attendance_records (register_id, student_id, present) VALUES (?, ?, ?)', rid, st.id, rand() < p ? 1 : 0);
          });
          registers++;
        }
      }
    }
    log(`Attendance: ${registers} registers`);

    const pending = q.all(
      `SELECT a.lecturer_id, COUNT(*) AS n FROM attendance_registers r JOIN timetable_sessions s ON s.id = r.session_id
         JOIN allocations a ON a.id = s.allocation_id WHERE r.status = 'submitted' GROUP BY a.lecturer_id`,
    );
    for (const p of pending) {
      insert('notifications', { user_id: p.lecturer_id, title: 'Attendance registers awaiting approval', body: `${p.n} ${p.n === 1 ? 'register' : 'registers'} submitted by class representatives need your approval.`, type: 'attendance', link: '/attendance' });
    }

    seedPay({ uni, today: now.date, hrId, deans: structure.map((f) => lecturer[f.dean[1]]), lecturer });
    seedVotes(uni);
    log('Part-time pay: rates, votes and sample claims');
    seedOps({ uni, today: now.date, historyEnd: now.date });
    log('Calendar, changes, leave, exams, coursework and check-ins');
    return { university_id: uni, term_id: term1 };
  });
}

/**
 * Adds features introduced after a hosted demo was first seeded (part-time pay, then teaching
 * operations and exams) to the existing Demo University, leaving every other tenant untouched.
 * Each step runs once, so this is safe on every start.
 */
export function upgradeDemo({ quiet = false } = {}) {
  const uni = q.get("SELECT id FROM universities WHERE slug = 'demo-university'");
  if (!uni) return false;
  let changed = false;
  // Date the samples from the demo's own attendance history.
  const last = q.get('SELECT MAX(lecture_date) AS d FROM attendance_registers WHERE university_id = ?', uni.id)?.d;
  if (!q.get("SELECT 1 FROM users WHERE email = 'hr@demo.edu'")) {
    tx(() => {
      const hrId = insert('users', {
        university_id: uni.id, name: 'Harriet Nansubuga', email: 'hr@demo.edu', role: 'hr', title: 'Ms.', identifier: 'HR-001',
        password_hash: hashPassword(DEMO_PASSWORD),
      });
      if (!q.get('SELECT 1 FROM pay_rates WHERE university_id = ?', uni.id)) {
        const lecturer = Object.fromEntries(
          q.all("SELECT id, name FROM users WHERE university_id = ? AND role IN ('lecturer', 'hod', 'dean')", uni.id).map((u) => [u.name, u.id]),
        );
        const deans = q.all('SELECT dean_id FROM faculties WHERE university_id = ? ORDER BY id', uni.id).map((f) => f.dean_id);
        if (['Esther Atim', 'Linda Auma', 'Joan Akello'].every((n) => lecturer[n])) {
          seedPay({ uni: uni.id, today: last ? addDays(last, 1) : zonedNow(TZ).date, hrId, deans, lecturer });
        }
      }
    });
    changed = true;
    if (!quiet) console.log('Demo upgraded with part-time pay');
  }
  if (q.get("SELECT 1 FROM pay_rates WHERE university_id = ? AND kind = 'teaching'", uni.id) && !q.get('SELECT 1 FROM pay_rates WHERE university_id = ? AND program_level IS NOT NULL', uni.id)) {
    tx(() => seedLevelRates(uni.id));
    changed = true;
    if (!quiet) console.log('Demo upgraded with teaching rates by programme level');
  }
  if (q.get('SELECT 1 FROM pay_claims WHERE university_id = ?', uni.id) && !q.get('SELECT 1 FROM pay_votes WHERE university_id = ?', uni.id)) {
    tx(() => seedVotes(uni.id));
    changed = true;
    if (!quiet) console.log('Demo upgraded with votes for part-time pay');
  }
  if (!q.get('SELECT 1 FROM calendar_events WHERE university_id = ?', uni.id)) {
    tx(() => seedOps({ uni: uni.id, today: zonedNow(TZ).date, historyEnd: last || zonedNow(TZ).date }));
    changed = true;
    if (!quiet) console.log('Demo upgraded with calendar, leave, exams and check-ins');
  }
  return changed;
}

/** One part-time pay vote per faculty; claims the Dean has signed off are charged to it. */
function seedVotes(uni) {
  const year = zonedNow(TZ).date.slice(0, 4);
  const fy = Number(zonedNow(TZ).date.slice(5, 7)) >= 7 ? `${year}/${Number(year) + 1}` : `${Number(year) - 1}/${year}`;
  for (const f of q.all('SELECT id, code, name, dean_id FROM faculties WHERE university_id = ?', uni)) {
    const id = insert('pay_votes', {
      university_id: uni, faculty_id: f.id, code: `${f.code}-PT-221001`, name: `Part-time lecturers, ${f.name}`,
      amount: f.code === 'FST' ? 6000000 : 4000000, financial_year: fy, created_by: f.dean_id,
    });
    q.run("UPDATE pay_claims SET vote_id = ? WHERE faculty_id = ? AND vote_id IS NULL AND status IN ('dean_approved', 'hr_verified', 'paid')", id, f.id);
  }
}

/** Teaching paid differently by programme level, next to the general rate (used for Bachelor's). */
function seedLevelRates(uni) {
  for (const f of q.all("SELECT f.id, f.code, f.dean_id FROM faculties f WHERE f.university_id = ? AND EXISTS (SELECT 1 FROM pay_rates r WHERE r.faculty_id = f.id AND r.kind = 'teaching')", uni)) {
    const base = f.code === 'FST' ? 50000 : 45000;
    for (const [level, factor] of [['Short course', 0.6], ['Diploma', 0.7], ['Masters', 1.6], ['PhD', 2]]) {
      insert('pay_rates', {
        university_id: uni, faculty_id: f.id, kind: 'teaching', name: `Teaching: ${level}`, unit: 'hour', amount: Math.round((base * factor) / 1000) * 1000,
        program_level: level, description: `Per contact hour for ${level} programmes`, updated_by: f.dean_id,
      });
    }
  }
}

const periodTitle = (from, to) => {
  const f = (d, opts) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts });
  return `${f(from, { day: 'numeric', month: 'short' })} - ${f(to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
};

/** Faculty rates, three part-time lecturers and claims at every stage of the approval chain. */
function seedPay({ uni, today, hrId, deans, lecturer }) {
  const faculties = q.all('SELECT id, code, dean_id FROM faculties WHERE university_id = ? ORDER BY id', uni);
  for (const f of faculties) {
    for (const [kind, name, unit, amount, description] of [
      ['teaching', 'Teaching', 'hour', f.code === 'FST' ? 50000 : 45000, 'Per contact hour, from attendance-approved lectures'],
      ['task', 'Marking', 'script', 2000, 'Coursework and examination scripts'],
      ['task', 'Internship supervision', 'student', 30000, 'Field visit and report, per student'],
      ['task', 'Project supervision', 'student', 40000, 'Final-year project, per student'],
      ['task', 'Invigilation', 'hour', 15000, null],
    ]) insert('pay_rates', { university_id: uni, faculty_id: f.id, kind, name, unit, amount, description, updated_by: f.dean_id });
  }
  seedLevelRates(uni);
  for (const name of ['Esther Atim', 'Linda Auma', 'Joan Akello']) q.run("UPDATE users SET employment_type = 'part_time' WHERE id = ?", lecturer[name]);

  const ev = (claimId, actorId, action, stage, note, when) =>
    insert('pay_claim_events', { claim_id: claimId, actor_id: actorId, action, stage, note, created_at: when });
  const claim = (name, from, to, status, tasks = []) => {
    const u = q.get('SELECT * FROM users WHERE id = ?', lecturer[name]);
    const id = insert('pay_claims', {
      university_id: uni, lecturer_id: u.id, department_id: u.department_id, faculty_id: u.faculty_id,
      title: periodTitle(from, to), period_start: from, period_end: to, currency: 'UGX',
    });
    refreshTeachingLines(q.get('SELECT * FROM pay_claims WHERE id = ?', id));
    for (const [rateName, quantity, description] of tasks) {
      const r = q.get('SELECT * FROM pay_rates WHERE faculty_id = ? AND name = ?', u.faculty_id, rateName);
      insert('pay_claim_lines', {
        claim_id: id, kind: 'task', rate_id: r.id, rate_name: r.name, unit: r.unit, unit_price: r.amount,
        quantity, amount: r.amount * quantity, work_date: to, description,
      });
    }
    recalcTotal(id);
    const d = q.get('SELECT d.hod_id, f.dean_id FROM departments d JOIN faculties f ON f.id = d.faculty_id WHERE d.id = ?', u.department_id);
    // Stored in UTC like datetime('now'): 07:00 UTC is 10:00 in Kampala.
    const at = (days) => `${addDays(to, days)} 07:00:00`;
    const reached = ['submitted', 'hod_approved', 'dean_approved', 'hr_verified', 'paid'].indexOf(status);
    ev(id, u.id, 'created', null, null, at(0));
    if (reached >= 0) ev(id, u.id, 'submitted', null, null, at(1));
    if (reached >= 1) ev(id, d.hod_id, 'approved', 'HoD', 'Lectures match the timetable and registers.', at(1));
    if (reached >= 2) ev(id, d.dean_id, 'approved', 'Dean', null, at(2));
    if (reached >= 3) ev(id, hrId, 'verified', 'HR', 'Within the approved part-time budget.', at(2));
    if (reached >= 4) ev(id, hrId, 'paid', 'Payment', 'Payment ref. PV-2026-0142', at(3));
    q.run(
      'UPDATE pay_claims SET status = ?, submitted_at = ?, payment_reference = ?, paid_at = ?, updated_at = ? WHERE id = ?',
      status, reached >= 0 ? at(1) : null, status === 'paid' ? 'PV-2026-0142' : null, status === 'paid' ? at(3) : null, at(Math.max(0, reached)), id,
    );
    return id;
  };
  claim('Esther Atim', addDays(today, -21), addDays(today, -15), 'paid', [['Marking', 45, 'CSC1103 coursework 1 scripts']]);
  const toHod = claim('Esther Atim', addDays(today, -14), addDays(today, -8), 'submitted', [['Marking', 52, 'CSC1103 test 1 scripts']]);
  const toDean = claim('Linda Auma', addDays(today, -21), addDays(today, -8), 'hod_approved', [['Internship supervision', 3, 'BIT Year 2 industrial training visits']]);
  const toHr = claim('Joan Akello', addDays(today, -21), addDays(today, -8), 'dean_approved', [['Marking', 120, 'CCS1101 coursework scripts (four classes)']]);
  const hod = q.get("SELECT id FROM users WHERE email = 'hod.cs@demo.edu'").id;
  insert('notifications', { user_id: hod, title: 'Part-time claim to approve', body: 'Ms. Esther Atim has submitted a teaching claim.', type: 'claim', link: `/claims/${toHod}` });
  insert('notifications', { user_id: deans[0], title: 'Part-time claim to approve', body: 'Ms. Linda Auma: approved by the HoD.', type: 'claim', link: `/claims/${toDean}` });
  insert('notifications', { user_id: hrId, title: 'Claim to check', body: 'Ms. Joan Akello: approved by the Dean.', type: 'claim', link: `/claims/${toHr}` });
}

/** Academic calendar, lecture changes, leave, exams, coursework, QR check-ins and budgets. */
function seedOps({ uni, today, historyEnd }) {
  const term = q.get('SELECT * FROM academic_terms WHERE university_id = ? AND is_current = 1', uni);
  if (!term) return;
  const userId = (email) => q.get('SELECT id FROM users WHERE email = ?', email)?.id;
  const byName = (name) => q.get('SELECT * FROM users WHERE university_id = ? AND name = ?', uni, name);

  // Coursework totals per programme (set by HoDs): BIT marks coursework out of 30, the rest out of 40.
  q.run("UPDATE programs SET coursework_max = 30 WHERE university_id = ? AND code = 'BIT'", uni);
  q.run("UPDATE pay_rates SET code = 'invigilation' WHERE university_id = ? AND name = 'Invigilation'", uni);

  // Academic calendar: reading week, exam weeks and public holidays still to come this term.
  const examStart = addDays(term.end_date, -11);
  const event = (title, kind, from, to, noTeaching = 1) => insert('calendar_events', { university_id: uni, title, kind, start_date: from, end_date: to, no_teaching: noTeaching });
  event('Reading week', 'reading', addDays(examStart, -7), addDays(examStart, -3));
  event('End-of-semester examinations', 'exams', examStart, term.end_date);
  for (let y = Number(today.slice(0, 4)); y <= Number(term.end_date.slice(0, 4)); y++) {
    for (const [title, md] of [["New Year's Day", '01-01'], ['Labour Day', '05-01'], ["Heroes' Day", '06-09'], ['Independence Day', '10-09'], ['Christmas Day', '12-25'], ['Boxing Day', '12-26']]) {
      const d = `${y}-${md}`;
      if (d > today && d >= term.start_date && d <= term.end_date) event(title, 'holiday', d, d);
    }
  }

  // Next week: one lecture cancelled and one moved (with students notified).
  const nextWeek = occurrences(uni, { from: addDays(today, 7), to: addDays(today, 13) });
  const brian = byName('Brian Kato');
  const cancel = nextWeek.find((o) => o.course_code === 'CSC1101');
  if (cancel) {
    insert('session_changes', { university_id: uni, session_id: cancel.session_id, original_date: cancel.date, action: 'cancel', reason: 'Lecturer presenting at the national ICT conference', created_by: brian?.id });
  }
  const move = nextWeek.find((o) => o.course_code === 'CSC1102');
  if (move) {
    const slot = suggestSlots(uni, move, { from: addDays(move.date, 1) })[0];
    if (slot) {
      insert('session_changes', {
        university_id: uni, session_id: move.session_id, original_date: move.date, action: 'move', new_date: slot.date, new_start: slot.start_time,
        new_end: slot.end_time, new_room_id: slot.room_id, reason: 'The usual room is needed for a guest lecture', created_by: move.lecturer_id,
      });
    }
  }

  // Leave: one waiting for the CS HoD to check, one checked and waiting for the FST Dean.
  const ivan = byName('Ivan Ssemwogerere');
  const joel = byName('Joel Byaruhanga');
  const hodIt = userId('hod.it@demo.edu');
  if (ivan) {
    const id = insert('leave_requests', { university_id: uni, lecturer_id: ivan.id, department_id: ivan.department_id, faculty_id: ivan.faculty_id, start_date: addDays(today, 14), end_date: addDays(today, 20), reason: 'Attending a research workshop in Nairobi', status: 'submitted' });
    insert('notifications', { user_id: userId('hod.cs@demo.edu'), title: 'Leave request: Ivan Ssemwogerere', body: 'Research workshop; lectures need cover.', type: 'leave', link: `/leave/${id}` });
  }
  if (joel) {
    const id = insert('leave_requests', {
      university_id: uni, lecturer_id: joel.id, department_id: joel.department_id, faculty_id: joel.faculty_id, start_date: addDays(today, 9), end_date: addDays(today, 10),
      reason: 'Family medical appointment', status: 'hod_checked', hod_by: hodIt, hod_at: `${today} 07:30:00`, hod_note: 'Cover arranged within the department.',
    });
    insert('notifications', { user_id: userId('dean.fst@demo.edu'), title: 'Leave to approve: Joel Byaruhanga', body: 'Checked by the HoD.', type: 'leave', link: `/leave/${id}` });
  }

  // Exam timetable for the exam weeks.
  generateExams(uni, term.id, { startDate: examStart, endDate: term.end_date });

  // Coursework marks out of 100, converted to each programme's total; a few missing or below half.
  const units = q.all('SELECT DISTINCT course_unit_id FROM allocations WHERE term_id = ? AND university_id = ?', term.id, uni);
  for (const { course_unit_id } of units) {
    const classes = q.all('SELECT DISTINCT ac.class_id FROM allocations a JOIN allocation_classes ac ON ac.allocation_id = a.id WHERE a.term_id = ? AND a.course_unit_id = ?', term.id, course_unit_id).map((r) => r.class_id);
    if (!classes.length) continue;
    const students = q.all(`SELECT u.id, p.coursework_max FROM users u JOIN classes c ON c.id = u.class_id JOIN programs p ON p.id = c.program_id WHERE u.role = 'student' AND u.class_id IN (${classes.map(() => '?').join(',')})`, ...classes);
    students.forEach((st, i) => {
      if (i % 9 === 8) return;
      const raw = i % 7 === 6 ? 30 + Math.round(rand() * 15) : 52 + Math.round(rand() * 40);
      insert('coursework_marks', { university_id: uni, term_id: term.id, course_unit_id, student_id: st.id, raw_mark: raw, out_of: 100, mark: Math.round((raw / 100) * st.coursework_max * 100) / 100, max_mark: st.coursework_max });
    });
  }

  // The last week of lectures was recorded by QR check-in: every student present scanned their own phone.
  const recent = q.all(
    `SELECT r.session_id, r.lecture_date, s.start_time, s.end_time, a.lecturer_id FROM attendance_registers r
       JOIN timetable_sessions s ON s.id = r.session_id JOIN allocations a ON a.id = s.allocation_id
      WHERE r.university_id = ? AND r.status = 'approved' AND r.lecture_date BETWEEN ? AND ?
      GROUP BY r.session_id, r.lecture_date`,
    uni,
    addDays(historyEnd, -6),
    historyEnd,
  );
  for (const o of recent) {
    const csId = insert('checkin_sessions', {
      university_id: uni, session_id: o.session_id, lecture_date: o.lecture_date, secret: crypto.randomBytes(16).toString('hex'),
      started_by: o.lecturer_id, started_at: `${o.lecture_date} ${o.start_time}:00`, closed_at: `${o.lecture_date} ${o.end_time}:00`, closed_by: o.lecturer_id,
    });
    for (const reg of q.all('SELECT id, class_id FROM attendance_registers WHERE session_id = ? AND lecture_date = ?', o.session_id, o.lecture_date)) {
      const present = q.all('SELECT student_id FROM attendance_records WHERE register_id = ? AND present = 1', reg.id).map((r) => r.student_id);
      for (const sid of present) {
        q.run('INSERT OR IGNORE INTO student_devices (user_id, device_id, registered_at) VALUES (?, ?, ?)', sid, `demo-phone-${sid}`, `${o.lecture_date} 07:00:00`);
        insert('checkins', { checkin_session_id: csId, student_id: sid, class_id: reg.class_id, method: 'qr', device_id: `demo-phone-${sid}`, scanned_at: `${o.lecture_date} ${o.start_time}:05` });
      }
      q.run("UPDATE attendance_records SET method = CASE WHEN present = 1 THEN 'qr' END WHERE register_id = ?", reg.id);
      q.run("UPDATE attendance_registers SET source = 'qr', self_checkins = ? WHERE id = ?", present.length, reg.id);
    }
  }
  q.run(
    `UPDATE pay_claim_lines SET self_checkins = (SELECT COUNT(*) FROM checkins ch JOIN checkin_sessions cs ON cs.id = ch.checkin_session_id
        WHERE cs.session_id = pay_claim_lines.session_id AND cs.lecture_date = pay_claim_lines.work_date AND ch.method = 'qr')
      WHERE kind = 'teaching' AND claim_id IN (SELECT id FROM pay_claims WHERE university_id = ?)`,
    uni,
  );

  // Part-time budgets for this term.
  for (const d of q.all('SELECT id, code FROM departments WHERE university_id = ?', uni)) {
    insert('pay_budgets', { university_id: uni, department_id: d.id, term_id: term.id, amount: d.code === 'CS' ? 2000000 : 1500000, set_by: q.get('SELECT dean_id FROM faculties f JOIN departments x ON x.faculty_id = f.id WHERE x.id = ?', d.id)?.dean_id });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedDemo();
  console.log(`Demo data ready. Sign in with admin@demo.edu / ${DEMO_PASSWORD} (see README for all demo accounts).`);
}
