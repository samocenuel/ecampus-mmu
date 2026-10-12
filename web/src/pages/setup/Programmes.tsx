import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { useFeedback } from '../../components/feedback';
import { ResourcePage } from '../../components/ResourcePage';
import { Badge, Button, Card, EmptyState, ErrorNote, Field, IconButton, Modal, PageHeader, Select, Spinner } from '../../components/ui';
import { useFetch } from '../../hooks';

export const LEVELS = ['Certificate', 'Diploma', 'Bachelor', 'Postgraduate Diploma', 'Masters', 'PhD'];

export function Programmes() {
  const { hasRole } = useAuth();
  const navigate = useNavigate();
  const { data: departments } = useFetch<any[]>('/api/departments');
  const canManage = hasRole('admin', 'dean', 'hod');
  return (
    <ResourcePage
      title="Programmes"
      subtitle="Academic programmes offered by each department. Open a programme to manage its course units per year and semester."
      noun="Programme"
      endpoint="/api/programs"
      searchKeys={['code', 'name', 'department_name']}
      canCreate={canManage}
      canEdit={() => canManage}
      canDelete={() => canManage}
      onRowClick={(p: any) => navigate(`/setup/programmes/${p.id}`)}
      deleteMessage={(p: any) => `Deleting ${p.code} also deletes its ${p.class_count} class(es).`}
      columns={[
        { key: 'code', header: 'Code', width: '100px', render: (p: any) => <strong>{p.code}</strong> },
        { key: 'name', header: 'Programme', render: (p: any) => <>{p.name}<div className="muted small">{p.level} · {p.duration_years} years</div></> },
        { key: 'department_name', header: 'Department', hideOnMobile: true },
        { key: 'course_unit_count', header: 'Course units', align: 'right' },
        { key: 'class_count', header: 'Classes', align: 'right', hideOnMobile: true },
      ]}
      fields={[
        { name: 'department_id', label: 'Department', type: 'select', required: true, span: 2, options: (departments || []).map((d) => ({ value: d.id, label: `${d.name} (${d.faculty_name})` })) },
        { name: 'name', label: 'Programme name', required: true, span: 2, placeholder: 'e.g. Bachelor of Science in Computer Science' },
        { name: 'code', label: 'Code', required: true, placeholder: 'e.g. BSCS' },
        { name: 'level', label: 'Level', type: 'select', defaultValue: 'Bachelor', options: LEVELS.map((l) => ({ value: l, label: l })) },
        { name: 'duration_years', label: 'Duration (years)', type: 'number', min: 1, max: 7, defaultValue: 3 },
      ]}
      fromRow={(p: any) => ({ department_id: p.department_id, name: p.name, code: p.code, level: p.level, duration_years: p.duration_years })}
    />
  );
}

export function ProgrammeDetail() {
  const { id } = useParams();
  const { hasRole } = useAuth();
  const { toast, fail, confirm } = useFeedback();
  const { data: p, loading, error, reload } = useFetch<any>(`/api/programs/${id}`);
  const { data: units } = useFetch<any[]>('/api/course-units');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ course_unit_id: '', year_of_study: '1', semester: '1' });
  const canManage = hasRole('admin', 'dean', 'hod');

  const add = async () => {
    try {
      await api(`/api/programs/${id}/course-units`, { method: 'POST', body: form });
      toast('Course unit added to the curriculum');
      setAdding(false);
      reload();
    } catch (err) {
      fail(err);
    }
  };
  const remove = async (cu: any) => {
    if (!(await confirm({ title: 'Remove from programme?', message: `${cu.code} will no longer be part of ${p.code}. The course unit itself is kept.`, confirmLabel: 'Remove', tone: 'danger' }))) return;
    try {
      await api(`/api/programs/${id}/course-units/${cu.id}`, { method: 'DELETE' });
      reload();
    } catch (err) {
      fail(err);
    }
  };

  if (loading && !p) return <Spinner />;
  if (error) return <ErrorNote error={error} />;
  if (!p) return null;
  const linked = new Set(p.course_units.map((c: any) => c.id));
  // Programme-specific units already used elsewhere can't be added; cross-cutting units can.
  const available = (units || []).filter((u) => !linked.has(u.id) && (u.is_cross_cutting || u.program_count === 0));
  const groups: Record<string, any[]> = {};
  for (const cu of p.course_units) (groups[`Year ${cu.year_of_study} · Semester ${cu.semester}`] ||= []).push(cu);

  return (
    <>
      <PageHeader
        title={`${p.code} · ${p.name}`}
        subtitle={`${p.level} · ${p.duration_years} years · ${p.department_name}, ${p.faculty_name}`}
        actions={
          <>
            <Link to="/setup/programmes" className="btn btn-secondary">
              <ArrowLeft size={16} /> <span>Programmes</span>
            </Link>
            {canManage && (
              <Button icon={<Plus size={16} />} onClick={() => setAdding(true)}>
                Add course unit
              </Button>
            )}
          </>
        }
      />
      <div className="grid-2 align-start">
        <div className="stack">
          {Object.keys(groups).length === 0 && (
            <Card>
              <EmptyState title="No course units yet">Add cross-cutting units first, then the programme's own units.</EmptyState>
            </Card>
          )}
          {Object.entries(groups).map(([label, list]) => (
            <Card key={label} title={label} padded={false}>
              <table className="table">
                <tbody>
                  {list.map((cu) => (
                    <tr key={cu.id}>
                      <td style={{ width: 110 }}>
                        <strong>{cu.code}</strong>
                      </td>
                      <td>
                        {cu.name} {cu.is_cross_cutting ? <Badge tone="warning">Cross-cutting · {cu.program_count} programmes</Badge> : null}
                        <div className="muted small">
                          {cu.credit_units} CU · {cu.hours_per_week} hrs/week
                        </div>
                      </td>
                      <td style={{ width: 50 }}>
                        {canManage && (
                          <IconButton label="Remove" className="danger" onClick={() => remove(cu)}>
                            <Trash2 size={16} />
                          </IconButton>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ))}
        </div>
        <Card title={`Classes (${p.classes.length})`}>
          {p.classes.length === 0 && <EmptyState title="No classes">Create classes (cohorts) under Setup → Classes.</EmptyState>}
          <ul className="name-list">
            {p.classes.map((c: any) => (
              <li key={c.id}>
                <strong>{c.name}</strong> <span className="muted">Year {c.year_of_study} · {c.academic_year}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title={`Add a course unit to ${p.code}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button onClick={add} disabled={!form.course_unit_id}>
              Add
            </Button>
          </>
        }
      >
        <div className="form-grid">
          <Field label="Course unit" span={2} help="Cross-cutting units can be shared by several programmes. Programme-specific units belong to one programme only.">
            <Select
              value={form.course_unit_id}
              onChange={(e) => setForm({ ...form, course_unit_id: e.target.value })}
              placeholder="Select..."
              options={available.map((u) => ({ value: u.id, label: `${u.is_cross_cutting ? '[Cross-cutting] ' : ''}${u.code} ${u.name}` }))}
            />
          </Field>
          <Field label="Year of study">
            <Select value={form.year_of_study} onChange={(e) => setForm({ ...form, year_of_study: e.target.value })} options={Array.from({ length: p.duration_years }, (_, i) => ({ value: i + 1, label: `Year ${i + 1}` }))} />
          </Field>
          <Field label="Semester">
            <Select value={form.semester} onChange={(e) => setForm({ ...form, semester: e.target.value })} options={[1, 2, 3].map((s) => ({ value: s, label: `Semester ${s}` }))} />
          </Field>
        </div>
      </Modal>
    </>
  );
}
