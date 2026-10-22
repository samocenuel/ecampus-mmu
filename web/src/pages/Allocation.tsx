import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Lock, Megaphone, Pencil, Trash2, UserPlus } from 'lucide-react';
import { api } from '../api';
import { useFeedback } from '../components/feedback';
import { Alert, Badge, Button, Card, Checkbox, DataTable, ErrorNote, Field, IconButton, Input, Modal, PageHeader, Progress, Select, Spinner, Textarea } from '../components/ui';
import { useFetch } from '../hooks';
import { useTerms } from './Timetable';

export type Workload = { id: number; name: string; hours: number; min: number; max: number; part_time_hours: number; status: 'under' | 'ok' | 'over'; spare: number; employment_type: string };

const loadLabel = (w?: Workload) => (w ? `${w.hours}/${w.max} h${w.hours >= w.max ? ' · full' : ''}` : '');

/** Shows what the allocation does to the lecturer's load, and the override when it goes above their maximum. */
function WorkloadCheck({ w, adding, override, setOverride, onCall }: { w?: Workload; adding: number; override: boolean; setOverride: (v: boolean) => void; onCall?: () => void }) {
  if (!w) return null;
  const after = Math.round((w.hours + adding) * 10) / 10;
  if (after <= w.max) {
    return (
      <p className="muted small span-2 m0">
        {w.name}: {w.hours} h → {after} h a week (limits {w.min}-{w.max} h){after < w.min ? ' · still under the minimum' : ''}
      </p>
    );
  }
  const excess = Math.round(Math.min(adding, after - w.max) * 10) / 10;
  const internal = w.employment_type !== 'part_time';
  return (
    <div className="span-2">
      <Alert tone="warning" title={`Above ${w.name}'s maximum load`}>
        {after} h a week against a maximum of {w.max} h.
        <Checkbox
          label={internal ? `Override: pay the extra ${excess} h a week as internal part-time load` : `Override: allow ${excess} h above their agreed maximum`}
          checked={override}
          onChange={setOverride}
        />
        {onCall && (
          <div style={{ marginTop: 6 }}>
            <Button size="sm" variant="secondary" icon={<Megaphone size={14} />} onClick={onCall}>
              Call for internal part-timers instead
            </Button>
          </div>
        )}
      </Alert>
    </div>
  );
}

