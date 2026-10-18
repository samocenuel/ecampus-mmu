export type Role = 'super_admin' | 'admin' | 'dean' | 'hod' | 'lecturer' | 'student' | 'hr';

export interface User {
  id: number;
  university_id: number | null;
  name: string;
  email: string;
  role: Role;
  employment_type?: 'full_time' | 'part_time';
  title?: string | null;
  phone?: string | null;
  identifier?: string | null;
  faculty_id?: number | null;
  department_id?: number | null;
  class_id?: number | null;
  faculty_name?: string | null;
  department_name?: string | null;
  class_name?: string | null;
  active: number;
  is_class_rep?: boolean | number;
  rep_classes?: { id: number; name: string }[];
}

export interface University {
  id: number;
  name: string;
  short_name?: string | null;
  address?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  logo_url?: string | null;
  primary_color: string;
  currency?: string;
  timezone: string;
  teaching_days: number[];
  day_start: string;
  day_end: string;
  lunch_start?: string | null;
  lunch_end?: string | null;
}

export interface Term {
  id: number;
  name: string;
  academic_year?: string;
  semester: number;
  start_date?: string;
  end_date?: string;
  is_current: number;
}

export interface Session {
  id: number;
  term_id: number;
  allocation_id: number;
  room_id: number;
  day_of_week: number;
  day_name?: string;
  start_time: string;
  end_time: string;
  generated: number;
  lecturer_id: number;
  lecturer_name: string;
  lecturer_title?: string | null;
  course_unit_id: number;
  course_code: string;
  course_name: string;
  is_cross_cutting: number;
  room_name: string;
  room_building?: string | null;
  room_capacity: number;
  classes: { id: number; name: string }[];
}

export interface TimetableSettings {
  teaching_days: number[];
  day_start: string;
  day_end: string;
  lunch_start?: string | null;
  lunch_end?: string | null;
  timezone: string;
}

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'Platform owner',
  admin: 'Administrator',
  dean: 'Dean',
  hod: 'Head of Department',
  lecturer: 'Lecturer',
  student: 'Student',
  hr: 'HR (Directorate)',
};

export const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const DAY_SHORT = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const MANAGER_ROLES: Role[] = ['admin', 'dean', 'hod'];
export const TEACHING_ROLES: Role[] = ['lecturer', 'hod', 'dean'];
export const STAFF_ROLES: Role[] = ['admin', 'dean', 'hod', 'lecturer'];
