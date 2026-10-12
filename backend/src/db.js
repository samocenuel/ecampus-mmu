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
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER REFERENCES universities(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super_admin','admin','dean','hod','lecturer','student')),
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

db.exec(SCHEMA);

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
