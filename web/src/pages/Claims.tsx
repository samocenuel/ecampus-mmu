import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Check, ClipboardCheck, Download, FileText, Landmark, Pencil, PiggyBank, Plus, Printer, QrCode, RefreshCw, Trash2, Undo2, Users as UsersIcon, Wallet } from 'lucide-react';
import { api, download } from '../api';
import { useAuth } from '../auth';
import { useFeedback } from '../components/feedback';
import { FieldDef, FormFields } from '../components/ResourcePage';
import {
  Alert, Badge, Button, Card, DataTable, EmptyState, ErrorNote, Field, IconButton, Input, Modal, PageHeader, plural, Progress, Select, Spinner, StatCard, Tabs, Textarea,
} from '../components/ui';
import { useFetch, usePersistentState } from '../hooks';
import { useTerms } from './Timetable';
import { LEVELS } from './setup/Programmes';
import { ROLE_LABELS, Role } from '../types';

type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';
const STATUS_TONE: Record<string, Tone> = {
  draft: 'neutral', submitted: 'warning', hod_approved: 'warning', dean_approved: 'info', hr_verified: 'primary', paid: 'success', rejected: 'danger',
};
const ClaimStatus = ({ claim }: { claim: any }) => <Badge tone={STATUS_TONE[claim.status]}>{claim.status_label}</Badge>;

const STEPS = [
  ['submitted', 'Submitted by lecturer'],
  ['hod_approved', 'Verified by HoD'],
  ['dean_approved', 'Signed off by Dean'],
  ['hr_verified', 'Final approval (HR)'],
  ['paid', 'Paid'],
] as const;
const CERTIFY = "I certify that the information provided herein above is correct to the best of my knowledge and the claim herein truly conforms to the established expenditure estimates and the finance regulations governing the university.";
const UNITS = ['hour', 'script', 'student', 'visit', 'day', 'item'];

