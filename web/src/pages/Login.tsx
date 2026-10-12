import { FormEvent, useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { CalendarClock, ClipboardCheck, GraduationCap, LogIn, Workflow } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Button, ErrorNote, Field, Input } from '../components/ui';

const DEMO = [
  ['Administrator', 'admin@demo.edu'],
  ['Dean (Science & Technology)', 'dean.fst@demo.edu'],
  ['Head of Dept (Computer Science)', 'hod.cs@demo.edu'],
  ['Lecturer', 'brian.kato@demo.edu'],
  ['Class representative', 'rep.bscs1@students.demo.edu'],
  ['Student', 'student.bscs1@students.demo.edu'],
  ['Platform owner (SaaS)', 'owner@lms-platform.example'],
];
const DEMO_PASSWORD = 'Passw0rd!';

export function AuthAside() {
  return (
    <aside className="auth-aside">
      <div className="auth-brand">
        <GraduationCap size={30} />
        <span>Lecture Management System</span>
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

export default function Login() {
  const { user, login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    api('/api/health')
      .then((h) => setDemo(Boolean(h.demo)))
      .catch(() => {});
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
          <p className="center muted small">
            New institution? <Link to="/register">Create your university</Link>
          </p>
          {demo && (
            <div className="demo-box">
              <strong>Demo accounts</strong>
              <span className="muted small">Password for all: {DEMO_PASSWORD}</span>
              <div className="demo-grid">
                {DEMO.map(([label, mail]) => (
                  <button
                    type="button"
                    key={mail}
                    className="demo-chip"
                    onClick={() => {
                      setEmail(mail);
                      setPassword(DEMO_PASSWORD);
                    }}
                  >
                    <strong>{label}</strong>
                    <small>{mail}</small>
                  </button>
                ))}
              </div>
            </div>
          )}
        </form>
      </main>
    </div>
  );
}
