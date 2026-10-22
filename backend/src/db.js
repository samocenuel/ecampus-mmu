import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

if (config.dbFile !== ':memory:') fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

export const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS universities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  short_name TEXT,
  slug TEXT UNIQUE,
  address TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  logo_path TEXT,
  primary_color TEXT NOT NULL DEFAULT '#1E5AA8',
  timezone TEXT NOT NULL DEFAULT 'Africa/Kampala',
  teaching_days TEXT NOT NULL DEFAULT '1,2,3,4,5',
  day_start TEXT NOT NULL DEFAULT '08:00',
  day_end TEXT NOT NULL DEFAULT '18:00',
  lunch_start TEXT DEFAULT '13:00',
  lunch_end TEXT DEFAULT '14:00',
  currency TEXT NOT NULL DEFAULT 'UGX',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER REFERENCES universities(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super_admin','admin','dean','hod','lecturer','student','hr')),
  employment_type TEXT NOT NULL DEFAULT 'full_time' CHECK (employment_type IN ('full_time','part_time')),
  title TEXT,
  phone TEXT,
  identifier TEXT,
  faculty_id INTEGER REFERENCES faculties(id) ON DELETE SET NULL,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_uni_role ON users(university_id, role);
CREATE INDEX IF NOT EXISTS idx_users_class ON users(class_id);

CREATE TABLE IF NOT EXISTS faculties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT,
  dean_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  faculty_id INTEGER NOT NULL REFERENCES faculties(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT,
  hod_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS programs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'Bachelor',
  duration_years INTEGER NOT NULL DEFAULT 3,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (university_id, code)
);

CREATE TABLE IF NOT EXISTS course_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  credit_units INTEGER NOT NULL DEFAULT 3,
  hours_per_week INTEGER NOT NULL DEFAULT 3,
  description TEXT,
  is_cross_cutting INTEGER NOT NULL DEFAULT 0,
  preferred_room_type TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (university_id, code)
);

CREATE TABLE IF NOT EXISTS program_course_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  course_unit_id INTEGER NOT NULL REFERENCES course_units(id) ON DELETE CASCADE,
  year_of_study INTEGER NOT NULL DEFAULT 1,
  semester INTEGER NOT NULL DEFAULT 1,
  UNIQUE (program_id, course_unit_id)
);
CREATE INDEX IF NOT EXISTS idx_pcu_cu ON program_course_units(course_unit_id);

CREATE TABLE IF NOT EXISTS academic_terms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  academic_year TEXT,
  semester INTEGER NOT NULL DEFAULT 1,
  start_date TEXT,
  end_date TEXT,
  is_current INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  year_of_study INTEGER NOT NULL DEFAULT 1,
  academic_year TEXT,
  expected_size INTEGER NOT NULL DEFAULT 0,
  class_rep_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  building TEXT,
  capacity INTEGER NOT NULL DEFAULT 50,
  room_type TEXT NOT NULL DEFAULT 'lecture',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  term_id INTEGER NOT NULL REFERENCES academic_terms(id) ON DELETE CASCADE,
  course_unit_id INTEGER NOT NULL REFERENCES course_units(id) ON DELETE CASCADE,
  lecturer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hours_per_week INTEGER NOT NULL DEFAULT 3,
  notes TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alloc_term ON allocations(term_id);

