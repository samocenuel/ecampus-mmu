import { Link } from 'react-router-dom';
import { Plus, X } from 'lucide-react';
import { useAuth } from '../../auth';
import { ResourcePage } from '../../components/ResourcePage';
import { Alert, Badge, Button, IconButton, Select, Tabs } from '../../components/ui';
import { useFetch, usePersistentState } from '../../hooks';

type Filter = 'all' | 'cc' | 'program';
type Sharing = 'all' | 'own' | 'in' | 'out';

const SHARING_BADGE: Record<string, { tone: 'info' | 'primary'; label: string; title: string }> = {
  in: { tone: 'info', label: 'Shared in', title: 'Owned by another department and taught to your programmes' },
  out: { tone: 'primary', label: 'Shared out', title: 'Owned by your department and also taught to other departments' },
};

function ProgrammeLinks({ form, setForm, programs }: { form: any; setForm: (f: any) => void; programs: any[] }) {
  const links: any[] = form.programs || [];
  const cc = Boolean(form.is_cross_cutting);
  const setLinks = (next: any[]) => setForm({ ...form, programs: next });
  const update = (i: number, k: string, v: any) => setLinks(links.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const canAdd = cc || links.length === 0;
  return (
    <div className="links-editor">
      <div className="field-label">
        Programmes using this unit{' '}
        <span className="muted">{cc ? '(cross-cutting: add every programme that takes it)' : '(programme-specific: one programme only)'}</span>
      </div>
      {links.map((l, i) => (
        <div key={i} className="link-row">
          <Select value={l.program_id} onChange={(e) => update(i, 'program_id', e.target.value)} placeholder="Programme..." options={programs.map((p) => ({ value: p.id, label: `${p.code} - ${p.name}` }))} />
          <Select value={l.year_of_study} onChange={(e) => update(i, 'year_of_study', e.target.value)} options={[1, 2, 3, 4, 5].map((y) => ({ value: y, label: `Year ${y}` }))} />
          <Select value={l.semester} onChange={(e) => update(i, 'semester', e.target.value)} options={[1, 2, 3].map((s) => ({ value: s, label: `Sem ${s}` }))} />
          <IconButton label="Remove" onClick={() => setLinks(links.filter((_, j) => j !== i))}>
            <X size={16} />
          </IconButton>
        </div>
      ))}
      {!cc && links.length > 1 && <div className="field-error">Only cross-cutting units can belong to several programmes.</div>}
      <Button type="button" variant="ghost" size="sm" icon={<Plus size={14} />} disabled={!canAdd} onClick={() => setLinks([...links, { program_id: '', year_of_study: 1, semester: 1 }])}>
        Add programme
      </Button>
    </div>
  );
}

export default function CourseUnits() {
  const { hasRole, user } = useAuth();
  const [filter, setFilter] = usePersistentState<Filter>('lms_cu_filter', 'all');
  const [sharing, setSharing] = usePersistentState<Sharing>('lms_cu_sharing', 'all');
  // Deans and HoDs see their own units plus the ones crossing their department boundary.
  const scoped = hasRole('dean', 'hod');
  const unitName = user?.role === 'dean' ? 'faculty' : 'department';
  const { data: departments } = useFetch<any[]>('/api/departments');
  const { data: programs } = useFetch<any[]>('/api/programs');
  const { data: ccUnits, reload: reloadCc } = useFetch<any[]>('/api/course-units?cross_cutting=1');
  const canManage = hasRole('admin', 'dean', 'hod');
  const params = new URLSearchParams();
  if (filter !== 'all') params.set('cross_cutting', filter === 'cc' ? '1' : '0');
  if (scoped && sharing !== 'all') params.set('sharing', sharing);
  const query = params.toString() ? `?${params}` : '';

  return (
    <ResourcePage
      key={query}
      title="Course units"
      subtitle={
        scoped
          ? `Units your ${unitName} owns, plus cross-cutting units shared in from, or out to, other departments.`
          : 'Course units with their codes and details. Cross-cutting units are shared across programmes and are allocated first.'
      }
      noun="Course unit"
      endpoint="/api/course-units"
      query={query}
      searchKeys={['code', 'name', 'department_name']}
      canCreate={canManage}
      canEdit={(u: any) => canManage && u.can_manage}
      canDelete={(u: any) => canManage && u.can_manage}
      onSaved={() => reloadCc()}
      before={() => (
        <>
          {ccUnits && ccUnits.length === 0 && (
            <Alert tone="warning" title="Create cross-cutting units first">
              Units such as Communication Skills or Entrepreneurship are taken by several programmes. Create them (tick "Cross-cutting") before programme-specific units - you'll be warned otherwise.
            </Alert>
          )}
          <div className="tab-row">
            <Tabs
              value={filter}
              onChange={setFilter}
              tabs={[
                { value: 'all', label: 'All units' },
                { value: 'cc', label: 'Cross-cutting', count: ccUnits?.length },
                { value: 'program', label: 'Programme-specific' },
              ]}
            />
            {scoped && (
              <Tabs
                value={sharing}
                onChange={setSharing}
                tabs={[
                  { value: 'all', label: 'Any owner' },
                  { value: 'own', label: `Our ${unitName}` },
                  { value: 'in', label: 'Shared in' },
                  { value: 'out', label: 'Shared out' },
                ]}
              />
            )}
          </div>
        </>
      )}
      columns={[
        { key: 'code', header: 'Code', width: '110px', render: (u: any) => <strong>{u.code}</strong> },
        {
          key: 'name',
          header: 'Course unit',
          render: (u: any) => (
            <>
              {u.name} {u.is_cross_cutting ? <Badge tone="warning">Cross-cutting</Badge> : null}
              <div className="muted small">
                {u.credit_units} CU · {u.hours_per_week} hrs/week{u.preferred_room_type ? ` · needs ${u.preferred_room_type}` : ''}
              </div>
            </>
          ),
        },
        {
          key: 'department_name',
          header: 'Owning department',
          hideOnMobile: true,
          render: (u: any) => (
            <div className="cell-stack">
              <span>{u.department_name || <span className="muted">University-wide</span>}</span>
              {scoped && SHARING_BADGE[u.sharing] && (
                <span title={SHARING_BADGE[u.sharing].title}>
                  <Badge tone={SHARING_BADGE[u.sharing].tone}>{SHARING_BADGE[u.sharing].label}</Badge>
                </span>
              )}
            </div>
          ),
        },
        {
          key: 'programs',
          header: 'Programmes',
          sortValue: (u: any) => u.programs.length,
          render: (u: any) => (
            <div className="chips">
              {u.programs.length === 0 && <span className="muted small">Not linked</span>}
              {u.programs.map((p: any) => (
                <Link key={p.id} to={`/setup/programmes/${p.id}`} className="chip" title={`Year ${p.year_of_study}, semester ${p.semester}`}>
                  {p.code} <small>Y{p.year_of_study}S{p.semester}</small>
                </Link>
              ))}
            </div>
          ),
        },
      ]}
      fields={[
        { name: 'code', label: 'Course code', required: true, placeholder: 'e.g. CSC1101' },
        { name: 'name', label: 'Course unit name', required: true },
        {
          name: 'is_cross_cutting',
          label: 'Cross-cutting unit (shared across programmes)',
          type: 'checkbox',
          span: 2,
          defaultValue: filter === 'cc' || (ccUnits?.length ?? 0) === 0,
          help: 'Cross-cutting units can be linked to many programmes, are taught to combined classes, and are allocated before other units.',
        },
        { name: 'credit_units', label: 'Credit units', type: 'number', min: 1, max: 20, defaultValue: 3 },
        { name: 'hours_per_week', label: 'Contact hours per week', type: 'number', min: 1, max: 20, defaultValue: 3 },
        {
          name: 'department_id',
          label: 'Owning department',
          type: 'select',
          placeholder: hasRole('admin') ? 'University-wide' : 'Select...',
          options: (departments || []).map((d) => ({ value: d.id, label: d.name })),
        },
        {
          name: 'preferred_room_type',
          label: 'Room needed',
          type: 'select',
          placeholder: 'Any room',
          options: [
            { value: 'lecture', label: 'Lecture hall' },
            { value: 'lab', label: 'Laboratory' },
            { value: 'seminar', label: 'Seminar room' },
          ],
        },
        { name: 'description', label: 'Description', type: 'textarea', span: 2 },
      ]}
      fromRow={(u: any) => ({
        code: u.code,
        name: u.name,
        is_cross_cutting: Boolean(u.is_cross_cutting),
        credit_units: u.credit_units,
        hours_per_week: u.hours_per_week,
        department_id: u.department_id || '',
        preferred_room_type: u.preferred_room_type || '',
        description: u.description || '',
        _programs: u.programs,
      })}
      toPayload={(f, editing) => {
        const { _programs, programs: links, ...rest } = f;
        const body: any = { ...rest, department_id: rest.department_id || null, preferred_room_type: rest.preferred_room_type || null };
        if (!editing) body.programs = (links || []).filter((l: any) => l.program_id);
        return body;
      }}
      extraForm={(form, setForm, editing) =>
        editing ? (
          <p className="muted small">
            Linked programmes: {form._programs?.map((p: any) => p.code).join(', ') || 'none'}. Manage links from each programme's page.
          </p>
        ) : (
          <ProgrammeLinks form={form} setForm={setForm} programs={programs || []} />
        )
      }
    />
  );
}
