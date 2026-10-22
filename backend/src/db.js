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

-- A programme's curriculum changes over time: each version lists its course units by year and
-- semester. New intakes follow the latest version; running classes keep theirs until they finish.
CREATE TABLE IF NOT EXISTS curriculum_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  starts_academic_year TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','phasing_out','retired')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cv_program ON curriculum_versions(program_id);

CREATE TABLE IF NOT EXISTS program_course_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  version_id INTEGER NOT NULL REFERENCES curriculum_versions(id) ON DELETE CASCADE,
  course_unit_id INTEGER NOT NULL REFERENCES course_units(id) ON DELETE CASCADE,
  year_of_study INTEGER NOT NULL DEFAULT 1,
  semester INTEGER NOT NULL DEFAULT 1,
  UNIQUE (version_id, course_unit_id)
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
// Research supervision: a student's project (undergraduate), dissertation (Master's) or thesis
// (PhD) from concept to clearance, with every sign-off kept as an event.
// Account deletion: requested by the person (or their HoD / Dean), approved by the university's
// administrator, archived for a while (restorable) and then erased by the scheduler.
// Internal part-time calls: a unit nobody can take within their maximum load is offered to
// full-time staff as paid part-time load; interested lecturers respond and the HoD picks one.
const PEOPLE_SCHEMA = `
CREATE TABLE IF NOT EXISTS account_deletions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','archived','rejected','cancelled','restored','purged')),
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at TEXT,
  decision_note TEXT,
  purge_after TEXT,
  purged_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_account_deletions ON account_deletions(university_id, status);

CREATE TABLE IF NOT EXISTS part_time_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  term_id INTEGER NOT NULL REFERENCES academic_terms(id) ON DELETE CASCADE,
  course_unit_id INTEGER NOT NULL REFERENCES course_units(id) ON DELETE CASCADE,
  class_ids TEXT NOT NULL,
  hours_per_week REAL NOT NULL,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','filled','closed')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  allocation_id INTEGER REFERENCES allocations(id) ON DELETE SET NULL,
  filled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS part_time_call_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id INTEGER NOT NULL REFERENCES part_time_calls(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (call_id, user_id)
);
`;

const RESEARCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS research_coordinators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  appointed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (department_id, user_id)
);

CREATE TABLE IF NOT EXISTS research_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  program_id INTEGER REFERENCES programs(id) ON DELETE SET NULL,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('project','dissertation','thesis')),
  title TEXT NOT NULL,
  problem TEXT,
  objectives TEXT,
  methodology TEXT,
  status TEXT NOT NULL DEFAULT 'concept_submitted',
  reports_required INTEGER NOT NULL DEFAULT 3,
  presentation_at TEXT,
  presentation_venue TEXT,
  defence_at TEXT,
  defence_venue TEXT,
  defence_panel TEXT,
  outcome_note TEXT,
  verify_code TEXT UNIQUE,
  submitted_at TEXT,
  cleared_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_research_student ON research_projects(student_id);
CREATE INDEX IF NOT EXISTS idx_research_department ON research_projects(department_id, status);

