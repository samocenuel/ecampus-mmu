// "Try the demo": visitors sign in to the Demo University as one of these roles without an account.
import { q } from './db.js';

export const DEMO_SLUG = 'demo-university';

export const DEMO_ROLES = [
  { key: 'admin', label: 'Administrator', email: 'admin@demo.edu', description: 'Set up the university, rooms and timetable' },
  { key: 'dean', label: 'Dean', email: 'dean.fst@demo.edu', description: 'Oversee the faculty, set part-time pay rates' },
  { key: 'hod', label: 'Head of Department', email: 'hod.cs@demo.edu', description: 'Run one department: programmes, staff, allocation' },
  { key: 'lecturer', label: 'Lecturer', email: 'brian.kato@demo.edu', description: 'Teaching timetable and attendance approvals' },
  { key: 'part_time', label: 'Part-time lecturer', email: 'esther.atim@demo.edu', description: 'Claim pay for teaching hours and tasks' },
  { key: 'class_rep', label: 'Class representative', email: 'rep.bscs1@students.demo.edu', description: 'Take attendance for a lecture' },
  { key: 'student', label: 'Student', email: 'student.bscs1@students.demo.edu', description: 'Timetable, reminders and attendance history' },
  { key: 'hr', label: 'HR (Directorate)', email: 'hr@demo.edu', description: 'Check approved claims and record payments' },
];

const DEMO_EMAILS = new Set(DEMO_ROLES.map((r) => r.email));

export function demoUniversity() {
  return q.get('SELECT id FROM universities WHERE slug = ? AND active = 1', DEMO_SLUG);
}

/** The shared demo accounts must keep working for every visitor. */
export function isProtectedDemoAccount(user) {
  if (!user || !DEMO_EMAILS.has(user.email)) return false;
  const uni = demoUniversity();
  return Boolean(uni && uni.id === user.university_id);
}
