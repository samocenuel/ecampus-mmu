import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarPlus, CheckCircle2, LayoutGrid, List, Trash2, Wand2, XCircle } from 'lucide-react';
import { api, ApiError, qs } from '../api';
import { useAuth } from '../auth';
import { useFeedback } from '../components/feedback';
import { Agenda, WeekGrid } from '../components/WeekGrid';
import { Alert, Badge, Button, Card, Checkbox, EmptyState, ErrorNote, Field, Input, Modal, PageHeader, Select, Spinner, Tabs } from '../components/ui';
import { useDebounced, useFetch, usePersistentState } from '../hooks';
import { DAY_NAMES, MANAGER_ROLES, Session } from '../types';
import { ExportButtons } from './MyTimetable';

type ViewType = 'all' | 'class' | 'lecturer' | 'room' | 'department';

const addHours = (t: string, h: number) => {
  const [hh, mm] = t.split(':').map(Number);
  const m = Math.min(hh * 60 + mm + h * 60, 23 * 60 + 59);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

export function useTerms() {
  const { data: terms } = useFetch<any[]>('/api/terms');
  const current = terms?.find((t) => t.is_current) || terms?.[0];
  return { terms: terms || [], current };
}

function SessionEditor({
  open,
  onClose,
  termId,
  session,
  settings,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  termId: number;
  session: Session | null;
  settings: any;
  onSaved: () => void;
}) {
  const { toast, fail, withConfirm, confirm } = useFeedback();
  const { data: allocations } = useFetch<any[]>(open ? `/api/allocations?term_id=${termId}` : null);
  const { data: rooms } = useFetch<any[]>(open ? '/api/rooms' : null);
  const [form, setForm] = useState<any>({});
  const [check, setCheck] = useState<{ conflicts: any[]; warnings: string[] } | null>(null);
  const [freeRooms, setFreeRooms] = useState<number[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCheck(null);
    setForm(
      session
        ? { allocation_id: session.allocation_id, room_id: session.room_id, day_of_week: session.day_of_week, start_time: session.start_time, end_time: session.end_time }
        : { allocation_id: '', room_id: '', day_of_week: settings?.teaching_days?.[0] || 1, start_time: '08:00', end_time: '10:00' },
    );
  }, [open, session, settings]);

  const debounced = useDebounced(form, 350);
  const allocation = allocations?.find((a) => a.id === Number(form.allocation_id));

  useEffect(() => {
    if (!open || !debounced.allocation_id || !debounced.day_of_week || !debounced.start_time || !debounced.end_time) return;
    let alive = true;
    api(`/api/timetable/free-rooms${qs({ term_id: termId, day: debounced.day_of_week, start: debounced.start_time, end: debounced.end_time })}`)
      .then((r) => alive && setFreeRooms(r.map((x: any) => x.id).concat(session ? [session.room_id] : [])))
      .catch(() => alive && setFreeRooms(null));
    if (debounced.room_id) {
      api('/api/timetable/check', { method: 'POST', body: { ...debounced, exclude_session_id: session?.id } })
        .then((r) => alive && setCheck(r))
        .catch((err) => alive && setCheck({ conflicts: [{ type: 'error', message: err.message }], warnings: [] }));
    }
    return () => {
      alive = false;
    };
  }, [open, debounced, termId, session]);

  const save = async () => {
    setSaving(true);
    try {
      const body = { ...form };
      const result = await withConfirm((force) =>
        session ? api(`/api/timetable/sessions/${session.id}`, { method: 'PUT', body: { ...body, force } }) : api('/api/timetable/sessions', { method: 'POST', body: { ...body, force } }),
      );
      if (result) {
        toast(session ? 'Session moved' : 'Session added');
        onSaved();
        onClose();
      }
    } catch (err) {
      if (err instanceof ApiError && err.data?.conflicts) setCheck({ conflicts: err.data.conflicts, warnings: err.data.warnings || [] });
      else fail(err);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!session) return;
    const yes = await confirm({ title: 'Remove session?', message: `Remove ${session.course_code} on ${DAY_NAMES[session.day_of_week]} ${session.start_time} from the timetable?`, confirmLabel: 'Remove', tone: 'danger' });
    if (!yes) return;
    try {
      const ok = await withConfirm((force) => api(`/api/timetable/sessions/${session.id}${force ? '?force=1' : ''}`, { method: 'DELETE' }));
      if (ok) {
        toast('Session removed');
        onSaved();
        onClose();
      }
    } catch (err) {
      fail(err);
    }
  };

  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v, ...(k === 'start_time' && f.end_time <= v ? { end_time: addHours(v, 2) } : {}) }));
  const days = settings?.teaching_days?.length ? settings.teaching_days : [1, 2, 3, 4, 5];

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={session ? `${session.course_code} - move or remove` : 'Add a lecture session'}
      footer={
        <>
          {session && (
            <Button variant="danger" icon={<Trash2 size={16} />} onClick={remove} className="mr-auto">
              Remove
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={!form.allocation_id || !form.room_id || Boolean(check?.conflicts.length)}>
            {session ? 'Save' : 'Add session'}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Allocation (course unit · lecturer · classes)" span={2}>
          <Select
            value={form.allocation_id}
            disabled={Boolean(session)}
            onChange={(e) => set('allocation_id', e.target.value)}
            placeholder="Select an allocation..."
            options={(allocations || []).map((a) => ({
              value: a.id,
              label: `${a.is_cross_cutting ? '[CC] ' : ''}${a.code} ${a.course_name} · ${a.lecturer_name} · ${a.classes.map((c: any) => c.name).join(', ')} (${Number(a.scheduled_hours)}/${a.hours_per_week}h scheduled)`,
            }))}
          />
        </Field>
        <Field label="Day">
          <Select value={form.day_of_week} onChange={(e) => set('day_of_week', Number(e.target.value))} options={days.map((d: number) => ({ value: d, label: DAY_NAMES[d] }))} />
        </Field>
        <div className="row gap-sm">
          <Field label="Start">
            <Input type="time" value={form.start_time} step={900} onChange={(e) => set('start_time', e.target.value)} />
          </Field>
          <Field label="End">
            <Input type="time" value={form.end_time} step={900} onChange={(e) => set('end_time', e.target.value)} />
          </Field>
        </div>
        <Field label="Room" span={2} help={allocation ? `Combined class size: ${allocation.classes.length} class(es)` : undefined}>
          <Select
            value={form.room_id}
            onChange={(e) => set('room_id', e.target.value)}
            placeholder="Select a room..."
            options={(rooms || [])
              .filter((r) => r.active)
              .map((r) => ({
                value: r.id,
                label: `${r.name}${r.building ? ` (${r.building})` : ''} · ${r.capacity} seats${freeRooms && !freeRooms.includes(r.id) ? ' · BUSY' : ''}`,
              }))}
          />
        </Field>
      </div>
      {check && (
        <div className="check-result">
          {check.conflicts.length === 0 && check.warnings.length === 0 && (
            <div className="text-success row gap-sm">
              <CheckCircle2 size={16} /> No collisions - the room, lecturer and classes are all free.
            </div>
          )}
          {check.conflicts.map((c, i) => (
            <div key={i} className="text-danger row gap-sm">
              <XCircle size={16} /> {c.message}
            </div>
          ))}
          {check.warnings.map((w) => (
            <div key={w} className="text-warning row gap-sm">
              <AlertTriangle size={16} /> {w}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function GenerateDialog({ open, onClose, termId, onDone }: { open: boolean; onClose: () => void; termId: number; onDone: () => void }) {
  const { fail, toast } = useFeedback();
  const [clear, setClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  useEffect(() => {
    if (open) setResult(null);
  }, [open]);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api('/api/timetable/generate', { method: 'POST', body: { term_id: termId, clear_existing: clear } });
      setResult(r);
      toast(`Timetable generated: ${r.placed} session(s) placed`);
      onDone();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Generate timetable"
      footer={
        result ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button icon={<Wand2 size={16} />} loading={busy} onClick={run}>
              Generate
            </Button>
          </>
        )
      }
    >
      {!result ? (
        <>
          <p>The generator places every allocation's weekly hours into the timetable:</p>
          <ul className="detail-list">
            <li>Cross-cutting units are placed first, then the largest classes.</li>
            <li>No room, lecturer or class is ever double-booked.</li>
            <li>Hours are split into blocks of up to 2 hours on different days, avoiding lunch.</li>
            <li>Each block gets the smallest free room that seats the combined classes.</li>
          </ul>
          <Checkbox label="Clear previously generated sessions first (sessions with attendance are kept)" checked={clear} onChange={setClear} />
        </>
      ) : (
        <>
          <div className="stat-grid compact">
            <div className="stat stat-success">
              <div>
                <div className="stat-value">{result.placed}</div>
                <div className="stat-label">sessions placed</div>
              </div>
            </div>
            <div className="stat">
              <div>
                <div className="stat-value">{result.total_sessions}</div>
                <div className="stat-label">sessions in timetable</div>
              </div>
            </div>
          </div>
          {result.unplaced.length > 0 ? (
            <Alert tone="warning" title={`${result.unplaced.length} allocation(s) could not be fully placed`}>
              <ul className="detail-list">
                {result.unplaced.map((u: any) => (
                  <li key={u.allocation_id}>
                    <strong>{u.code}</strong> {u.course_name} - {u.hours}h: {u.reason}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : (
            <Alert tone="success" title="Every allocation is fully scheduled with no collisions." />
          )}
        </>
      )}
    </Modal>
  );
}

export default function Timetable() {
  const { user } = useAuth();
  const isManager = MANAGER_ROLES.includes(user!.role);
  const { terms, current } = useTerms();
  const [termId, setTermId] = useState<number | null>(null);
  const [viewType, setViewType] = usePersistentState<ViewType>('lms_tt_type', 'all');
  const [entity, setEntity] = useState<string>('');
  const [layout, setLayout] = usePersistentState<'week' | 'list'>('lms_tt_layout', 'week');
  const [editing, setEditing] = useState<Session | 'new' | null>(null);
  const [generating, setGenerating] = useState(false);
  const term = termId ?? current?.id;

  const { data: classes } = useFetch<any[]>('/api/classes');
  const { data: lecturers } = useFetch<any[]>('/api/users?roles=lecturer,hod,dean&active=1');
  const { data: rooms } = useFetch<any[]>('/api/rooms');
  const { data: departments } = useFetch<any[]>('/api/departments');

  const entityOptions = useMemo(() => {
    if (viewType === 'class') return (classes || []).map((c) => ({ value: c.id, label: c.name }));
    if (viewType === 'lecturer') return (lecturers || []).map((l) => ({ value: l.id, label: `${l.title ? `${l.title} ` : ''}${l.name}` }));
    if (viewType === 'room') return (rooms || []).map((r) => ({ value: r.id, label: `${r.name}${r.building ? ` (${r.building})` : ''}` }));
    if (viewType === 'department') return (departments || []).map((d) => ({ value: d.id, label: d.name }));
    return [];
  }, [viewType, classes, lecturers, rooms, departments]);

  useEffect(() => {
    setEntity(entityOptions[0] ? String(entityOptions[0].value) : '');
  }, [entityOptions]);

  const filterKey = { class: 'class_id', lecturer: 'lecturer_id', room: 'room_id', department: 'department_id', all: '' }[viewType];
  const query = term ? `term_id=${term}${viewType !== 'all' && entity ? `&${filterKey}=${entity}` : ''}` : null;
  const ready = query && (viewType === 'all' || entity);
  const { data, loading, error, reload } = useFetch<any>(ready ? `/api/timetable?${query}` : null);

  return (
    <>
      <PageHeader
        title="Timetable"
        subtitle={data?.title || 'Weekly teaching timetable'}
        actions={
          <>
            {query && <ExportButtons query={`${query}${viewType === 'all' ? '' : ''}`} />}
            {isManager && (
              <Button variant="secondary" icon={<CalendarPlus size={16} />} onClick={() => setEditing('new')} disabled={!term}>
                Add session
              </Button>
            )}
            {user!.role === 'admin' && (
              <Button icon={<Wand2 size={16} />} onClick={() => setGenerating(true)} disabled={!term}>
                Generate
              </Button>
            )}
          </>
        }
      />
      <div className="filters">
        <Field label="Term">
          <Select value={term ?? ''} onChange={(e) => setTermId(Number(e.target.value))} options={terms.map((t) => ({ value: t.id, label: `${t.name}${t.is_current ? ' (current)' : ''}` }))} />
        </Field>
        <Field label="View">
          <Select
            value={viewType}
            onChange={(e) => setViewType(e.target.value as ViewType)}
            options={[
              { value: 'all', label: isManager && user!.role !== 'admin' ? 'My unit (master)' : 'Master timetable' },
              { value: 'class', label: 'By class' },
              { value: 'lecturer', label: 'By lecturer' },
              { value: 'room', label: 'By room' },
              { value: 'department', label: 'By department' },
            ]}
          />
        </Field>
        {viewType !== 'all' && (
          <Field label={viewType[0].toUpperCase() + viewType.slice(1)}>
            <Select value={entity} onChange={(e) => setEntity(e.target.value)} options={entityOptions} />
          </Field>
        )}
        <div className="filters-end">
          <Tabs
            value={layout}
            onChange={setLayout}
            tabs={[
              { value: 'week', label: <LayoutGrid size={15} /> },
              { value: 'list', label: <List size={15} /> },
            ]}
          />
        </div>
      </div>
      <ErrorNote error={error} />
      {!terms.length && <Alert tone="warning" title="Create an academic term first" />}
      {loading && !data && <Spinner />}
      {data && (
        <Card padded={false} title={<span className="row gap-sm">{data.title} <Badge>{data.sessions.length} sessions</Badge></span>} actions={<span className="muted small hide-sm"><span className="cc-tag">CC</span> cross-cutting</span>}>
          {data.sessions.length === 0 ? (
            <EmptyState title="No sessions in this view">{user!.role === 'admin' ? 'Allocate lecturers, then use Generate to build the timetable automatically.' : 'Nothing scheduled yet.'}</EmptyState>
          ) : layout === 'week' ? (
            <WeekGrid sessions={data.sessions} settings={data.settings} onSelect={isManager ? (s) => setEditing(s) : undefined} showClasses={viewType !== 'class'} />
          ) : (
            <div className="pad">
              <Agenda sessions={data.sessions} onSelect={isManager ? (s) => setEditing(s) : undefined} showClasses={viewType !== 'class'} />
            </div>
          )}
        </Card>
      )}
      {term && (
        <>
          <SessionEditor open={editing !== null} onClose={() => setEditing(null)} termId={term} session={editing === 'new' ? null : editing} settings={data?.settings} onSaved={reload} />
          <GenerateDialog open={generating} onClose={() => setGenerating(false)} termId={term} onDone={reload} />
        </>
      )}
    </>
  );
}
