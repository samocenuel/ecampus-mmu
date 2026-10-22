import { useState } from 'react';
import { CalendarPlus, CheckCircle2 } from 'lucide-react';
import { api } from '../../api';
import { useFeedback } from '../../components/feedback';
import { ResourcePage } from '../../components/ResourcePage';
import { Badge, Button, Field, IconButton, Input, Modal } from '../../components/ui';

const ROOM_TYPES = [
  { value: 'lecture', label: 'Lecture hall' },
  { value: 'lab', label: 'Laboratory' },
  { value: 'seminar', label: 'Seminar room' },
];

export function Rooms() {
  return (
    <ResourcePage
      title="Rooms"
      subtitle="Teaching spaces available for timetabling. Capacity is checked against class sizes."
      noun="Room"
      endpoint="/api/rooms"
      searchKeys={['name', 'building', 'room_type']}
      canCreate
      canEdit={() => true}
      canDelete={() => true}
      deleteMessage={(r: any) => `Deleting ${r.name} also removes every timetable session booked in it. Consider marking it unavailable instead.`}
      columns={[
        { key: 'name', header: 'Room', render: (r: any) => <strong>{r.name}</strong> },
        { key: 'building', header: 'Building' },
        { key: 'room_type', header: 'Type', render: (r: any) => ROOM_TYPES.find((t) => t.value === r.room_type)?.label || r.room_type },
        { key: 'capacity', header: 'Seats', align: 'right' },
        { key: 'active', header: 'Status', render: (r: any) => (r.active ? <Badge tone="success">Available</Badge> : <Badge>Unavailable</Badge>) },
      ]}
      fields={[
        { name: 'name', label: 'Room name', required: true, placeholder: 'e.g. LT 1' },
        { name: 'building', label: 'Building' },
        { name: 'capacity', label: 'Seats', type: 'number', required: true, min: 1, defaultValue: 60 },
        { name: 'room_type', label: 'Type', type: 'select', noPlaceholder: true, defaultValue: 'lecture', options: ROOM_TYPES },
        { name: 'active', label: 'Available for timetabling', type: 'checkbox', defaultValue: true, span: 2 },
      ]}
      fromRow={(r: any) => ({ ...r, active: Boolean(r.active) })}
    />
  );
}

/** Create an academic year's semesters together, named after the year. */
function NewAcademicYear({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { toast, fail } = useFeedback();
  // The next academic year: from July the coming one starts next calendar year.
  const now = new Date();
  const y = now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear();
  const [year, setYear] = useState(`${y}/${y + 1}`);
  const [sems, setSems] = useState([
    { semester: 1, start_date: `${y}-08-17`, end_date: `${y}-12-11` },
    { semester: 2, start_date: `${y + 1}-01-18`, end_date: `${y + 1}-05-14` },
  ]);
  const [busy, setBusy] = useState(false);
  const set = (i: number, k: string, v: string) => setSems(sems.map((s, j) => (j === i ? { ...s, [k]: v } : s)));
  const save = async () => {
    setBusy(true);
    try {
      await api('/api/academic-years', { method: 'POST', body: { academic_year: year, semesters: sems } });
      toast(`${year} created. Classes move up a year when Semester 1 starts.`);
      onDone();
      onClose();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="New academic year" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save}>Create</Button></>}>
      <p className="muted m0">
        On the first day of Semester 1 every class moves up a year, finalists are marked completed, new Year 1 classes open on the latest curriculum, and last year's allocations are copied as drafts for HoDs to confirm.
      </p>
      <Field label="Academic year">
        <Input value={year} onChange={(e) => setYear(e.target.value)} placeholder="2027/2028" />
      </Field>
      {sems.map((s, i) => (
        <div className="form-grid" key={s.semester}>
          <Field label={`Semester ${s.semester} starts`}>
            <Input type="date" value={s.start_date} onChange={(e) => set(i, 'start_date', e.target.value)} />
          </Field>
          <Field label={`Semester ${s.semester} ends`}>
            <Input type="date" value={s.end_date} onChange={(e) => set(i, 'end_date', e.target.value)} />
          </Field>
        </div>
      ))}
      {sems.length < 3 ? (
        <Button size="sm" variant="ghost" onClick={() => setSems([...sems, { semester: sems.length + 1, start_date: '', end_date: '' }])}>
          Add Semester {sems.length + 1}
        </Button>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setSems(sems.slice(0, 2))}>
          Remove Semester 3
        </Button>
      )}
    </Modal>
  );
}

export function Terms() {
  const { toast, fail } = useFeedback();
  const year = new Date().getFullYear();
  const [creatingYear, setCreatingYear] = useState(false);
  const [version, setVersion] = useState(0);
  return (
    <>
    {creatingYear && <NewAcademicYear onClose={() => setCreatingYear(false)} onDone={() => setVersion((v) => v + 1)} />}
    <ResourcePage
      key={version}
      headerActions={() => (
        <Button icon={<CalendarPlus size={16} />} onClick={() => setCreatingYear(true)}>
          New academic year
        </Button>
      )}
      title="Academic terms"
      subtitle="Semesters of each academic year. The current term follows the dates: a term becomes current on its start date."
      noun="Term"
      endpoint="/api/terms"
      canCreate
      canEdit={() => true}
      canDelete={() => true}
      deleteMessage={() => 'Deleting a term deletes its allocations, timetable and attendance records.'}
      columns={[
        { key: 'name', header: 'Term', render: (t: any) => <><strong>{t.name}</strong> {t.is_current ? <Badge tone="primary">Current</Badge> : null}</> },
        { key: 'semester', header: 'Semester', align: 'center' },
        { key: 'start_date', header: 'Starts' },
        { key: 'end_date', header: 'Ends' },
      ]}
      rowActions={(t: any, reload) =>
        !t.is_current && (
          <IconButton
            label="Make current term"
            onClick={async () => {
              try {
                await api(`/api/terms/${t.id}`, { method: 'PUT', body: { is_current: true } });
                toast(`${t.name} is now the current term`);
                reload();
              } catch (err) {
                fail(err);
              }
            }}
          >
            <CheckCircle2 size={16} />
          </IconButton>
        )
      }
      fields={[
        { name: 'name', label: 'Name', required: true, span: 2, defaultValue: `${year}/${year + 1} Semester 1` },
        { name: 'academic_year', label: 'Academic year', defaultValue: `${year}/${year + 1}` },
        { name: 'semester', label: 'Semester', type: 'select', required: true, defaultValue: '1', noPlaceholder: true, options: [1, 2, 3].map((s) => ({ value: s, label: `Semester ${s}` })) },
        { name: 'start_date', label: 'Start date', type: 'date' },
        { name: 'end_date', label: 'End date', type: 'date' },
        { name: 'is_current', label: 'Make this the current term', type: 'checkbox', span: 2 },
      ]}
      fromRow={(t: any) => ({ ...t, is_current: Boolean(t.is_current) })}
    />
    </>
  );
}
