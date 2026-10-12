// Faculties (led by Deans) and Departments (led by Heads of Department).
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth';
import { ResourcePage } from '../../components/ResourcePage';
import { Badge } from '../../components/ui';
import { useFetch } from '../../hooks';

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
  const { data: deans } = useFetch<any[]>('/api/users?role=dean&active=1');
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
      deleteMessage={(f: any) => `Deleting ${f.name} also deletes its ${f.department_count} department(s), their programmes and classes.`}
      columns={[
        { key: 'name', header: 'Faculty', render: (f: any) => <strong>{f.name}</strong> },
        { key: 'code', header: 'Code', width: '90px' },
        { key: 'dean_name', header: 'Dean', render: (f: any) => leader(f.dean_name, f.dean_email) },
        { key: 'department_count', header: 'Departments', align: 'right' },
      ]}
      fields={[
        { name: 'name', label: 'Faculty name', required: true, span: 2, placeholder: 'e.g. Faculty of Science and Technology' },
        { name: 'code', label: 'Code', placeholder: 'e.g. FST' },
        { name: 'dean_id', label: 'Dean', type: 'select', placeholder: 'Not appointed', options: (deans || []).map((d) => ({ value: d.id, label: `${d.title ? `${d.title} ` : ''}${d.name}` })) },
      ]}
      fromRow={(f: any) => ({ name: f.name, code: f.code || '', dean_id: f.dean_id || '' })}
    />
  );
}

export function Departments() {
  const { hasRole } = useAuth();
  const { data: faculties } = useFetch<any[]>('/api/faculties');
  const { data: hods } = useFetch<any[]>('/api/users?role=hod&active=1');
  const canManage = hasRole('admin', 'dean');
  return (
    <ResourcePage
      title="Departments"
      subtitle="Departments belong to a faculty and are managed by a Head of Department (HoD)."
      noun="Department"
      endpoint="/api/departments"
      searchKeys={['name', 'code', 'faculty_name', 'hod_name']}
      canCreate={canManage}
      canEdit={() => canManage}
      canDelete={() => canManage}
      deleteMessage={(d: any) => `Deleting ${d.name} also deletes its ${d.program_count} programme(s) and their classes.`}
      columns={[
        { key: 'name', header: 'Department', render: (d: any) => <><strong>{d.name}</strong>{d.code && <span className="muted"> · {d.code}</span>}</> },
        { key: 'faculty_name', header: 'Faculty', hideOnMobile: true },
        { key: 'hod_name', header: 'Head of Department', render: (d: any) => leader(d.hod_name, d.hod_email) },
        { key: 'program_count', header: 'Programmes', align: 'right', hideOnMobile: true },
        { key: 'lecturer_count', header: 'Lecturers', align: 'right', hideOnMobile: true },
      ]}
      fields={[
        { name: 'faculty_id', label: 'Faculty', type: 'select', required: true, span: 2, options: (faculties || []).map((f) => ({ value: f.id, label: f.name })) },
        { name: 'name', label: 'Department name', required: true, span: 2 },
        { name: 'code', label: 'Code' },
        { name: 'hod_id', label: 'Head of Department', type: 'select', placeholder: 'Not appointed', options: (hods || []).map((h) => ({ value: h.id, label: `${h.title ? `${h.title} ` : ''}${h.name}` })) },
      ]}
      fromRow={(d: any) => ({ faculty_id: d.faculty_id, name: d.name, code: d.code || '', hod_id: d.hod_id || '' })}
    />
  );
}
