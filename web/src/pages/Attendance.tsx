import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Check, CheckCheck, CircleCheck, CircleX, ClipboardList, Download, FileSpreadsheet, FileText, MessageSquareWarning, QrCode, Search, X } from 'lucide-react';
import { api, download } from '../api';
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
const METHOD_LABEL: Record<string, string> = { qr: 'phone', manual: 'manual', correction: 'corrected', rep: 'class rep' };
export const MethodTag = ({ method }: { method?: string | null }) => (method && METHOD_LABEL[method] ? <small className="muted"> · {METHOD_LABEL[method]}</small> : null);

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
/** PDF and Excel buttons for a file the API builds. */
function DownloadButtons({ path, name, size = 'sm' }: { path: string; name: string; size?: 'sm' | 'md' }) {
  const { fail } = useFeedback();
  const [busy, setBusy] = useState<string | null>(null);
  const get = async (format: 'pdf' | 'xlsx') => {
    setBusy(format);
    try {
      await download(`${path}${path.includes('?') ? '&' : '?'}format=${format}`, `${name}.${format}`);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="row gap-sm">
      <Button size={size} variant="secondary" icon={<FileText size={14} />} loading={busy === 'pdf'} onClick={() => get('pdf')}>
        PDF
      </Button>
      <Button size={size} variant="secondary" icon={<FileSpreadsheet size={14} />} loading={busy === 'xlsx'} onClick={() => get('xlsx')}>
        Excel
      </Button>
    </div>
  );
}

/** Term attendance sheet: pick a course unit and class, get every lecture with P / A and each student's percentage. */
function DownloadSheet({ onClose }: { onClose: () => void }) {
  const { data, loading, error } = useFetch<any>('/api/attendance/sheets');
  const [allocationId, setAllocationId] = useState<string>('');
  const [classId, setClassId] = useState<string>('');
  const items: any[] = data?.items || [];
  const item = items.find((i) => String(i.allocation_id) === allocationId) || items[0];
  const cls = item?.classes.find((c: any) => String(c.id) === classId) || item?.classes[0];
  return (
    <Modal open onClose={onClose} title="Download attendance" footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <ErrorNote error={error} />
      {loading && <Spinner />}
      {data && !items.length && <p className="muted m0">No course units to download for {data.term?.name || 'this term'}.</p>}
      {item && (
        <div className="stack">
          <p className="muted m0">
            One sheet per class for {data.term?.name}: every lecture with approved attendance, P or A for each student, and their percentage. Students below the exam requirement are highlighted.
          </p>
          <Field label="Course unit">
            <Select
              value={String(item.allocation_id)}
              onChange={(e) => {
                setAllocationId(e.target.value);
                setClassId('');
              }}
              options={items.map((i) => ({ value: String(i.allocation_id), label: `${i.course_code} ${i.course_name} (${i.lecturer_name})` }))}
            />
          </Field>
          {item.classes.length > 1 && (
            <Field label="Class">
              <Select value={String(cls.id)} onChange={(e) => setClassId(e.target.value)} options={item.classes.map((c: any) => ({ value: String(c.id), label: c.name }))} />
            </Field>
          )}
          <div className="row between wrap gap-sm">
            <span className="muted small">{item.registers ? `${item.registers} approved registers` : 'No approved registers yet'}</span>
            <DownloadButtons size="md" path={`/api/attendance/sheets/export?allocation_id=${item.allocation_id}&class_id=${cls.id}`} name={`attendance-${item.course_code}-${cls.name}`.replace(/\s+/g, '-')} />
          </div>
        </div>
      )}
    </Modal>
  );
}

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
            Submitted by {data.submitted_by_name || '-'} {data.topic ? `· Topic: ${data.topic}` : ''} {data.note ? `· Note: ${data.note}` : ''} {data.source === 'qr' ? `· QR check-in: ${data.self_checkins} scanned by phone` : ''}
          </div>
        </div>
        <div className="row gap-sm wrap">
          <StatusBadge status={data.status} />
          <DownloadButtons path={`/api/attendance/registers/${id}/export`} name={`attendance-${data.course_code}-${data.class_name}-${data.lecture_date}`.replace(/\s+/g, '-')} />
        </div>
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
                <CircleCheck size={15} className="text-success" /> {s.name} <small className="muted">{s.identifier}</small><MethodTag method={s.method} />
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
  const navigate = useNavigate();
  const { fail } = useFeedback();
  const [date, setDate] = useState(localToday());
  const startCheckin = async (i: any) => {
    try {
      const r = await api('/api/checkin/start', { method: 'POST', body: { session_id: i.session.id, date } });
      navigate(`/checkin/${r.id}`);
    } catch (err) {
      fail(err);
    }
  };
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
          onClick={() => (role === 'rep' ? (i.checkin ? navigate(`/checkin/${i.checkin.id}`) : setOpen(i)) : i.register && setReview(i.register.id))}
          extra={
            <div className="session-extra">
              {role === 'lecturer' && <small className="muted">{i.class_name}</small>}
              {i.register ? <StatusBadge status={i.register.status} /> : i.not_started ? <Badge>Not started</Badge> : <Badge tone="info">Not taken</Badge>}
              {i.checkin && (
                <Button size="sm" variant={i.checkin.open ? 'success' : 'secondary'} icon={<QrCode size={14} />} onClick={(e) => { e.stopPropagation(); navigate(`/checkin/${i.checkin.id}`); }}>
                  {i.checkin.open ? 'QR check-in open' : 'QR check-in'}
                </Button>
              )}
              {role === 'lecturer' && !i.checkin && !i.register && date === localToday() && !i.not_started && (
                <Button size="sm" icon={<QrCode size={14} />} onClick={(e) => { e.stopPropagation(); startCheckin(i); }}>
                  Start check-in
                </Button>
              )}
              {role === 'rep' && i.can_submit && !i.register && !i.checkin && <Button size="sm">Take</Button>}
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

function Corrections() {
  const { fail, toast } = useFeedback();
  const { data, loading, error, reload } = useFetch<any[]>('/api/attendance/corrections');
  const [deciding, setDeciding] = useState<{ c: any; action: 'approve' | 'reject' } | null>(null);
  const [note, setNote] = useState('');
  const decide = async () => {
    try {
      await api(`/api/attendance/corrections/${deciding!.c.id}/review`, { method: 'POST', body: { action: deciding!.action, note } });
      toast(deciding!.action === 'approve' ? 'Marked present' : 'Correction rejected');
      setDeciding(null);
      setNote('');
      reload();
    } catch (err) {
      fail(err);
    }
  };
  return (
    <Card title="Correction requests" padded={false}>
      <ErrorNote error={error} />
      <DataTable
        rows={data}
        loading={loading}
        searchKeys={['student_name', 'student_identifier', 'course_code', 'class_name']}
        empty="No correction requests"
        columns={[
          { key: 'student_name', header: 'Student', render: (c: any) => <><strong>{c.student_name}</strong><div className="muted small">{c.student_identifier} · {c.class_name}</div></> },
          { key: 'lecture_date', header: 'Lecture', render: (c: any) => <><strong>{c.course_code}</strong> {niceDate(c.lecture_date)}<div className="muted small">{c.start_time}-{c.end_time}</div></> },
          { key: 'note', header: 'Student says', render: (c: any) => <span className="small">{c.note}</span> },
          {
            key: 'status',
            header: '',
            align: 'right',
            render: (c: any) =>
              c.status === 'submitted' ? (
                <div className="row-actions">
                  <Button size="sm" variant="success" onClick={() => setDeciding({ c, action: 'approve' })}>Mark present</Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeciding({ c, action: 'reject' })}>Reject</Button>
                </div>
              ) : (
                <><StatusBadge status={c.status} />{c.reviewed_by_name && <div className="muted small">{c.reviewed_by_name}</div>}</>
              ),
          },
        ]}
      />
      {deciding && (
        <Modal
          open
          title={deciding.action === 'approve' ? `Mark ${deciding.c.student_name} present?` : 'Reject this correction?'}
          onClose={() => setDeciding(null)}
          footer={<><Button variant="secondary" onClick={() => setDeciding(null)}>Cancel</Button><Button variant={deciding.action === 'approve' ? 'success' : 'danger'} disabled={deciding.action === 'reject' && !note.trim()} onClick={decide}>{deciding.action === 'approve' ? 'Mark present' : 'Reject'}</Button></>}
        >
          <p className="m0">"{deciding.c.note}"</p>
          <Field label={deciding.action === 'reject' ? 'Reason *' : 'Note (optional)'}>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </Modal>
      )}
    </Card>
  );
}

function RequestCorrection({ record, onClose, onDone }: { record: any; onClose: () => void; onDone: () => void }) {
  const { fail, toast } = useFeedback();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await api('/api/attendance/corrections', { method: 'POST', body: { register_id: record.register_id, note } });
      toast('Request sent to your lecturer');
      onDone();
      onClose();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open title={`${record.course_code} on ${niceDate(record.lecture_date)}`} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={note.trim().length < 5} onClick={send}>Send request</Button></>}>
      <p className="muted m0">You are marked absent. If you attended but could not check in (flat battery, no network), tell your lecturer. Requests are accepted for a short time after the lecture.</p>
      <Field label="What happened? *">
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. My phone battery died; I sat in the front row" />
      </Field>
    </Modal>
  );
}

