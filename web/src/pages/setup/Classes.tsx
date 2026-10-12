import { useState } from 'react';
import { Crown, Users } from 'lucide-react';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { useFeedback } from '../../components/feedback';
import { ResourcePage } from '../../components/ResourcePage';
import { Badge, Button, DataTable, EmptyState, Field, IconButton, Modal, Select, Spinner } from '../../components/ui';
import { useFetch } from '../../hooks';

function StudentsDialog({ cls, onClose }: { cls: any; onClose: () => void }) {
  const { data, loading } = useFetch<any[]>(`/api/classes/${cls.id}/students`);
  return (
    <Modal open wide onClose={onClose} title={`${cls.name} - students`}>
      {loading && !data && <Spinner />}
      {data && (
        <DataTable
          rows={data}
          searchKeys={['name', 'email', 'identifier']}
          empty="No students in this class yet - add them under Users"
          columns={[
            { key: 'name', header: 'Name', render: (s) => <>{s.name} {s.is_class_rep ? <Badge tone="primary">Class rep</Badge> : null}</> },
            { key: 'identifier', header: 'Reg. no.' },
            { key: 'email', header: 'Email', hideOnMobile: true },
          ]}
        />
      )}
    </Modal>
  );
}

function RepDialog({ cls, onClose, onDone }: { cls: any; onClose: () => void; onDone: () => void }) {
  const { data } = useFetch<any[]>(`/api/classes/${cls.id}/students`);
  const [studentId, setStudentId] = useState(String(cls.class_rep_id || ''));
  const [busy, setBusy] = useState(false);
  const { toast, fail } = useFeedback();
  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/classes/${cls.id}/rep`, { method: 'PUT', body: { student_id: studentId || null } });
      toast(studentId ? 'Class representative appointed - they have been notified' : 'Class representative removed');
      onDone();
      onClose();
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
      title={`Class representative · ${cls.name}`}
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
      <p className="muted">The class representative records attendance during lectures; the lecturer then approves each list.</p>
      {data && data.length === 0 ? (
        <EmptyState title="No students yet">Add students to this class first.</EmptyState>
      ) : (
        <Field label="Student">
          <Select value={studentId} onChange={(e) => setStudentId(e.target.value)} placeholder="No class representative" options={(data || []).map((s) => ({ value: s.id, label: `${s.name}${s.identifier ? ` (${s.identifier})` : ''}` }))} />
        </Field>
      )}
    </Modal>
  );
}

export default function Classes() {
  const { hasRole } = useAuth();
  const { data: programs } = useFetch<any[]>('/api/programs');
  const [students, setStudents] = useState<any>(null);
  const [rep, setRep] = useState<{ cls: any; reload: () => void } | null>(null);
  const canManage = hasRole('admin', 'dean', 'hod');
  const year = new Date().getFullYear();

  return (
    <>
      <ResourcePage
        title="Classes"
        subtitle="A class is a cohort of students in a programme and year of study. Each class can have a class representative."
        noun="Class"
        endpoint="/api/classes"
        searchKeys={['name', 'program_code', 'department_name', 'class_rep_name']}
        canCreate={canManage}
        canEdit={() => canManage}
        canDelete={() => canManage}
        columns={[
          { key: 'name', header: 'Class', render: (c: any) => <><strong>{c.name}</strong><div className="muted small">{c.program_name}</div></> },
          { key: 'year_of_study', header: 'Year', align: 'center' },
          { key: 'academic_year', header: 'Intake', hideOnMobile: true },
          { key: 'student_count', header: 'Students', align: 'right', render: (c: any) => <>{c.student_count}<span className="muted small"> / {c.expected_size} expected</span></> },
          { key: 'class_rep_name', header: 'Class rep', render: (c: any) => c.class_rep_name || <Badge tone="warning">Not appointed</Badge> },
        ]}
        rowActions={(c: any, reload) => (
          <>
            <IconButton label="Students" onClick={() => setStudents(c)}>
              <Users size={16} />
            </IconButton>
            {canManage && (
              <IconButton label="Appoint class representative" onClick={() => setRep({ cls: c, reload })}>
                <Crown size={16} />
              </IconButton>
            )}
          </>
        )}
        fields={[
          { name: 'program_id', label: 'Programme', type: 'select', required: true, span: 2, options: (programs || []).map((p) => ({ value: p.id, label: `${p.code} - ${p.name}` })) },
          { name: 'name', label: 'Class name', required: true, placeholder: 'e.g. BSCS Year 1' },
          { name: 'year_of_study', label: 'Year of study', type: 'number', min: 1, max: 7, defaultValue: 1 },
          { name: 'academic_year', label: 'Academic year / intake', defaultValue: `${year}/${year + 1}` },
          { name: 'expected_size', label: 'Expected size', type: 'number', min: 0, defaultValue: 50, help: 'Used to choose large enough rooms' },
        ]}
        fromRow={(c: any) => ({ program_id: c.program_id, name: c.name, year_of_study: c.year_of_study, academic_year: c.academic_year || '', expected_size: c.expected_size })}
      />
      {students && <StudentsDialog cls={students} onClose={() => setStudents(null)} />}
      {rep && <RepDialog cls={rep.cls} onClose={() => setRep(null)} onDone={rep.reload} />}
    </>
  );
}
