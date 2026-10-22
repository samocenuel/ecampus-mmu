import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BellRing, CheckCheck, Send } from 'lucide-react';
import { api } from '../api';
import { useFeedback } from '../components/feedback';
import { Alert, Badge, Button, Card, EmptyState, ErrorNote, Field, PageHeader, Select, Spinner, Toggle } from '../components/ui';
import { useFetch } from '../hooks';

const LEAD_TIMES = [5, 10, 15, 20, 30, 45, 60, 90, 120];

function ReminderSettings() {
  const { toast, fail } = useFeedback();
  const { data: prefs, setData } = useFetch<any>('/api/notifications/preferences');
  const { data: upcoming } = useFetch<any>('/api/notifications/upcoming?days=7');
  const [permission, setPermission] = useState<string>(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');

  const save = async (patch: any) => {
    try {
      const next = await api('/api/notifications/preferences', { method: 'PUT', body: { ...prefs, ...patch } });
      setData(next);
      toast('Reminder settings saved');
    } catch (err) {
      fail(err);
    }
  };

  const enableBrowser = async () => {
    if (typeof Notification === 'undefined') return;
    setPermission(await Notification.requestPermission());
  };

  if (!prefs) return <Spinner />;
  return (
    <Card title={<span className="row gap-sm"><BellRing size={18} /> Lecture reminders</span>}>
      <div className="stack">
        <Toggle checked={prefs.enabled} onChange={(v) => save({ enabled: v })} label="Remind me before my lectures start" />
        <Field label="Remind me" help="Applies on the web, and the mobile app schedules alarms on your phone with the same lead time.">
          <Select
            value={prefs.minutes_before}
            disabled={!prefs.enabled}
            onChange={(e) => save({ minutes_before: Number(e.target.value) })}
            options={LEAD_TIMES.map((m) => ({ value: m, label: m < 60 ? `${m} minutes before` : `${m / 60} hour${m > 60 ? 's' : ''} before` }))}
          />
        </Field>
        {permission === 'granted' ? (
          <Alert tone="success" title="Browser notifications are on">You'll get a pop-up from this browser while the site is open.</Alert>
        ) : permission === 'unsupported' ? (
          <Alert tone="info">This browser doesn't support notifications - reminders still appear in the bell.</Alert>
        ) : (
          <Alert tone="info" title="Get pop-up reminders" action={<Button size="sm" onClick={enableBrowser} disabled={permission === 'denied'}>Allow notifications</Button>}>
            {permission === 'denied' ? 'Notifications are blocked for this site in your browser settings.' : 'Allow this browser to show lecture reminders.'}
          </Alert>
        )}
        <div>
          <Button variant="ghost" size="sm" icon={<Send size={14} />} onClick={() => api('/api/notifications/test', { method: 'POST' }).then(() => toast('Test notification sent - it appears within 30 seconds'))}>
            Send me a test notification
          </Button>
        </div>
        {upcoming && (
          <div>
            <div className="field-label">Next reminders</div>
            {upcoming.items.length === 0 && <span className="muted small">No lectures in the next 7 days.</span>}
            <ul className="detail-list">
              {upcoming.items.slice(0, 5).map((u: any) => (
                <li key={`${u.session_id}-${u.date}`}>
                  <strong>{u.course_code}</strong> {new Date(u.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} at {u.start_time}
                  <span className="muted"> - reminder at {(() => {
                    const [h, m] = u.start_time.split(':').map(Number);
                    const t = h * 60 + m - prefs.minutes_before;
                    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(((t % 60) + 60) % 60).padStart(2, '0')}`;
                  })()}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}

const RESEARCH_LEAD = [15, 30, 60, 120, 180, 360, 720];

function ResearchReminderSettings() {
  const { toast, fail } = useFeedback();
  const { data: prefs, setData } = useFetch<any>('/api/notifications/preferences');
  const save = async (patch: any) => {
    try {
      const next = await api('/api/notifications/preferences', { method: 'PUT', body: { ...prefs, ...patch } });
      setData(next);
      toast('Reminder settings saved');
    } catch (err) {
      fail(err);
    }
  };
  if (!prefs) return null;
  return (
    <Card title={<span className="row gap-sm"><BellRing size={18} /> Presentations and defences</span>}>
      <div className="stack">
        <Toggle checked={prefs.research_enabled} onChange={(v) => save({ research_enabled: v })} label="Remind me before research presentations and defences I take part in" />
        <Toggle checked={prefs.research_day_before} onChange={(v) => save({ research_day_before: v })} label="Also remind me the day before" />
        <Field label="Remind me" help="Applies to the bell, the mobile app and, where your calendar app supports it, your calendar subscription.">
          <Select
            value={prefs.research_minutes_before}
            disabled={!prefs.research_enabled}
            onChange={(e) => save({ research_minutes_before: Number(e.target.value) })}
            options={RESEARCH_LEAD.map((m) => ({ value: m, label: m < 60 ? `${m} minutes before` : `${m / 60} hour${m > 60 ? 's' : ''} before` }))}
          />
        </Field>
      </div>
    </Card>
  );
}

export default function Notifications() {
  const { data, loading, error, reload } = useFetch<any>('/api/notifications?limit=100');
  const { fail } = useFeedback();
  useEffect(() => {
    const t = setInterval(reload, 30_000);
    return () => clearInterval(t);
  }, [reload]);

  const readAll = async () => {
    try {
      await api('/api/notifications/read-all', { method: 'POST' });
      reload();
    } catch (err) {
      fail(err);
    }
  };

  return (
    <>
      <PageHeader title="Notifications" subtitle="Lecture reminders, approvals and timetable changes." />
      <div className="grid-2 align-start">
        <ReminderSettings />
        <ResearchReminderSettings />
        <Card
          title={<span className="row gap-sm">Inbox {data?.unread_count ? <Badge tone="primary">{data.unread_count} new</Badge> : null}</span>}
          actions={
            <Button variant="ghost" size="sm" icon={<CheckCheck size={14} />} onClick={readAll}>
              Mark all read
            </Button>
          }
        >
          <ErrorNote error={error} />
          {loading && !data && <Spinner />}
          {data && data.items.length === 0 && <EmptyState title="No notifications yet" />}
          <div className="notif-list">
            {data?.items.map((n: any) => (
              <div key={n.id} className={`notif ${n.read_at ? '' : 'unread'}`}>
                <strong>{n.title}</strong>
                {n.body && <span>{n.body}</span>}
                <small className="muted">
                  {new Date(n.created_at.replace(' ', 'T') + 'Z').toLocaleString()}
                  {n.link && (
                    <>
                      {' · '}
                      <Link to={n.link} onClick={() => !n.read_at && api(`/api/notifications/${n.id}/read`, { method: 'POST' })}>
                        Open
                      </Link>
                    </>
                  )}
                </small>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
