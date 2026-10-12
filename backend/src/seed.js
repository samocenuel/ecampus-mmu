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
import { generateTimetable } from './services/timetable.js';
import { addDays, dowOf, toMinutes, zonedNow } from './util.js';

export const DEMO_PASSWORD = 'Passw0rd!';
const TZ = 'Africa/Kampala';

// Small deterministic PRNG so the demo data is the same on every run.
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

function wipe() {
  for (const t of [
    'notifications', 'notification_prefs', 'attendance_records', 'attendance_registers', 'timetable_sessions',
    'allocation_classes', 'allocations', 'program_course_units', 'course_units', 'classes', 'programs',
    'departments', 'faculties', 'rooms', 'academic_terms', 'users', 'universities',
  ]) db.exec(`DELETE FROM ${t}`);
  db.exec("DELETE FROM sqlite_sequence");
}

const FIRST = ['Aisha', 'Brian', 'Catherine', 'Daniel', 'Esther', 'Francis', 'Gloria', 'Henry', 'Irene', 'Joseph', 'Kevin', 'Lydia', 'Moses', 'Naomi', 'Oscar', 'Patience', 'Ronald', 'Sharon', 'Timothy', 'Vivian', 'Winnie', 'Allan', 'Brenda', 'Collins'];
const LAST = ['Akello', 'Byamukama', 'Chebet', 'Draku', 'Ekwaru', 'Friday', 'Kabugo', 'Lubega', 'Mirembe', 'Nakimuli', 'Ochieng', 'Pande', 'Rukundo', 'Ssali', 'Tumwine', 'Wanyama', 'Zziwa', 'Asiimwe', 'Barungi', 'Kyomuhendo'];

export function seedDemo({ quiet = false } = {}) {
  const log = (...a) => !quiet && console.log(...a);
  const hash = hashPassword(DEMO_PASSWORD);

  return tx(() => {
    wipe();

    insert('users', { university_id: null, name: 'Platform Owner', email: 'owner@lms-platform.example', password_hash: hash, role: 'super_admin' });

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
    const classId = {};
    let studentNo = 0;
    for (const [code, [name, d]] of Object.entries(programs)) {
      programId[code] = insert('programs', { university_id: uni, department_id: dept[d], name, code, level: 'Bachelor', duration_years: 3 });
      for (const y of [1, 2]) {
        const cid = insert('classes', {
          university_id: uni, program_id: programId[code], name: `${code} Year ${y}`, year_of_study: y,
          academic_year: academicYear, expected_size: y === 1 ? 60 : 45,
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
        q.run('INSERT INTO program_course_units (program_id, course_unit_id, year_of_study, semester) VALUES (?, ?, ?, ?)', programId[p], cuId[code], y, s);
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
      insert('notifications', { user_id: p.lecturer_id, title: 'Attendance registers awaiting approval', body: `${p.n} register(s) submitted by class representatives need your approval.`, type: 'attendance', link: '/attendance' });
    }
    return { university_id: uni, term_id: term1 };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedDemo();
  console.log(`Demo data ready. Sign in with admin@demo.edu / ${DEMO_PASSWORD} (see README for all demo accounts).`);
}
