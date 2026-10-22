import { ReactNode, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Bell, BookOpen, Building2, CalendarClock, CalendarDays, ChartColumn, ClipboardCheck, DoorOpen, GraduationCap,
  CalendarRange, CalendarX2, FilePenLine, KeyRound, Landmark, Layers, LayoutDashboard, LogOut, Menu, Network, School, Settings, UserCog, Users, Wallet,
  Workflow, X,
} from 'lucide-react';
import { api, assetUrl } from '../api';
import { useAuth } from '../auth';
import { ROLE_LABELS, Role, User } from '../types';
import { Avatar, IconButton } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  roles?: Role[];
  /** Extra visibility rule, e.g. part-time lecturers only. */
  show?: (user: User) => boolean;
}

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Overview',
    items: [
      { to: '/', label: 'Dashboard', icon: <LayoutDashboard size={18} /> },
      { to: '/my-timetable', label: 'My timetable', icon: <CalendarDays size={18} />, roles: ['lecturer', 'hod', 'dean', 'student'] },
      { to: '/attendance', label: 'Attendance', icon: <ClipboardCheck size={18} />, roles: ['admin', 'dean', 'hod', 'lecturer', 'student'] },
      { to: '/notifications', label: 'Notifications', icon: <Bell size={18} />, roles: ['admin', 'dean', 'hod', 'lecturer', 'student', 'hr'] },
    ],
  },
  {
    section: 'Teaching',
    items: [
      { to: '/allocation', label: 'Load allocation', icon: <Workflow size={18} />, roles: ['admin', 'dean', 'hod'] },
      { to: '/timetable', label: 'Timetable', icon: <CalendarClock size={18} />, roles: ['admin', 'dean', 'hod', 'lecturer'] },
      { to: '/reports', label: 'Reports', icon: <ChartColumn size={18} />, roles: ['admin', 'dean', 'hod', 'lecturer'] },
      { to: '/exams', label: 'Exams', icon: <FilePenLine size={18} />, roles: ['admin', 'dean', 'hod', 'lecturer', 'student'] },
      { to: '/leave', label: 'Leave', icon: <CalendarX2 size={18} />, roles: ['admin', 'dean', 'hod', 'lecturer'] },
    ],
  },
  {
    section: 'Part-time pay',
    items: [
      {
        to: '/claims',
        label: 'Pay claims',
        icon: <Wallet size={18} />,
        show: (u) => ['admin', 'dean', 'hod', 'hr'].includes(u.role) || u.employment_type === 'part_time',
      },
    ],
  },
  {
    section: 'Setup',
    items: [
      { to: '/setup/university', label: 'University', icon: <Landmark size={18} />, roles: ['admin'] },
      { to: '/setup/faculties', label: 'Faculties', icon: <Building2 size={18} />, roles: ['admin'] },
      { to: '/setup/departments', label: 'Departments', icon: <Network size={18} />, roles: ['admin', 'dean'] },
      { to: '/setup/programmes', label: 'Programmes', icon: <GraduationCap size={18} />, roles: ['admin', 'dean', 'hod'] },
      { to: '/setup/course-units', label: 'Course units', icon: <BookOpen size={18} />, roles: ['admin', 'dean', 'hod'] },
      { to: '/setup/classes', label: 'Classes', icon: <School size={18} />, roles: ['admin', 'dean', 'hod'] },
      { to: '/setup/rooms', label: 'Rooms', icon: <DoorOpen size={18} />, roles: ['admin'] },
      { to: '/setup/terms', label: 'Academic terms', icon: <Layers size={18} />, roles: ['admin'] },
      { to: '/setup/calendar', label: 'Academic calendar', icon: <CalendarRange size={18} />, roles: ['admin'] },
      { to: '/users', label: 'Users', icon: <Users size={18} />, roles: ['admin', 'dean', 'hod'] },
    ],
  },
  {
    section: 'Platform',
    items: [{ to: '/platform', label: 'Universities', icon: <Settings size={18} />, roles: ['super_admin'] }],
  },
];