/** Offers a unit to full-time staff as paid internal part-time load; they respond in Part-time calls. */
export function CallDialog({ unit, termId, onClose, onDone }: { unit: any; termId: number; onClose: () => void; onDone?: () => void }) {
  const { toast, fail } = useFeedback();
  const pending = unit.classes.filter((c: any) => !c.allocation_id);
  const [form, setForm] = useState({ hours_per_week: unit.hours_per_week, note: '', class_ids: pending.map((c: any) => c.class_id) as number[] });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api<any>('/api/allocations/part-time-calls', { method: 'POST', body: { term_id: termId, course_unit_id: unit.course_unit_id, ...form } });
      toast(`Call sent to ${r.notified} full-time staff`);
      onDone?.();
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
      onClose={onClose}
      title={`Call for internal part-timers: ${unit.code}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} icon={<Megaphone size={16} />} disabled={!form.class_ids.length}>
            Send call
          </Button>
        </>
      }
    >
      <p className="muted">
        {unit.name}. Full-time staff in the department are notified; those who can take it respond, and you assign one in Part-time calls. Their hours on it are paid as part-time load.
      </p>
      <div className="form-grid">
        <Field label="Hours per week">
          <Input type="number" min={1} max={20} value={form.hours_per_week} onChange={(e) => setForm({ ...form, hours_per_week: Number(e.target.value) })} />
        </Field>
        <div />
        <div className="span-2">
          <div className="field-label">Classes</div>
          <div className="check-grid">
            {pending.map((c: any) => (
              <Checkbox
                key={c.class_id}
                label={`${c.class_name} (${c.program_code})`}
                checked={form.class_ids.includes(c.class_id)}
                onChange={(v) => setForm((x) => ({ ...x, class_ids: v ? [...x.class_ids, c.class_id] : x.class_ids.filter((id) => id !== c.class_id) }))}
              />
            ))}
          </div>
        </div>
        <Field label="Note for staff" span={2}>
          <Textarea value={form.note} placeholder="e.g. evening sessions, starts in week 3" onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

function AllocateDialog({ unit, termId, lecturers, workloads, onClose, onDone, onCall }: { unit: any; termId: number; lecturers: any[]; workloads: Map<number, Workload>; onClose: () => void; onDone: () => void; onCall: () => void }) {
  const { toast, fail, withConfirm } = useFeedback();
  const pending = unit.classes.filter((c: any) => !c.allocation_id);
  const [form, setForm] = useState({ lecturer_id: '', hours_per_week: unit.hours_per_week, notes: '', class_ids: pending.map((c: any) => c.class_id) as number[] });
  const [busy, setBusy] = useState(false);
  const [override, setOverride] = useState(false);
  const toggle = (id: number, on: boolean) => setForm((f) => ({ ...f, class_ids: on ? [...f.class_ids, id] : f.class_ids.filter((x) => x !== id) }));
  const w = workloads.get(Number(form.lecturer_id));
  const overMax = Boolean(w && w.hours + Number(form.hours_per_week) > w.max);

  const save = async () => {
    setBusy(true);
    try {
      const res = await withConfirm((force) =>
        api('/api/allocations', { method: 'POST', body: { term_id: termId, course_unit_id: unit.course_unit_id, ...form, force, override_workload: override } }),
      );
      if (res) {
        toast(`${unit.code} allocated to ${res.lecturer_name}${res.part_time_hours ? ` (${res.part_time_hours} h a week internal part-time)` : ''}`);
        onDone();
        onClose();
      }
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={
        <span className="row gap-sm">
          Allocate {unit.code} {unit.is_cross_cutting ? <Badge tone="warning">Cross-cutting</Badge> : null}
        </span>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!form.lecturer_id || !form.class_ids.length || (overMax && !override)}>
            Allocate
          </Button>
        </>
      }
    >
      <p className="muted">{unit.name}</p>
      <div className="form-grid">
        <Field label="Lecturer *" span={2}>
          <Select
            value={form.lecturer_id}
            onChange={(e) => {
              setForm({ ...form, lecturer_id: e.target.value });
              setOverride(false);
            }}
            placeholder="Choose a lecturer..."
            options={lecturers.map((l) => ({
              value: l.id,
              label: `${l.title ? `${l.title} ` : ''}${l.name} · ${l.department_name || 'No department'} · ${loadLabel(workloads.get(l.id)) || '0 h'}`,
            }))}
          />
        </Field>
        <WorkloadCheck w={w} adding={Number(form.hours_per_week) || 0} override={override} setOverride={setOverride} onCall={() => { onClose(); onCall(); }} />
        <Field label="Hours per week">
          <Input type="number" min={1} max={20} value={form.hours_per_week} onChange={(e) => setForm({ ...form, hours_per_week: Number(e.target.value) })} />
        </Field>
        <div />
        <div className="span-2">
          <div className="field-label">Classes taught together {unit.is_cross_cutting && <span className="muted">(combine classes from several programmes)</span>}</div>
          <div className="check-grid">
            {pending.map((c: any) => (
              <Checkbox key={c.class_id} label={`${c.class_name} (${c.program_code})`} checked={form.class_ids.includes(c.class_id)} onChange={(v) => toggle(c.class_id, v)} />
            ))}
          </div>
        </div>
        <Field label="Notes" span={2}>
          <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

function EditAllocation({ allocation, lecturers, workloads, onClose, onDone }: { allocation: any; lecturers: any[]; workloads: Map<number, Workload>; onClose: () => void; onDone: () => void }) {
  const { toast, fail } = useFeedback();
  const [form, setForm] = useState({ lecturer_id: String(allocation.lecturer_id), hours_per_week: allocation.hours_per_week, notes: allocation.notes || '' });
  const [busy, setBusy] = useState(false);
  const [conflicts, setConflicts] = useState<any[]>([]);
  const [override, setOverride] = useState(false);
  const sameLecturer = Number(form.lecturer_id) === allocation.lecturer_id;
  const base = workloads.get(Number(form.lecturer_id));
  const w = base && sameLecturer ? { ...base, hours: Math.round((base.hours - allocation.hours_per_week) * 10) / 10 } : base;
  const changed = !sameLecturer || Number(form.hours_per_week) !== allocation.hours_per_week;
  const overMax = changed && Boolean(w && w.hours + Number(form.hours_per_week) > w.max);
  const save = async () => {
    setBusy(true);
    setConflicts([]);
    try {
      await api(`/api/allocations/${allocation.id}`, { method: 'PUT', body: { ...form, override_workload: override } });
      toast('Allocation updated');
      onDone();
      onClose();
    } catch (err: any) {
      if (err.data?.conflicts) setConflicts(err.data.conflicts);
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${allocation.code} allocation`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={overMax && !override}>
            Save
          </Button>
        </>
      }
    >
      <p className="muted">
        {allocation.course_name} · {allocation.classes.map((c: any) => c.name).join(', ')}
      </p>
      <div className="form-grid">
        <Field label="Lecturer" span={2} help="Existing timetable sessions are re-checked for clashes with the new lecturer.">
          <Select value={form.lecturer_id} onChange={(e) => { setForm({ ...form, lecturer_id: e.target.value }); setOverride(false); }} options={lecturers.map((l) => ({ value: l.id, label: `${l.title ? `${l.title} ` : ''}${l.name} · ${loadLabel(workloads.get(l.id)) || '0 h'}` }))} />
        </Field>
        {changed && <WorkloadCheck w={w} adding={Number(form.hours_per_week) || 0} override={override} setOverride={setOverride} />}
        {allocation.part_time_hours > 0 && <p className="muted small span-2 m0">{allocation.part_time_hours} h a week of this allocation is internal part-time load.</p>}
        <Field label="Hours per week">
          <Input type="number" min={1} max={20} value={form.hours_per_week} onChange={(e) => setForm({ ...form, hours_per_week: Number(e.target.value) })} />
        </Field>
        <Field label="Notes" span={2}>
          <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
      </div>
      {conflicts.map((c, i) => (
        <div key={i} className="text-danger small">
          {c.message}
        </div>
      ))}
    </Modal>
  );
}

