import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BellRing, FileSpreadsheet, FileText, LayoutGrid, List } from 'lucide-react';
import { download } from '../api';
import { useAuth } from '../auth';
import { useFeedback } from '../components/feedback';
import { Agenda, WeekGrid } from '../components/WeekGrid';
import { Button, Card, EmptyState, ErrorNote, PageHeader, Spinner, Tabs } from '../components/ui';
import { useFetch, usePersistentState } from '../hooks';

export function ExportButtons({ query, label = 'timetable' }: { query: string; label?: string }) {
  const { fail } = useFeedback();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (format: 'pdf' | 'xlsx') => {
    setBusy(format);
    try {
      await download(`/api/timetable/export?format=${format}${query ? `&${query}` : ''}`, `${label}.${format}`);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <Button variant="secondary" icon={<FileText size={16} />} loading={busy === 'pdf'} onClick={() => run('pdf')}>
        PDF
      </Button>
      <Button variant="secondary" icon={<FileSpreadsheet size={16} />} loading={busy === 'xlsx'} onClick={() => run('xlsx')}>
        Excel
      </Button>
    </>
  );
}

export default function MyTimetable() {
  const { user } = useAuth();
  const { data, loading, error } = useFetch<any>('/api/timetable?mine=1');
  const [view, setView] = usePersistentState<'week' | 'list'>('lms_tt_view', window.innerWidth < 720 ? 'list' : 'week');
  const todayDow = ((new Date().getDay() + 6) % 7) + 1;
  const isStudent = user?.role === 'student';

  return (
    <>
      <PageHeader
        title="My timetable"
        subtitle={data ? `${data.title} · ${data.term?.name || 'No term'}` : ' '}
        actions={
          <>
            <Link to="/notifications" className="btn btn-ghost">
              <BellRing size={16} /> <span>Reminders</span>
            </Link>
            <ExportButtons query="mine=1" label="my-timetable" />
          </>
        }
      />
      <ErrorNote error={error} />
      {loading && !data && <Spinner />}
      {data && (
        <Card
          padded={false}
          title={
            <Tabs
              value={view}
              onChange={setView}
              tabs={[
                { value: 'week', label: <span className="row gap-sm"><LayoutGrid size={15} /> Week</span> },
                { value: 'list', label: <span className="row gap-sm"><List size={15} /> List</span> },
              ]}
            />
          }
          actions={<span className="muted small">{data.sessions.length} weekly sessions</span>}
        >
          {data.sessions.length === 0 ? (
            <EmptyState title="Nothing scheduled yet">
              {isStudent ? 'Your class timetable will appear here once it is published.' : 'Lectures allocated to you will appear here once the timetable is generated.'}
            </EmptyState>
          ) : view === 'week' ? (
            <WeekGrid sessions={data.sessions} settings={data.settings} showClasses={!isStudent} todayDow={todayDow} />
          ) : (
            <div className="pad">
              <Agenda sessions={data.sessions} showClasses={!isStudent} />
            </div>
          )}
        </Card>
      )}
    </>
  );
}