CREATE TABLE IF NOT EXISTS allocation_classes (
  allocation_id INTEGER NOT NULL REFERENCES allocations(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  PRIMARY KEY (allocation_id, class_id)
);
CREATE INDEX IF NOT EXISTS idx_alloc_classes_class ON allocation_classes(class_id);

CREATE TABLE IF NOT EXISTS timetable_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  term_id INTEGER NOT NULL REFERENCES academic_terms(id) ON DELETE CASCADE,
  allocation_id INTEGER NOT NULL REFERENCES allocations(id) ON DELETE CASCADE,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  generated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_term_day ON timetable_sessions(term_id, day_of_week);

CREATE TABLE IF NOT EXISTS attendance_registers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES timetable_sessions(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  lecture_date TEXT NOT NULL,
  topic TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected')),
  submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  review_note TEXT,
  UNIQUE (session_id, class_id, lecture_date)
);

CREATE TABLE IF NOT EXISTS attendance_records (
  register_id INTEGER NOT NULL REFERENCES attendance_registers(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  present INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (register_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_att_records_student ON attendance_records(student_id);

CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  minutes_before INTEGER NOT NULL DEFAULT 15
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT,
  type TEXT NOT NULL DEFAULT 'info',
  link TEXT,
  dedupe_key TEXT UNIQUE,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);
`;

// Part-time pay: the Dean sets the faculty's rates; part-time lecturers claim teaching hours (from
// attendance-approved lectures) and tasks; HoD -> Dean -> HR (Directorate) approve, then HR records payment.
const PAY_SCHEMA = `
CREATE TABLE IF NOT EXISTS pay_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  faculty_id INTEGER NOT NULL REFERENCES faculties(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('teaching','task')),
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'hour',
  amount REAL NOT NULL CHECK (amount >= 0),
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pay_rates_faculty ON pay_rates(faculty_id);

CREATE TABLE IF NOT EXISTS pay_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  lecturer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  faculty_id INTEGER REFERENCES faculties(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','hod_approved','dean_approved','hr_verified','paid','rejected')),
  returned_from TEXT,
  total REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'UGX',
  payment_reference TEXT,
  submitted_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pay_claims_status ON pay_claims(university_id, status);
CREATE INDEX IF NOT EXISTS idx_pay_claims_lecturer ON pay_claims(lecturer_id);

CREATE TABLE IF NOT EXISTS pay_claim_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id INTEGER NOT NULL REFERENCES pay_claims(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('teaching','task')),
  rate_id INTEGER REFERENCES pay_rates(id) ON DELETE SET NULL,
  rate_name TEXT NOT NULL,
  unit TEXT NOT NULL,
  unit_price REAL NOT NULL DEFAULT 0,
  quantity REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  work_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  session_id INTEGER REFERENCES timetable_sessions(id) ON DELETE SET NULL,
  course_unit_code TEXT,
  course_unit_name TEXT,
  class_names TEXT,
  students_present INTEGER,
  students_total INTEGER,
  description TEXT
);
CREATE INDEX IF NOT EXISTS idx_pay_lines_claim ON pay_claim_lines(claim_id);
-- A lecture (session on a date) can be claimed once.
CREATE UNIQUE INDEX IF NOT EXISTS ux_pay_lines_lecture ON pay_claim_lines(session_id, work_date) WHERE kind = 'teaching';

CREATE TABLE IF NOT EXISTS pay_claim_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id INTEGER NOT NULL REFERENCES pay_claims(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  stage TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pay_events_claim ON pay_claim_events(claim_id);
`;

// Teaching operations and exams: QR check-in, attendance corrections, lecture changes, the
// academic calendar, leave with cover lecturers, exam timetables, coursework marks and budgets.
const OPS_SCHEMA = `
CREATE TABLE IF NOT EXISTS student_devices (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL UNIQUE,
  registered_at TEXT NOT NULL DEFAULT (datetime('now')),
  changed_in_term_id INTEGER REFERENCES academic_terms(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS checkin_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES timetable_sessions(id) ON DELETE CASCADE,
  lecture_date TEXT NOT NULL,
  secret TEXT NOT NULL,
  started_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (session_id, lecture_date)
);

CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checkin_session_id INTEGER NOT NULL REFERENCES checkin_sessions(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('qr','manual')),
  device_id TEXT,
  reason TEXT,
  marked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  latitude REAL,
  longitude REAL,
  scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (checkin_session_id, student_id)
);
-- One phone checks in one student per lecture.
CREATE UNIQUE INDEX IF NOT EXISTS ux_checkins_device ON checkins(checkin_session_id, device_id) WHERE method = 'qr';

CREATE TABLE IF NOT EXISTS checkin_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  checkin_session_id INTEGER REFERENCES checkin_sessions(id) ON DELETE CASCADE,
  student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT,
  kind TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_checkin_flags_session ON checkin_flags(checkin_session_id);

CREATE TABLE IF NOT EXISTS attendance_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  register_id INTEGER NOT NULL REFERENCES attendance_registers(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected')),
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  review_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (register_id, student_id)
);

CREATE TABLE IF NOT EXISTS session_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES timetable_sessions(id) ON DELETE CASCADE,
  original_date TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('cancel','move')),
  new_date TEXT,
  new_start TEXT,
  new_end TEXT,
  new_room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  reason TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (session_id, original_date)
);
CREATE INDEX IF NOT EXISTS idx_session_changes_new_date ON session_changes(university_id, new_date);

CREATE TABLE IF NOT EXISTS calendar_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'holiday' CHECK (kind IN ('holiday','recess','reading','exams','event')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  no_teaching INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  lecturer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  faculty_id INTEGER REFERENCES faculties(id) ON DELETE SET NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','hod_checked','approved','rejected','cancelled')),
  hod_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  hod_at TEXT,
  hod_note TEXT,
  dean_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  dean_at TEXT,
  dean_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leave_covers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  leave_id INTEGER NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES timetable_sessions(id) ON DELETE CASCADE,
  lecture_date TEXT NOT NULL,
  substitute_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (session_id, lecture_date)
);

CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  term_id INTEGER NOT NULL REFERENCES academic_terms(id) ON DELETE CASCADE,
  course_unit_id INTEGER NOT NULL REFERENCES course_units(id) ON DELETE CASCADE,
  exam_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  notes TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (term_id, course_unit_id)
);
CREATE INDEX IF NOT EXISTS idx_exams_date ON exams(university_id, exam_date);

CREATE TABLE IF NOT EXISTS exam_rooms (
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seats INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (exam_id, room_id)
);

CREATE TABLE IF NOT EXISTS exam_invigilators (
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  PRIMARY KEY (exam_id, user_id)
);

CREATE TABLE IF NOT EXISTS coursework_marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  term_id INTEGER NOT NULL REFERENCES academic_terms(id) ON DELETE CASCADE,
  course_unit_id INTEGER NOT NULL REFERENCES course_units(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  raw_mark REAL NOT NULL,
  out_of REAL NOT NULL,
  mark REAL NOT NULL,
  max_mark REAL NOT NULL,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (term_id, course_unit_id, student_id)
);

CREATE TABLE IF NOT EXISTS exam_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (exam_id, student_id)
);

