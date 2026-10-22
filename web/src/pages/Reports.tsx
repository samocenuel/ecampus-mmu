import { useMemo, useState } from 'react';
import { FileSpreadsheet, FileText, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { download } from '../api';
import { useAuth } from '../auth';
import { useFeedback } from '../components/feedback';
import { Badge, Button, Card, Checkbox, DataTable, ErrorNote, Field, Input, PageHeader, Progress, rateTone, Select, Spinner, StatCard } from '../components/ui';
import { useFetch } from '../hooks';
import { useTerms } from './Timetable';

const Rate = ({ value }: { value: number | null }) =>
  value === null || value === undefined ? <span className="muted">-</span> : <strong className={`text-${rateTone(value)}`}>{value}%</strong>;

type Filters = {
  faculty_id: string;
  department_id: string;
  program_id: string;
  year_of_study: string;
  class_id: string;
  course_unit_id: string;
  lecturer_id: string;
  from: string;
  to: string;
  threshold: string;
};
const NO_FILTERS: Filters = { faculty_id: '', department_id: '', program_id: '', year_of_study: '', class_id: '', course_unit_id: '', lecturer_id: '', from: '', to: '', threshold: '75' };
/** Choosing a broader filter clears the narrower ones that may no longer match. */
const CLEARS: Partial<Record<keyof Filters, (keyof Filters)[]>> = {
  faculty_id: ['department_id', 'program_id', 'class_id', 'course_unit_id', 'lecturer_id'],
  department_id: ['program_id', 'class_id', 'course_unit_id', 'lecturer_id'],
  program_id: ['class_id'],
  year_of_study: ['class_id'],
};

/** Lectures that ended with no attendance taken (no register, no check-in). */
function MissedLectures({ missed }: { missed: { from: string; to: string; items: any[] } }) {
  const day = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return (
    <Card
      title={<span className="row gap-sm">Lectures with no attendance <Badge tone={missed.items.length ? 'danger' : 'success'}>{missed.items.length}</Badge></span>}
      padded={false}
      actions={<span className="muted small">{missed.from && `${day(missed.from)} to ${day(missed.to)}`}</span>}
    >
      <DataTable
        rows={missed.items.map((o: any) => ({ ...o, id: o.key }))}
        searchKeys={['course_code', 'course_name', 'lecturer_name']}
        empty="Every lecture had attendance taken"
        columns={[
          { key: 'date', header: 'Date', render: (o: any) => <>{day(o.date)}<div className="muted small">{o.start_time}-{o.end_time}</div></> },
          { key: 'course_code', header: 'Course unit', render: (o: any) => <><strong>{o.course_code}</strong> {o.course_name}<div className="muted small">{o.classes.map((c: any) => c.name).join(', ')}</div></> },
          { key: 'lecturer_name', header: 'Lecturer' },
          { key: 'room_name', header: 'Room', hideOnMobile: true },
        ]}
      />
    </Card>
  );
}

export default function Reports() {
  const { user } = useAuth();
  const { terms, current } = useTerms();
  const [termId, setTermId] = useState<number | null>(null);
  const term = termId ?? current?.id;
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [sections, setSections] = useState<string[] | null>(null);
  const [showFilters, setShowFilters] = useState(true);
  const { fail } = useFeedback();
  const [busy, setBusy] = useState<'pdf' | 'xlsx' | null>(null);
  const isLecturer = user?.role === 'lecturer';
  const { data: opts } = useFetch<any>(`/api/reports/options${term ? `?term_id=${term}` : ''}`);
  const allSections: [string, string][] = opts ? Object.entries(opts.sections) : [];
  const chosen = sections ?? allSections.map(([k]) => k);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (term) p.set('term_id', String(term));
    for (const [k, v] of Object.entries(filters)) if (v && !(k === 'threshold' && v === '75')) p.set(k, v);
    if (sections) p.set('sections', sections.join(','));
    return p.toString();
  }, [term, filters, sections]);
  const { data: r, loading, error } = useFetch<any>(`/api/reports/overview?${query}`);
  const show = (k: string) => chosen.includes(k);

  const set = (k: keyof Filters, v: string) =>
    setFilters((f) => {
      const next = { ...f, [k]: v };
      for (const c of CLEARS[k] || []) next[c] = '';
      return next;
    });
  const toggleSection = (k: string, on: boolean) => {
    const next = on ? [...chosen, k] : chosen.filter((s) => s !== k);
    setSections(allSections.map(([s]) => s).filter((s) => next.includes(s)));
  };

  // Option lists narrow to the broader filters already chosen.
  const departments = (opts?.departments || []).filter((d: any) => !filters.faculty_id || d.faculty_id === Number(filters.faculty_id));
  const deptIds = new Set(departments.map((d: any) => d.id));
  const inDept = (x: any) => (filters.department_id ? x.department_id === Number(filters.department_id) : !filters.faculty_id || deptIds.has(x.department_id));
  const programs = (opts?.programs || []).filter((p: any) => isLecturer || inDept(p));
  const programIds = new Set(programs.map((p: any) => p.id));
  const classes = (opts?.classes || []).filter(
    (c: any) =>
      (filters.program_id ? c.program_id === Number(filters.program_id) : programIds.has(c.program_id)) &&
      (!filters.year_of_study || c.year_of_study === Number(filters.year_of_study)),
  );
  const units = (opts?.course_units || []).filter((u: any) => isLecturer || !filters.faculty_id && !filters.department_id || inDept(u));
  const lecturers = (opts?.lecturers || []).filter((l: any) => !filters.faculty_id && !filters.department_id || inDept(l));
  const years = [...new Set<number>((opts?.classes || []).map((c: any) => c.year_of_study))].sort();
  const active = Object.entries(filters).filter(([k, v]) => v && !(k === 'threshold' && v === '75')).length + (sections ? 1 : 0);

  const exportAs = async (format: 'pdf' | 'xlsx') => {
    setBusy(format);
    try {
      await download(`/api/reports/export?${query}&format=${format}`, `report.${format}`);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle={r ? <>Scope: <strong>{r.scope}</strong>{r.term ? ` · ${r.term.name}` : ''}{r.filters.labels.length ? ` · ${r.filters.labels.join(' · ')}` : ''}</> : ' '}
        actions={
          <>
            <Select value={term ?? ''} onChange={(e) => setTermId(Number(e.target.value))} options={terms.map((t) => ({ value: t.id, label: t.name }))} aria-label="Term" />
            <Button variant="secondary" icon={<SlidersHorizontal size={16} />} onClick={() => setShowFilters((s) => !s)}>
              Filters{active ? ` (${active})` : ''}
            </Button>
            <Button variant="secondary" icon={<FileText size={16} />} loading={busy === 'pdf'} onClick={() => exportAs('pdf')}>
              PDF
            </Button>
            <Button variant="secondary" icon={<FileSpreadsheet size={16} />} loading={busy === 'xlsx'} onClick={() => exportAs('xlsx')}>
              Excel
            </Button>
          </>
        }
      />
      {showFilters && opts && (
        <Card
          title="Choose what you need"
          actions={
            active ? (
              <Button size="sm" variant="ghost" icon={<RotateCcw size={14} />} onClick={() => { setFilters(NO_FILTERS); setSections(null); }}>
                Clear filters
              </Button>
            ) : null
          }
        >
          <div className="filters">
            {opts.faculties.length > 1 && (
              <Field label="Faculty">
                <Select value={filters.faculty_id} onChange={(e) => set('faculty_id', e.target.value)} placeholder="All faculties" options={opts.faculties.map((f: any) => ({ value: f.id, label: f.name }))} />
              </Field>
            )}
            {departments.length > 1 && (
              <Field label="Department">
                <Select value={filters.department_id} onChange={(e) => set('department_id', e.target.value)} placeholder="All departments" options={departments.map((d: any) => ({ value: d.id, label: d.name }))} />
              </Field>
            )}
            {programs.length > 0 && (
              <Field label="Programme">
                <Select value={filters.program_id} onChange={(e) => set('program_id', e.target.value)} placeholder="All programmes" options={programs.map((p: any) => ({ value: p.id, label: `${p.code} · ${p.name}` }))} />
              </Field>
            )}
            {years.length > 1 && (
              <Field label="Year of study">
                <Select value={filters.year_of_study} onChange={(e) => set('year_of_study', e.target.value)} placeholder="All years" options={years.map((y) => ({ value: y, label: `Year ${y}` }))} />
              </Field>
            )}
            {classes.length > 0 && (
              <Field label="Class">
                <Select value={filters.class_id} onChange={(e) => set('class_id', e.target.value)} placeholder="All classes" options={classes.map((c: any) => ({ value: c.id, label: c.name }))} />
              </Field>
            )}
            {units.length > 0 && (
              <Field label="Course unit">
                <Select value={filters.course_unit_id} onChange={(e) => set('course_unit_id', e.target.value)} placeholder="All course units" options={units.map((u: any) => ({ value: u.id, label: `${u.code} · ${u.name}` }))} />
              </Field>
            )}
            {lecturers.length > 0 && (
              <Field label="Lecturer">
                <Select value={filters.lecturer_id} onChange={(e) => set('lecturer_id', e.target.value)} placeholder="All lecturers" options={lecturers.map((l: any) => ({ value: l.id, label: [l.title, l.name].filter(Boolean).join(' ') }))} />
              </Field>
            )}
            <Field label="Lectures from">
              <Input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set('from', e.target.value)} />
            </Field>
            <Field label="To">
              <Input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set('to', e.target.value)} />
            </Field>
            <Field label="At risk below (%)">
              <Input type="number" min={1} max={100} value={filters.threshold} onChange={(e) => set('threshold', e.target.value)} />
            </Field>
          </div>
          <div className="field-label">Sections to include</div>
          <div className="check-grid">
            {allSections
              .filter(([k]) => !isLecturer || !['departments', 'rooms', 'allocation'].includes(k))
              .map(([k, label]) => (
                <Checkbox key={k} label={label} checked={chosen.includes(k)} onChange={(v) => toggleSection(k, v)} />
              ))}
          </div>
          <p className="muted small m0">The screen, the PDF and the Excel file all follow these choices.</p>
        </Card>
      )}
      <ErrorNote error={error} />
      {loading && !r && <Spinner />}
      {r && (
        <div className="stack">
          {show('summary') && (
            <div className="stat-grid">
              {['admin', 'dean'].includes(user?.role || '') && <StatCard label="Departments" value={r.counts.departments} />}
              {!isLecturer && <StatCard label="Programmes" value={r.counts.programs} />}
              <StatCard label="Classes" value={r.counts.classes} />
              <StatCard label="Students" value={r.counts.students} />
              {!isLecturer && <StatCard label="Lecturers" value={r.counts.lecturers} />}
              <StatCard label="Units allocated" value={r.counts.course_units_allocated} hint={`${r.counts.cross_cutting_allocated} cross-cutting`} />
              <StatCard label="Weekly teaching" value={`${r.counts.weekly_teaching_hours} h`} hint={`${r.counts.weekly_sessions} sessions`} />
              <StatCard label="Average attendance" value={r.attendance.average_rate !== null ? `${r.attendance.average_rate}%` : '-'} tone={rateTone(r.attendance.average_rate) === 'danger' ? 'danger' : 'success'} hint={`${r.attendance.approved_registers} approved registers`} />
            </div>
          )}

          {!isLecturer && show('allocation') && (
            <div className="grid-2">
              <Card title="Allocation progress">
                <div className="metric-row">
                  <span>Cross-cutting</span>
                  <strong>
                    {r.allocation.cross_cutting_allocated}/{r.allocation.cross_cutting_pairs}
                  </strong>
                </div>
                <Progress value={r.allocation.cross_cutting_allocated} total={r.allocation.cross_cutting_pairs} tone="warning" />
                <div className="metric-row">
                  <span>Programme-specific</span>
                  <strong>
                    {r.allocation.other_allocated}/{r.allocation.other_pairs}
                  </strong>
                </div>
                <Progress value={r.allocation.other_allocated} total={r.allocation.other_pairs} />
              </Card>
              <Card title="Attendance registers">
                <div className="stat-grid compact">
                  <StatCard label="Approved" value={r.attendance.approved_registers} tone="success" />
                  <StatCard label="Awaiting approval" value={r.attendance.pending_registers} tone={r.attendance.pending_registers ? 'warning' : undefined} />
                  <StatCard label="Rejected" value={r.attendance.rejected_registers} tone={r.attendance.rejected_registers ? 'danger' : undefined} />
                </div>
              </Card>
            </div>
          )}

          {show('departments') && r.departments.length > 1 && (
            <Card title="Departments" padded={false}>
              <DataTable
                rows={r.departments}
                columns={[
                  { key: 'name', header: 'Department', render: (d) => <><strong>{d.name}</strong><div className="muted small">{d.faculty_name}</div></> },
                  { key: 'hod_name', header: 'HoD', hideOnMobile: true },
                  { key: 'programs', header: 'Programmes', align: 'right' },
                  { key: 'classes', header: 'Classes', align: 'right', hideOnMobile: true },
                  { key: 'students', header: 'Students', align: 'right' },
                  { key: 'lecturers', header: 'Lecturers', align: 'right', hideOnMobile: true },
                  { key: 'allocations', header: 'Units', align: 'right', hideOnMobile: true },
                  { key: 'attendance_rate', header: 'Attendance', align: 'right', render: (d) => <Rate value={d.attendance_rate} /> },
                ]}
              />
            </Card>
          )}

          {show('workload') && (
            <Card title="Lecturer workload" padded={false}>
              <DataTable
                rows={r.workload}
                searchKeys={['name', 'department']}
                empty="No lecturers match these filters"
                columns={[
                  { key: 'name', header: 'Lecturer' },
                  { key: 'department', header: 'Department', hideOnMobile: true },
                  { key: 'units', header: 'Units', align: 'right' },
                  {
                    key: 'allocated_hours',
                    header: 'Hours / week',
                    render: (w) => (
                      <div className="bar-cell">
                        <div className="bar" style={{ width: `${Math.min(100, (w.allocated_hours / 20) * 100)}%` }} />
                        <span>{w.allocated_hours} h</span>
                      </div>
                    ),
                  },
                  { key: 'scheduled_hours', header: 'Scheduled', align: 'right', hideOnMobile: true, render: (w) => `${w.scheduled_hours} h` },
                  { key: 'max_hours', header: 'Limits', align: 'right', hideOnMobile: true, render: (w) => `${w.min_hours}-${w.max_hours} h` },
                  {
                    key: 'status',
                    header: 'Load',
                    align: 'right',
                    render: (w) => (
                      <>
                        <Badge tone={w.status === 'Over maximum' ? 'danger' : w.status === 'Under minimum' ? 'warning' : 'success'}>{w.status}</Badge>
                        {w.part_time_hours > 0 && <div className="muted small">{w.part_time_hours} h internal part-time</div>}
                      </>
                    ),
                  },
                ]}
              />
            </Card>
          )}

          {show('course_attendance') && (
            <Card title="Attendance by course unit" padded={false}>
              <DataTable
                rows={r.attendance.by_course.map((c: any) => ({ ...c, id: c.allocation_id }))}
                searchKeys={['code', 'name', 'lecturer', 'classes']}
                empty="No course units match these filters"
                columns={[
                  { key: 'code', header: 'Unit', render: (c) => <><strong>{c.code}</strong> {c.is_cross_cutting ? <span className="cc-tag">CC</span> : null}<div className="muted small">{c.name}</div></> },
                  { key: 'classes', header: 'Classes', hideOnMobile: true },
                  { key: 'lecturer', header: 'Lecturer', hideOnMobile: true },
                  { key: 'registers', header: 'Lectures', align: 'right' },
                  { key: 'rate', header: 'Attendance', align: 'right', render: (c) => <Rate value={c.rate} /> },
                ]}
              />
            </Card>
          )}

          {(show('class_attendance') || show('at_risk')) && (
            <div className={show('class_attendance') && show('at_risk') ? 'grid-2' : 'stack'}>
              {show('class_attendance') && (
                <Card title="Attendance by class" padded={false}>
                  <DataTable
                    rows={r.attendance.by_class}
                    empty="No classes match these filters"
                    columns={[
                      { key: 'name', header: 'Class' },
                      { key: 'students', header: 'Students', align: 'right' },
                      { key: 'registers', header: 'Lectures', align: 'right' },
                      { key: 'rate', header: 'Attendance', align: 'right', render: (c) => <Rate value={c.rate} /> },
                    ]}
                  />
                </Card>
              )}
              {show('at_risk') && (
                <Card title={<span className="row gap-sm">Students at risk <Badge tone="danger">below {r.attendance.at_risk_threshold}%</Badge></span>} padded={false}>
                  <DataTable
                    rows={r.attendance.at_risk}
                    searchKeys={['name', 'identifier', 'class_name']}
                    empty="No students below the threshold"
                    columns={[
                      { key: 'name', header: 'Student', render: (s) => <><strong>{s.name}</strong><div className="muted small">{s.identifier}</div></> },
                      { key: 'class_name', header: 'Class' },
                      { key: 'rate', header: 'Rate', align: 'right', render: (s) => <><Rate value={s.rate} /><div className="muted small">{s.attended}/{s.total}</div></> },
                    ]}
                  />
                </Card>
              )}
            </div>
          )}

          {show('missed') && <MissedLectures missed={r.missed} />}

          {show('rooms') && r.rooms.length > 0 && (
            <Card title="Room utilisation" padded={false}>
              <DataTable
                rows={r.rooms}
                columns={[
                  { key: 'name', header: 'Room', render: (x) => <><strong>{x.name}</strong><div className="muted small">{x.building}</div></> },
                  { key: 'capacity', header: 'Seats', align: 'right' },
                  { key: 'booked_hours', header: 'Booked / week', align: 'right', render: (x) => `${x.booked_hours} h` },
                  {
                    key: 'utilisation',
                    header: 'Utilisation',
                    render: (x) => (
                      <div className="bar-cell">
                        <div className="bar" style={{ width: `${Math.min(100, x.utilisation)}%` }} />
                        <span>{x.utilisation}%</span>
                      </div>
                    ),
                  },
                ]}
              />
            </Card>
          )}
        </div>
      )}
    </>
  );
}
