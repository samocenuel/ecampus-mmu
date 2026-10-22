import { ChangeEvent, useMemo, useRef, useState } from 'react';
import { CalendarCheck, Download, FileSpreadsheet, FileText, Pencil, ShieldCheck, Trash2, Upload, UserPlus, Wand2, X } from 'lucide-react';
import { api, download } from '../api';
import { useAuth } from '../auth';
import { useFeedback } from '../components/feedback';
import {
  Alert, Badge, Button, Card, Checkbox, DataTable, EmptyState, ErrorNote, Field, IconButton, Input, Modal, PageHeader, Select, Spinner, StatCard, Tabs, Textarea,
} from '../components/ui';
import { useFetch, usePersistentState } from '../hooks';
import { useTerms } from './Timetable';

const niceDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

function GenerateExams({ termId, onClose, onDone }: { termId: number; onClose: () => void; onDone: () => void }) {
  const { fail } = useFeedback();
  const { data: events } = useFetch<any[]>('/api/ops/calendar-events');
  const period = events?.find((e) => e.kind === 'exams');
  const [form, setForm] = useState<any>({ start_date: '', end_date: '', slots: [['09:00', '12:00'], ['14:00', '17:00']], students_per_invigilator: 50, clear: false });
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const start = form.start_date || period?.start_date || '';
  const end = form.end_date || period?.end_date || '';
  const setSlot = (i: number, j: number, v: string) => setForm({ ...form, slots: form.slots.map((s: string[], k: number) => (k === i ? s.map((x, m) => (m === j ? v : x)) : s)) });
  const run = async () => {
    setBusy(true);
    try {
      setResult(await api('/api/exams/generate', { method: 'POST', body: { ...form, term_id: termId, start_date: start, end_date: end } }));
      onDone();
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
      title="Generate the exam timetable"
      onClose={onClose}
      footer={
        result ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button icon={<Wand2 size={16} />} loading={busy} disabled={!start || !end} onClick={run}>
              Generate
            </Button>
          </>
        )
      }
    >
      {result ? (
        <>
          <Alert tone={result.unplaced.length ? 'warning' : 'success'} title={`${result.placed} exams placed · ${result.total} in the timetable`}>
            {result.unplaced.length ? `${result.unplaced.length} could not be placed.` : 'Every course unit has an exam slot.'}
          </Alert>
          {result.unplaced.map((u: any) => (
            <div key={u.course_unit_id} className="small">
              <strong>{u.code}</strong> {u.name}: {u.reason}
            </div>
          ))}
          {result.warnings.map((w: string, i: number) => (
            <div key={i} className="small text-warning">
              {w}
            </div>
          ))}
        </>
      ) : (
        <>
          <p className="muted">Every course unit taught this term gets one exam. No class sits two exams in a day, rooms are large enough and never double-booked, and free lecturers are assigned to invigilate.</p>
          <div className="form-grid">
            <Field label="First exam day" help={period ? `From the academic calendar: ${period.title}` : 'Add an "Examinations" period to the academic calendar to fill this in.'}>
              <Input type="date" value={start} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
            </Field>
            <Field label="Last exam day">
              <Input type="date" value={end} min={start} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
            </Field>
            {form.slots.map((s: string[], i: number) => (
              <Field key={i} label={`Session ${i + 1}`}>
                <div className="row gap-sm">
                  <Input type="time" value={s[0]} onChange={(e) => setSlot(i, 0, e.target.value)} />
                  <Input type="time" value={s[1]} onChange={(e) => setSlot(i, 1, e.target.value)} />
                </div>
              </Field>
            ))}
            <Field label="Students per invigilator">
              <Input type="number" min={10} max={200} value={form.students_per_invigilator} onChange={(e) => setForm({ ...form, students_per_invigilator: e.target.value })} />
            </Field>
            <div className="span-2">
              <Checkbox label="Replace the current exam timetable for this term" checked={form.clear} onChange={(v) => setForm({ ...form, clear: v })} />
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}

function EditExam({ exam, onClose, onDone }: { exam: any; onClose: () => void; onDone: () => void }) {
  const { fail, toast } = useFeedback();
  const { data: rooms } = useFetch<any[]>('/api/rooms');
  const { data: staff } = useFetch<any[]>('/api/users?roles=lecturer,hod,dean&active=1');
  const [form, setForm] = useState({ exam_date: exam.exam_date, start_time: exam.start_time, end_time: exam.end_time, room_ids: exam.rooms.map((r: any) => r.id) as number[] });
  const [current, setCurrent] = useState(exam);
  const [add, setAdd] = useState({ user_id: '', room_id: '' });
  const [busy, setBusy] = useState(false);
  const toggleRoom = (id: number, on: boolean) => setForm({ ...form, room_ids: on ? [...form.room_ids, id] : form.room_ids.filter((r) => r !== id) });
  const seats = (rooms || []).filter((r) => form.room_ids.includes(r.id)).reduce((t, r) => t + r.capacity, 0);
  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/exams/${exam.id}`, { method: 'PUT', body: form });
      toast('Exam updated');
      onDone();
      onClose();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  const addInvigilator = async () => {
    try {
      setCurrent(await api(`/api/exams/${exam.id}/invigilators`, { method: 'POST', body: add }));
      setAdd({ user_id: '', room_id: '' });
      onDone();
    } catch (err) {
      fail(err);
    }
  };
  const removeInvigilator = async (id: number) => {
    try {
      setCurrent(await api(`/api/exams/${exam.id}/invigilators/${id}`, { method: 'DELETE' }));
      onDone();
    } catch (err) {
      fail(err);
    }
  };
  return (
    <Modal
      open
      wide
      title={`${exam.course_code} ${exam.course_name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button loading={busy} onClick={save} disabled={!form.room_ids.length}>
            Save date, time and rooms
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Date">
          <Input type="date" value={form.exam_date} onChange={(e) => setForm({ ...form, exam_date: e.target.value })} />
        </Field>
        <Field label="Time">
          <div className="row gap-sm">
            <Input type="time" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} />
            <Input type="time" value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} />
          </div>
        </Field>
      </div>
      <div className="field-label">
        Rooms <span className={seats < exam.students ? 'text-danger' : 'muted'}>({seats} seats for {exam.students} students)</span>
      </div>
      <div className="check-grid">
        {(rooms || []).map((r) => (
          <Checkbox key={r.id} label={`${r.name} (${r.capacity})`} checked={form.room_ids.includes(r.id)} onChange={(v) => toggleRoom(r.id, v)} />
        ))}
      </div>
      <div className="field-label">Invigilators</div>
      <ul className="name-list">
        {current.invigilators.map((p: any) => (
          <li key={p.id}>
            <span className="grow">
              {[p.title, p.name].filter(Boolean).join(' ')} <span className="muted small">{p.room_name || ''}</span>
            </span>
            <IconButton label="Remove" className="danger" onClick={() => removeInvigilator(p.id)}>
              <X size={15} />
            </IconButton>
          </li>
        ))}
        {!current.invigilators.length && <li className="muted">No invigilators yet</li>}
      </ul>
      <div className="row gap-sm wrap">
        <Select value={add.user_id} onChange={(e) => setAdd({ ...add, user_id: e.target.value })} placeholder="Add a staff member..." options={(staff || []).map((u) => ({ value: u.id, label: `${u.name} (${u.department_name || u.role})` }))} />
        <Select value={add.room_id} onChange={(e) => setAdd({ ...add, room_id: e.target.value })} placeholder="Any room" options={current.rooms.map((r: any) => ({ value: r.id, label: r.name }))} />
        <Button variant="secondary" icon={<UserPlus size={16} />} disabled={!add.user_id} onClick={addInvigilator}>
          Add
        </Button>
      </div>
    </Modal>
  );
}

function Override({ exam, student, onClose, onDone }: { exam: any; student: any; onClose: () => void; onDone: () => void }) {
  const { fail, toast } = useFeedback();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await api(`/api/exams/${exam.id}/overrides`, { method: 'POST', body: { student_id: student.id, reason } });
      toast(`${student.name} may sit the exam`);
      onDone();
      onClose();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open title={`Allow ${student.name} to sit ${exam.course_code}`} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={reason.trim().length < 5} onClick={go}>Allow to sit</Button></>}>
      <Alert tone="warning">{student.reasons.join(' · ')}</Alert>
      <Field label="Reason for the override *" help="Recorded with your name, e.g. medical leave with a hospital letter.">
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}