CREATE TABLE IF NOT EXISTS pay_budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  term_id INTEGER NOT NULL REFERENCES academic_terms(id) ON DELETE CASCADE,
  amount REAL NOT NULL CHECK (amount >= 0),
  set_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (department_id, term_id)
);
`;

/** Columns added after a table was first created (SQLite only appends columns). */
const ADDED_COLUMNS = {
  universities: {
    checkin_latitude: 'REAL',
    checkin_longitude: 'REAL',
    checkin_radius_m: 'INTEGER NOT NULL DEFAULT 0',
    manual_mark_limit: 'INTEGER NOT NULL DEFAULT 3',
    correction_hours: 'INTEGER NOT NULL DEFAULT 48',
    exam_min_attendance: 'INTEGER NOT NULL DEFAULT 75',
    coursework_min_percent: 'INTEGER NOT NULL DEFAULT 50',
    claims_require_checkin: 'INTEGER NOT NULL DEFAULT 0',
  },
  users: { calendar_token: 'TEXT', must_change_password: 'INTEGER NOT NULL DEFAULT 0', photo_path: 'TEXT' },
  programs: { coursework_max: 'REAL NOT NULL DEFAULT 40' },
  attendance_registers: { source: "TEXT NOT NULL DEFAULT 'rep'", self_checkins: 'INTEGER NOT NULL DEFAULT 0' },
  attendance_records: { method: 'TEXT' },
  pay_rates: { code: 'TEXT' },
  pay_claim_lines: { exam_id: 'INTEGER REFERENCES exams(id) ON DELETE SET NULL', self_checkins: 'INTEGER' },
};

function addColumns() {
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, type] of Object.entries(columns)) {
      if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_users_calendar_token ON users(calendar_token) WHERE calendar_token IS NOT NULL');
}

/** Brings databases created by earlier versions up to the current schema. */
function migrate() {
  const usersSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()?.sql || '';
  if (!usersSql.includes("'hr'")) {
    // SQLite can't change a CHECK constraint in place, so rebuild the users table (ids and references are kept).
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          university_id INTEGER REFERENCES universities(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE COLLATE NOCASE,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('super_admin','admin','dean','hod','lecturer','student','hr')),
          employment_type TEXT NOT NULL DEFAULT 'full_time' CHECK (employment_type IN ('full_time','part_time')),
          title TEXT,
          phone TEXT,
          identifier TEXT,
          faculty_id INTEGER REFERENCES faculties(id) ON DELETE SET NULL,
          department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
          class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO users_new (id, university_id, name, email, password_hash, role, title, phone, identifier,
                               faculty_id, department_id, class_id, active, created_at)
          SELECT id, university_id, name, email, password_hash, role, title, phone, identifier,
                 faculty_id, department_id, class_id, active, created_at FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
        CREATE INDEX IF NOT EXISTS idx_users_uni_role ON users(university_id, role);
        CREATE INDEX IF NOT EXISTS idx_users_class ON users(class_id);
      `);
      const broken = db.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error(`users migration left ${broken.length} broken references`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
  const uniCols = db.prepare('PRAGMA table_info(universities)').all().map((c) => c.name);
  if (!uniCols.includes('currency')) db.exec("ALTER TABLE universities ADD COLUMN currency TEXT NOT NULL DEFAULT 'UGX'");
}

db.exec(SCHEMA);
migrate();
db.exec(PAY_SCHEMA);
db.exec(OPS_SCHEMA);
addColumns();

// node:sqlite only binds null/number/bigint/string/bytes, so normalise JS values first.
const bindable = (params) =>
  params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

const cache = new Map();
function prepare(sql) {
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

export const q = {
  all: (sql, ...params) => prepare(sql).all(...bindable(params)).map((r) => ({ ...r })),
  get: (sql, ...params) => {
    const row = prepare(sql).get(...bindable(params));
    return row ? { ...row } : undefined;
  },
  run: (sql, ...params) => prepare(sql).run(...bindable(params)),
};

export function insert(table, data) {
  const keys = Object.keys(data);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  return Number(q.run(sql, ...keys.map((k) => data[k])).lastInsertRowid);
}

export function update(table, id, data) {
  const keys = Object.keys(data);
  if (!keys.length) return;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  q.run(sql, ...keys.map((k) => data[k]), id);
}

let depth = 0;
export function tx(fn) {
  if (depth > 0) return fn();
  db.exec('BEGIN');
  depth++;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth--;
  }
}
