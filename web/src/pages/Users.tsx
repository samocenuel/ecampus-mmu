import { useState } from 'react';
import { BarChart3, Copy, KeyRound, Power, Smartphone, Upload } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useFeedback } from '../components/feedback';
import { FieldDef, ResourcePage } from '../components/ResourcePage';
import { Alert, Badge, Button, DataTable, Field, IconButton, Input, Modal, plural, Progress, rateTone, Select, Spinner, StatCard, Tabs, Textarea } from '../components/ui';
import { useFetch, usePersistentState } from '../hooks';
import { ROLE_LABELS, Role } from '../types';

type Tab = 'staff' | 'students' | 'admins';
const TAB_ROLES: Record<Tab, string> = { staff: 'lecturer,hod,dean', students: 'student', admins: 'admin,hr' };
const CREATABLE: Record<string, Role[]> = { admin: ['admin', 'hr', 'dean', 'hod', 'lecturer', 'student'], dean: ['hod', 'lecturer', 'student'], hod: ['lecturer', 'student'] };

export type TempInfo = { name: string; password: string; count?: number; reset?: boolean; email?: string };

export function TempPassword({ info, onClose }: { info: TempInfo | null; onClose: () => void }) {
  const { toast } = useFeedback();
  if (!info) return null;
  return (
    <Modal open onClose={onClose} title={info.reset ? 'Password reset' : 'Temporary password'} footer={<Button onClick={onClose}>Done</Button>}>
      <p>
        {info.reset
          ? `${info.name}${info.email ? ` (${info.email})` : ''} can now sign in with this temporary password, and will be asked to choose a new one straight away.`
          : `${info.count ? `${plural(info.count, 'account')} ${info.count === 1 ? 'was' : 'were'} created` : `${info.name}'s account was created`} with this temporary password. They will be asked to choose their own password at first sign-in.`}{' '}
        Share it securely: it is shown only once.
      </p>
      <div className="secret">
        <code>{info.password}</code>
        <IconButton label="Copy" onClick={() => navigator.clipboard?.writeText(info.password).then(() => toast('Copied'))}>
          <Copy size={16} />
        </IconButton>
      </div>
    </Modal>
  );
}

function ImportDialog({ tab, onClose, onDone }: { tab: Tab; onClose: () => void; onDone: (r: any) => void }) {
  const { data: classes } = useFetch<any[]>('/api/classes?mine=1');
  const { data: departments } = useFetch<any[]>('/api/departments');
  const { fail } = useFeedback();
  const [form, setForm] = useState({ role: tab === 'students' ? 'student' : 'lecturer', class_id: '', department_id: '', csv: '', default_password: '' });
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api('/api/users/import', { method: 'POST', body: form });
      setResult(r);
      onDone(r);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="Import accounts from CSV"
      footer={
        result ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button icon={<Upload size={16} />} loading={busy} onClick={run} disabled={!form.csv.trim()}>
              Import
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="stack">
          <Alert tone={result.errors.length ? 'warning' : 'success'} title={`${plural(result.created, 'account')} created`}>
            {result.errors.length > 0 && (
              <ul className="detail-list">
                {result.errors.map((e: any) => (
                  <li key={e.line}>
                    Line {e.line}: {e.error}
                  </li>
                ))}
              </ul>
            )}
          </Alert>
        </div>
      ) : (
        <div className="form-grid">
          <Field label="Account type">
            <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} options={[{ value: 'student', label: 'Students' }, { value: 'lecturer', label: 'Lecturers' }]} />
          </Field>
          {form.role === 'student' ? (
            <Field label="Class *">
              <Select value={form.class_id} onChange={(e) => setForm({ ...form, class_id: e.target.value })} placeholder="Select class..." options={(classes || []).map((c) => ({ value: c.id, label: c.name }))} />
            </Field>
          ) : (
            <Field label="Department">
              <Select value={form.department_id} onChange={(e) => setForm({ ...form, department_id: e.target.value })} placeholder="Select..." options={(departments || []).map((d) => ({ value: d.id, label: d.name }))} />
            </Field>
          )}
          <Field label="CSV - one per line: name,email,registration/staff no,phone" span={2}>
            <Textarea rows={8} value={form.csv} onChange={(e) => setForm({ ...form, csv: e.target.value })} placeholder={'Jane Doe,jane.doe@example.edu,2026/BSCS/0101,+256700000000\nJohn Okot,john.okot@example.edu,2026/BSCS/0102'} />
          </Field>
          <Field label="Password for all imported accounts" help="Leave blank to generate one temporary password" span={2}>
            <Input value={form.default_password} onChange={(e) => setForm({ ...form, default_password: e.target.value })} minLength={8} />
          </Field>
        </div>
      )}
    </Modal>
  );
}

