import { FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check, CalendarX2, Plus, Undo2, X } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useFeedback } from '../components/feedback';
import { Alert, Badge, Button, Card, DataTable, ErrorNote, Field, Input, Modal, PageHeader, Select, Spinner, Tabs, Textarea } from '../components/ui';
import { useFetch, usePersistentState } from '../hooks';
import { TEACHING_ROLES } from '../types';

const TONE: Record<string, 'warning' | 'info' | 'success' | 'danger' | 'neutral'> = { submitted: 'warning', hod_checked: 'info', approved: 'success', rejected: 'danger', cancelled: 'neutral' };
const niceDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const LeaveStatus = ({ lr }: { lr: any }) => <Badge tone={TONE[lr.status]}>{lr.status_label}</Badge>;

function NewLeave({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { fail, toast } = useFeedback();
  const [form, setForm] = useState({ start_date: '', end_date: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const lr = await api('/api/ops/leave', { method: 'POST', body: form });
      toast('Leave request sent');
      navigate(`/leave/${lr.id}`);
    } catch (err) {
      fail(err);
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title="Request short-term leave"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="leave-form" loading={busy}>
            Send request
          </Button>
        </>
      }
    >
      <p className="muted">Your HoD checks the request and arranges cover for your lectures; the Dean gives the final approval.</p>
      <form id="leave-form" className="form-grid" onSubmit={submit}>
        <Field label="From">
          <Input type="date" required value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value, end_date: form.end_date || e.target.value })} />
        </Field>
        <Field label="To">
          <Input type="date" required min={form.start_date} value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
        </Field>
        <Field label="Reason" span={2}>
          <Textarea required value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="e.g. Attending a research workshop" />
        </Field>
      </form>
    </Modal>
  );
}

type View = 'mine' | 'review' | 'all';

export default function Leave() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const teaches = TEACHING_ROLES.includes(user!.role);
  const reviews = ['hod', 'dean', 'admin'].includes(user!.role);
  const tabs = [
    ...(teaches ? [{ value: 'mine' as View, label: 'My leave' }] : []),
    ...(reviews ? [{ value: 'review' as View, label: 'To review' }, { value: 'all' as View, label: 'All requests' }] : []),
  ];
  const [view, setView] = usePersistentState<View>('lms_leave_view', tabs[0].value);
  const current = tabs.some((t) => t.value === view) ? view : tabs[0].value;
  const { data, loading, error } = useFetch<any[]>(`/api/ops/leave?view=${current}`);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader
        title="Leave"
        subtitle="Short-term leave: the lecturer requests it, the HoD checks it and arranges cover, and the Dean approves it."
        actions={
          teaches && (
            <Button icon={<Plus size={16} />} onClick={() => setCreating(true)}>
              Request leave
            </Button>
          )
        }
      />
      {tabs.length > 1 && <Tabs value={current} onChange={setView} tabs={tabs} />}
      <ErrorNote error={error} />
      <Card padded={false}>
        <DataTable
          rows={data}
          loading={loading}
          searchKeys={['lecturer_name', 'reason', 'department_name', 'status_label']}
          onRowClick={(lr: any) => navigate(`/leave/${lr.id}`)}
          empty={current === 'review' ? 'Nothing is waiting for you' : 'No leave requests'}
          columns={[
            ...(current === 'mine' ? [] : [{ key: 'lecturer_name', header: 'Lecturer', render: (lr: any) => <><strong>{[lr.lecturer_title, lr.lecturer_name].filter(Boolean).join(' ')}</strong><div className="muted small">{lr.department_name}</div></> }]),
            { key: 'start_date', header: 'Dates', render: (lr: any) => <>{niceDate(lr.start_date)}{lr.end_date !== lr.start_date && <div className="muted small">to {niceDate(lr.end_date)}</div>}</> },
            { key: 'reason', header: 'Reason', hideOnMobile: true },
            { key: 'status', header: 'Status', render: (lr: any) => <LeaveStatus lr={lr} /> },
          ]}
        />
      </Card>
      {creating && <NewLeave onClose={() => setCreating(false)} />}
    </>
  );
}

