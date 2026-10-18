import { useState } from 'react';
import { FileSpreadsheet } from 'lucide-react';
import { download } from '../api';
import { useAuth } from '../auth';
import { useFeedback } from '../components/feedback';
import { Badge, Button, Card, DataTable, ErrorNote, PageHeader, Progress, rateTone, Select, Spinner, StatCard } from '../components/ui';
import { useFetch } from '../hooks';
import { useTerms } from './Timetable';

const Rate = ({ value }: { value: number | null }) =>
  value === null || value === undefined ? <span className="muted">-</span> : <strong className={`text-${rateTone(value)}`}>{value}%</strong>;

export default function Reports() {
  const { user } = useAuth();
  const { terms, current } = useTerms();
  const [termId, setTermId] = useState<number | null>(null);
  const term = termId ?? current?.id;
  const { data: r, loading, error } = useFetch<any>(term ? `/api/reports/overview?term_id=${term}` : '/api/reports/overview');
  const { fail } = useFeedback();
  const [busy, setBusy] = useState(false);
  const isLecturer = user?.role === 'lecturer';

  const exportXlsx = async () => {
    setBusy(true);
    try {
      await download(`/api/reports/export${term ? `?term_id=${term}` : ''}`, 'report.xlsx');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle={r ? <>Scope: <strong>{r.scope}</strong>{r.term ? ` · ${r.term.name}` : ''}</> : ' '}
        actions={
          <>
            <Select value={term ?? ''} onChange={(e) => setTermId(Number(e.target.value))} options={terms.map((t) => ({ value: t.id, label: t.name }))} aria-label="Term" />
            <Button variant="secondary" icon={<FileSpreadsheet size={16} />} loading={busy} onClick={exportXlsx}>
              Export Excel
            </Button>
          </>
        }
      />
      <ErrorNote error={error} />
      {loading && !r && <Spinner />}
      {r && (
        <div className="stack">
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

          {!isLecturer && (
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

          {r.departments.length > 1 && (
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

          <Card title="Lecturer workload" padded={false}>
            <DataTable
              rows={r.workload}
              searchKeys={['name', 'department']}
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
              ]}
            />
          </Card>

          <Card title="Attendance by course unit" padded={false}>
            <DataTable
              rows={r.attendance.by_course.map((c: any) => ({ ...c, id: c.allocation_id }))}
              searchKeys={['code', 'name', 'lecturer', 'classes']}
              columns={[
                { key: 'code', header: 'Unit', render: (c) => <><strong>{c.code}</strong> {c.is_cross_cutting ? <span className="cc-tag">CC</span> : null}<div className="muted small">{c.name}</div></> },
                { key: 'classes', header: 'Classes', hideOnMobile: true },
                { key: 'lecturer', header: 'Lecturer', hideOnMobile: true },
                { key: 'registers', header: 'Lectures', align: 'right' },
                { key: 'rate', header: 'Attendance', align: 'right', render: (c) => <Rate value={c.rate} /> },
              ]}
            />
          </Card>

          <div className="grid-2">
            <Card title="Attendance by class" padded={false}>
              <DataTable
                rows={r.attendance.by_class}
                columns={[
                  { key: 'name', header: 'Class' },
                  { key: 'students', header: 'Students', align: 'right' },
                  { key: 'registers', header: 'Lectures', align: 'right' },
                  { key: 'rate', header: 'Attendance', align: 'right', render: (c) => <Rate value={c.rate} /> },
                ]}
              />
            </Card>
            <Card title={<span className="row gap-sm">Students at risk <Badge tone="danger">below {r.attendance.at_risk_threshold}%</Badge></span>} padded={false}>
              <DataTable
                rows={r.attendance.at_risk}
                empty="No students below the threshold"
                columns={[
                  { key: 'name', header: 'Student', render: (s) => <><strong>{s.name}</strong><div className="muted small">{s.identifier}</div></> },
                  { key: 'class_name', header: 'Class' },
                  { key: 'rate', header: 'Rate', align: 'right', render: (s) => <><Rate value={s.rate} /><div className="muted small">{s.attended}/{s.total}</div></> },
                ]}
              />
            </Card>
          </div>

          {r.rooms.length > 0 && (
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