function StudentHistory({ student, onClose }: { student: any; onClose: () => void }) {
  const { data, loading, error } = useFetch<any>(`/api/attendance/students/${student.id}/history`);
  return (
    <Modal open wide onClose={onClose} title={`${student.name} - attendance`}>
      {loading && !data && <Spinner />}
      {error && <Alert tone="danger">{error}</Alert>}
      {data && (
        <div className="stack">
          <div className="stat-grid compact">
            <StatCard label="Overall" value={data.summary.rate !== null ? `${data.summary.rate}%` : '-'} tone={rateTone(data.summary.rate) === 'danger' ? 'danger' : 'success'} />
            <StatCard label="Attended" value={`${data.summary.attended}/${data.summary.total}`} />
          </div>
          {data.courses.map((c: any) => (
            <div key={c.course_unit_id} className="course-rate">
              <div className="row between">
                <span>
                  <strong>{c.code}</strong> {c.name}
                </span>
                <strong>{c.rate !== null ? `${c.rate}%` : '-'}</strong>
              </div>
              <Progress value={c.attended} total={c.total} tone={rateTone(c.rate)} />
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export default function Users() {
  const { user } = useAuth();
  const { toast, fail, confirm } = useFeedback();
  const [tab, setTab] = usePersistentState<Tab>('lms_users_tab', 'staff');
  const [temp, setTemp] = useState<TempInfo | null>(null);
  const [importing, setImporting] = useState(false);
  const [history, setHistory] = useState<any>(null);
  const [version, setVersion] = useState(0);
  const { data: faculties } = useFetch<any[]>('/api/faculties');
  const { data: departments } = useFetch<any[]>('/api/departments');
  const { data: classes } = useFetch<any[]>('/api/classes');
  const creatable = (CREATABLE[user!.role] || []).filter((r) => TAB_ROLES[tab].split(',').includes(r));
  const tabs = [
    { value: 'staff' as Tab, label: user!.role === 'admin' ? 'Lecturers, HoDs & Deans' : user!.role === 'dean' ? 'Faculty staff' : 'Department staff' },
    { value: 'students' as Tab, label: 'Students' },
    ...(user!.role === 'admin' ? [{ value: 'admins' as Tab, label: 'Administrators & HR' }] : []),
  ];

  const fields: FieldDef[] = [
    { name: 'role', label: 'Role', type: 'select', required: true, noPlaceholder: true, defaultValue: creatable[creatable.length - 1], options: creatable.map((r) => ({ value: r, label: ROLE_LABELS[r] })) },
    { name: 'title', label: 'Title', placeholder: 'Dr., Prof., Mr., Ms.', showIf: (f) => f.role !== 'student' },
    { name: 'name', label: 'Full name', required: true, span: 2 },
    { name: 'email', label: 'Email', type: 'email', required: true },
    { name: 'phone', label: 'Phone', type: 'tel' },
    { name: 'identifier', label: tab === 'students' ? 'Registration number' : 'Staff number' },
    {
      name: 'employment_type',
      label: 'Employment',
      type: 'select',
      noPlaceholder: true,
      defaultValue: 'full_time',
      showIf: (f) => ['lecturer', 'hod', 'dean'].includes(f.role),
      options: [
        { value: 'full_time', label: 'Full-time' },
        { value: 'part_time', label: 'Part-time (paid per hour and task)' },
      ],
    },
    { name: 'faculty_id', label: 'Faculty', type: 'select', showIf: (f) => f.role === 'dean', options: (faculties || []).map((x) => ({ value: x.id, label: x.name })), help: 'A new Dean is appointed to the faculty if it has none.' },
    {
      name: 'department_id',
      label: 'Department',
      type: 'select',
      showIf: (f) => ['hod', 'lecturer'].includes(f.role),
      options: (departments || []).map((x) => ({ value: x.id, label: x.name })),
      help: 'A new HoD is appointed to the department if it has none.',
    },
    { name: 'class_id', label: 'Class', type: 'select', required: true, showIf: (f) => f.role === 'student', options: (classes || []).map((x) => ({ value: x.id, label: x.name })) },
    { name: 'password', label: 'Password', type: 'password', placeholder: 'Leave blank to generate a temporary password', span: 2, showIf: (_f, editing) => !editing },
  ];

  const resetPassword = async (u: any) => {
    if (!(await confirm({ title: `Reset ${u.name}'s password?`, message: 'Their current password stops working. You get a temporary password to give them, and they choose a new one when they sign in.', confirmLabel: 'Reset password' }))) return;
    try {
      const r = await api<any>(`/api/users/${u.id}/reset-password`, { method: 'POST' });
      setTemp({ name: r.name, email: r.email, password: r.temporary_password, reset: true });
    } catch (err) {
      fail(err);
    }
  };

  const resetPhone = async (u: any) => {
    try {
      await api(`/api/users/${u.id}/reset-device`, { method: 'POST' });
      toast(`${u.name} can now check in from a new phone`);
    } catch (err) {
      fail(err);
    }
  };

  const toggleActive = async (u: any, reload: () => void) => {
    try {
      await api(`/api/users/${u.id}`, { method: 'PUT', body: { active: !u.active } });
      toast(u.active ? `${u.name} deactivated` : `${u.name} reactivated`);
      reload();
    } catch (err) {
      fail(err);
    }
  };

  return (
    <>
      <ResourcePage
        key={`${tab}-${version}`}
        title="Users"
        subtitle={
          user!.role === 'admin'
            ? 'Accounts for administrators, Deans, Heads of Department, lecturers and students.'
            : `Staff and students of ${user!.role === 'dean' ? user!.faculty_name || 'your faculty' : user!.department_name || 'your department'}.`
        }
        noun={tab === 'students' ? 'Student' : tab === 'admins' ? 'Account' : 'Staff member'}
        endpoint="/api/users"
        query={`?roles=${TAB_ROLES[tab]}`}
        searchKeys={['name', 'email', 'identifier', 'department_name', 'class_name']}
        canCreate={creatable.length > 0}
        canEdit={(u: any) => (CREATABLE[user!.role] || []).includes(u.role)}
        headerActions={() =>
          tab !== 'admins' && (
            <Button variant="secondary" icon={<Upload size={16} />} onClick={() => setImporting(true)}>
              Import CSV
            </Button>
          )
        }
        before={() => <Tabs value={tab} onChange={setTab} tabs={tabs} />}
        columns={[
          {
            key: 'name',
            header: 'Name',
            render: (u: any) => (
              <>
                <strong>
                  {u.title ? `${u.title} ` : ''}
                  {u.name}
                </strong>{' '}
                {u.is_class_rep ? <Badge tone="primary">Class rep</Badge> : null}
                {u.employment_type === 'part_time' ? <Badge tone="info">Part-time</Badge> : null}
                <div className="muted small">{u.email}</div>
              </>
            ),
          },
          { key: 'role', header: 'Role', render: (u: any) => ROLE_LABELS[u.role as Role], hideOnMobile: tab === 'students' },
          { key: 'identifier', header: tab === 'students' ? 'Reg. no.' : 'Staff no.', hideOnMobile: true },
          { key: 'unit', header: tab === 'students' ? 'Class' : 'Unit', render: (u: any) => u.class_name || u.department_name || u.faculty_name || (u.role === 'hr' ? 'Directorate' : '-') },
          { key: 'active', header: 'Status', render: (u: any) => (u.active ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>) },
        ]}
        rowActions={(u: any, reload) => (
          <>
            {u.role === 'student' && (
              <IconButton label="Attendance" onClick={() => setHistory(u)}>
                <BarChart3 size={16} />
              </IconButton>
            )}
            {u.role === 'student' && u.has_device && (CREATABLE[user!.role] || []).includes('student') && (
              <IconButton label="Reset registered phone (student changed phones)" onClick={() => resetPhone(u)}>
                <Smartphone size={16} />
              </IconButton>
            )}
            {u.id !== user!.id && (CREATABLE[user!.role] || []).includes(u.role) && (
              <IconButton label="Reset password" onClick={() => resetPassword(u)}>
                <KeyRound size={16} />
              </IconButton>
            )}
            {u.id !== user!.id && (CREATABLE[user!.role] || []).includes(u.role) && (
              <IconButton label={u.active ? 'Deactivate' : 'Reactivate'} className={u.active ? 'danger' : ''} onClick={() => toggleActive(u, reload)}>
                <Power size={16} />
              </IconButton>
            )}
          </>
        )}
        fields={fields}
        fromRow={(u: any) => ({ role: u.role, employment_type: u.employment_type || 'full_time', title: u.title || '', name: u.name, email: u.email, phone: u.phone || '', identifier: u.identifier || '', faculty_id: u.faculty_id || '', department_id: u.department_id || '', class_id: u.class_id || '', password: '' })}
        toPayload={(f) => {
          const body: any = { ...f };
          for (const k of ['faculty_id', 'department_id', 'class_id']) body[k] = body[k] || null;
          if (!['lecturer', 'hod', 'dean'].includes(body.role)) delete body.employment_type;
          if (!body.password) delete body.password;
          return body;
        }}
        onSaved={(r, created) => created && r.temporary_password && setTemp({ name: r.name, password: r.temporary_password })}
      />
      <TempPassword info={temp} onClose={() => setTemp(null)} />
      {importing && (
        <ImportDialog
          tab={tab}
          onClose={() => setImporting(false)}
          onDone={(r) => {
            setVersion((v) => v + 1);
            if (r.temporary_password && r.created) setTemp({ name: '', password: r.temporary_password, count: r.created });
          }}
        />
      )}
      {history && <StudentHistory student={history} onClose={() => setHistory(null)} />}
    </>
  );
}
