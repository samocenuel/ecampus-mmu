import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Check, CheckCheck, CircleCheck, CircleX, ClipboardList, Search, X } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useFeedback } from '../components/feedback';
import { SessionRow } from '../components/WeekGrid';
import {
  Alert, Badge, Button, Card, Checkbox, DataTable, EmptyState, ErrorNote, Field, Input, Modal, PageHeader, Progress, rateTone, Select, Spinner, StatCard, Tabs, Textarea,
} from '../components/ui';
import { useFetch } from '../hooks';
import { MANAGER_ROLES, TEACHING_ROLES } from '../types';

const STATUS_TONE: Record<string, 'warning' | 'success' | 'danger'> = { submitted: 'warning', approved: 'success', rejected: 'danger' };
const STATUS_LABEL: Record<string, string> = { submitted: 'Awaiting approval', approved: 'Approved', rejected: 'Rejected' };
export const StatusBadge = ({ status }: { status: string }) => <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status] || status}</Badge>;

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const niceDate = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

/** The class rep's register: tick everyone who is present. */
function RegisterSheet({ item, date, onClose, onSaved }: { item: any; date: string; onClose: () => void; onSaved: () => void }) {
  const { toast, fail } = useFeedback();
  const { data, loading, error } = useFetch<any>(`/api/attendance/sessions/${item.session.id}/sheet?class_id=${item.class_id}&date=${date}`);
  const [present, setPresent] = useState<Set<number>>(new Set());
  const [topic, setTopic] = useState('');
  const [note, setNote] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    setPresent(new Set(data.students.filter((s: any) => s.present).map((s: any) => s.id)));
    setTopic(data.register?.topic || '');
    setNote(data.register?.note || '');
  }, [data]);

  const students = useMemo(() => (data?.students || []).filter((s: any) => `${s.name} ${s.identifier || ''}`.toLowerCase().includes(query.toLowerCase())), [data, query]);
  const toggle = (id: number, on: boolean) =>
    setPresent((p) => {
      const n = new Set(p);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const submit = async () => {
    setBusy(true);
    try {
      await api('/api/attendance/registers', {
        method: 'POST',
        body: { session_id: item.session.id, class_id: item.class_id, date, present_student_ids: [...present], topic, note },
      });
      toast('Attendance submitted to the lecturer for approval');
      onSaved();
      onClose();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const canEdit = data?.can_edit;
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={`${item.session.course_code} · ${item.class_name}`}
      footer={
        canEdit ? (
          <>
            <span className="muted mr-auto">
              {present.size} of {data?.students.length || 0} present
            </span>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button icon={<Check size={16} />} onClick={submit} loading={busy}>
              {data?.register ? 'Resubmit' : 'Submit for approval'}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Close</Button>
        )
      }
    >
      <p className="muted">
        {item.session.course_name} · {niceDate(date)} · {item.session.start_time}-{item.session.end_time} · {item.session.room_name}
      </p>
      <ErrorNote error={error} />
      {loading && <Spinner />}
      {data?.register && (
        <Alert tone={data.register.status === 'approved' ? 'success' : data.register.status === 'rejected' ? 'danger' : 'warning'} title={STATUS_LABEL[data.register.status]}>
          {data.register.status === 'rejected' && <>Lecturer's note: {data.register.review_note}. Correct the list and resubmit.</>}
          {data.register.status === 'approved' && <>Approved by {data.register.reviewed_by_name}. It can no longer be changed.</>}
          {data.register.status === 'submitted' && <>Waiting for {data.register.lecturer_name} to approve. You can still make corrections.</>}
        </Alert>
      )}
      {data && (
        <>
          {canEdit && (
            <div className="form-grid">
              <Field label="Topic covered">
                <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Optional" />
              </Field>
              <Field label="Note to lecturer">
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
              </Field>
            </div>
          )}
          <div className="sheet-toolbar">
            <div className="search">
              <Search size={16} />
              <input placeholder="Find a student..." value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            {canEdit && (
              <>
                <Button size="sm" variant="secondary" icon={<CheckCheck size={14} />} onClick={() => setPresent(new Set(data.students.map((s: any) => s.id)))}>
                  All present
                </Button>
                <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={() => setPresent(new Set())}>
                  Clear
                </Button>
              </>
            )}
          </div>
          <div className="sheet">
            {students.map((s: any) => (
              <label key={s.id} className={`sheet-row ${present.has(s.id) ? 'present' : ''}`}>
                <input type="checkbox" checked={present.has(s.id)} disabled={!canEdit} onChange={(e) => toggle(s.id, e.target.checked)} />
                <span className="grow">
                  <strong>{s.name}</strong>
                  <small className="muted">{s.identifier}</small>
                </span>
                {present.has(s.id) ? <Badge tone="success">Present</Badge> : <Badge>Absent</Badge>}
              </label>
            ))}
            {!students.length && <EmptyState title="No students found" />}
          </div>
        </>
      )}
    </Modal>
  );
}

/** Lecturer (or manager) review of a submitted register. */
export function RegisterReview({ id, onDone, onClose }: { id: number; onDone?: () => void; onClose?: () => void }) {
  const { toast, fail } = useFeedback();
  const { data, loading, error, reload } = useFetch<any>(`/api/attendance/registers/${id}`);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const review = async (action: 'approve' | 'reject') => {
    if (action === 'reject' && !note.trim()) return fail(new Error('Add a note explaining why the register is rejected'));
    setBusy(action);
    try {
      await api(`/api/attendance/registers/${id}/review`, { method: 'POST', body: { action, note } });
      toast(action === 'approve' ? 'Register approved' : 'Register returned to the class rep');
      reload();
      onDone?.();
      onClose?.();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  if (loading && !data) return <Spinner />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;
  const present = data.students.filter((s: any) => s.present);
  const absent = data.students.filter((s: any) => !s.present);
  return (
    <div className="stack">
      <div className="row between wrap gap-sm">
        <div>
          <h3 className="m0">
            {data.course_code} {data.course_name}
          </h3>
          <div className="muted">
            {data.class_name} · {niceDate(data.lecture_date)} · {data.start_time}-{data.end_time} · {data.room_name}
          </div>
          <div className="muted small">
            Submitted by {data.submitted_by_name || '-'} {data.topic ? `· Topic: ${data.topic}` : ''} {data.note ? `· Note: ${data.note}` : ''}
          </div>
        </div>
        <StatusBadge status={data.status} />
      </div>
      <div className="stat-grid compact">
        <StatCard label="Present" value={present.length} tone="success" />
        <StatCard label="Absent" value={absent.length} tone={absent.length ? 'danger' : undefined} />
        <StatCard label="Attendance" value={`${data.total ? Math.round((present.length / data.total) * 100) : 0}%`} />
      </div>
      {data.review_note && <Alert tone={data.status === 'rejected' ? 'danger' : 'info'} title="Review note">{data.review_note}</Alert>}
      <div className="grid-2">
        <Card title={`Present (${present.length})`}>
          <ul className="name-list">
            {present.map((s: any) => (
              <li key={s.id}>
                <CircleCheck size={15} className="text-success" /> {s.name} <small className="muted">{s.identifier}</small>
              </li>
            ))}
          </ul>
        </Card>
        <Card title={`Absent (${absent.length})`}>
          <ul className="name-list">
            {absent.map((s: any) => (
              <li key={s.id}>
                <CircleX size={15} className="text-danger" /> {s.name} <small className="muted">{s.identifier}</small>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      {data.can_review && (
        <Card title="Your decision">
          <Field label="Note (required when rejecting)">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Two students marked present were absent" />
          </Field>
          <div className="row gap-sm">
            <Button variant="success" icon={<Check size={16} />} loading={busy === 'approve'} onClick={() => review('approve')}>
              Approve list
            </Button>
            <Button variant="danger" icon={<X size={16} />} loading={busy === 'reject'} onClick={() => review('reject')}>
              Reject
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function SessionsForDate({ role }: { role: 'rep' | 'lecturer' }) {
  const [date, setDate] = useState(localToday());
  const { data, loading, error, reload } = useFetch<any>(`/api/attendance/sessions?date=${date}`);
  const [open, setOpen] = useState<any>(null);
  const [review, setReview] = useState<number | null>(null);
  const items = (data?.items || []).filter((i: any) => i.role === role);

  return (
    <Card
      title={role === 'rep' ? 'Take attendance' : 'My lectures'}
      actions={<Input type="date" value={date} max={localToday()} onChange={(e) => setDate(e.target.value)} aria-label="Lecture date" />}
    >
      <ErrorNote error={error} />
      {loading && !data && <Spinner />}
      {data && !items.length && <EmptyState title={`No lectures on ${data.day_name || 'this day'}`} icon={<ClipboardList size={26} />} />}
      {items.map((i: any) => (
        <SessionRow
          key={`${i.session.id}-${i.class_id}`}
          s={i.session}
          showClasses={role === 'lecturer'}
          onClick={() => (role === 'rep' ? setOpen(i) : i.register && setReview(i.register.id))}
          extra={
            <div className="session-extra">
              {role === 'lecturer' && <small className="muted">{i.class_name}</small>}
              {i.register ? <StatusBadge status={i.register.status} /> : i.not_started ? <Badge>Not started</Badge> : <Badge tone="info">Not taken</Badge>}
              {role === 'rep' && i.can_submit && !i.register && <Button size="sm">Take</Button>}
            </div>
          }
        />
      ))}
      {open && <RegisterSheet item={open} date={date} onClose={() => setOpen(null)} onSaved={reload} />}
      {review && (
        <Modal open wide title="Attendance register" onClose={() => setReview(null)}>
          <RegisterReview id={review} onDone={reload} />
        </Modal>
      )}
    </Card>
  );
}

function RegisterList({ status, title }: { status?: string; title: string }) {
  const [filter, setFilter] = useState(status || '');
  const { data, loading, error, reload } = useFetch<any[]>(`/api/attendance/registers${filter ? `?status=${filter}` : ''}`);
  const [review, setReview] = useState<number | null>(null);
  return (
    <Card
      title={title}
      padded={false}
      actions={
        !status && (
          <Select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Status"
            options={[
              { value: '', label: 'All statuses' },
              { value: 'submitted', label: 'Awaiting approval' },
              { value: 'approved', label: 'Approved' },
              { value: 'rejected', label: 'Rejected' },
            ]}
          />
        )
      }
    >
      <ErrorNote error={error} />
      <DataTable
        rows={data}
        loading={loading}
        searchKeys={['course_code', 'course_name', 'class_name', 'lecturer_name']}
        empty={status === 'submitted' ? 'Nothing waiting for approval' : 'No registers yet'}
        onRowClick={(r) => setReview(r.id)}
        columns={[
          { key: 'lecture_date', header: 'Date', render: (r) => <>{niceDate(r.lecture_date)}<div className="muted small">{r.start_time}-{r.end_time}</div></> },
          { key: 'course_code', header: 'Course unit', render: (r) => <><strong>{r.course_code}</strong><div className="muted small">{r.course_name}</div></> },
          { key: 'class_name', header: 'Class' },
          { key: 'lecturer_name', header: 'Lecturer', hideOnMobile: true },
          { key: 'present_count', header: 'Present', render: (r) => `${r.present_count}/${r.total}` },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
        ]}
      />
      {review && (
        <Modal open wide title="Attendance register" onClose={() => setReview(null)}>
          <RegisterReview id={review} onDone={reload} onClose={() => setReview(null)} />
        </Modal>
      )}
    </Card>
  );
}

function MyAttendance() {
  const { data, loading, error } = useFetch<any>('/api/attendance/my-history');
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;
  return (
    <div className="stack">
      <div className="stat-grid">
        <StatCard label="Overall attendance" value={data.summary.rate !== null ? `${data.summary.rate}%` : '-'} tone={rateTone(data.summary.rate) === 'danger' ? 'danger' : 'success'} hint="Approved registers only" />
        <StatCard label="Lectures attended" value={data.summary.attended} />
        <StatCard label="Lectures recorded" value={data.summary.total} />
      </div>
      {data.summary.rate !== null && data.summary.rate < 75 && (
        <Alert tone="danger" title="Your attendance is below 75%">Many universities require at least 75% attendance to sit final examinations.</Alert>
      )}
      <Card title="By course unit">
        {data.courses.length === 0 && <EmptyState title="No attendance recorded yet" />}
        <div className="course-rates">
          {data.courses.map((c: any) => (
            <div key={c.course_unit_id} className="course-rate">
              <div className="row between">
                <span>
                  <strong>{c.code}</strong> {c.name}
                </span>
                <strong className={`text-${rateTone(c.rate) || 'muted'}`}>{c.rate !== null ? `${c.rate}%` : '-'}</strong>
              </div>
              <Progress value={c.attended} total={c.total} tone={rateTone(c.rate)} />
              <small className="muted">
                {c.attended}/{c.total} attended{c.pending ? ` · ${c.pending} awaiting approval` : ''} · {c.lecturer_name}
              </small>
            </div>
          ))}
        </div>
      </Card>
      <Card title="History" padded={false}>
        <DataTable
          rows={data.records.map((r: any) => ({ ...r, id: r.register_id }))}
          searchKeys={['course_code', 'course_name']}
          columns={[
            { key: 'lecture_date', header: 'Date', render: (r) => niceDate(r.lecture_date) },
            { key: 'start_time', header: 'Time', render: (r) => `${r.start_time}-${r.end_time}`, hideOnMobile: true },
            { key: 'course_code', header: 'Course unit', render: (r) => <><strong>{r.course_code}</strong> <span className="muted hide-sm">{r.course_name}</span></> },
            { key: 'present', header: 'Attendance', render: (r) => (r.present ? <Badge tone="success">Present</Badge> : <Badge tone="danger">Absent</Badge>) },
            { key: 'status', header: 'Register', render: (r) => <StatusBadge status={r.status} />, hideOnMobile: true },
          ]}
        />
      </Card>
    </div>
  );
}

export default function Attendance() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const isRep = Boolean(user?.is_class_rep);
  const teaches = TEACHING_ROLES.includes(user!.role);
  const manages = MANAGER_ROLES.includes(user!.role);
  const tabs = [
    ...(isRep ? [{ value: 'take', label: 'Take attendance' }] : []),
    ...(teaches ? [{ value: 'lectures', label: 'My lectures' }] : []),
    ...(teaches || manages ? [{ value: 'approvals', label: 'Approvals' }] : []),
    ...(teaches || manages || isRep ? [{ value: 'registers', label: isRep && !teaches ? 'Submitted registers' : 'All registers' }] : []),
    ...(user!.role === 'student' ? [{ value: 'mine', label: 'My attendance' }] : []),
  ];
  const tab = tabs.some((t) => t.value === params.get('tab')) ? params.get('tab')! : tabs[0]?.value;

  return (
    <>
      <PageHeader
        title="Attendance"
        subtitle={
          isRep
            ? `You are class representative for ${user!.rep_classes?.map((c) => c.name).join(', ')}. Mark who is present; your lecturer approves the list.`
            : teaches
              ? 'Review and approve the attendance lists submitted by class representatives.'
              : user!.role === 'student'
                ? 'Your attendance history across all course units.'
                : 'Attendance registers across your unit.'
        }
      />
      {tabs.length > 1 && <Tabs value={tab} onChange={(v) => setParams({ tab: v })} tabs={tabs} />}
      <div className="stack">
        {tab === 'take' && <SessionsForDate role="rep" />}
        {tab === 'lectures' && <SessionsForDate role="lecturer" />}
        {tab === 'approvals' && <RegisterList status="submitted" title="Waiting for approval" />}
        {tab === 'registers' && <RegisterList title="Registers" />}
        {tab === 'mine' && <MyAttendance />}
      </div>
    </>
  );
}

export function RegisterPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader
        title="Attendance register"
        actions={
          <Button variant="secondary" icon={<ArrowLeft size={16} />} onClick={() => navigate('/attendance')}>
            Back
          </Button>
        }
      />
      <Card>
        <RegisterReview id={Number(id)} />
      </Card>
      <p className="muted small">
        <Link to="/attendance?tab=approvals">See all registers waiting for approval</Link>
      </p>
    </>
  );
}
