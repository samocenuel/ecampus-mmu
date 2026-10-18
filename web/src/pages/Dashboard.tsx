import { Link, Navigate } from 'react-router-dom';
import {
  AlertTriangle, BookOpen, Building2, CalendarClock, CheckCircle2, Circle, ClipboardCheck, DoorOpen, GraduationCap, Network, School, UserRound, Users, Wallet,
} from 'lucide-react';
import { useAuth } from '../auth';
import { money } from './Claims';
import { SessionRow } from '../components/WeekGrid';
import { Alert, Badge, Button, Card, EmptyState, ErrorNote, PageHeader, plural, Progress, rateTone, Spinner, StatCard } from '../components/ui';
import { useFetch } from '../hooks';
import { MANAGER_ROLES, TEACHING_ROLES } from '../types';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function SetupChecklist({ d }: { d: any }) {
  const { university } = useAuth();
  const c = d.counts || {};
  const steps = [
    ['University profile & logo', Boolean(university?.logo_url && university?.address), '/setup/university'],
    ['Faculties with Deans', c.faculties > 0, '/setup/faculties'],
    ['Departments with HoDs', c.departments > 0, '/setup/departments'],
    ['Programmes', c.programs > 0, '/setup/programmes'],
    ['Cross-cutting course units', c.cross_cutting_units > 0, '/setup/course-units'],
    ['Programme course units', c.course_units > c.cross_cutting_units, '/setup/course-units'],
    ['Rooms', c.rooms > 0, '/setup/rooms'],
    ['Academic term', Boolean(d.term), '/setup/terms'],
    ['Lecturer & student accounts', c.lecturers > 0 && c.students > 0, '/users'],
    ['Classes & class representatives', c.classes > 0, '/setup/classes'],
    ['Load allocation (cross-cutting first)', c.course_units_allocated > 0, '/allocation'],
    ['Generate the timetable', c.weekly_sessions > 0, '/timetable'],
  ] as const;
  const done = steps.filter((s) => s[1]).length;
  if (done === steps.length) return null;
  return (
    <Card title={`Getting started - ${done} of ${steps.length} done`}>
      <Progress value={done} total={steps.length} />
      <ul className="checklist">
        {steps.map(([label, ok, to]) => (
          <li key={label} className={ok ? 'done' : ''}>
            {ok ? <CheckCircle2 size={18} /> : <Circle size={18} />}
            <Link to={to}>{label}</Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const { data: d, loading, error } = useFetch<any>(user?.role === 'super_admin' ? null : '/api/dashboard');
  if (user?.role === 'super_admin') return <Navigate to="/platform" replace />;
  if (!user) return null;
  const isManager = MANAGER_ROLES.includes(user.role);
  const teaches = TEACHING_ROLES.includes(user.role);
  const first = user.name.split(' ')[0];

  return (
    <>
      <PageHeader
        title={`${greeting()}, ${first}`}
        subtitle={d ? `${d.day_name}, ${new Date(d.today + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}${d.term ? ` · ${d.term.name}` : ''} · ${d.scope}` : ' '}
      />
      <ErrorNote error={error} />
      {loading && !d && <Spinner label="Loading your dashboard..." />}
      {d && (
        <div className="stack">
          {!d.term && isManager && (
            <Alert tone="warning" title="No academic term yet" action={user.role === 'admin' ? <Link to="/setup/terms" className="btn btn-sm btn-primary">Create term</Link> : undefined}>
              Timetables and allocations are organised per term.
            </Alert>
          )}

          {user.role === 'student' && d.is_class_rep && d.registers_due_today > 0 && (
            <Alert tone="info" title={`You have ${plural(d.registers_due_today, 'attendance register')} to take today`} action={<Link to="/attendance" className="btn btn-sm btn-primary">Take attendance</Link>}>
              As class representative, mark who is present during each lecture. Your lecturer approves the list.
            </Alert>
          )}
          {teaches && d.my_pending_approvals > 0 && (
            <Alert tone="warning" title={`${plural(d.my_pending_approvals, 'attendance register')} waiting for your approval`} action={<Link to="/attendance?tab=approvals" className="btn btn-sm btn-primary">Review</Link>} />
          )}

          {d.claims?.awaiting_me > 0 && (
            <Alert
              tone="warning"
              title={`${plural(d.claims.awaiting_me, 'pay claim')} waiting for you (${money(d.claims.awaiting_me_total, d.claims.currency)})`}
              action={<Link to="/claims" className="btn btn-sm btn-primary">Open claims</Link>}
            />
          )}
          {d.claims?.mine.returned > 0 && (
            <Alert tone="danger" title={`${plural(d.claims.mine.returned, 'pay claim')} returned to you for correction`} action={<Link to="/claims" className="btn btn-sm btn-primary">Fix</Link>} />
          )}

          {user.role === 'admin' && <SetupChecklist d={d} />}

          {isManager && d.counts && (
            <div className="stat-grid">
              {user.role === 'admin' && <StatCard label="Faculties" value={d.counts.faculties} icon={<Building2 size={20} />} />}
              {user.role !== 'hod' && <StatCard label="Departments" value={d.counts.departments} icon={<Network size={20} />} />}
              <StatCard label="Programmes" value={d.counts.programs} icon={<GraduationCap size={20} />} />
              <StatCard label="Course units" value={d.counts.course_units ?? '-'} hint={d.counts.cross_cutting_units !== undefined ? `${d.counts.cross_cutting_units} cross-cutting` : undefined} icon={<BookOpen size={20} />} />
              <StatCard label="Lecturers" value={d.counts.lecturers} icon={<UserRound size={20} />} />
              <StatCard label="Students" value={d.counts.students} icon={<Users size={20} />} />
              <StatCard label="Classes" value={d.counts.classes} icon={<School size={20} />} />
              {user.role === 'admin' && <StatCard label="Rooms" value={d.counts.rooms} icon={<DoorOpen size={20} />} />}
            </div>
          )}

          <div className="grid-2">
            {(teaches || user.role === 'student') && (
              <Card title="Today's lectures" actions={<Link to="/my-timetable" className="link">Full timetable</Link>}>
                {d.today_sessions.length === 0 ? (
                  <EmptyState title="No lectures today" icon={<CalendarClock size={26} />} />
                ) : (
                  d.today_sessions.map((s: any) => <SessionRow key={s.id} s={s} showClasses={user.role !== 'student'} />)
                )}
              </Card>
            )}

            {isManager && d.allocation && (
              <Card title="Load allocation" actions={<Link to="/allocation" className="link">Open</Link>}>
                <div className="metric-row">
                  <span>
                    Cross-cutting units <Badge tone="warning">first</Badge>
                  </span>
                  <strong>
                    {d.allocation.cross_cutting_allocated}/{d.allocation.cross_cutting_pairs}
                  </strong>
                </div>
                <Progress value={d.allocation.cross_cutting_allocated} total={d.allocation.cross_cutting_pairs} tone="warning" />
                <div className="metric-row">
                  <span>Programme-specific units</span>
                  <strong>
                    {d.allocation.other_allocated}/{d.allocation.other_pairs}
                  </strong>
                </div>
                <Progress value={d.allocation.other_allocated} total={d.allocation.other_pairs} />
                {d.allocation.cross_cutting_allocated < d.allocation.cross_cutting_pairs && (
                  <p className="small text-warning row gap-sm">
                    <AlertTriangle size={14} /> Allocate the remaining cross-cutting units before programme units.
                  </p>
                )}
                <div className="metric-row muted small">
                  <span>Weekly teaching scheduled</span>
                  <span>
                    {d.counts.weekly_sessions} sessions · {d.counts.weekly_teaching_hours} hrs
                  </span>
                </div>
              </Card>
            )}

            {(isManager || user.role === 'lecturer') && d.attendance && (
              <Card title="Attendance" actions={<Link to="/reports" className="link">Reports</Link>}>
                <div className="stat-grid compact">
                  <StatCard label="Average attendance" value={d.attendance.average_rate !== null ? `${d.attendance.average_rate}%` : '-'} tone={rateTone(d.attendance.average_rate) === 'danger' ? 'danger' : 'success'} />
                  <StatCard label="Awaiting approval" value={d.attendance.pending_registers} tone={d.attendance.pending_registers ? 'warning' : undefined} />
                  <StatCard label="Students below 75%" value={d.attendance.at_risk} tone={d.attendance.at_risk ? 'danger' : undefined} />
                </div>
              </Card>
            )}

            {user.role === 'student' && d.attendance && (
              <Card title="My attendance" actions={<Link to="/attendance" className="link">History</Link>}>
                <div className="big-rate">
                  <span className={`text-${rateTone(d.attendance.rate) || 'muted'}`}>{d.attendance.rate !== null ? `${d.attendance.rate}%` : '-'}</span>
                  <small className="muted">
                    {d.attendance.attended} of {d.attendance.total} approved lectures attended
                  </small>
                </div>
                <Progress value={d.attendance.attended} total={d.attendance.total} tone={rateTone(d.attendance.rate)} />
              </Card>
            )}

            {teaches && (
              <Card title="My teaching load">
                <div className="stat-grid compact">
                  <StatCard label="Hours per week" value={d.my_weekly_hours} icon={<CalendarClock size={20} />} />
                  <StatCard label="Registers to approve" value={d.my_pending_approvals} icon={<ClipboardCheck size={20} />} tone={d.my_pending_approvals ? 'warning' : undefined} />
                </div>
              </Card>
            )}

            {d.claims && (d.claims.part_timer || user.role === 'hr') && (
              <Card title={user.role === 'hr' ? 'Part-time claims' : 'My pay claims'} actions={<Link to="/claims" className="link">Open</Link>}>
                <div className="stat-grid compact">
                  {user.role === 'hr' ? (
                    <>
                      <StatCard label="To check" value={d.claims.awaiting_me - (d.claims.awaiting_payment || 0)} icon={<Wallet size={20} />} tone={d.claims.awaiting_me ? 'warning' : undefined} />
                      <StatCard label="Verified, to pay" value={d.claims.awaiting_payment || 0} />
                    </>
                  ) : (
                    <>
                      <StatCard label="Open claims" value={d.claims.mine.open} icon={<Wallet size={20} />} />
                      <StatCard label="Paid to me" value={money(d.claims.mine.paid_total, d.claims.currency)} tone="success" />
                    </>
                  )}
                </div>
              </Card>
            )}

            {d.upcoming.length > 0 && (
              <Card title="Coming up this week" actions={<Link to="/notifications" className="link">Reminders</Link>}>
                {d.upcoming.map((u: any) => (
                  <div key={`${u.session_id}-${u.date}`} className="upcoming">
                    <div className="upcoming-date">
                      <strong>{new Date(u.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short' })}</strong>
                      <span>{u.start_time}</span>
                    </div>
                    <div>
                      <strong>{u.course_code}</strong> {u.course_name}
                      <div className="muted small">
                        {u.room_name} · {user.role === 'student' ? u.lecturer_name : u.classes.map((c: any) => c.name).join(', ')}
                      </div>
                    </div>
                    {u.in_progress && <Badge tone="success">Now</Badge>}
                  </div>
                ))}
              </Card>
            )}
          </div>

          {isManager && !d.today_sessions.length && d.counts?.weekly_sessions === 0 && d.term && (
            <Alert tone="info" title="No timetable yet" action={<Link to="/timetable"><Button size="sm">Go to timetable</Button></Link>}>
              Once lecturers are allocated, generate the timetable automatically - collisions are prevented.
            </Alert>
          )}
        </div>
      )}
    </>
  );
}
