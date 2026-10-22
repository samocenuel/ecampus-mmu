import { ResourcePage } from '../../components/ResourcePage';
import { Badge } from '../../components/ui';

const KINDS = [
  { value: 'holiday', label: 'Public holiday' },
  { value: 'recess', label: 'Recess / break' },
  { value: 'reading', label: 'Reading week' },
  { value: 'exams', label: 'Examinations' },
  { value: 'event', label: 'University event' },
];
const niceDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

export default function AcademicCalendar() {
  return (
    <ResourcePage
      title="Academic calendar"
      subtitle="Holidays, breaks, reading weeks and exam periods. No lectures, reminders or missed-lecture alerts fall on days marked 'no teaching'."
      noun="Calendar date"
      endpoint="/api/ops/calendar-events"
      searchKeys={['title', 'kind']}
      canCreate
      canEdit={() => true}
      canDelete={() => true}
      columns={[
        { key: 'title', header: 'Event', render: (e: any) => <strong>{e.title}</strong> },
        { key: 'kind', header: 'Type', render: (e: any) => KINDS.find((k) => k.value === e.kind)?.label || e.kind },
        { key: 'start_date', header: 'Dates', render: (e: any) => <>{niceDate(e.start_date)}{e.end_date !== e.start_date && <div className="muted small">to {niceDate(e.end_date)}</div>}</> },
        { key: 'no_teaching', header: 'Teaching', render: (e: any) => (e.no_teaching ? <Badge tone="warning">No teaching</Badge> : <Badge>Normal</Badge>) },
      ]}
      fields={[
        { name: 'title', label: 'Name', required: true, span: 2, placeholder: 'e.g. Independence Day' },
        { name: 'kind', label: 'Type', type: 'select', noPlaceholder: true, defaultValue: 'holiday', options: KINDS },
        { name: 'no_teaching', label: 'No lectures on these days', type: 'checkbox', defaultValue: true },
        { name: 'start_date', label: 'From', type: 'date', required: true },
        { name: 'end_date', label: 'To', type: 'date', help: 'Leave empty for a single day' },
      ]}
      fromRow={(e: any) => ({ title: e.title, kind: e.kind, no_teaching: Boolean(e.no_teaching), start_date: e.start_date, end_date: e.end_date })}
      toPayload={(f) => ({ ...f, end_date: f.end_date || f.start_date, no_teaching: Boolean(f.no_teaching) })}
    />
  );
}