function MyAttendance() {
  const { data, loading, error, reload } = useFetch<any>('/api/attendance/my-history');
  const [correcting, setCorrecting] = useState<any>(null);
  const recent = (d: string) => (Date.now() - new Date(`${d}T12:00:00`).getTime()) / 86400000 <= 3;
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
            { key: 'present', header: 'Attendance', render: (r) => (r.present ? <><Badge tone="success">Present</Badge><MethodTag method={r.method} /></> : <Badge tone="danger">Absent</Badge>) },
            { key: 'status', header: 'Register', render: (r) => <StatusBadge status={r.status} />, hideOnMobile: true },
            {
              key: '_c',
              header: '',
              align: 'right',
              render: (r: any) =>
                r.correction_status ? (
                  <Badge tone={r.correction_status === 'approved' ? 'success' : r.correction_status === 'rejected' ? 'danger' : 'warning'}>Correction {r.correction_status === 'submitted' ? 'pending' : r.correction_status}</Badge>
                ) : (
                  !r.present && recent(r.lecture_date) && (
                    <Button size="sm" variant="ghost" icon={<MessageSquareWarning size={14} />} onClick={() => setCorrecting(r)}>
                      I was there
                    </Button>
                  )
                ),
            },
          ]}
        />
      </Card>
      {correcting && <RequestCorrection record={correcting} onClose={() => setCorrecting(null)} onDone={reload} />}
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
    ...(teaches || manages ? [{ value: 'corrections', label: 'Corrections' }] : []),
    ...(teaches || manages || isRep ? [{ value: 'registers', label: isRep && !teaches ? 'Submitted registers' : 'All registers' }] : []),
    ...(user!.role === 'student' ? [{ value: 'mine', label: 'My attendance' }] : []),
  ];
  const tab = tabs.some((t) => t.value === params.get('tab')) ? params.get('tab')! : tabs[0]?.value;
  const [sheet, setSheet] = useState(false);

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
        actions={
          (teaches || manages || isRep) && (
            <Button variant="secondary" icon={<Download size={16} />} onClick={() => setSheet(true)}>
              Download attendance
            </Button>
          )
        }
      />
      {sheet && <DownloadSheet onClose={() => setSheet(false)} />}
      {tabs.length > 1 && <Tabs value={tab} onChange={(v) => setParams({ tab: v })} tabs={tabs} />}
      <div className="stack">
        {tab === 'take' && <SessionsForDate role="rep" />}
        {tab === 'lectures' && <SessionsForDate role="lecturer" />}
        {tab === 'approvals' && <RegisterList status="submitted" title="Waiting for approval" />}
        {tab === 'registers' && <RegisterList title="Registers" />}
        {tab === 'corrections' && <Corrections />}
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