function UnitTable({ units, onAllocate, onCall, locked }: { units: any[]; onAllocate: (u: any) => void; onCall: (u: any) => void; locked?: boolean }) {
  return (
    <DataTable
      rows={units.map((u) => ({ ...u, id: u.course_unit_id }))}
      searchKeys={['code', 'name']}
      empty="No course units are required this semester"
      columns={[
        { key: 'code', header: 'Code', width: '110px', render: (u) => <strong>{u.code}</strong> },
        { key: 'name', header: 'Course unit', render: (u) => <>{u.name} <span className="muted small">· {u.hours_per_week} hrs/wk</span></> },
        {
          key: 'classes',
          header: 'Classes',
          sortValue: (u) => u.allocated_count / Math.max(u.total, 1),
          render: (u) => (
            <div className="chips">
              {u.classes.map((c: any) => (
                <span key={c.class_id} className={`chip ${c.draft ? 'chip-draft' : c.allocation_id ? 'chip-done' : 'chip-pending'}`} title={c.lecturer_name ? `${c.draft ? 'Draft (copied from last year)' : 'Lecturer'}: ${c.lecturer_name}` : 'Not allocated'}>
                  {c.class_name}
                  {c.lecturer_name && <small> · {c.lecturer_name}</small>}
                </span>
              ))}
            </div>
          ),
        },
        {
          key: 'status',
          header: '',
          align: 'right',
          sortValue: (u) => (u.fully_allocated ? 1 : 0),
          render: (u) =>
            u.fully_allocated ? (
              <Badge tone="success">Allocated</Badge>
            ) : (
              <span className="row gap-sm" style={{ justifyContent: 'flex-end' }}>
                <IconButton label="Call for internal part-timers" onClick={() => onCall(u)}>
                  <Megaphone size={16} />
                </IconButton>
                <Button size="sm" variant={locked ? 'secondary' : 'primary'} icon={locked ? <Lock size={14} /> : <UserPlus size={14} />} onClick={() => onAllocate(u)}>
                  Allocate
                </Button>
              </span>
            ),
        },
      ]}
    />
  );
}