function Decide({ lr, mode, onClose, onDone }: { lr: any; mode: 'approve' | 'reject'; onClose: () => void; onDone: () => void }) {
  const { fail, toast } = useFeedback();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const label = mode === 'reject' ? 'Decline' : lr.status === 'submitted' ? 'Mark as checked' : 'Approve leave';
  const go = async () => {
    setBusy(true);
    try {
      await api(`/api/ops/leave/${lr.id}/review`, { method: 'POST', body: { action: mode, note } });
      toast(mode === 'reject' ? 'Leave declined' : lr.status === 'submitted' ? 'Checked and sent to the Dean' : 'Leave approved');
      onDone();
      onClose();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={`${label}: ${lr.lecturer_name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={mode === 'reject' ? 'danger' : 'success'} loading={busy} disabled={mode === 'reject' && !note.trim()} onClick={go}>
            {label}
          </Button>
        </>
      }
    >
      <Field label={mode === 'reject' ? 'Reason *' : 'Note (optional)'}>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}

const STEPS = [
  ['submitted', 'Requested'],
  ['hod_checked', 'HoD checked'],
  ['approved', 'Dean approved'],
] as const;

export function LeaveDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const { fail, toast, confirm } = useFeedback();
  const { data: lr, loading, error, reload } = useFetch<any>(`/api/ops/leave/${id}`);
  const [deciding, setDeciding] = useState<'approve' | 'reject' | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  if (loading && !lr) return <Spinner />;
  if (error || !lr) return <ErrorNote error={error || 'Not found'} />;
  const reached = lr.status === 'approved' ? 2 : lr.status === 'hod_checked' ? 1 : lr.status === 'submitted' ? 0 : -1;

  const setCover = async (o: any, substitute: string | null, cancel = false) => {
    setSaving(o.key);
    try {
      await api(`/api/ops/leave/${lr.id}/covers`, { method: 'PUT', body: { session_id: o.session_id, date: o.date, substitute_id: substitute ? Number(substitute) : null, cancel } });
      toast(cancel ? 'Lecture cancelled; students told' : substitute ? 'Cover lecturer assigned' : 'Cover removed');
      reload();
    } catch (err) {
      fail(err);
    } finally {
      setSaving(null);
    }
  };
  const withdraw = async () => {
    if (!(await confirm({ title: 'Cancel this leave request?', message: 'Your HoD and Dean will no longer see it as pending.', confirmLabel: 'Cancel request', tone: 'danger' }))) return;
    try {
      await api(`/api/ops/leave/${lr.id}/cancel`, { method: 'POST' });
      reload();
    } catch (err) {
      fail(err);
    }
  };

  return (
    <>
      <Link to="/leave" className="back-link">
        <ArrowLeft size={16} /> Leave
      </Link>
      <PageHeader
        title={
          <>
            {[lr.lecturer_title, lr.lecturer_name].filter(Boolean).join(' ')} <LeaveStatus lr={lr} />
          </>
        }
        subtitle={`${lr.department_name || ''} · ${niceDate(lr.start_date)} to ${niceDate(lr.end_date)}`}
        actions={
          <div className="page-actions">
            {lr.lecturer_id === user?.id && ['submitted', 'hod_checked'].includes(lr.status) && (
              <Button variant="ghost" icon={<Undo2 size={16} />} onClick={withdraw}>
                Cancel request
              </Button>
            )}
            {lr.can_act && (
              <>
                <Button variant="secondary" icon={<X size={16} />} onClick={() => setDeciding('reject')}>
                  Decline
                </Button>
                <Button variant="success" icon={<Check size={16} />} onClick={() => setDeciding('approve')}>
                  {lr.status === 'submitted' ? 'Mark as checked' : 'Approve leave'}
                </Button>
              </>
            )}
          </div>
        }
      />
      <ol className="stepper claim-steps">
        {STEPS.map(([s, label], i) => (
          <li key={s} className={i <= reached ? 'done' : i === reached + 1 ? 'current' : ''}>
            <span>{i <= reached ? <Check size={13} /> : i + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      <div className="stack">
        <Card title="Request">
          <p className="m0">{lr.reason}</p>
          {lr.hod_at && <p className="muted small m0">Checked by {lr.hod_name || 'the HoD'}{lr.hod_note ? `: ${lr.hod_note}` : ''}</p>}
          {lr.dean_at && <p className="muted small m0">{lr.status === 'rejected' ? 'Declined' : 'Approved'} by {lr.dean_name || 'the Dean'}{lr.dean_note ? `: ${lr.dean_note}` : ''}</p>}
        </Card>
        <Card title={`Lectures during the leave (${lr.lectures.length})`} padded={false}>
          {lr.can_assign_covers && <div className="pad-x"><Alert tone="info">Choose a free colleague to cover each lecture, or cancel it. Covers take effect once the Dean approves the leave.</Alert></div>}
          <DataTable
            rows={lr.lectures.map((o: any) => ({ ...o, id: o.key }))}
            empty={<span className="row gap-sm"><CalendarX2 size={16} /> No lectures in these dates</span>}
            columns={[
              { key: 'date', header: 'Date', render: (o: any) => <>{niceDate(o.date)}<div className="muted small">{o.start_time}-{o.end_time}</div></> },
              { key: 'course_code', header: 'Course unit', render: (o: any) => <><strong>{o.course_code}</strong> {o.course_name}<div className="muted small">{o.classes.map((c: any) => c.name).join(', ')}</div></> },
              {
                key: 'cover',
                header: 'Cover',
                render: (o: any) =>
                  o.status === 'cancelled' ? (
                    <Badge tone="danger">Cancelled</Badge>
                  ) : lr.can_assign_covers ? (
                    <div className="row gap-sm wrap">
                      <Select
                        value={o.cover?.substitute_id || ''}
                        disabled={saving === o.key}
                        onChange={(e) => setCover(o, e.target.value || null)}
                        placeholder="No cover yet"
                        options={[
                          ...(o.cover && !(o.candidates || []).some((c: any) => c.id === o.cover.substitute_id) ? [{ value: o.cover.substitute_id, label: o.cover.substitute_name }] : []),
                          ...(o.candidates || []).map((c: any) => ({ value: c.id, label: `${[c.title, c.name].filter(Boolean).join(' ')}${c.same_department ? '' : ' (other dept.)'}` })),
                        ]}
                      />
                      <Button size="sm" variant="ghost" onClick={() => setCover(o, null, true)}>
                        Cancel lecture
                      </Button>
                    </div>
                  ) : o.cover ? (
                    o.cover.substitute_name
                  ) : (
                    <span className="muted">Not arranged</span>
                  ),
              },
            ]}
          />
        </Card>
      </div>
      {deciding && <Decide lr={lr} mode={deciding} onClose={() => setDeciding(null)} onDone={reload} />}
    </>
  );
}
