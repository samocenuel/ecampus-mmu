import { useState } from 'react';
import { Hand, Megaphone, UserCheck, X } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useFeedback } from '../components/feedback';
import { Alert, Badge, Button, Card, EmptyState, ErrorNote, Field, Modal, PageHeader, Select, Spinner, Textarea } from '../components/ui';
import { useFetch } from '../hooks';
import { useTerms } from './Timetable';

const STATUS: Record<string, [string, 'success' | 'warning' | 'neutral']> = { open: ['Open', 'warning'], filled: ['Assigned', 'success'], closed: ['Closed', 'neutral'] };

/**
 * Internal part-time calls: units nobody can take within their maximum load, offered to full-time
 * staff as paid part-time load. Lecturers respond; the HoD assigns one and the unit is allocated.
 */
export default function PartTimeCalls() {
  const { user } = useAuth();
  const { toast, fail, confirm } = useFeedback();
  const { terms, current } = useTerms();
  const [termId, setTermId] = useState<number | null>(null);
  const term = termId ?? current?.id;
  const { data, loading, error, reload } = useFetch<any[]>(term ? `/api/allocations/part-time-calls?term_id=${term}` : null);
  const [responding, setResponding] = useState<any>(null);
  const [note, setNote] = useState('');
  const manager = ['admin', 'dean', 'hod'].includes(user!.role);
  const partTimer = user!.employment_type === 'part_time';

  const respond = async () => {
    try {
      await api(`/api/allocations/part-time-calls/${responding.id}/respond`, { method: 'POST', body: { note } });
      toast('Thank you. Your HoD will be in touch if you are chosen.');
      setResponding(null);
      setNote('');
      reload();
    } catch (err) {
      fail(err);
    }
  };
  const withdraw = async (c: any) => {
    try {
      await api(`/api/allocations/part-time-calls/${c.id}/respond`, { method: 'DELETE' });
      reload();
    } catch (err) {
      fail(err);
    }
  };
  const assign = async (c: any, r: any) => {
    const ok = await confirm({
      title: `Give ${c.code} to ${r.name}?`,
      message: `${c.hours_per_week} h a week for ${c.classes.map((x: any) => x.name).join(', ')}, paid as internal part-time load. The others who responded are told.`,
      confirmLabel: 'Assign',
    });
    if (!ok) return;
    try {
      await api(`/api/allocations/part-time-calls/${c.id}/assign`, { method: 'POST', body: { user_id: r.user_id } });
      toast(`${c.code} allocated to ${r.name}`);
      reload();
    } catch (err) {
      fail(err);
    }
  };
  const close = async (c: any) => {
    if (!(await confirm({ title: `Close the call for ${c.code}?`, message: 'Staff can no longer respond. The unit stays unallocated.', confirmLabel: 'Close call' }))) return;
    try {
      await api(`/api/allocations/part-time-calls/${c.id}/close`, { method: 'POST' });
      reload();
    } catch (err) {
      fail(err);
    }
  };

  return (
    <>
      <PageHeader
        title="Internal part-time calls"
        subtitle={manager ? 'Units offered to full-time staff as paid part-time load. Start a call from Load allocation.' : 'Teaching your HoD is offering to full-time staff as paid part-time load.'}
        actions={<Select value={term ?? ''} onChange={(e) => setTermId(Number(e.target.value))} options={terms.map((t) => ({ value: t.id, label: t.name }))} aria-label="Term" />}
      />
      <ErrorNote error={error} />
      {loading && !data && <Spinner />}
      {partTimer && <Alert tone="info">Internal part-time calls are for full-time staff. Part-time lecturers are allocated directly by the HoD.</Alert>}
      {data && data.length === 0 && <EmptyState icon={<Megaphone size={22} />} title="No calls this term" />}
      <div className="stack">
        {data?.map((c) => (
          <Card
            key={c.id}
            title={
              <span className="row gap-sm wrap">
                <strong>{c.code}</strong> {c.course_name} <Badge tone={STATUS[c.status][1]}>{STATUS[c.status][0]}</Badge>
              </span>
            }
            actions={
              manager && c.can_manage && c.status === 'open' ? (
                <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={() => close(c)}>
                  Close
                </Button>
              ) : !manager && c.status === 'open' && !partTimer ? (
                c.responded ? (
                  <Button size="sm" variant="secondary" onClick={() => withdraw(c)}>
                    Withdraw
                  </Button>
                ) : (
                  <Button size="sm" icon={<Hand size={14} />} onClick={() => setResponding(c)}>
                    I can take it
                  </Button>
                )
              ) : null
            }
          >
            <p className="m0">
              {c.classes.map((x: any) => x.name).join(', ')} · {c.hours_per_week} h a week · {c.term_name}
            </p>
            {c.note && <p className="muted m0">{c.note}</p>}
            <p className="muted small m0">
              Posted by {c.created_by_name || 'the HoD'}
              {c.status === 'filled' && c.filled_by_name ? ` · assigned to ${c.filled_by_name}` : ''}
              {!manager && c.responded && c.status === 'open' ? ' · you responded' : ''}
            </p>
            {manager && c.can_manage && (
              <div className="stack" style={{ marginTop: 10 }}>
                <div className="field-label">{c.responses.length ? `Responses (${c.responses.length})` : 'No responses yet'}</div>
                {c.responses.map((r: any) => (
                  <div key={r.user_id} className="metric-row">
                    <span>
                      <strong>{[r.title, r.name].filter(Boolean).join(' ')}</strong> <span className="muted small">{r.department_name}</span>
                      {r.workload && (
                        <div className="muted small">
                          Load {r.workload.hours}/{r.workload.max} h a week{r.workload.part_time_hours ? ` · ${r.workload.part_time_hours} h part-time already` : ''}
                        </div>
                      )}
                      {r.note && <div className="small">{r.note}</div>}
                    </span>
                    {c.status === 'open' && (
                      <Button size="sm" icon={<UserCheck size={14} />} onClick={() => assign(c, r)}>
                        Assign
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        ))}
      </div>
      <Modal
        open={Boolean(responding)}
        onClose={() => setResponding(null)}
        title={`Offer to teach ${responding?.code}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setResponding(null)}>
              Cancel
            </Button>
            <Button onClick={respond}>Send</Button>
          </>
        }
      >
        <p className="muted">The hours are paid as internal part-time load through Pay claims once attendance is approved.</p>
        <Field label="Note for the HoD (optional)">
          <Textarea value={note} placeholder="e.g. available Tuesday and Thursday evenings" onChange={(e) => setNote(e.target.value)} />
        </Field>
      </Modal>
    </>
  );
}
