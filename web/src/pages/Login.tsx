import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  ArrowRight, BadgeCheck, BookOpenCheck, BriefcaseBusiness, Building2, CalendarClock, ClipboardCheck, GraduationCap, Landmark, Loader2, LogIn, Network,
  PlayCircle, UserRound, Workflow,
} from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Button, ErrorNote, Field, Input, Modal } from '../components/ui';

interface DemoRole {
  key: string;
  label: string;
  description: string;
}

const ROLE_ICONS: Record<string, ReactNode> = {
  admin: <Landmark size={20} />,
  dean: <Building2 size={20} />,
  hod: <Network size={20} />,
  lecturer: <BookOpenCheck size={20} />,
  class_rep: <ClipboardCheck size={20} />,
  student: <UserRound size={20} />,
  part_time: <BriefcaseBusiness size={20} />,
  hr: <BadgeCheck size={20} />,
};

export function AuthAside() {
  return (
    <aside className="auth-aside">
      <div className="auth-brand">
        <GraduationCap size={30} />
        <span>eCampus</span>
      </div>
      <h2>Teaching & learning, organised.</h2>
      <p>One place for your university's staff, programmes, course units, rooms, timetables and attendance.</p>
      <ul className="auth-points">
        <li>
          <Workflow size={18} /> Load allocation that puts cross-cutting units first
        </li>
        <li>
          <CalendarClock size={18} /> Clash-free timetables, exported to Excel or PDF
        </li>
        <li>
          <ClipboardCheck size={18} /> Class-rep attendance with lecturer approval
        </li>
      </ul>
    </aside>
  );
}

/** Lets a visitor explore the Demo University as any role, without an account. */
function DemoPicker({ open, roles, onClose }: { open: boolean; roles: DemoRole[]; onClose: () => void }) {
  const { loginDemo } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const enter = async (role: string) => {
    setBusy(role);
    setError(null);
    try {
      await loginDemo(role);
    } catch (err: any) {
      setError(err.message);
      setBusy(null);
    }
  };

  return (
    <Modal open={open} title="Try the demo" onClose={onClose}>
      <p className="muted">
        Explore <strong>Demo University</strong> with sample faculties, timetables and attendance. Pick the role you want to see it as.
      </p>
      <ErrorNote error={error} />
      <div className="role-list">
        {roles.map((r) => (
          <button type="button" key={r.key} className="role-option" disabled={Boolean(busy)} onClick={() => enter(r.key)}>
            <span className="role-icon">{ROLE_ICONS[r.key] || <UserRound size={20} />}</span>
            <span className="grow">
              <strong>{r.label}</strong>
              <small>{r.description}</small>
            </span>
            {busy === r.key ? <Loader2 size={16} className="spin role-go" /> : <ArrowRight size={16} className="role-go" />}
          </button>
        ))}
      </div>
      <p className="muted small">The demo is shared with other visitors, so please keep changes tidy.</p>
    </Modal>
  );
}

export default function Login() {
  const { user, login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [demoRoles, setDemoRoles] = useState<DemoRole[]>([]);
  const [picker, setPicker] = useState(false);
  const [forgot, setForgot] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = (attempt: number) =>
      api<{ available: boolean; roles: DemoRole[] }>('/api/auth/demo')
        .then((d) => !cancelled && setDemoRoles(d.available ? d.roles : []))
        .catch(() => {
          if (!cancelled && attempt < 5) setTimeout(() => load(attempt + 1), 2000 * attempt);
        });
    load(1);
    return () => {
      cancelled = true;
    };
  }, []);

  if (user) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <AuthAside />
      <main className="auth-main">
        <form className="auth-card" onSubmit={submit}>
          <div className="auth-mobile-brand">
            <GraduationCap size={24} /> eCampus
          </div>
          <h1>Sign in</h1>
          <p className="muted">Use the account your university administrator created for you.</p>
          <ErrorNote error={error} />
          <Field label="Email">
            <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </Field>
          <Field label="Password">
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <Button type="submit" loading={busy} icon={<LogIn size={16} />} className="block">
            Sign in
          </Button>
          <p className="center small m0">
            <button type="button" className="link" onClick={() => setForgot(true)}>
              Forgot your password?
            </button>
          </p>
          <p className="center muted small">
            New institution? <Link to="/register">Create your university</Link>
          </p>
          {demoRoles.length > 0 && (
            <>
              <div className="auth-divider">
                <span>or</span>
              </div>
              <button type="button" className="demo-link" onClick={() => setPicker(true)}>
                <PlayCircle size={18} /> Try the demo (no account needed)
              </button>
            </>
          )}
        </form>
      </main>
      <DemoPicker open={picker} roles={demoRoles} onClose={() => setPicker(false)} />
      <Modal open={forgot} onClose={() => setForgot(false)} title="Forgot your password?" footer={<Button onClick={() => setForgot(false)}>OK</Button>}>
        <p className="m0">Ask your university administrator, Dean or Head of Department to reset it. In eCampus they open <strong>Users</strong>, find your account and choose <strong>Reset password</strong>.</p>
        <p>They give you a temporary password; sign in with it and you will be asked to choose a new one.</p>
        <p className="muted small m0">University administrators who are locked out can ask the eCampus platform team to reset their account.</p>
      </Modal>
    </div>
  );
}