CREATE TABLE IF NOT EXISTS research_supervisors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'main' CHECK (role IN ('main','co')),
  assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS research_mentors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  institution TEXT,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','confirmed','declined')),
  proposed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS research_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  file_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS research_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  document_id INTEGER REFERENCES research_documents(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','supervisor_approved','approved','returned')),
  supervisor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  supervisor_at TEXT,
  supervisor_note TEXT,
  hod_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  hod_at TEXT,
  hod_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- History and sign-offs. An approval here is a digital signature (see services/research.js).
CREATE TABLE IF NOT EXISTS research_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  stage TEXT NOT NULL,
  step TEXT,
  action TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_research_events ON research_events(project_id, id);
`;

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

-- Votes (budget lines) the Dean as Vote Controller charges signed-off part-time claims to.
CREATE TABLE IF NOT EXISTS pay_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  faculty_id INTEGER NOT NULL REFERENCES faculties(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount >= 0),
  financial_year TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (faculty_id, code)
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
    // The academic year classes are in; when a later year's Semester 1 starts, classes move up.
    progressed_year: 'TEXT',
    // Approved account deletions are archived this many days before personal data is erased.
    account_archive_days: 'INTEGER NOT NULL DEFAULT 30',
    // Weekly teaching load for full-time staff; above the maximum needs an override (internal part-time load).
    workload_min_hours: 'REAL NOT NULL DEFAULT 10',
    workload_max_hours: 'REAL NOT NULL DEFAULT 20',
  },
  users: {
    calendar_token: 'TEXT',
    must_change_password: 'INTEGER NOT NULL DEFAULT 0',
    photo_path: 'TEXT',
    // Position (e.g. Senior Lecturer); set by the HoD, Dean or administrator, like the name.
    designation: 'TEXT',
    // Contacts the person keeps up to date themselves.
    alt_phone: 'TEXT',
    contact_email: 'TEXT',
    office: 'TEXT',
    address: 'TEXT',
    emergency_name: 'TEXT',
    emergency_phone: 'TEXT',
    // Personal workload limits (hours per week) replacing the university's defaults.
    workload_min: 'REAL',
    workload_max: 'REAL',
  },
  pay_claims: { vote_id: 'INTEGER', verify_code: 'TEXT' },
  notification_prefs: { research_enabled: 'INTEGER NOT NULL DEFAULT 1', research_day_before: 'INTEGER NOT NULL DEFAULT 1', research_minutes_before: 'INTEGER NOT NULL DEFAULT 60' },
  // Research: the HoD turns it on per programme, says from which year of study, and how many progress reports.
  programs: { coursework_max: 'REAL NOT NULL DEFAULT 40', research_enabled: 'INTEGER NOT NULL DEFAULT 0', research_year: 'INTEGER', research_reports: 'INTEGER NOT NULL DEFAULT 3' },
  classes: { curriculum_version_id: 'INTEGER', status: "TEXT NOT NULL DEFAULT 'active'", completed_at: 'TEXT', intake_year: 'TEXT' },
  // part_time_hours: hours a week above the lecturer's maximum, paid as internal part-time load.
  allocations: { status: "TEXT NOT NULL DEFAULT 'confirmed'", carried_from: 'INTEGER', part_time_hours: 'REAL NOT NULL DEFAULT 0' },
  academic_terms: { carried_over_at: 'TEXT' },
  attendance_registers: { source: "TEXT NOT NULL DEFAULT 'rep'", self_checkins: 'INTEGER NOT NULL DEFAULT 0' },
  attendance_records: { method: 'TEXT' },
  pay_rates: { code: 'TEXT', program_level: 'TEXT' },
  pay_claim_lines: { exam_id: 'INTEGER REFERENCES exams(id) ON DELETE SET NULL', self_checkins: 'INTEGER', program_level: 'TEXT' },
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

/**
 * Curriculum versions (added after the first releases): every programme's existing curriculum
 * becomes its "Version 1", its classes follow it, and the year the classes are in is recorded so
 * that nothing moves up until the next academic year actually starts.
 */
function migrateCurriculumVersions() {
  const cols = db.prepare('PRAGMA table_info(program_course_units)').all().map((c) => c.name);
  if (!cols.includes('version_id')) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      const add = db.prepare("INSERT INTO curriculum_versions (university_id, program_id, name, status) VALUES (?, ?, 'Version 1', 'active')");
      for (const prog of db.prepare('SELECT id, university_id FROM programs').all()) add.run(prog.university_id, prog.id);
      db.exec(`
        CREATE TABLE program_course_units_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
          version_id INTEGER NOT NULL REFERENCES curriculum_versions(id) ON DELETE CASCADE,
          course_unit_id INTEGER NOT NULL REFERENCES course_units(id) ON DELETE CASCADE,
          year_of_study INTEGER NOT NULL DEFAULT 1,
          semester INTEGER NOT NULL DEFAULT 1,
          UNIQUE (version_id, course_unit_id)
        );
        INSERT INTO program_course_units_new (id, program_id, version_id, course_unit_id, year_of_study, semester)
          SELECT pcu.id, pcu.program_id, (SELECT MIN(v.id) FROM curriculum_versions v WHERE v.program_id = pcu.program_id),
                 pcu.course_unit_id, pcu.year_of_study, pcu.semester
            FROM program_course_units pcu;
        DROP TABLE program_course_units;
        ALTER TABLE program_course_units_new RENAME TO program_course_units;
        CREATE INDEX IF NOT EXISTS idx_pcu_cu ON program_course_units(course_unit_id);
      `);
      const broken = db.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error(`curriculum migration left ${broken.length} broken references`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_pcu_version ON program_course_units(version_id, year_of_study, semester)');
  // Programmes without a version yet (e.g. created by an older release after the rebuild) get one.
  for (const prog of db.prepare('SELECT id, university_id FROM programs p WHERE NOT EXISTS (SELECT 1 FROM curriculum_versions v WHERE v.program_id = p.id)').all()) {
    db.prepare("INSERT INTO curriculum_versions (university_id, program_id, name, status) VALUES (?, ?, 'Version 1', 'active')").run(prog.university_id, prog.id);
  }
  db.exec(`UPDATE classes SET curriculum_version_id = (SELECT MIN(v.id) FROM curriculum_versions v WHERE v.program_id = classes.program_id)
             WHERE curriculum_version_id IS NULL`);
  db.exec(`UPDATE universities SET progressed_year = COALESCE(
             (SELECT academic_year FROM academic_terms t WHERE t.university_id = universities.id AND t.is_current = 1 AND t.academic_year IS NOT NULL LIMIT 1),
             (SELECT MAX(academic_year) FROM academic_terms t WHERE t.university_id = universities.id AND t.start_date <= date('now')))
           WHERE progressed_year IS NULL`);
}

db.exec(SCHEMA);
migrate();
db.exec(PAY_SCHEMA);
db.exec(OPS_SCHEMA);
db.exec(RESEARCH_SCHEMA);
db.exec(PEOPLE_SCHEMA);
addColumns();
migrateCurriculumVersions();

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