export function money(amount: number, currency = 'UGX') {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount || 0);
  } catch {
    return `${currency} ${Number(amount || 0).toLocaleString()}`;
  }
}
const niceDate = (d: string) => new Date(d.slice(0, 10) + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const niceDateTime = (d: string) => new Date(d.replace(' ', 'T') + (d.includes('Z') ? '' : 'Z')).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const qty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

// ------------------------------------------------------------- New claim

function NewClaim({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { fail } = useFeedback();
  const now = new Date();
  const [month, setMonth] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
  const [from, to] = useMemo(() => {
    const [y, m] = month.split('-').map(Number);
    const last = new Date(y, m, 0);
    const end = last > now ? now : last;
    return [ymd(new Date(y, m - 1, 1)), ymd(end)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);
  const title = useMemo(() => new Date(from + 'T12:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' }), [from]);
  const { data: preview, loading, error } = useFetch<any>(from <= to ? `/api/claims/preview?from=${from}&to=${to}` : null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const claim = await api('/api/claims', { method: 'POST', body: { period_start: from, period_end: to, title } });
      navigate(`/claims/${claim.id}`);
    } catch (err) {
      fail(err);
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="New pay claim"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={create} loading={busy} disabled={from > to}>
            Create draft
          </Button>
        </>
      }
    >
      <p className="muted">Lectures whose attendance you have approved are added automatically. You can add marking, supervision and other tasks next.</p>
      <Field label="Month">
        <Input type="month" value={month} max={`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`} onChange={(e) => setMonth(e.target.value)} />
      </Field>
      <ErrorNote error={error} />
      {loading && <Spinner label="Checking your lectures..." />}
      {preview && (
        <div className="stat-grid">
          <StatCard label="Lectures to claim" value={preview.lectures.length} />
          <StatCard label="Teaching hours" value={qty(preview.hours)} />
          <StatCard
            label="Estimated teaching pay"
            value={preview.rates?.length || preview.rate ? money(preview.estimate ?? preview.hours * (preview.rate?.amount || 0)) : '-'}
            hint={!preview.rate ? 'No teaching rate set yet' : preview.rates?.length > 1 ? 'Rates by programme level' : `${money(preview.rate.amount)} per hour`}
          />
        </div>
      )}
      {preview?.pending_lectures > 0 && (
        <Alert tone="warning">
          {plural(preview.pending_lectures, 'lecture')} in this month still {preview.pending_lectures === 1 ? 'needs' : 'need'} your attendance approval and won't be included until you approve the register.
        </Alert>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ Rates

function Rates() {
  const { user, university } = useAuth();
  const { toast, fail, confirm } = useFeedback();
  const { data: rates, loading, reload } = useFetch<any[]>('/api/claims/rates');
  const { data: faculties } = useFetch<any[]>('/api/faculties');
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  const [form, setForm] = useState<any>({});
  const [busy, setBusy] = useState(false);
  const currency = university?.currency || 'UGX';

  const fields: FieldDef[] = [
    ...((faculties || []).length > 1 ? [{ name: 'faculty_id', label: 'Faculty', type: 'select' as const, required: true, options: (faculties || []).map((f) => ({ value: f.id, label: f.name })) }] : []),
    {
      name: 'kind', label: 'Type', type: 'select', noPlaceholder: true, showIf: (_f, editing) => !editing,
      options: [{ value: 'task', label: 'Task (marking, supervision...)' }, { value: 'teaching', label: 'Teaching (per contact hour)' }],
    },
    { name: 'name', label: 'Name', required: true, placeholder: 'e.g. Marking, Internship supervision' },
    {
      name: 'program_level', label: 'Programme level', type: 'select', placeholder: 'All programme levels',
      options: LEVELS.map((l) => ({ value: l, label: l })),
      help: 'Teaching is paid at the rate for the level of the classes taught (e.g. Diploma, Masters), or the all-levels rate when a level has none.',
    },
    {
      name: 'invigilation', label: 'Use this rate for exam invigilation', type: 'checkbox', span: 2, showIf: (f) => f.kind !== 'teaching',
      help: 'Invigilation duties on the exam timetable are added to claims at this rate, per hour.',
    },
    { name: 'unit', label: 'Paid per', type: 'select', noPlaceholder: true, showIf: (f) => f.kind !== 'teaching' && !f.invigilation, options: UNITS.map((u) => ({ value: u, label: u })) },
    { name: 'amount', label: `Unit price (${currency})`, type: 'number', required: true, min: 0 },
    { name: 'description', label: 'Notes', span: 2, placeholder: 'What the rate covers' },
  ];

  const open = (r: any | 'new') => {
    setForm(r === 'new' ? { kind: 'task', unit: 'script', faculty_id: faculties?.length === 1 ? faculties[0].id : '' } : { ...r, invigilation: r.code === 'invigilation' });
    setEditing(r);
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { invigilation, ...rest } = form;
      const body = { ...rest, faculty_id: form.faculty_id || faculties?.[0]?.id, ...(form.kind !== 'teaching' ? { code: invigilation ? 'invigilation' : null } : {}) };
      if (editing === 'new') await api('/api/claims/rates', { method: 'POST', body });
      else await api(`/api/claims/rates/${editing.id}`, { method: 'PUT', body });
      toast('Rate saved');
      setEditing(null);
      reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (r: any) => {
    if (!(await confirm({ title: `Delete "${r.name}"?`, message: 'Claims already made keep the price they were made with.', confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      await api(`/api/claims/rates/${r.id}`, { method: 'DELETE' });
      toast('Rate deleted');
      reload();
    } catch (err) {
      fail(err);
    }
  };

  const canEdit = user?.role === 'dean' || user?.role === 'admin';
  return (
    <Card
      title="Pay rates"
      padded={false}
      actions={
        canEdit && (
          <Button size="sm" icon={<Plus size={14} />} onClick={() => open('new')}>
            Add rate
          </Button>
        )
      }
    >
      {rates && !rates.some((r) => r.kind === 'teaching') && (
        <div className="pad-x">
          <Alert tone="warning" title="No teaching rate yet">
            Part-time lecturers can't submit claims until the teaching rate per hour is set.
          </Alert>
        </div>
      )}
      <DataTable
        rows={rates}
        loading={loading}
        empty="No rates yet"
        columns={[
          {
            key: 'name',
            header: 'Item',
            render: (r: any) => (
              <>
                <strong>{r.name}</strong> {r.kind === 'teaching' && <Badge tone="primary">Teaching</Badge>} {r.code === 'invigilation' && <Badge tone="info">Invigilation</Badge>} {r.program_level && <Badge>{r.program_level}</Badge>}
                {r.description && <div className="muted small">{r.description}</div>}
              </>
            ),
          },
          { key: 'faculty_name', header: 'Faculty', hideOnMobile: true },
          { key: 'amount', header: 'Rate', align: 'right', render: (r: any) => <strong>{money(r.amount, currency)}</strong> },
          { key: 'unit', header: 'Per', render: (r: any) => r.unit },
          { key: 'updated', header: 'Set by', hideOnMobile: true, render: (r: any) => <span className="muted small">{r.updated_by_name || '-'}</span> },
          ...(canEdit
            ? [
                {
                  key: '_a',
                  header: '',
                  align: 'right' as const,
                  render: (r: any) => (
                    <div className="row-actions">
                      <IconButton label="Edit" onClick={() => open(r)}>
                        <Pencil size={16} />
                      </IconButton>
                      <IconButton label="Delete" className="danger" onClick={() => remove(r)}>
                        <Trash2 size={16} />
                      </IconButton>
                    </div>
                  ),
                },
              ]
            : []),
        ]}
      />
      <Modal
        open={editing !== null}
        title={editing === 'new' ? 'New rate' : 'Edit rate'}
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button type="submit" form="rate-form" loading={busy}>
              Save
            </Button>
          </>
        }
      >
        <form id="rate-form" onSubmit={save}>
          <FormFields fields={fields} form={form} setForm={setForm} editing={editing !== 'new'} />
        </form>
      </Modal>
    </Card>
  );
}

// ---------------------------------------------------------------- Budgets

/** Votes (budget lines) the Dean as Vote Controller charges signed-off claims to. */
function Votes() {
  const { user, university } = useAuth();
  const { toast, fail, confirm } = useFeedback();
  const { data: votes, loading, reload } = useFetch<any[]>('/api/claims/votes');
  const { data: faculties } = useFetch<any[]>('/api/faculties');
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  const [form, setForm] = useState<any>({});
  const [busy, setBusy] = useState(false);
  const canEdit = user?.role === 'dean' || user?.role === 'admin';
  const currency = university?.currency || 'UGX';
  const myFaculties = (faculties || []).filter((f) => user?.role === 'admin' || f.dean_id === user?.id);
  const open = (v: any | 'new') => {
    setForm(v === 'new' ? { faculty_id: myFaculties[0]?.id || '', code: '', name: '', amount: '', financial_year: '', active: true } : { ...v, active: Boolean(v.active) });
    setEditing(v);
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { ...form, amount: Number(form.amount) };
      if (editing === 'new') await api('/api/claims/votes', { method: 'POST', body });
      else await api(`/api/claims/votes/${editing.id}`, { method: 'PUT', body });
      toast('Vote saved');
      setEditing(null);
      reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (v: any) => {
    if (!(await confirm({ title: `Remove vote ${v.code}?`, message: 'A vote that claims were charged to is closed instead, so their requisitions keep it.', confirmLabel: 'Remove', tone: 'danger' }))) return;
    try {
      const r = await api<any>(`/api/claims/votes/${v.id}`, { method: 'DELETE' });
      toast(r.closed ? 'Vote closed' : 'Vote removed');
      reload();
    } catch (err) {
      fail(err);
    }
  };
  return (
    <Card
      title={<span className="row gap-sm"><Landmark size={18} /> Votes</span>}
      padded={false}
      actions={canEdit && <Button size="sm" icon={<Plus size={14} />} onClick={() => open('new')}>New vote</Button>}
    >
      <div className="pad-x muted small">The Dean, as Vote Controller, signs off each claim against one of these votes. The balance shown on the requisition form is the vote amount less claims already signed off.</div>
      <DataTable
        rows={votes}
        loading={loading}
        empty={canEdit ? 'No votes yet. Add the vote part-time claims are paid from.' : 'No votes yet'}
        columns={[
          { key: 'code', header: 'Vote', render: (v: any) => <><strong>{v.code}</strong> {!v.active && <Badge>Closed</Badge>}<div className="muted small">{v.name}{v.financial_year ? ` · ${v.financial_year}` : ''}</div></> },
          { key: 'faculty_name', header: 'Faculty', hideOnMobile: true },
          { key: 'amount', header: 'Amount', align: 'right', render: (v: any) => money(v.amount, currency) },
          { key: 'charged', header: 'Charged', align: 'right', hideOnMobile: true, render: (v: any) => money(v.charged, currency) },
          { key: 'balance', header: 'Balance', align: 'right', render: (v: any) => <strong className={v.balance < 0 ? 'text-danger' : ''}>{money(v.balance, currency)}</strong> },
          ...(canEdit
            ? [{
                key: '_a',
                header: '',
                align: 'right' as const,
                render: (v: any) => (
                  <div className="row-actions">
                    <IconButton label="Edit" onClick={() => open(v)}><Pencil size={16} /></IconButton>
                    <IconButton label="Remove" className="danger" onClick={() => remove(v)}><Trash2 size={16} /></IconButton>
                  </div>
                ),
              }]
            : []),
        ]}
      />
      {editing && (
        <Modal
          open
          title={editing === 'new' ? 'New vote' : `Edit vote ${editing.code}`}
          onClose={() => setEditing(null)}
          footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button type="submit" form="vote-form" loading={busy}>Save</Button></>}
        >
          <VoteFields form={form} setForm={setForm} faculties={editing === 'new' ? myFaculties : []} onSubmit={save} />
        </Modal>
      )}
    </Card>
  );
}

function VoteFields({ form, setForm, faculties, onSubmit }: { form: any; setForm: (f: any) => void; faculties: any[]; onSubmit: (e: FormEvent) => void }) {
  const { university } = useAuth();
  const set = (k: string) => ({ value: form[k] ?? '', onChange: (e: any) => setForm({ ...form, [k]: e.target.value }) });
  return (
    <form id="vote-form" className="form-grid" onSubmit={onSubmit}>
      {faculties.length > 1 && (
        <Field label="Faculty *" span={2}>
          <Select required value={form.faculty_id} onChange={(e) => setForm({ ...form, faculty_id: e.target.value })} options={faculties.map((f) => ({ value: f.id, label: f.name }))} />
        </Field>
      )}
      <Field label="Vote code *">
        <Input required maxLength={40} placeholder="e.g. 221001" {...set('code')} />
      </Field>
      <Field label="Financial year">
        <Input placeholder="e.g. 2026/2027" {...set('financial_year')} />
      </Field>
      <Field label="Vote name *" span={2}>
        <Input required placeholder="e.g. Part-time lecturers' allowances" {...set('name')} />
      </Field>
      <Field label={`Amount (${university?.currency || 'UGX'}) *`} span={2}>
        <Input required type="number" min={0} step="any" {...set('amount')} />
      </Field>
    </form>
  );
}

function Budgets() {
  const { university } = useAuth();
  const { toast, fail } = useFeedback();
  const { terms, current } = useTerms();
  const [termId, setTermId] = useState<number | null>(null);
  const term = termId ?? current?.id;
  const { data, loading, error, reload } = useFetch<any>(term ? `/api/claims/budgets?term_id=${term}` : '/api/claims/budgets');
  const [editing, setEditing] = useState<any>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const currency = university?.currency || 'UGX';

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/claims/budgets', { method: 'PUT', body: { department_id: editing.id, term_id: data.term.id, amount: Number(amount) } });
      toast('Budget saved');
      setEditing(null);
      reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={<span className="row gap-sm"><PiggyBank size={18} /> Part-time pay budgets</span>}
      padded={false}
      actions={terms.length > 1 && <Select value={term ?? ''} onChange={(e) => setTermId(Number(e.target.value))} options={terms.map((t) => ({ value: t.id, label: t.name }))} aria-label="Term" />}
    >
      <ErrorNote error={error} />
      <div className="pad-x muted small">Claims submitted in a term count against the department's budget. Approvers are warned when a claim takes a department over it.</div>
      <DataTable
        rows={data?.departments}
        loading={loading}
        empty={data && !data.term ? 'Add a term first' : 'No departments'}
        columns={[
          { key: 'name', header: 'Department', render: (d: any) => <><strong>{d.name}</strong><div className="muted small">{d.faculty_name}</div></> },
          { key: 'amount', header: 'Budget', align: 'right', render: (d: any) => (d.amount == null ? <span className="muted">Not set</span> : <strong>{money(d.amount, currency)}</strong>) },
          { key: 'committed', header: 'Claimed', align: 'right', render: (d: any) => money(d.committed, currency) },
          { key: 'paid', header: 'Paid', align: 'right', hideOnMobile: true, render: (d: any) => money(d.paid, currency) },
          {
            key: 'remaining',
            header: 'Used',
            render: (d: any) =>
              d.amount == null ? (
                <span className="muted">-</span>
              ) : (
                <div style={{ minWidth: 120 }}>
                  <Progress value={d.committed} total={d.amount || 1} tone={d.remaining < 0 ? 'danger' : d.committed > d.amount * 0.85 ? 'warning' : undefined} />
                  <div className={`small ${d.remaining < 0 ? 'text-danger' : 'muted'}`}>{d.remaining < 0 ? `${money(-d.remaining, currency)} over` : `${money(d.remaining, currency)} left`}</div>
                </div>
              ),
          },
          {
            key: '_a',
            header: '',
            align: 'right',
            render: (d: any) =>
              d.can_set && (
                <IconButton label="Set budget" onClick={() => { setEditing(d); setAmount(d.amount == null ? '' : String(d.amount)); }}>
                  <Pencil size={16} />
                </IconButton>
              ),
          },
        ]}
      />
      {editing && (
        <Modal
          open
          title={`${editing.name}: ${data.term.name}`}
          onClose={() => setEditing(null)}
          footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button type="submit" form="budget-form" loading={busy}>Save</Button></>}
        >
          <form id="budget-form" onSubmit={save}>
            <Field label={`Part-time pay budget (${currency}) *`} help={`Already claimed this term: ${money(editing.committed, currency)}`}>
              <Input type="number" min={0} step="any" required autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
          </form>
        </Modal>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ List

type View = 'mine' | 'queue' | 'all' | 'completed' | 'rates' | 'budgets';

export default function Claims() {
  const { user, university } = useAuth();
  const navigate = useNavigate();
  const { fail } = useFeedback();
  const partTimer = user?.employment_type === 'part_time';
  const approver = ['admin', 'dean', 'hod', 'hr'].includes(user?.role || '');
  const tabs: { value: View; label: string; count?: number }[] = [
    ...(partTimer ? [{ value: 'mine' as View, label: 'My claims' }] : []),
    ...(approver ? [{ value: 'queue' as View, label: 'Awaiting me' }, { value: 'all' as View, label: 'All claims' }, { value: 'completed' as View, label: 'Completed requisitions' }] : []),
    ...(['admin', 'dean', 'hod', 'hr'].includes(user?.role || '') || partTimer ? [{ value: 'rates' as View, label: 'Pay rates' }] : []),
    ...(approver ? [{ value: 'budgets' as View, label: 'Votes & budgets' }] : []),
  ];
  const [params] = useSearchParams();
  const [view, setView] = usePersistentState<View>('lms_claims_view', tabs[0]?.value || 'mine');
  // The verification page links here with ?view=completed.
  const asked = params.get('view') as View | null;
  const [linked, setLinked] = useState(asked && tabs.some((t) => t.value === asked) ? asked : null);
  const chosen = linked || view;
  const current = tabs.some((t) => t.value === chosen) ? chosen : tabs[0]?.value;
  const choose = (v: View) => {
    setLinked(null);
    setView(v);
  };
  const { data: summary } = useFetch<any>('/api/claims/summary');
  const { data, loading, error } = useFetch<any[]>(current === 'rates' || current === 'budgets' ? null : `/api/claims?view=${current}`);
  const [creating, setCreating] = useState(false);
  const currency = university?.currency || 'UGX';
  if (summary) for (const t of tabs) if (t.value === 'queue') t.count = summary.awaiting_me;

  const exportSchedule = async () => {
    try {
      await download(`/api/claims/export?status=${user?.role === 'hr' || user?.role === 'admin' ? 'hr_verified' : 'submitted,hod_approved,dean_approved,hr_verified,paid'}`, 'claims.xlsx');
    } catch (err) {
      fail(err);
    }
  };

  const subtitle =
    user?.role === 'hr'
      ? 'Check claims approved by Deans, then record each payment.'
      : user?.role === 'dean'
        ? 'Approve claims your HoDs have approved, and set the pay rates for your faculty.'
        : user?.role === 'hod'
          ? "Check part-time lecturers' claims against the timetable and attendance before they go to the Dean."
          : partTimer
            ? 'Claim pay for the lectures you taught and for tasks such as marking and supervision.'
            : 'Part-time teaching and task claims across the university.';

  return (
    <>
      <PageHeader
        title="Pay claims"
        subtitle={subtitle}
        actions={
          <>
            {approver && user?.role !== 'hod' && (
              <Button variant="secondary" icon={<Download size={16} />} onClick={exportSchedule}>
                {user?.role === 'hr' || user?.role === 'admin' ? 'Payment schedule' : 'Export'}
              </Button>
            )}
            {partTimer && (
              <Button icon={<Plus size={16} />} onClick={() => setCreating(true)}>
                New claim
              </Button>
            )}
          </>
        }
      />
      {summary && (
        <div className="stat-grid" style={{ marginBottom: 16 }}>
          {approver && <StatCard label="Awaiting you" value={summary.awaiting_me} hint={money(summary.awaiting_me_total, currency)} tone={summary.awaiting_me ? 'warning' : undefined} icon={<Wallet size={20} />} />}
          {summary.awaiting_payment !== undefined && <StatCard label="Verified, to pay" value={summary.awaiting_payment} />}
          {partTimer && <StatCard label="My open claims" value={summary.mine.open} hint={summary.mine.returned ? `${summary.mine.returned} returned to you` : undefined} />}
          {partTimer && <StatCard label="Paid to me" value={money(summary.mine.paid_total, currency)} tone="success" />}
        </div>
      )}
      {tabs.length > 1 && <Tabs value={current} onChange={choose} tabs={tabs} />}
      <ErrorNote error={error} />
      {current === 'rates' ? (
        <Rates />
      ) : current === 'budgets' ? (
        <div className="stack">
          <Votes />
          <Budgets />
        </div>
      ) : (
        <Card padded={false}>
          <DataTable
            rows={data}
            loading={loading}
            searchKeys={['lecturer_name', 'title', 'department_name', 'status_label']}
            onRowClick={(c: any) => navigate(`/claims/${c.id}`)}
            empty={
              current === 'queue' ? (
                'Nothing is waiting for you'
              ) : partTimer ? (
                <EmptyState title="No claims yet" icon={<Wallet size={28} />}>
                  Use <strong>New claim</strong> to claim a month's lectures and tasks.
                </EmptyState>
              ) : (
                'No claims yet'
              )
            }
            columns={[
              ...(current === 'mine'
                ? []
                : [
                    {
                      key: 'lecturer_name',
                      header: 'Lecturer',
                      render: (c: any) => (
                        <>
                          <strong>{[c.lecturer_title, c.lecturer_name].filter(Boolean).join(' ')}</strong>
                          <div className="muted small">{c.department_name}</div>
                        </>
                      ),
                    },
                  ]),
              { key: 'title', header: 'Period', render: (c: any) => <>{c.title}<div className="muted small">{niceDate(c.period_start)} - {niceDate(c.period_end)}</div></> },
              { key: 'teaching_hours', header: 'Teaching', hideOnMobile: true, render: (c: any) => <>{qty(c.teaching_hours)} h<div className="muted small">{plural(c.lecture_count, 'lecture')}</div></> },
              { key: 'task_count', header: 'Tasks', align: 'right', hideOnMobile: true },
              { key: 'total', header: 'Amount', align: 'right', render: (c: any) => <strong>{money(c.total, c.currency)}</strong> },
              { key: 'status', header: 'Status', render: (c: any) => <ClaimStatus claim={c} /> },
            ]}
          />
        </Card>
      )}
      {creating && <NewClaim onClose={() => setCreating(false)} />}
    </>
  );
}

// ---------------------------------------------------------------- Detail

function AttendanceModal({ claimId, line, onClose }: { claimId: number; line: any; onClose: () => void }) {
  const { data, loading, error } = useFetch<any>(`/api/claims/${claimId}/lines/${line.id}/attendance`);
  return (
    <Modal open wide title={`${line.course_unit_code} · ${niceDate(line.work_date)} ${line.start_time}-${line.end_time}`} onClose={onClose}>
      <ErrorNote error={error} />
      {loading && <Spinner />}
      {data?.registers.map((r: any) => (
        <div key={r.id} className="stack" style={{ gap: 8 }}>
          <div className="row between wrap gap-sm">
            <strong>{r.class_name}</strong>
            <span className="muted small">
              {r.students.filter((s: any) => s.present).length} of {r.students.length} present · taken by {r.submitted_by_name || 'class rep'}
              {r.topic ? ` · ${r.topic}` : ''}
            </span>
          </div>
          <div className="chips">
            {r.students.map((s: any) => (
              <span key={s.identifier || s.name} className={`chip ${s.present ? 'chip-done' : ''}`} title={s.identifier || ''}>
                {s.name}
                {!s.present && <small>absent</small>}
              </span>
            ))}
          </div>
        </div>
      ))}
    </Modal>
  );
}

function AddTask({ claim, onClose, onSaved }: { claim: any; onClose: () => void; onSaved: () => void }) {
  const { fail, toast } = useFeedback();
  const { data: rates } = useFetch<any[]>(`/api/claims/rates?faculty_id=${claim.faculty_id}&active=1`);
  const tasks = (rates || []).filter((r) => r.kind === 'task');
  const [form, setForm] = useState<any>({ work_date: claim.period_end, quantity: 1 });
  const [busy, setBusy] = useState(false);
  const rate = tasks.find((r) => String(r.id) === String(form.rate_id));
  useEffect(() => {
    if (!form.rate_id && tasks.length) setForm((f: any) => ({ ...f, rate_id: tasks[0].id }));
  }, [tasks, form.rate_id]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/api/claims/${claim.id}/lines`, { method: 'POST', body: form });
      toast('Task added');
      onSaved();
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
      title="Add a task"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="task-form" loading={busy} disabled={!tasks.length}>
            Add
          </Button>
        </>
      }
    >
      {rates && !tasks.length && <Alert tone="warning">Your Dean hasn't set any task rates yet.</Alert>}
      <form id="task-form" className="form-grid" onSubmit={save}>
        <Field label="Task" span={2}>
          <Select value={form.rate_id || ''} onChange={(e) => setForm({ ...form, rate_id: e.target.value })} options={tasks.map((r) => ({ value: r.id, label: `${r.name} - ${money(r.amount, claim.currency)} per ${r.unit}` }))} />
        </Field>
        <Field label={rate ? `Number of ${rate.unit}s` : 'Quantity'}>
          <Input type="number" min={0.25} step={0.25} required value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
        </Field>
        <Field label="Date">
          <Input type="date" required min={claim.period_start} max={claim.period_end} value={form.work_date} onChange={(e) => setForm({ ...form, work_date: e.target.value })} />
        </Field>
        <Field label="Details" span={2} help="Course unit, class or students covered, e.g. 'CSC1103 test 1, 52 scripts'.">
          <Textarea required value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        {rate && form.quantity > 0 && (
          <div className="span-2 muted">
            Amount: <strong>{money(rate.amount * Number(form.quantity), claim.currency)}</strong>
          </div>
        )}
      </form>
    </Modal>
  );
}

function Decide({ claim, mode, onClose, onDone }: { claim: any; mode: 'approve' | 'reject'; onClose: () => void; onDone: () => void }) {
  const { fail, toast } = useFeedback();
  const [note, setNote] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const paying = mode === 'approve' && claim.status === 'hr_verified';
  const signing = mode === 'approve' && claim.status === 'hod_approved';
  const label = mode === 'reject' ? 'Return for correction' : claim.next_action;
  const { data: votes, reload: reloadVotes } = useFetch<any[]>(signing ? `/api/claims/votes?faculty_id=${claim.faculty_id}&active=1` : null);
  const [voteId, setVoteId] = useState('');
  const [newVote, setNewVote] = useState<any>(null);
  const vote = (votes || []).find((v) => String(v.id) === voteId) || (votes?.length === 1 ? votes[0] : null);

  const go = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      let chosen = vote?.id;
      if (signing && newVote) {
        const created = await api<any>('/api/claims/votes', { method: 'POST', body: { ...newVote, faculty_id: claim.faculty_id, amount: Number(newVote.amount) } });
        chosen = created.id;
        reloadVotes();
      }
      if (signing && !chosen) throw new Error('Choose the vote this claim is charged to');
      const r = await api(`/api/claims/${claim.id}/${mode}`, { method: 'POST', body: { note, payment_reference: reference, vote_id: chosen } });
      toast(mode === 'reject' ? 'Claim returned to the lecturer' : paying ? 'Payment recorded' : claim.status === 'dean_approved' ? 'Final approval given; print the requisition form' : 'Claim signed off and passed on');
      if (r?.budget_warning) toast(r.budget_warning, 'error');
      if (r?.vote_warning) toast(r.vote_warning, 'error');
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
      title={`${label}: ${claim.lecturer_name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="decide-form" variant={mode === 'reject' ? 'danger' : 'primary'} loading={busy}>
            {label}
          </Button>
        </>
      }
    >
      <form id="decide-form" className="stack" onSubmit={go}>
        <p>
          {claim.title}: <strong>{money(claim.total, claim.currency)}</strong>
        </p>
        {signing && !newVote && (
          <Field label="Charge to vote *" help={vote ? `Balance ${money(vote.balance, claim.currency)}, ${money(vote.balance - claim.total, claim.currency)} after this claim` : 'You sign off as Vote Controller against one of the faculty votes.'}>
            <Select value={vote ? String(vote.id) : ''} onChange={(e) => setVoteId(e.target.value)} placeholder={votes?.length ? 'Choose a vote...' : 'No votes yet'} options={(votes || []).map((v) => ({ value: String(v.id), label: `${v.code} - ${v.name} (balance ${money(v.balance, claim.currency)})` }))} />
          </Field>
        )}
        {signing && (newVote ? (
          <Card title="New vote">
            <VoteFields form={newVote} setForm={setNewVote} faculties={[]} onSubmit={(e) => e.preventDefault()} />
            <Button size="sm" variant="ghost" onClick={() => setNewVote(null)}>Use an existing vote</Button>
          </Card>
        ) : (
          <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={() => setNewVote({ code: '', name: '', amount: '', financial_year: '' })}>
            Create a new vote
          </Button>
        ))}
        {paying && (
          <Field label="Payment reference *" help="Voucher, payroll or bank transfer number.">
            <Input required value={reference} onChange={(e) => setReference(e.target.value)} autoFocus />
          </Field>
        )}
        <Field label={mode === 'reject' ? 'What needs correcting? *' : 'Note (optional)'}>
          <Textarea required={mode === 'reject'} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

const EVENT_LABEL: Record<string, string> = {
  created: 'Draft created', submitted: 'Signed off and submitted', resubmitted: 'Resubmitted', approved: 'Approved', verified: 'Final approval by HR', paid: 'Payment recorded', returned: 'Returned for correction',
};

export function ClaimDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast, fail, confirm } = useFeedback();
  const { data: claim, loading, error, reload } = useFetch<any>(`/api/claims/${id}`);
  const [attendance, setAttendance] = useState<any>(null);
  const [addingTask, setAddingTask] = useState(false);
  const [deciding, setDeciding] = useState<'approve' | 'reject' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (loading && !claim) return <Spinner label="Loading claim..." />;
  if (error || !claim) return <ErrorNote error={error || 'Claim not found'} />;

  const teaching = claim.lines.filter((l: any) => l.kind === 'teaching');
  const tasks = claim.lines.filter((l: any) => l.kind === 'task');
  const teachingTotal = teaching.reduce((t: number, l: any) => t + l.amount, 0);
  const taskTotal = tasks.reduce((t: number, l: any) => t + l.amount, 0);
  const lastReturn = [...claim.events].reverse().find((e: any) => e.action === 'returned');
  const reached = claim.status === 'rejected' || claim.status === 'draft' ? -1 : STEPS.findIndex(([s]) => s === claim.status);

  const run = async (key: string, fn: () => Promise<unknown>, message: string) => {
    setBusy(key);
    try {
      await fn();
      toast(message);
      reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };
  const removeLine = (line: any) => run(`line-${line.id}`, () => api(`/api/claims/${claim.id}/lines/${line.id}`, { method: 'DELETE' }), 'Task removed');
  const deleteDraft = async () => {
    if (!(await confirm({ title: 'Delete this draft?', message: 'Its lectures become available for another claim.', confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      await api(`/api/claims/${claim.id}`, { method: 'DELETE' });
      toast('Draft deleted');
      navigate('/claims');
    } catch (err) {
      fail(err);
    }
  };

  return (
    <div className="claim-page">
      <Link to="/claims" className="back-link no-print">
        <ArrowLeft size={16} /> Pay claims
      </Link>
      <PageHeader
        title={
          <>
            {claim.title} <ClaimStatus claim={claim} />
          </>
        }
        subtitle={`${[claim.lecturer_title, claim.lecturer_name].filter(Boolean).join(' ')} · ${claim.department_name || ''} · ${niceDate(claim.period_start)} to ${niceDate(claim.period_end)}`}
        actions={
          <div className="page-actions no-print">
            <Button variant="secondary" icon={<Printer size={16} />} onClick={() => window.print()}>
              Print
            </Button>
            {claim.status !== 'draft' && claim.status !== 'rejected' && (
              <Button variant={claim.cleared ? 'primary' : 'secondary'} icon={<ClipboardCheck size={16} />} onClick={() => download(`/api/claims/${claim.id}/requisition`, `requisition-${claim.id}.pdf`).catch(fail)}>
                {claim.cleared ? 'Requisition form' : 'Requisition (preview)'}
              </Button>
            )}
            {claim.status !== 'draft' && (
              <Button variant="secondary" icon={<FileText size={16} />} onClick={() => download(`/api/claims/${claim.id}/payslip`, `${claim.status === 'paid' ? 'payslip' : 'claim'}-${claim.id}.pdf`).catch(fail)}>
                {claim.status === 'paid' ? 'Payslip PDF' : 'Claim PDF'}
              </Button>
            )}
            {claim.can_edit && claim.status === 'draft' && (
              <Button variant="ghost" icon={<Trash2 size={16} />} onClick={deleteDraft}>
                Delete draft
              </Button>
            )}
            {claim.can_edit && (
              <Button
                icon={<Check size={16} />}
                loading={busy === 'submit'}
                onClick={async () => {
                  if (!(await confirm({ title: 'Sign off and submit this claim?', message: CERTIFY, confirmLabel: 'I certify, submit' }))) return;
                  run('submit', () => api(`/api/claims/${claim.id}/submit`, { method: 'POST' }), 'Claim submitted to your HoD for verification');
                }}
              >
                {claim.status === 'rejected' ? 'Resubmit' : 'Submit claim'}
              </Button>
            )}
            {claim.can_act && (
              <>
                <Button variant="secondary" icon={<Undo2 size={16} />} onClick={() => setDeciding('reject')}>
                  Return
                </Button>
                <Button variant="success" icon={<Check size={16} />} onClick={() => setDeciding('approve')}>
                  {claim.next_action}
                </Button>
              </>
            )}
          </div>
        }
      />

      <ol className="stepper claim-steps">
        {STEPS.map(([s, label], i) => (
          <li key={s} className={i <= reached ? 'done' : i === reached + 1 && reached >= 0 ? 'current' : ''}>
            <span>{i <= reached ? <Check size={13} /> : i + 1}</span>
            {label}
          </li>
        ))}
      </ol>

      <div className="stack">
        {claim.status === 'rejected' && lastReturn && (
          <Alert tone="danger" title={`Returned by the ${lastReturn.stage} (${lastReturn.actor_name})`}>
            {lastReturn.note} {claim.can_edit && 'Make the corrections below, then resubmit.'}
          </Alert>
        )}
        {claim.can_edit && claim.pending_lectures > 0 && (
          <Alert tone="warning" action={<Link to="/attendance?tab=approvals" className="btn btn-sm btn-secondary">Approve registers</Link>}>
            {plural(claim.pending_lectures, 'lecture')} in this period still {claim.pending_lectures === 1 ? 'needs' : 'need'} your attendance approval before {claim.pending_lectures === 1 ? 'it' : 'they'} can be claimed.
          </Alert>
        )}
        {!claim.teaching_rate && <Alert tone="warning">The Dean has not set a teaching rate for this faculty yet, so teaching hours can't be priced.</Alert>}
        {claim.status === 'hr_verified' && (
          <Alert tone="success" title="Cleared by HR">
            The requisition form is ready to print and submit to Finance.
          </Alert>
        )}
        {claim.sign_offs && (
          <Card title="Digital signatures" padded={false} actions={<a className="small" href={claim.verify_url} target="_blank" rel="noreferrer">Verify {claim.verify_code}</a>}>
            <ul className="footprints">
              {Object.values(claim.sign_offs).map((s: any) => (
                <li key={s.step} className={s.footprint ? '' : 'missing'}>
                  <div>
                    <strong>{s.step}</strong>
                    <div className="muted small">{s.name ? `${s.name} · ${niceDateTime(s.at)}` : 'Not yet signed off'}</div>
                  </div>
                  {s.footprint && <code>{s.footprint}</code>}
                </li>
              ))}
            </ul>
          </Card>
        )}
        {claim.vote && (
          <Alert tone={claim.vote.balance < 0 ? 'warning' : 'info'} title={`Vote ${claim.vote.code}: ${claim.vote.name}`}>
            Signed off by the Vote Controller. Balance after signed-off claims: <strong>{money(claim.vote.balance, claim.currency)}</strong>
            {claim.vote.financial_year ? ` (${claim.vote.financial_year})` : ''}.
          </Alert>
        )}
        {claim.status === 'paid' && (
          <Alert tone="success" title="Paid">
            Payment reference <strong>{claim.payment_reference}</strong>
            {claim.paid_at ? `, ${niceDateTime(claim.paid_at)}` : ''}.
          </Alert>
        )}

        <div className="stat-grid">
          <StatCard label="Teaching hours" value={qty(teaching.reduce((t: number, l: any) => t + l.quantity, 0))} hint={plural(teaching.length, 'lecture')} />
          <StatCard label="Teaching" value={money(teachingTotal, claim.currency)} hint={claim.teaching_rates?.length > 1 ? 'Rates by programme level' : claim.teaching_rate ? `${money(claim.teaching_rate.amount, claim.currency)} per hour` : undefined} />
          <StatCard label="Tasks" value={money(taskTotal, claim.currency)} hint={plural(tasks.length, 'item')} />
          <StatCard label="Total claimed" value={money(claim.total, claim.currency)} tone="primary" />
          {claim.verification?.lectures > 0 && (
            <StatCard
              label="QR-confirmed lectures"
              value={`${claim.verification.confirmed} of ${claim.verification.lectures}`}
              hint="Students checked in with their phones"
              tone={claim.verification.confirmed === claim.verification.lectures ? 'success' : 'warning'}
              icon={<QrCode size={20} />}
            />
          )}
        </div>

        {claim.budget && claim.budget.amount != null && (
          <Alert tone={claim.budget.would_exceed || claim.budget.remaining < 0 ? 'warning' : 'info'} title={`${claim.department_name} budget, ${claim.budget.term_name}`}>
            {money(claim.budget.committed, claim.currency)} of {money(claim.budget.amount, claim.currency)} claimed so far
            {claim.budget.remaining < 0 ? `, ${money(-claim.budget.remaining, claim.currency)} over budget.` : `, ${money(claim.budget.remaining, claim.currency)} left.`}
            {claim.budget.would_exceed && claim.budget.remaining >= 0 && ' Approving this claim would take the department over budget.'}
          </Alert>
        )}

        <Card
          title="Lectures taught"
          padded={false}
          actions={
            claim.can_edit && (
              <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} loading={busy === 'refresh'} onClick={() => run('refresh', () => api(`/api/claims/${claim.id}/refresh`, { method: 'POST' }), 'Lectures updated')}>
                Update from attendance
              </Button>
            )
          }
        >
          <DataTable
            rows={teaching}
            empty="No attendance-approved lectures in this period"
            onRowClick={(l: any) => setAttendance(l)}
            columns={[
              { key: 'work_date', header: 'Date', render: (l: any) => <>{niceDate(l.work_date)}<div className="muted small">{l.start_time}-{l.end_time}</div></> },
              { key: 'course_unit_code', header: 'Course unit', render: (l: any) => <><strong>{l.course_unit_code}</strong> <span className="hide-sm">{l.course_unit_name}</span><div className="muted small">{l.class_names}</div></> },
              {
                key: 'students_present',
                header: 'Attended',
                render: (l: any) => (
                  <button type="button" className="link row gap-sm" onClick={(e) => { e.stopPropagation(); setAttendance(l); }}>
                    <UsersIcon size={14} /> {l.students_present} of {l.students_total}
                    {l.self_checkins > 0 && <Badge tone="success"><QrCode size={11} /> {l.self_checkins}</Badge>}
                  </button>
                ),
              },
              { key: 'quantity', header: 'Hours', align: 'right', render: (l: any) => qty(l.quantity) },
              { key: 'unit_price', header: 'Rate', align: 'right', hideOnMobile: true, render: (l: any) => <>{money(l.unit_price, claim.currency)}{l.program_level && <div className="muted small">{l.program_level}</div>}</> },
              { key: 'amount', header: 'Amount', align: 'right', render: (l: any) => <strong>{money(l.amount, claim.currency)}</strong> },
            ]}
          />
        </Card>

        <Card
          title="Tasks"
          padded={false}
          actions={
            claim.can_edit && (
              <Button size="sm" icon={<Plus size={14} />} onClick={() => setAddingTask(true)}>
                Add task
              </Button>
            )
          }
        >
          <DataTable
            rows={tasks}
            empty={claim.can_edit ? 'Add marking, internship supervision or other tasks done in this period' : 'No tasks claimed'}
            columns={[
              { key: 'work_date', header: 'Date', render: (l: any) => niceDate(l.work_date) },
              { key: 'rate_name', header: 'Task', render: (l: any) => <><strong>{l.rate_name}</strong><div className="muted small">{l.description}</div></> },
              { key: 'quantity', header: 'Quantity', align: 'right', render: (l: any) => `${qty(l.quantity)} ${l.unit}${l.quantity === 1 ? '' : 's'}` },
              { key: 'unit_price', header: 'Rate', align: 'right', hideOnMobile: true, render: (l: any) => money(l.unit_price, claim.currency) },
              { key: 'amount', header: 'Amount', align: 'right', render: (l: any) => <strong>{money(l.amount, claim.currency)}</strong> },
              ...(claim.can_edit
                ? [
                    {
                      key: '_a',
                      header: '',
                      align: 'right' as const,
                      render: (l: any) => (
                        <IconButton label="Remove" className="danger" onClick={() => removeLine(l)}>
                          <Trash2 size={16} />
                        </IconButton>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </Card>

        <Card title="History">
          <ul className="timeline">
            {claim.events.map((e: any) => (
              <li key={e.id} className={`tl-${e.action}`}>
                <div>
                  <strong>{EVENT_LABEL[e.action] || e.action}</strong>
                  {e.stage && e.action !== 'paid' ? <span className="muted"> · {e.stage}</span> : null}
                  <span className="muted"> · {e.actor_name}{e.actor_role ? ` (${ROLE_LABELS[e.actor_role as Role] || e.actor_role})` : ''}</span>
                </div>
                {e.note && <div className="small">{e.note}</div>}
                <small className="muted">{niceDateTime(e.created_at)}</small>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {attendance && <AttendanceModal claimId={claim.id} line={attendance} onClose={() => setAttendance(null)} />}
      {addingTask && <AddTask claim={claim} onClose={() => setAddingTask(false)} onSaved={reload} />}
      {deciding && <Decide claim={claim} mode={deciding} onClose={() => setDeciding(null)} onDone={reload} />}
    </div>
  );
}