function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ items: any[]; unread_count: number }>({ items: [], unread_count: 0 });
  const lastSeen = useRef<number | null>(null);
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await api('/api/notifications?limit=10');
        if (!alive) return;
        setData(res);
        const maxId = Math.max(0, ...res.items.map((n: any) => n.id));
        // Show a browser notification for anything new since the last poll.
        if (lastSeen.current !== null && 'Notification' in window && Notification.permission === 'granted') {
          for (const n of res.items.filter((n: any) => n.id > (lastSeen.current as number) && !n.read_at).reverse()) {
            try {
              new Notification(n.title, { body: n.body || '', tag: `lms-${n.id}` });
            } catch {
              /* some browsers only allow notifications from a service worker */
            }
          }
        }
        lastSeen.current = maxId;
      } catch {
        /* offline - try again next tick */
      }
    };
    poll();
    const t = setInterval(poll, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    const onClick = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const openItem = async (n: any) => {
    setOpen(false);
    if (!n.read_at) await api(`/api/notifications/${n.id}/read`, { method: 'POST' }).catch(() => {});
    setData((d) => ({ unread_count: Math.max(0, d.unread_count - (n.read_at ? 0 : 1)), items: d.items.map((x) => (x.id === n.id ? { ...x, read_at: 'now' } : x)) }));
    if (n.link) navigate(n.link);
  };

  return (
    <div className="bell" ref={ref}>
      <IconButton label="Notifications" onClick={() => setOpen((o) => !o)}>
        <Bell size={20} />
        {data.unread_count > 0 && <span className="bell-count">{data.unread_count > 99 ? '99+' : data.unread_count}</span>}
      </IconButton>
      {open && (
        <div className="dropdown bell-menu">
          <div className="dropdown-head">
            <strong>Notifications</strong>
            <button
              className="link"
              onClick={async () => {
                await api('/api/notifications/read-all', { method: 'POST' });
                setData((d) => ({ unread_count: 0, items: d.items.map((x) => ({ ...x, read_at: x.read_at || 'now' })) }));
              }}
            >
              Mark all read
            </button>
          </div>
          {data.items.length === 0 && <div className="muted pad">You're all caught up.</div>}
          {data.items.map((n) => (
            <button key={n.id} className={`notif ${n.read_at ? '' : 'unread'}`} onClick={() => openItem(n)}>
              <strong>{n.title}</strong>
              {n.body && <span>{n.body}</span>}
              <small className="muted">{new Date(n.created_at.replace(' ', 'T') + 'Z').toLocaleString()}</small>
            </button>
          ))}
          <button className="dropdown-foot link" onClick={() => { setOpen(false); navigate('/notifications'); }}>
            View all & reminder settings
          </button>
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);
  if (!user) return null;
  return (
    <div className="user-menu" ref={ref}>
      <button className="user-chip" onClick={() => setOpen((o) => !o)}>
        <Avatar name={user.name} src={assetUrl(user.photo_url)} />
        <span className="hide-sm user-chip-text">
          <strong>{user.name}</strong>
          <small>
            {ROLE_LABELS[user.role]}
            {user.is_class_rep ? ' · Class rep' : ''}
            {user.employment_type === 'part_time' ? ' · Part-time' : ''}
          </small>
        </span>
      </button>
      {open && (
        <div className="dropdown">
          <div className="dropdown-head column">
            <strong>{user.name}</strong>
            <small className="muted">{user.email}</small>
          </div>
          <button className="dropdown-item" onClick={() => { setOpen(false); navigate('/profile'); }}>
            <KeyRound size={16} /> Profile & password
          </button>
          <button className="dropdown-item" onClick={logout}>
            <LogOut size={16} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const { user, university } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMenuOpen(false), [location.pathname]);
  if (!user) return null;

  const visible = NAV.map((g) => ({
    ...g,
    items: g.items.filter(
      (i) =>
        (!i.roles || i.roles.includes(user.role)) &&
        (!i.show || i.show(user)) &&
        (user.role !== 'super_admin' || i.roles?.includes('super_admin') || i.to === '/'),
    ),
  })).filter((g) => g.items.length);

  const logo = assetUrl(university?.logo_url);
  return (
    <div className={`shell ${menuOpen ? 'menu-open' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          {logo ? <img src={logo} alt="" className="brand-logo" /> : <div className="brand-mark">{(university?.short_name || university?.name || 'LMS').slice(0, 3).toUpperCase()}</div>}
          <div className="brand-text">
            <strong>{university?.name || 'eCampus'}</strong>
            <small>{university ? 'Teaching & Learning' : 'Platform administration'}</small>
          </div>
          <IconButton label="Close menu" className="show-sm" onClick={() => setMenuOpen(false)}>
            <X size={18} />
          </IconButton>
        </div>
        <nav>
          {visible.map((g) => (
            <div key={g.section} className="nav-group">
              <div className="nav-section">{g.section}</div>
              {g.items.map((i) => (
                <NavLink key={i.to} to={i.to} end={i.to === '/'} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                  {i.icon}
                  <span>{i.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <UserCog size={14} /> {ROLE_LABELS[user.role]}
          {user.department_name ? ` · ${user.department_name}` : user.faculty_name ? ` · ${user.faculty_name}` : ''}
        </div>
      </aside>
      <div className="scrim" onClick={() => setMenuOpen(false)} />
      <div className="main">
        <header className="topbar">
          <IconButton label="Open menu" className="show-sm" onClick={() => setMenuOpen(true)}>
            <Menu size={20} />
          </IconButton>
          <div className="topbar-title show-sm">{university?.short_name || university?.name}</div>
          <div className="spacer" />
          {user.role !== 'super_admin' && <NotificationBell />}
          <UserMenu />
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
