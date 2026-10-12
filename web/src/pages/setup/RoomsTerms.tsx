import { CheckCircle2 } from 'lucide-react';
import { api } from '../../api';
import { useFeedback } from '../../components/feedback';
import { ResourcePage } from '../../components/ResourcePage';
import { Badge, IconButton } from '../../components/ui';

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

export function Terms() {
  const { toast, fail } = useFeedback();
  const year = new Date().getFullYear();
  return (
    <ResourcePage
      title="Academic terms"
      subtitle="Semesters for which allocations, timetables and attendance are recorded. The current term is used by default everywhere."
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
  );
}