function Eligibility({ exam, onClose }: { exam: any; onClose: () => void }) {
  const { fail } = useFeedback();
  const { data, loading, error, reload } = useFetch<any>(`/api/exams/${exam.id}/eligibility`);
  const [overriding, setOverriding] = useState<any>(null);
  const [filter, setFilter] = useState<'all' | 'blocked'>('blocked');
  const rows = (data?.students || []).filter((s: any) => filter === 'all' || !s.eligible || s.override);
  const removeOverride = async (s: any) => {
    try {
      await api(`/api/exams/${exam.id}/overrides/${s.id}`, { method: 'DELETE' });
      reload();
    } catch (err) {
      fail(err);
    }
  };
  return (
    <Modal open wide title={`Who may sit ${exam.course_code}`} onClose={onClose} footer={<Button onClick={onClose}>Done</Button>}>
      <ErrorNote error={error} />
      {loading && !data && <Spinner />}
      {data && (
        <>
          <p className="muted m0">
            Students need at least {data.thresholds.exam_min_attendance}% attendance and {data.thresholds.coursework_min_percent}% of their programme's coursework total. The HoD or Dean can override.
          </p>
          <div className="stat-grid compact">
            <StatCard label="Students" value={data.students.length} />
            <StatCard label="Eligible" value={data.students.filter((s: any) => s.eligible).length} tone="success" />
            <StatCard label="Not eligible" value={data.students.filter((s: any) => !s.eligible).length} tone="danger" />
            <StatCard label="Overridden" value={data.students.filter((s: any) => s.override).length} />
          </div>
          <Tabs value={filter} onChange={setFilter} tabs={[{ value: 'blocked', label: 'Not eligible / overridden' }, { value: 'all', label: 'Everyone' }]} />
          <DataTable
            rows={rows}
            searchKeys={['name', 'identifier', 'class_name']}
            empty="Everyone is eligible"
            columns={[
              { key: 'name', header: 'Student', render: (s: any) => <><strong>{s.name}</strong><div className="muted small">{s.identifier} · {s.class_name}</div></> },
              { key: 'attendance', header: 'Attendance', sortValue: (s: any) => s.attendance.rate ?? 0, render: (s: any) => <span className={s.attendance.ok ? '' : 'text-danger'}>{s.attendance.rate === null ? '-' : `${s.attendance.rate}%`}<div className="muted small">{s.attendance.attended}/{s.attendance.total}</div></span> },
              { key: 'coursework', header: 'Coursework', sortValue: (s: any) => s.coursework?.percent ?? -1, render: (s: any) => s.coursework ? <span className={s.coursework.ok ? '' : 'text-danger'}>{s.coursework.mark}/{s.coursework.max}<div className="muted small">{s.coursework.percent}%</div></span> : <span className="text-danger">No mark</span> },
              {
                key: 'eligible',
                header: 'Status',
                render: (s: any) =>
                  s.override ? (
                    <><Badge tone="info">Allowed by {s.override.by}</Badge><div className="muted small">{s.override.reason}</div></>
                  ) : s.eligible ? (
                    <Badge tone="success">Eligible</Badge>
                  ) : (
                    <><Badge tone="danger">Not eligible</Badge><div className="muted small">{s.reasons.join(' · ')}</div></>
                  ),
              },
              {
                key: '_a',
                header: '',
                align: 'right',
                render: (s: any) =>
                  s.can_override &&
                  (s.override ? (
                    <Button size="sm" variant="ghost" onClick={() => removeOverride(s)}>
                      Withdraw
                    </Button>
                  ) : (
                    !s.eligible && (
                      <Button size="sm" variant="secondary" icon={<ShieldCheck size={14} />} onClick={() => setOverriding(s)}>
                        Override
                      </Button>
                    )
                  )),
              },
            ]}
          />
        </>
      )}
      {overriding && <Override exam={exam} student={overriding} onClose={() => setOverriding(null)} onDone={reload} />}
    </Modal>
  );
}

