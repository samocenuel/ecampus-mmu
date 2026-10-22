import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, GitBranch, Plus, Trash2 } from 'lucide-react';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { useFeedback } from '../../components/feedback';
import { ResourcePage } from '../../components/ResourcePage';
import { Badge, Button, Card, EmptyState, ErrorNote, Field, IconButton, Input, Modal, PageHeader, Select, Spinner } from '../../components/ui';
import { useFetch } from '../../hooks';

export const LEVELS = ['Short course', 'Certificate', 'Diploma', 'Bachelor', 'Postgraduate Diploma', 'Masters', 'PhD'];

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
        { key: 'name', header: 'Programme', render: (p: any) => <>{p.name}<div className="muted small">{p.level} · {p.duration_years} years · coursework /{p.coursework_max ?? 40}{p.research_enabled ? ` · research from Year ${p.research_year || 1}, ${p.research_reports} reports` : ''}</div></> },
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
        { name: 'coursework_max', label: 'Coursework marks out of', type: 'number', min: 1, max: 100, defaultValue: 40, help: 'Coursework uploads are converted to this total; students need half of it to sit exams.' },
        { name: 'research_enabled', label: 'Students do research (project, dissertation or thesis)', type: 'checkbox', span: 2, help: "Master's programmes write a dissertation, PhD programmes a thesis, others a project." },
        { name: 'research_year', label: 'Research starts in year of study', type: 'number', min: 1, max: 10, showIf: (f) => Boolean(f.research_enabled), placeholder: 'e.g. 3' },
        { name: 'research_reports', label: 'Progress reports required', type: 'number', min: 0, max: 20, defaultValue: 3, showIf: (f) => Boolean(f.research_enabled) },
      ]}
      fromRow={(p: any) => ({ department_id: p.department_id, name: p.name, code: p.code, level: p.level, duration_years: p.duration_years, coursework_max: p.coursework_max ?? 40, research_enabled: Boolean(p.research_enabled), research_year: p.research_year ?? '', research_reports: p.research_reports ?? 3 })}
    />
  );
}

export function ProgrammeDetail() {
  const { id } = useParams();
  const { hasRole } = useAuth();
  const { toast, fail, confirm } = useFeedback();
  const [versionId, setVersionId] = useState<string>('');
  const { data: p, loading, error, reload } = useFetch<any>(`/api/programs/${id}${versionId ? `?version_id=${versionId}` : ''}`);
  const { data: units } = useFetch<any[]>('/api/course-units');
  const [adding, setAdding] = useState(false);
  const [newVersion, setNewVersion] = useState<any>(null);
  const year = new Date().getFullYear();
  const [form, setForm] = useState({ course_unit_id: '', year_of_study: '1', semester: '1' });
  const canManage = hasRole('admin', 'dean', 'hod');

  const add = async () => {
    try {
      await api(`/api/programs/${id}/course-units`, { method: 'POST', body: { ...form, version_id: p.version?.id } });
      toast('Course unit added to the curriculum');
      setAdding(false);
      reload();
    } catch (err) {
      fail(err);
    }
  };
  const remove = async (cu: any) => {
    if (!(await confirm({ title: `Remove from ${p.version?.name || 'the curriculum'}?`, message: `${cu.code} will no longer be part of ${p.code} ${p.version?.name || ''}. Other versions and the course unit itself are kept.`, confirmLabel: 'Remove', tone: 'danger' }))) return;
    try {
      await api(`/api/programs/${id}/course-units/${cu.id}${p.version ? `?version_id=${p.version.id}` : ''}`, { method: 'DELETE' });
      reload();
    } catch (err) {
      fail(err);
    }
  };

  const createVersion = async () => {
    try {
      const v = await api<any>(`/api/programs/${id}/versions`, { method: 'POST', body: newVersion });
      toast(`${v.name} created as a copy of the current curriculum. New intakes will follow it.`);
      setNewVersion(null);
      setVersionId(String(v.id));
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
  const available = (units || []).filter((u) => !linked.has(u.id) && (u.is_cross_cutting || u.program_count === 0 || (u.programs || []).some((x: any) => x.id === p.id)));
  const editable = canManage && p.version && p.version.status !== 'retired';
  const VERSION_TONE: Record<string, 'success' | 'warning' | 'neutral'> = { active: 'success', phasing_out: 'warning', retired: 'neutral' };
  const VERSION_LABEL: Record<string, string> = { active: 'Current', phasing_out: 'Phasing out', retired: 'Retired' };
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
              <Button variant="secondary" icon={<GitBranch size={16} />} onClick={() => setNewVersion({ name: `${year + 1} curriculum`, starts_academic_year: `${year + 1}/${year + 2}` })}>
                New curriculum version
              </Button>
            )}
            {editable && (
              <Button icon={<Plus size={16} />} onClick={() => setAdding(true)}>
                Add course unit
              </Button>
            )}
          </>
        }
      />
      {p.versions?.length > 0 && (
        <Card title="Curriculum versions" padded={false}>
          <div className="pad-x muted small">New intakes follow the current version. Classes keep the version they started on until they finish, then it retires.</div>
          <div className="version-list">
            {p.versions.map((v: any) => (
              <button key={v.id} type="button" className={`version-chip${p.version?.id === v.id ? ' selected' : ''}`} onClick={() => setVersionId(String(v.id))}>
                <strong>{v.name}</strong> <Badge tone={VERSION_TONE[v.status]}>{VERSION_LABEL[v.status]}</Badge>
                <span className="muted small">{v.starts_academic_year ? `From ${v.starts_academic_year} · ` : ''}{v.unit_count} units · {v.class_count} classes</span>
              </button>
            ))}
          </div>
        </Card>
      )}
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
                        {editable && (
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
                <strong>{c.name}</strong> {c.status === 'completed' && <Badge>Completed</Badge>}{' '}
                <span className="muted">Year {c.year_of_study} · {c.academic_year}{c.curriculum_version_name ? ` · ${c.curriculum_version_name}` : ''}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title={`Add a course unit to ${p.code}${p.version ? ` (${p.version.name})` : ''}`}
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
      {newVersion && (
        <Modal
          open
          onClose={() => setNewVersion(null)}
          title={`New curriculum version for ${p.code}`}
          footer={<><Button variant="secondary" onClick={() => setNewVersion(null)}>Cancel</Button><Button onClick={createVersion} disabled={!newVersion.name?.trim()}>Create</Button></>}
        >
          <p className="muted m0">The new version starts as a copy of {p.versions?.find((v: any) => v.status !== 'retired')?.name || 'the current curriculum'}; then add, move or remove units. Classes already running keep their version, so they are phased out as they finish.</p>
          <div className="form-grid">
            <Field label="Name *">
              <Input value={newVersion.name} onChange={(e) => setNewVersion({ ...newVersion, name: e.target.value })} />
            </Field>
            <Field label="First intake (academic year)">
              <Input value={newVersion.starts_academic_year} placeholder="2027/2028" onChange={(e) => setNewVersion({ ...newVersion, starts_academic_year: e.target.value })} />
            </Field>
          </div>
        </Modal>
      )}
    </>
  );
}
