import { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { AuthProvider, useAuth } from './auth';
import { FeedbackProvider } from './components/feedback';
import { Layout } from './components/Layout';
import { EmptyState, Spinner } from './components/ui';
import Allocation from './pages/Allocation';
import Attendance, { RegisterPage } from './pages/Attendance';
import CheckIn from './pages/CheckIn';
import Claims, { ClaimDetail } from './pages/Claims';
import Exams from './pages/Exams';
import Leave, { LeaveDetail } from './pages/Leave';
import { ForcedPasswordChange } from './pages/Profile';
import AcademicCalendar from './pages/setup/AcademicCalendar';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';
import MyTimetable from './pages/MyTimetable';
import Notifications from './pages/Notifications';
import Platform from './pages/Platform';
import Profile from './pages/Profile';
import Register from './pages/Register';
import Reports from './pages/Reports';
import Timetable from './pages/Timetable';
import Users from './pages/Users';
import Classes from './pages/setup/Classes';
import CourseUnits from './pages/setup/CourseUnits';
import { ProgrammeDetail, Programmes } from './pages/setup/Programmes';
import { Rooms, Terms } from './pages/setup/RoomsTerms';
import { Departments, Faculties } from './pages/setup/Structure';
import UniversitySettings from './pages/setup/University';
import type { Role } from './types';

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="fullscreen-center">
        <Spinner label="Loading..." />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  // Someone else knew the starting password, so the owner chooses their own before anything else.
  if (user.must_change_password) return <ForcedPasswordChange />;
  return <>{children}</>;
}

function Only({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user } = useAuth();
  if (user && roles.includes(user.role)) return <>{children}</>;
  return (
    <EmptyState title="Not available for your role" icon={<ShieldAlert size={28} />}>
      Ask your administrator if you need access.
    </EmptyState>
  );
}

const MANAGERS: Role[] = ['admin', 'dean', 'hod'];
const STAFF: Role[] = ['admin', 'dean', 'hod', 'lecturer'];
const MEMBERS: Role[] = ['admin', 'dean', 'hod', 'lecturer', 'student'];

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <FeedbackProvider>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route
              element={
                <RequireAuth>
                  <Layout />
                </RequireAuth>
              }
            >
              <Route index element={<Dashboard />} />
              <Route path="my-timetable" element={<Only roles={['lecturer', 'hod', 'dean', 'student']}><MyTimetable /></Only>} />
              <Route path="attendance" element={<Only roles={MEMBERS}><Attendance /></Only>} />
              <Route path="attendance/registers/:id" element={<Only roles={MEMBERS}><RegisterPage /></Only>} />
              <Route path="notifications" element={<Only roles={[...MEMBERS, 'hr']}><Notifications /></Only>} />
              <Route path="claims" element={<Only roles={[...STAFF, 'hr']}><Claims /></Only>} />
              <Route path="checkin/:id" element={<Only roles={MEMBERS}><CheckIn /></Only>} />
              <Route path="exams" element={<Only roles={MEMBERS}><Exams /></Only>} />
              <Route path="leave" element={<Only roles={STAFF}><Leave /></Only>} />
              <Route path="leave/:id" element={<Only roles={STAFF}><LeaveDetail /></Only>} />
              <Route path="setup/calendar" element={<Only roles={['admin']}><AcademicCalendar /></Only>} />
              <Route path="claims/:id" element={<Only roles={[...STAFF, 'hr']}><ClaimDetail /></Only>} />
              <Route path="allocation" element={<Only roles={MANAGERS}><Allocation /></Only>} />
              <Route path="timetable" element={<Only roles={STAFF}><Timetable /></Only>} />
              <Route path="reports" element={<Only roles={STAFF}><Reports /></Only>} />
              <Route path="setup/university" element={<Only roles={['admin']}><UniversitySettings /></Only>} />
              <Route path="setup/faculties" element={<Only roles={['admin']}><Faculties /></Only>} />
              <Route path="setup/departments" element={<Only roles={['admin', 'dean']}><Departments /></Only>} />
              <Route path="setup/programmes" element={<Only roles={MANAGERS}><Programmes /></Only>} />
              <Route path="setup/programmes/:id" element={<Only roles={MANAGERS}><ProgrammeDetail /></Only>} />
              <Route path="setup/course-units" element={<Only roles={MANAGERS}><CourseUnits /></Only>} />
              <Route path="setup/classes" element={<Only roles={MANAGERS}><Classes /></Only>} />
              <Route path="setup/rooms" element={<Only roles={['admin']}><Rooms /></Only>} />
              <Route path="setup/terms" element={<Only roles={['admin']}><Terms /></Only>} />
              <Route path="users" element={<Only roles={MANAGERS}><Users /></Only>} />
              <Route path="platform" element={<Only roles={['super_admin']}><Platform /></Only>} />
              <Route path="profile" element={<Profile />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </FeedbackProvider>
    </BrowserRouter>
  );
}