function ExamTimetable({ termId }: { termId: number }) {
  const { user } = useAuth();
  const { fail, confirm } = useFeedback();
  const { data, loading, error, reload } = useFetch<any>(`/api/exams?term_id=${termId}`);
  const [generating, setGenerating] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [eligible, setEligible] = useState<any>(null);
  const admin = user?.role === 'admin';
  const exportAs = async (format: 'pdf' | 'xlsx') => {
    try {
      await download(`/api/exams/export?term_id=${termId}&format=${format}`, `exam-timetable.${format}`);
    } catch (err) {
      fail(err);
    }
  };
  const remove = async (e: any) => {
    if (!(await confirm({ title: `Delete the ${e.course_code} exam?`, message: 'Its rooms, invigilators and eligibility overrides are removed.', confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      await api(`/api/exams/${e.id}`, { method: 'DELETE' });
      reload();
    } catch (err) {
      fail(err);
    }
  };
  return (
    <Card
      title="Exam timetable"
      padded={false}
      actions={
        <div className="card-actions">
          <Button size="sm" variant="secondary" icon={<FileText size={14} />} onClick={() => exportAs('pdf')}>
            PDF
          </Button>
          <Button size="sm" variant="secondary" icon={<FileSpreadsheet size={14} />} onClick={() => exportAs('xlsx')}>
            Excel
          </Button>
          {admin && (
            <Button size="sm" icon={<Wand2 size={14} />} onClick={() => setGenerating(true)}>
              Generate
            </Button>
          )}
        </div>
      }
    >
      <ErrorNote error={error} />
      <DataTable
        rows={data?.exams}
        loading={loading}
        searchKeys={['course_code', 'course_name', 'department_name']}
        empty={admin ? <EmptyState title="No exams yet" icon={<CalendarCheck size={26} />}>Use <strong>Generate</strong> to build the exam timetable.</EmptyState> : 'No exams scheduled yet'}
        columns={[
          { key: 'exam_date', header: 'Date', sortValue: (e: any) => `${e.exam_date} ${e.start_time}`, render: (e: any) => <>{niceDate(e.exam_date)}<div className="muted small">{e.start_time}-{e.end_time}</div></> },
          { key: 'course_code', header: 'Course unit', render: (e: any) => <><strong>{e.course_code}</strong> {e.course_name}<div className="muted small">{e.classes.map((c: any) => c.name).join(', ')} · {e.students} students</div></> },
          { key: 'rooms', header: 'Rooms', hideOnMobile: true, render: (e: any) => e.rooms.map((r: any) => `${r.name} (${r.seats})`).join(', ') || <span className="text-danger">None</span> },
          { key: 'invigilators', header: 'Invigilators', hideOnMobile: true, render: (e: any) => e.invigilators.map((p: any) => p.name).join(', ') || <span className="muted">None</span> },
          {
            key: '_a',
            header: '',
            align: 'right',
            render: (e: any) => (
              <div className="row-actions">
                <Button size="sm" variant="ghost" icon={<ShieldCheck size={14} />} onClick={() => setEligible(e)}>
                  Eligibility
                </Button>
                {admin && (
                  <>
                    <IconButton label="Edit" onClick={() => setEditing(e)}>
                      <Pencil size={16} />
                    </IconButton>
                    <IconButton label="Delete" className="danger" onClick={() => remove(e)}>
                      <Trash2 size={16} />
                    </IconButton>
                  </>
                )}
              </div>
            ),
          },
        ]}
      />
      {generating && <GenerateExams termId={termId} onClose={() => setGenerating(false)} onDone={reload} />}
      {editing && <EditExam exam={editing} onClose={() => setEditing(null)} onDone={reload} />}
      {eligible && <Eligibility exam={eligible} onClose={() => setEligible(null)} />}
    </Card>
  );
}

function Coursework({ termId }: { termId: number }) {
  const { fail, toast } = useFeedback();
  const { data: units, loading: unitsLoading } = useFetch<any[]>(`/api/exams/coursework/units?term_id=${termId}`);
  const [unitId, setUnitId] = usePersistentState<string>('lms_cw_unit', '');
  const unit = units?.find((u) => String(u.id) === String(unitId)) || units?.[0];
  const { data, loading, error, reload } = useFetch<any>(unit ? `/api/exams/coursework?term_id=${termId}&course_unit_id=${unit.id}` : null);
  const [outOf, setOutOf] = useState('100');
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const template = async () => {
    try {
      await download(`/api/exams/coursework/template?term_id=${termId}&course_unit_id=${unit.id}`, `coursework-${unit.code}.xlsx`);
    } catch (err) {
      fail(err);
    }
  };
  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('term_id', String(termId));
      form.append('course_unit_id', String(unit.id));
      form.append('out_of', outOf);
      form.append('file', file);
      const r = await api('/api/exams/coursework/upload', { method: 'POST', form });
      setResult(r);
      toast(`${r.updated} marks saved`);
      reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  const totals = useMemo(() => [...new Set((data?.students || []).map((s: any) => `${s.program_code}: out of ${s.coursework_max}`))], [data]);

  if (unitsLoading && !units) return <Spinner />;
  if (units && !units.length) return <EmptyState title="No course units for you this term">Coursework is entered by the lecturer of each course unit, or its HoD.</EmptyState>;
  return (
    <div className="stack">
      <Card
        title="Coursework marks"
        actions={
          <Select value={unit?.id || ''} onChange={(e) => { setUnitId(e.target.value); setResult(null); }} options={(units || []).map((u) => ({ value: u.id, label: `${u.code} ${u.name} (${u.marked}/${u.students})` }))} />
        }
      >
        <p className="muted m0">
          Download the template, enter each student's mark against their Reg No, then upload it and say what the marks are out of. eCampus converts them to each programme's coursework total ({totals.join(' · ') || 'set by the HoD'}). Students need at least half of it to sit the exam.
        </p>
        <div className="row gap-sm wrap">
          <Button variant="secondary" icon={<Download size={16} />} onClick={template} disabled={!unit}>
            Download template
          </Button>
          <Field label="Marks are out of">
            <Input type="number" min={1} max={1000} value={outOf} onChange={(e) => setOutOf(e.target.value)} style={{ width: 110 }} />
          </Field>
          <Button icon={<Upload size={16} />} loading={busy} disabled={!unit || !(Number(outOf) > 0)} onClick={() => fileRef.current?.click()}>
            Upload marks
          </Button>
          <input ref={fileRef} type="file" accept=".xlsx" hidden onChange={upload} />
        </div>
        {result && (
          <Alert tone={result.errors.length ? 'warning' : 'success'} title={`${result.updated} marks saved (out of ${result.out_of}), ${result.skipped} blank`}>
            {result.errors.slice(0, 8).map((e: any) => (
              <div key={e.row}>
                Row {e.row} ({e.reg_no || 'no Reg No'}): {e.error}
              </div>
            ))}
          </Alert>
        )}
      </Card>
      <Card padded={false}>
        <ErrorNote error={error} />
        <DataTable
          rows={data?.students}
          loading={loading}
          searchKeys={['name', 'identifier', 'class_name']}
          empty="No students take this course unit"
          columns={[
            { key: 'identifier', header: 'Reg No', render: (s: any) => s.identifier || <span className="text-danger">Missing</span> },
            { key: 'name', header: 'Student', render: (s: any) => <><strong>{s.name}</strong><div className="muted small">{s.class_name}</div></> },
            { key: 'raw_mark', header: 'Entered', hideOnMobile: true, render: (s: any) => (s.raw_mark != null ? `${s.raw_mark}/${s.out_of}` : '-') },
            { key: 'mark', header: 'Coursework', sortValue: (s: any) => (s.mark != null ? s.mark / s.max_mark : -1), render: (s: any) => (s.mark != null ? <span className={s.mark / s.max_mark < 0.5 ? 'text-danger' : ''}><strong>{s.mark}</strong>/{s.max_mark}</span> : <span className="muted">No mark</span>) },
          ]}
        />
      </Card>
    </div>
  );
}

function MyExams() {
  const { user } = useAuth();
  const { data, loading, error } = useFetch<any>('/api/exams/mine');
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorNote error={error} />;
  const exams = data?.exams || [];
  const student = user?.role === 'student';
  if (!exams.length) return <EmptyState title={student ? 'No exams scheduled yet' : 'No invigilation duties'} icon={<CalendarCheck size={26} />} />;
  return (
    <Card title={student ? 'My exams' : 'My invigilation duties'}>
      {student && (
        <p className="muted m0">
          To sit an exam you need {data.thresholds.exam_min_attendance}% attendance and at least {data.thresholds.coursework_min_percent}% of the coursework mark.
        </p>
      )}
      {exams.map((e: any) => (
        <div key={e.id} className="occ-row">
          <div className="occ-when">
            <strong>{niceDate(e.exam_date)}</strong>
            <div className="muted small">
              {e.start_time}-{e.end_time}
            </div>
          </div>
          <div className="occ-main">
            <strong>{e.course_code}</strong> {e.course_name}
            <div className="muted small">{e.duty ? `Invigilate in ${e.duty_room || e.rooms.map((r: any) => r.name).join(', ')}` : e.rooms.map((r: any) => r.name).join(', ')}</div>
            {e.eligibility && !e.eligibility.eligible && <div className="small text-danger">{e.eligibility.reasons.join(' · ')}. Talk to your HoD.</div>}
            {e.eligibility?.override && <div className="small">Allowed by {e.eligibility.override.by}</div>}
          </div>
          {e.eligibility && <Badge tone={e.eligibility.eligible ? 'success' : 'danger'}>{e.eligibility.eligible ? 'Eligible' : 'Not eligible'}</Badge>}
        </div>
      ))}
    </Card>
  );
}

type Tab = 'timetable' | 'coursework' | 'mine';

export default function Exams() {
  const { user } = useAuth();
  const { terms, current } = useTerms();
  const [termId, setTermId] = useState<number | null>(null);
  const term = termId ?? current?.id;
  const student = user?.role === 'student';
  const tabs = student
    ? [{ value: 'mine' as Tab, label: 'My exams' }]
    : [
        { value: 'timetable' as Tab, label: 'Exam timetable' },
        { value: 'coursework' as Tab, label: 'Coursework marks' },
        { value: 'mine' as Tab, label: 'My duties' },
      ];
  const [tab, setTab] = usePersistentState<Tab>('lms_exams_tab', tabs[0].value);
  const currentTab = tabs.some((t) => t.value === tab) ? tab : tabs[0].value;
  return (
    <>
      <PageHeader
        title="Exams"
        subtitle={student ? 'Your exam timetable and whether you qualify to sit each exam.' : 'Exam timetable, invigilators, coursework marks and who qualifies to sit.'}
        actions={!student && terms.length > 0 && <Select value={term ?? ''} onChange={(e) => setTermId(Number(e.target.value))} options={terms.map((t) => ({ value: t.id, label: `${t.name}${t.is_current ? ' (current)' : ''}` }))} />}
      />
      {tabs.length > 1 && <Tabs value={currentTab} onChange={setTab} tabs={tabs} />}
      {!term && !student ? (
        <Alert tone="warning" title="Create an academic term first" />
      ) : (
        <div className="stack">
          {currentTab === 'timetable' && term && <ExamTimetable termId={term} />}
          {currentTab === 'coursework' && term && <Coursework termId={term} />}
          {currentTab === 'mine' && <MyExams />}
        </div>
      )}
    </>
  );
}