export default function Allocation() {
  const { terms, current } = useTerms();
  const [termId, setTermId] = useState<number | null>(null);
  const term = termId ?? current?.id;
  const { data: reqs, loading, error, reload: reloadReqs } = useFetch<any>(term ? `/api/allocations/requirements?term_id=${term}` : null);
  const { data: allocations, reload: reloadAllocs } = useFetch<any[]>(term ? `/api/allocations?term_id=${term}` : null);
  const { data: lecturers } = useFetch<any[]>('/api/users?roles=lecturer,hod,dean&active=1');
  const { toast, fail, confirm } = useFeedback();
  const [allocating, setAllocating] = useState<any>(null);
  const [editing, setEditing] = useState<any>(null);
  const [calling, setCalling] = useState<any>(null);
  const { data: loads, reload: reloadLoads } = useFetch<{ items: Workload[]; default_min: number; default_max: number }>(term ? `/api/allocations/workloads?term_id=${term}` : null);
  const { data: calls, reload: reloadCalls } = useFetch<any[]>(term ? `/api/allocations/part-time-calls?term_id=${term}` : null);
  const workloads = useMemo(() => new Map((loads?.items || []).map((w) => [w.id, w])), [loads]);
  const openCalls = (calls || []).filter((c) => c.status === 'open');

  const reload = () => {
    reloadReqs();
    reloadAllocs();
    reloadLoads();
    reloadCalls();
  };
  useEffect(() => setAllocating(null), [term]);

  const s = reqs?.summary;
  const ccDone = s ? s.cross_cutting_allocated >= s.cross_cutting_pairs : true;

  const drafts = (allocations || []).filter((a) => a.status === 'draft');
  const confirmOne = async (a: any) => {
    try {
      await api(`/api/allocations/${a.id}/confirm`, { method: 'POST' });
      toast(`${a.code} confirmed for ${a.lecturer_name}`);
      reload();
    } catch (err) {
      fail(err);
    }
  };
  const confirmAll = async () => {
    if (!(await confirm({ title: `Confirm ${drafts.length} draft allocations?`, message: 'They were copied from last year with the same lecturers. Confirmed allocations are placed when the timetable is generated, and lecturers are told.', confirmLabel: 'Confirm all' }))) return;
    try {
      const r = await api<any>('/api/allocations/confirm-drafts', { method: 'POST', body: { term_id: term } });
      toast(`${r.confirmed} allocations confirmed`);
      reload();
    } catch (err) {
      fail(err);
    }
  };

  const remove = async (a: any) => {
    const ok = await confirm({ title: 'Remove allocation?', message: `${a.code} for ${a.classes.map((c: any) => c.name).join(', ')} - its timetable sessions are removed too.`, confirmLabel: 'Remove', tone: 'danger' });
    if (!ok) return;
    try {
      await api(`/api/allocations/${a.id}`, { method: 'DELETE' });
      toast('Allocation removed');
      reload();
    } catch (err) {
      fail(err);
    }
  };

  return (
    <>
      <PageHeader
        title="Load allocation"
        subtitle="Assign lecturers to course units for each class. Cross-cutting units are allocated first."
        actions={
          <Select value={term ?? ''} onChange={(e) => setTermId(Number(e.target.value))} options={terms.map((t) => ({ value: t.id, label: `${t.name}${t.is_current ? ' (current)' : ''}` }))} aria-label="Term" />
        }
      />
      <ErrorNote error={error} />
      {loading && !reqs && <Spinner />}
      {reqs && (
        <div className="stack">
          {drafts.length > 0 && (
            <Alert tone="info" title={`${drafts.length} draft allocations copied from last year`} action={<Button size="sm" onClick={confirmAll}>Confirm all</Button>}>
              The same course units with last year's lecturers, matched to this year's classes. Change any that need a different lecturer (saving confirms it), then confirm the rest.
            </Alert>
          )}
          {openCalls.length > 0 && (
            <Alert tone="info" title={`${openCalls.length} internal part-time call${openCalls.length > 1 ? 's' : ''} open`} action={<Link to="/part-time-calls" className="btn btn-sm btn-secondary">Review responses</Link>}>
              {openCalls.map((c) => `${c.code} (${c.response_count} responded)`).join(', ')}
            </Alert>
          )}
          {reqs.cross_cutting_units_defined === 0 && (
            <Alert tone="warning" title="No cross-cutting course units have been created" action={<Link to="/setup/course-units" className="btn btn-sm btn-primary">Create course units</Link>}>
              Cross-cutting units (e.g. Communication Skills) are shared by several programmes and must be created and allocated before programme-specific units.
            </Alert>
          )}
          <div className="grid-2">
            <div className={`step-card ${ccDone ? 'done' : 'active'}`}>
              <div className="step-num">{ccDone ? <CheckCircle2 size={18} /> : 1}</div>
              <div className="grow">
                <strong>Cross-cutting units</strong>
                <div className="muted small">
                  {s.cross_cutting_allocated} of {s.cross_cutting_pairs} class allocations · {s.cross_cutting_units} units
                </div>
                <Progress value={s.cross_cutting_allocated} total={s.cross_cutting_pairs} tone="warning" />
              </div>
            </div>
            <div className={`step-card ${!ccDone ? 'locked' : s.other_allocated >= s.other_pairs ? 'done' : 'active'}`}>
              <div className="step-num">{!ccDone ? <Lock size={16} /> : s.other_allocated >= s.other_pairs ? <CheckCircle2 size={18} /> : 2}</div>
              <div className="grow">
                <strong>Programme-specific units</strong>
                <div className="muted small">
                  {s.other_allocated} of {s.other_pairs} class allocations · {s.other_units} units
                </div>
                <Progress value={s.other_allocated} total={s.other_pairs} />
              </div>
            </div>
          </div>

          <Card title={<span className="row gap-sm">Step 1 · Cross-cutting units <Badge tone="warning">allocate first</Badge></span>} padded={false}>
            <UnitTable units={reqs.cross_cutting} onAllocate={setAllocating} onCall={setCalling} />
          </Card>

          <Card title="Step 2 · Programme-specific units" padded={false}>
            {!ccDone && (
              <div className="pad-x">
                <Alert tone="warning" title="Cross-cutting units are still pending">
                  <span className="row gap-sm">
                    <AlertTriangle size={14} /> Finish Step 1 first. If you allocate a programme unit now, you'll be asked to confirm.
                  </span>
                </Alert>
              </div>
            )}
            <UnitTable units={reqs.program_specific} onAllocate={setAllocating} onCall={setCalling} locked={!ccDone} />
          </Card>

          {loads && loads.items.length > 0 && (
            <Card title="Staff workload" actions={<span className="muted small">Default {loads.default_min}-{loads.default_max} h a week</span>} padded={false}>
              <DataTable
                rows={loads.items}
                searchKeys={['name']}
                columns={[
                  { key: 'name', header: 'Lecturer', render: (w: Workload) => <>{w.name} {w.employment_type === 'part_time' && <Badge tone="info">Part-time</Badge>}</> },
                  {
                    key: 'hours',
                    header: 'Hours / week',
                    render: (w: Workload) => (
                      <div className="bar-cell">
                        <div className="bar" style={{ width: `${Math.min(100, (w.hours / Math.max(w.max, 1)) * 100)}%` }} />
                        <span>{w.hours} h</span>
                      </div>
                    ),
                  },
                  { key: 'max', header: 'Limits', align: 'right', render: (w: Workload) => `${w.min}-${w.max} h`, hideOnMobile: true },
                  { key: 'part_time_hours', header: 'Internal part-time', align: 'right', render: (w: Workload) => (w.part_time_hours ? `${w.part_time_hours} h` : '-'), hideOnMobile: true },
                  {
                    key: 'status',
                    header: 'Load',
                    align: 'right',
                    render: (w: Workload) => (w.status === 'over' ? <Badge tone="danger">Over maximum</Badge> : w.status === 'under' ? <Badge tone="warning">Under minimum</Badge> : <Badge tone="success">Within limits</Badge>),
                  },
                ]}
              />
            </Card>
          )}

          <Card title={`Allocations this term (${allocations?.length ?? 0})`} padded={false}>
            <DataTable
              rows={allocations}
              searchKeys={['code', 'course_name', 'lecturer_name']}
              columns={[
                { key: 'code', header: 'Unit', render: (a) => <><strong>{a.code}</strong> {a.is_cross_cutting ? <span className="cc-tag">CC</span> : null}<div className="muted small">{a.course_name}</div></> },
                { key: 'classes', header: 'Classes', render: (a) => a.classes.map((c: any) => c.name).join(', ') },
                { key: 'lecturer_name', header: 'Lecturer', render: (a) => <>{`${a.lecturer_title ? `${a.lecturer_title} ` : ''}${a.lecturer_name}`} {a.status === 'draft' && <Badge tone="info">Draft</Badge>} {a.part_time_hours > 0 && <Badge tone="warning">{`Part-time ${a.part_time_hours} h`}</Badge>}</> },
                {
                  key: 'hours_per_week',
                  header: 'Scheduled',
                  render: (a) => (
                    <span className={Number(a.scheduled_hours) < a.hours_per_week ? 'text-warning' : 'text-success'}>
                      {Number(a.scheduled_hours)}/{a.hours_per_week} h
                    </span>
                  ),
                },
                {
                  key: '_a',
                  header: '',
                  align: 'right',
                  render: (a) => (
                    <div className="row-actions">
                      {a.status === 'draft' && (
                        <IconButton label="Confirm" onClick={() => confirmOne(a)}>
                          <CheckCircle2 size={16} />
                        </IconButton>
                      )}
                      <IconButton label="Edit" onClick={() => setEditing(a)}>
                        <Pencil size={16} />
                      </IconButton>
                      <IconButton label="Remove" className="danger" onClick={() => remove(a)}>
                        <Trash2 size={16} />
                      </IconButton>
                    </div>
                  ),
                },
              ]}
            />
          </Card>
        </div>
      )}
      {allocating && term && (
        <AllocateDialog unit={allocating} termId={term} lecturers={lecturers || []} workloads={workloads} onClose={() => setAllocating(null)} onDone={reload} onCall={() => setCalling(allocating)} />
      )}
      {editing && <EditAllocation allocation={editing} lecturers={lecturers || []} workloads={workloads} onClose={() => setEditing(null)} onDone={reload} />}
      {calling && term && <CallDialog unit={calling} termId={term} onClose={() => setCalling(null)} onDone={reload} />}
    </>
  );
}
