// Dated lectures (the weekly timetable applied to real dates) with changes, check-in and
// calendar sync. Used on My timetable.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarPlus, CalendarX2, Copy, ExternalLink, QrCode, RefreshCw, Repeat, Undo2 } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useFeedback } from './feedback';
import { Alert, Badge, Button, Card, EmptyState, ErrorNote, Field, Input, Modal, Select, Spinner, Tabs, Textarea } from './ui';
import { useFetch } from '../hooks';

const niceDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
const shortDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

export function CalendarSync({ onClose }: { onClose: () => void }) {
  const { data, loading, error, setData } = useFetch<any>('/api/ops/calendar-link');
  const { toast, fail, confirm } = useFeedback();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.url);
      toast('Link copied');
    } catch {
      fail(new Error('Copy the link by hand'));
    }
  };
  const reset = async () => {
    if (!(await confirm({ title: 'Make a new link?', message: 'Calendars using the old link stop updating; add the new one instead.', confirmLabel: 'New link' }))) return;
    try {
      setData(await api('/api/ops/calendar-link/reset', { method: 'POST' }));
      toast('New calendar link ready');
    } catch (err) {
      fail(err);
    }
  };
  return (
    <Modal open title="Add your timetable to your calendar" onClose={onClose} footer={<Button onClick={onClose}>Done</Button>}>
      <p className="muted">Your lectures, rescheduled lectures and exams appear in Google Calendar, Outlook or your phone's calendar, and update automatically.</p>
      <ErrorNote error={error} />
      {loading && <Spinner />}
      {data && (
        <div className="cal-links">
          <a className="btn btn-primary" href={data.google} target="_blank" rel="noreferrer">
            <ExternalLink size={16} /> <span>Add to Google Calendar</span>
          </a>
          <a className="btn btn-secondary" href={data.webcal}>
            <CalendarPlus size={16} /> <span>Open in Outlook / Apple Calendar</span>
          </a>
          <Field label="Or copy your private link" help="Keep it private: anyone with it can see your timetable.">
            <div className="copy-row">
              <Input readOnly value={data.url} onFocus={(e) => e.target.select()} />
              <Button variant="secondary" icon={<Copy size={16} />} onClick={copy}>
                Copy
              </Button>
            </div>
          </Field>
          <div>
            <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={reset}>
              Make a new link
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function ChangeLecture({ occ, onClose, onDone }: { occ: any; onClose: () => void; onDone: () => void }) {
  const { toast, fail } = useFeedback();
  const [mode, setMode] = useState<'move' | 'cancel'>('move');
  const [reason, setReason] = useState('');
  const [slot, setSlot] = useState<any>(null);
  const [manual, setManual] = useState({ new_date: '', new_start: occ.start_time, new_room_id: '' });
  const [busy, setBusy] = useState(false);
  const { data: slots, loading } = useFetch<any[]>(mode === 'move' ? `/api/ops/sessions/${occ.session_id}/suggestions?date=${occ.date}` : null);
  const { data: rooms } = useFetch<any[]>(mode === 'move' ? '/api/rooms' : null);

  const save = async (force = false) => {
    setBusy(true);
    try {
      const body: any = { session_id: occ.session_id, date: occ.date, action: mode, reason, force };
      if (mode === 'move') {
        const pick = slot || { date: manual.new_date, start_time: manual.new_start, room_id: manual.new_room_id || null };
        Object.assign(body, { new_date: pick.date, new_start: pick.start_time, new_room_id: pick.room_id });
      }
      await api('/api/ops/changes', { method: 'POST', body });
      toast(mode === 'cancel' ? 'Lecture cancelled; students have been told' : 'Lecture rescheduled; students have been told');
      onDone();
      onClose();
    } catch (err: any) {
      if (err?.data?.requires_confirmation && !force && window.confirm(`${err.message}. Use this room anyway?`)) return save(true);
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      wide
      title={`${occ.course_code} · ${niceDay(occ.date)} ${occ.start_time}-${occ.end_time}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep as it is
          </Button>
          <Button variant={mode === 'cancel' ? 'danger' : 'primary'} loading={busy} onClick={() => save()} disabled={reason.trim().length < 3 || (mode === 'move' && !slot && !(manual.new_date && manual.new_start))}>
            {mode === 'cancel' ? 'Cancel lecture' : 'Reschedule'}
          </Button>
        </>
      }
    >
      <Tabs
        value={mode}
        onChange={(v) => setMode(v)}
        tabs={[
          { value: 'move', label: 'Reschedule' },
          { value: 'cancel', label: 'Cancel' },
        ]}
      />
      {mode === 'move' && (
        <>
          <div className="field-label">Free slots for you, your classes and a room</div>
          {loading && <Spinner />}
          {slots && !slots.length && <Alert tone="warning">No free slot in the next two weeks; choose a time below.</Alert>}
          <div className="slot-list">
            {(slots || []).map((s) => (
              <button type="button" key={`${s.date}-${s.start_time}-${s.room_id}`} className={`slot-option ${slot === s ? 'selected' : ''}`} onClick={() => setSlot(s)}>
                <span>
                  <strong>{shortDay(s.date)}</strong> {s.start_time}-{s.end_time}
                </span>
                <span className="muted">
                  {s.room_name} ({s.room_capacity})
                </span>
              </button>
            ))}
          </div>
          <details>
            <summary className="link">Or pick a date, time and room yourself</summary>
            <div className="form-grid" style={{ marginTop: 10 }}>
              <Field label="Date">
                <Input type="date" value={manual.new_date} onChange={(e) => { setSlot(null); setManual({ ...manual, new_date: e.target.value }); }} />
              </Field>
              <Field label="Start time">
                <Input type="time" value={manual.new_start} onChange={(e) => { setSlot(null); setManual({ ...manual, new_start: e.target.value }); }} />
              </Field>
              <Field label="Room" span={2} help="Clashes with other lectures and exams are checked when you save.">
                <Select value={manual.new_room_id} onChange={(e) => { setSlot(null); setManual({ ...manual, new_room_id: e.target.value }); }} placeholder={`Same room (${occ.room_name})`} options={(rooms || []).map((r) => ({ value: r.id, label: `${r.name} (${r.capacity})` }))} />
              </Field>
            </div>
          </details>
        </>
      )}
      {mode === 'cancel' && <Alert tone="warning">Students and the lecturer are notified. Consider rescheduling so the teaching hours are not lost.</Alert>}
      <Field label="Reason (shown to students) *">
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder={mode === 'cancel' ? 'e.g. Lecturer at an external examination board' : 'e.g. Room needed for a guest lecture'} />
      </Field>
    </Modal>
  );
}

const STATUS: Record<string, { label: string; tone: 'warning' | 'danger' | 'info' | 'neutral' }> = {
  rescheduled: { label: 'Rescheduled', tone: 'warning' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
  moved: { label: 'Moved', tone: 'neutral' },
  no_teaching: { label: 'No teaching', tone: 'neutral' },
  covered: { label: 'Covered', tone: 'info' },
};

export function UpcomingLectures() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { fail, toast, confirm } = useFeedback();
  const { data, loading, error, reload } = useFetch<any>('/api/ops/occurrences');
  const [changing, setChanging] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const student = user?.role === 'student';

  const startCheckin = async (o: any) => {
    setBusy(o.key);
    try {
      const r = await api('/api/checkin/start', { method: 'POST', body: { session_id: o.session_id, date: o.date } });
      navigate(`/checkin/${r.id}`);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };
  const undo = async (o: any) => {
    if (!(await confirm({ title: 'Undo this change?', message: 'The lecture goes back to its usual time and room, and students are told.', confirmLabel: 'Undo change' }))) return;
    try {
      await api(`/api/ops/changes/${o.change_id}`, { method: 'DELETE' });
      toast('Change undone');
      reload();
    } catch (err) {
      fail(err);
    }
  };

  const items: any[] = data?.items || [];
  const days = [...new Set(items.map((i) => i.date))];
  return (
    <Card title="Next two weeks" actions={<span className="muted small">Holidays, cancellations, moves and covers included</span>}>
      <ErrorNote error={error} />
      {loading && !data && <Spinner />}
      {data && !items.length && <EmptyState title="No lectures in the next two weeks" icon={<CalendarX2 size={26} />} />}
      {days.map((d) => (
        <div key={d}>
          <div className="occ-day">
            {niceDay(d)} {d === data.today && <Badge tone="primary">Today</Badge>}
          </div>
          {items
            .filter((i) => i.date === d)
            .map((o) => {
              const st = STATUS[o.status];
              const inactive = ['cancelled', 'moved', 'no_teaching', 'covered'].includes(o.status);
              return (
                <div key={`${o.key}-${o.status}`} className={`occ-row ${inactive ? 'inactive' : ''}`}>
                  <div className="occ-when">
                    <strong>{o.start_time}</strong>
                    <div className="muted small">{o.end_time}</div>
                  </div>
                  <div className="occ-main">
                    <strong>{o.course_code}</strong> {o.course_name} {st && <Badge tone={st.tone}>{st.label}</Badge>}
                    {o.covered && o.status !== 'covered' && <Badge tone="info">{o.original_lecturer_id === user?.id ? `Covered by ${o.lecturer_name}` : `Cover for ${o.original_lecturer_name}`}</Badge>}
                    <div className="muted small">
                      {o.room_name}
                      {o.room_building ? `, ${o.room_building}` : ''} · {student ? o.lecturer_name : o.classes.map((c: any) => c.name).join(', ')}
                      {o.status === 'rescheduled' && o.original_date ? ` · from ${shortDay(o.original_date)}` : ''}
                      {o.status === 'moved' && o.moved_to ? ` · moved to ${shortDay(o.moved_to.date)} ${o.moved_to.start_time}` : ''}
                      {o.status === 'covered' ? ` · ${o.lecturer_name} covers it` : ''}
                    </div>
                    {o.change_reason && <div className="small">{o.change_reason}</div>}
                  </div>
                  {!student && (
                    <div className="occ-actions">
                      {o.checkin ? (
                        <Button size="sm" variant={o.checkin.open ? 'success' : 'secondary'} icon={<QrCode size={14} />} onClick={() => navigate(`/checkin/${o.checkin.id}`)}>
                          {o.checkin.open ? 'Check-in open' : 'Check-in'}
                        </Button>
                      ) : (
                        o.can_checkin && (
                          <Button size="sm" icon={<QrCode size={14} />} loading={busy === o.key} onClick={() => startCheckin(o)}>
                            Start check-in
                          </Button>
                        )
                      )}
                      {o.can_change && !o.has_attendance && (
                        <Button size="sm" variant="secondary" icon={<Repeat size={14} />} onClick={() => setChanging(o)}>
                          Change
                        </Button>
                      )}
                      {o.change_id && ['cancelled', 'moved', 'rescheduled'].includes(o.status) && !o.has_attendance && (o.original_lecturer_id === user?.id || ['hod', 'dean', 'admin'].includes(user?.role || '')) && (
                        <Button size="sm" variant="ghost" icon={<Undo2 size={14} />} onClick={() => undo(o)}>
                          Undo
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      ))}
      {changing && <ChangeLecture occ={changing} onClose={() => setChanging(null)} onDone={reload} />}
    </Card>
  );
}
