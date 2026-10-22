// Faculties (led by Deans) and Departments (led by Heads of Department).
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth';
import { useFeedback } from '../../components/feedback';
import { ResourcePage } from '../../components/ResourcePage';
import { Badge, plural } from '../../components/ui';
import { useFetch } from '../../hooks';
import { ROLE_LABELS, Role } from '../../types';

const leader = (name?: string | null, email?: string | null) =>
  name ? (
    <>
      {name}
      <div className="muted small">{email}</div>
    </>
  ) : (
    <Badge tone="warning">Not appointed</Badge>
  );

export function Faculties() {
  const { hasRole } = useAuth();
  const { data: deans } = useFetch<any[]>('/api/users?roles=lecturer,hod,dean&active=1');
  const { toast } = useFeedback();
  const isAdmin = hasRole('admin');
  return (
    <ResourcePage
      title="Faculties"
      subtitle={
        <>
          Each faculty is led by a Dean who oversees its departments. Create Dean accounts under <Link to="/users">Users</Link> first.
        </>
      }
      noun="Faculty"
      endpoint="/api/faculties"
      searchKeys={['name', 'code', 'dean_name']}
      canCreate={isAdmin}
      canEdit={() => isAdmin}
      canDelete={() => isAdmin}
      deleteMessage={(f: any) => `Deleting ${f.name} also deletes its ${plural(f.department_count, 'department')}, their programmes and classes.`}
      columns={[
        { key: 'name', header: 'Faculty', render: (f: any) => <strong>{f.name}</strong> },
        { key: 'code', header: 'Code', width: '90px' },
        { key: 'dean_name', header: 'Dean', render: (f: any) => leader(f.dean_name, f.dean_email) },
        { key: 'department_count', header: 'Departments', align: 'right' },
      ]}
      fields={[
        { name: 'name', label: 'Faculty name', required: true, span: 2, placeholder: 'e.g. Faculty of Science and Technology' },
        { name: 'code', label: 'Code', placeholder: 'e.g. FST' },
        { name: 'dean_id', label: 'Dean', type: 'select', placeholder: 'Not appointed', options: (deans || []).map((x: any) => ({ value: x.id, label: `${x.title ? `${x.title} ` : ''}${x.name} (${ROLE_LABELS[x.role as Role] || x.role}${x.department_name ? `, ${x.department_name}` : ''})` })), help: 'Appointing someone new hands the faculty over: the previous Dean becomes a lecturer.' },
      ]}
      fromRow={(f: any) => ({ name: f.name, code: f.code || '', dean_id: f.dean_id || '' })}
      onSaved={(r: any) => r?.handed_over_from && toast(`${r.dean_name} is now Dean; ${r.handed_over_from.name} has a lecturer account`)}
    />
  );
}

export function Departments() {
  const { hasRole, user } = useAuth();
  const isDean = user?.role === 'dean';
  const { data: faculties } = useFetch<any[]>('/api/faculties');
  const { data: hods } = useFetch<any[]>('/api/users?roles=lecturer,hod&active=1');
  const { toast } = useFeedback();
  const canManage = hasRole('admin', 'dean');
  return (
    <ResourcePage
      title="Departments"
      subtitle={
        isDean
          ? `The departments of ${user?.faculty_name || 'your faculty'}, each run by a Head of Department (HoD).`
          : 'Departments belong to a faculty and are managed by a Head of Department (HoD).'
      }
      noun="Department"
      endpoint="/api/departments"
      searchKeys={['name', 'code', 'faculty_name', 'hod_name']}
      canCreate={canManage}
      canEdit={() => canManage}
      canDelete={() => canManage}
      deleteMessage={(d: any) => `Deleting ${d.name} also deletes its ${plural(d.program_count, 'programme')} and their classes.`}
      columns={[
        { key: 'name', header: 'Department', render: (d: any) => <><strong>{d.name}</strong>{d.code && <span className="muted"> · {d.code}</span>}</> },
        ...(isDean ? [] : [{ key: 'faculty_name', header: 'Faculty', hideOnMobile: true }]),
        { key: 'hod_name', header: 'Head of Department', render: (d: any) => leader(d.hod_name, d.hod_email) },
        { key: 'program_count', header: 'Programmes', align: 'right', hideOnMobile: true },
        { key: 'lecturer_count', header: 'Lecturers', align: 'right', hideOnMobile: true },
      ]}
      fields={[
        { name: 'faculty_id', label: 'Faculty', type: 'select', required: true, span: 2, options: (faculties || []).map((f) => ({ value: f.id, label: f.name })) },
        { name: 'name', label: 'Department name', required: true, span: 2 },
        { name: 'code', label: 'Code' },
        { name: 'hod_id', label: 'Head of Department', type: 'select', placeholder: 'Not appointed', options: (hods || []).map((x: any) => ({ value: x.id, label: `${x.title ? `${x.title} ` : ''}${x.name} (${ROLE_LABELS[x.role as Role] || x.role}${x.department_name ? `, ${x.department_name}` : ''})` })), help: 'Appointing someone new hands the department over: the previous HoD becomes a lecturer.' },
      ]}
      fromRow={(d: any) => ({ faculty_id: d.faculty_id, name: d.name, code: d.code || '', hod_id: d.hod_id || '' })}
      onSaved={(r: any) => r?.handed_over_from && toast(`${r.hod_name} is now Head of Department; ${r.handed_over_from.name} has a lecturer account`)}
    />
  );
}
