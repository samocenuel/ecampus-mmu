import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Lock, Pencil, Trash2, UserPlus } from 'lucide-react';
import { api } from '../api';
import { useFeedback } from '../components/feedback';
import { Alert, Badge, Button, Card, Checkbox, DataTable, ErrorNote, Field, IconButton, Input, Modal, PageHeader, Progress, Select, Spinner, Textarea } from '../components/ui';
import { useFetch } from '../hooks';
import { useTerms } from './Timetable';

function AllocateDialog({ unit, termId, lecturers, load, onClose, onDone }: { unit: any; termId: number; lecturers: any[]; load: Map<number, number>; onClose: () => void; onDone: () => void }) {
  const { toast, fail, withConfirm } = useFeedback();
  const pending = unit.classes.filter((c: any) => !c.allocation_id);
  const [form, setForm] = useState({ lecturer_id: '', hours_per_week: unit.hours_per_week, notes: '', class_ids: pending.map((c: any) => c.class_id) as number[] });
  const [busy, setBusy] = useState(false);
  const toggle = (id: number, on: boolean) => setForm((f) => ({ ...f, class_ids: on ? [...f.class_ids, id] : f.class_ids.filter((x) => x !== id) }));

  const save = async () => {
    setBusy(true);
    try {
      const res = await withConfirm((force) =>
        api('/api/allocations', { method: 'POST', body: { term_id: termId, course_unit_id: unit.course_unit_id, ...form, force } }),
      );
      if (res) {
        toast(`${unit.code} allocated to ${res.lecturer_name}`);
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
          <Button onClick={save} loading={busy} disabled={!form.lecturer_id || !form.class_ids.length}>
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
            onChange={(e) => setForm({ ...form, lecturer_id: e.target.value })}
            placeholder="Choose a lecturer..."
            options={lecturers.map((l) => ({
              value: l.id,
              label: `${l.title ? `${l.title} ` : ''}${l.name} · ${l.department_name || 'No department'} · ${load.get(l.id) || 0} hrs/wk allocated`,
            }))}
          />
        </Field>
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

function EditAllocation({ allocation, lecturers, onClose, onDone }: { allocation: any; lecturers: any[]; onClose: () => void; onDone: () => void }) {
  const { toast, fail } = useFeedback();
  const [form, setForm] = useState({ lecturer_id: String(allocation.lecturer_id), hours_per_week: allocation.hours_per_week, notes: allocation.notes || '' });
  const [busy, setBusy] = useState(false);
  const [conflicts, setConflicts] = useState<any[]>([]);
  const save = async () => {
    setBusy(true);
    setConflicts([]);
    try {
      await api(`/api/allocations/${allocation.id}`, { method: 'PUT', body: form });
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
          <Button onClick={save} loading={busy}>
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
          <Select value={form.lecturer_id} onChange={(e) => setForm({ ...form, lecturer_id: e.target.value })} options={lecturers.map((l) => ({ value: l.id, label: `${l.title ? `${l.title} ` : ''}${l.name}` }))} />
        </Field>
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

function UnitTable({ units, onAllocate, locked }: { units: any[]; onAllocate: (u: any) => void; locked?: boolean }) {
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
                <span key={c.class_id} className={`chip ${c.allocation_id ? 'chip-done' : 'chip-pending'}`} title={c.lecturer_name ? `Lecturer: ${c.lecturer_name}` : 'Not allocated'}>
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
              <Button size="sm" variant={locked ? 'secondary' : 'primary'} icon={locked ? <Lock size={14} /> : <UserPlus size={14} />} onClick={() => onAllocate(u)}>
                Allocate
              </Button>
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

  const reload = () => {
    reloadReqs();
    reloadAllocs();
  };
  const load = useMemo(() => {
    const m = new Map<number, number>();
    for (const a of allocations || []) m.set(a.lecturer_id, (m.get(a.lecturer_id) || 0) + a.hours_per_week);
    return m;
  }, [allocations]);
  useEffect(() => setAllocating(null), [term]);

  const s = reqs?.summary;
  const ccDone = s ? s.cross_cutting_allocated >= s.cross_cutting_pairs : true;

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
            <UnitTable units={reqs.cross_cutting} onAllocate={setAllocating} />
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
            <UnitTable units={reqs.program_specific} onAllocate={setAllocating} locked={!ccDone} />
          </Card>

          <Card title={`Allocations this term (${allocations?.length ?? 0})`} padded={false}>
            <DataTable
              rows={allocations}
              searchKeys={['code', 'course_name', 'lecturer_name']}
              columns={[
                { key: 'code', header: 'Unit', render: (a) => <><strong>{a.code}</strong> {a.is_cross_cutting ? <span className="cc-tag">CC</span> : null}<div className="muted small">{a.course_name}</div></> },
                { key: 'classes', header: 'Classes', render: (a) => a.classes.map((c: any) => c.name).join(', ') },
                { key: 'lecturer_name', header: 'Lecturer', render: (a) => `${a.lecturer_title ? `${a.lecturer_title} ` : ''}${a.lecturer_name}` },
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
      {allocating && term && <AllocateDialog unit={allocating} termId={term} lecturers={lecturers || []} load={load} onClose={() => setAllocating(null)} onDone={reload} />}
      {editing && <EditAllocation allocation={editing} lecturers={lecturers || []} onClose={() => setEditing(null)} onDone={reload} />}
    </>
  );
}
