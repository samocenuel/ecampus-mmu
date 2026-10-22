import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { ArrowLeft, CheckCircle2, Maximize2, Minimize2, Shuffle, UserPlus, X } from 'lucide-react';
import { api } from '../api';
import { useFeedback } from '../components/feedback';
import { Alert, Badge, Button, Card, DataTable, EmptyState, ErrorNote, Field, IconButton, Input, Modal, Select, Spinner } from '../components/ui';
import { useFetch } from '../hooks';

const METHOD: Record<string, { label: string; tone: 'success' | 'info' }> = {
  qr: { label: 'Phone', tone: 'success' },
  manual: { label: 'Manual', tone: 'info' },
};
const FLAG: Record<string, string> = {
  device_belongs_to_other: "Tried a phone registered to another student",
  device_used: 'Phone already used for another student',
  device_other_account: 'Account registered to another phone',
  expired_code: 'Scanned an old code',
  outside_area: 'Outside the campus area',
  not_in_class: 'Not in a class at this lecture',
  closed: 'Scanned after closing',
  removed: 'Removed by the lecturer',
};

/** The rotating QR code, refreshed from the server a little before it expires. */
function LiveCode({ id, big }: { id: number; big: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const { code, expires_in } = await api<{ code: string; expires_in: number }>(`/api/checkin/${id}/code`);
        const url = await QRCode.toDataURL(code, { margin: 1, width: 640, errorCorrectionLevel: 'M' });
        if (!alive) return;
        setSrc(url);
        setLeft(expires_in);
        setError(null);
        timer = setTimeout(load, Math.max(1000, (expires_in - 1) * 1000));
      } catch (err: any) {
        if (!alive) return;
        setError(err.message);
        timer = setTimeout(load, 4000);
      }
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id]);
  useEffect(() => {
    const t = setInterval(() => setLeft((l) => Math.max(0, l - 1)), 1000);
    return () => clearInterval(t);
  }, []);
  if (error) return <Alert tone="warning">{error}</Alert>;
  if (!src) return <Spinner label="Preparing the code..." />;
  return (
    <div className={`qr-box ${big ? 'qr-big' : ''}`}>
      <img src={src} alt="Check-in QR code" />
      <div className="qr-caption">
        Scan with the <strong>eCampus app</strong> · new code in {left}s
      </div>
    </div>
  );
}

function ManualMark({ id, onClose, onDone }: { id: number; onClose: () => void; onDone: () => void }) {
  const { data } = useFetch<any[]>(`/api/checkin/${id}/students`);
  const { fail, toast } = useFeedback();
  const [form, setForm] = useState({ student_id: '', reason: 'Flat battery' });
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const options = (data || []).filter((s) => `${s.name} ${s.identifier || ''}`.toLowerCase().includes(query.toLowerCase()));
  const save = async () => {
    setBusy(true);
    try {
      const r = await api(`/api/checkin/${id}/manual`, { method: 'POST', body: form });
      toast(r.over_limit ? `Marked. This student has ${r.manual_marks_this_term} manual marks this term; the HoD has been told.` : 'Marked present');
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
      title="Mark a student manually"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!form.student_id}>
            Mark present
          </Button>
        </>
      }
    >
      <Alert tone="info">Check the student's ID card first. Manual marks are labelled in the register and limited per term.</Alert>
      <Field label="Find the student">
        <Input placeholder="Name or registration number" value={query} onChange={(e) => setQuery(e.target.value)} />
      </Field>
      <Field label="Student">
        <Select value={form.student_id} onChange={(e) => setForm({ ...form, student_id: e.target.value })} placeholder="Choose..." options={options.map((s) => ({ value: s.id, label: `${s.name}${s.identifier ? ` (${s.identifier})` : ''} - ${s.class_name}` }))} />
      </Field>
      <Field label="Reason">
        <Select
          value={form.reason}
          onChange={(e) => setForm({ ...form, reason: e.target.value })}
          options={['Flat battery', 'No smartphone', 'Phone lost or broken', 'App problem'].map((r) => ({ value: r, label: r }))}
        />
      </Field>
    </Modal>
  );
}

export default function CheckIn() {
  const { id } = useParams();
  const cid = Number(id);
  const { toast, fail, confirm } = useFeedback();
  const { data, loading, error, reload } = useFetch<any>(`/api/checkin/${cid}`);
  const [big, setBig] = useState(false);
  const [marking, setMarking] = useState(false);
  const [rollcall, setRollcall] = useState<any[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Live count while open.
  useEffect(() => {
    if (!data?.open) return;
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [data?.open, reload]);

  if (loading && !data) return <Spinner label="Loading check-in..." />;
  if (error || !data) return <ErrorNote error={error || 'Check-in not found'} />;
  const o = data.occurrence;

  const close = async () => {
    if (!(await confirm({ title: 'Close check-in?', message: 'The attendance registers are written from the check-ins and approved. Late manual marks are still possible.', confirmLabel: 'Close check-in' }))) return;
    setBusy('close');
    try {
      const r = await api(`/api/checkin/${cid}/close`, { method: 'POST' });
      toast(`Check-in closed: ${r.registers} register${r.registers === 1 ? '' : 's'} saved`);
      reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };
  const remove = async (row: any) => {
    if (!(await confirm({ title: `Remove ${row.name}?`, message: 'Use this if the student is not in the room.', confirmLabel: 'Remove', tone: 'danger' }))) return;
    try {
      await api(`/api/checkin/${cid}/entries/${row.student_id}`, { method: 'DELETE' });
      reload();
    } catch (err) {
      fail(err);
    }
  };
  const roll = async () => {
    setBusy('roll');
    try {
      setRollcall(await api(`/api/checkin/${cid}/rollcall`, { method: 'POST' }));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={big ? 'checkin-full' : ''}>
      {!big && (
        <Link to="/my-timetable" className="back-link">
          <ArrowLeft size={16} /> My timetable
        </Link>
      )}
      <div className="checkin-layout">
        <Card
          title={
            <>
              {o.course_code} {o.course_name} {data.open ? <Badge tone="success">Open</Badge> : <Badge>Closed</Badge>}
            </>
          }
          actions={
            data.can_manage && data.open && (
              <IconButton label={big ? 'Exit full screen' : 'Full screen for the projector'} onClick={() => setBig((b) => !b)}>
                {big ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
              </IconButton>
            )
          }
        >
          <div className="muted">
            {o.start_time}-{o.end_time} · {o.room_name} · {o.classes.map((c: any) => c.name).join(', ')}
          </div>
          {data.open && data.can_manage ? (
            <LiveCode id={cid} big={big} />
          ) : !data.open ? (
            <Alert tone="success" title="Check-in closed">
              The registers were written from the check-ins. {data.can_manage ? 'You can still mark a student manually.' : ''}
            </Alert>
          ) : (
            <Alert tone="info">Check-in is running. Students scan the code on the lecturer's screen.</Alert>
          )}
          <div className="checkin-count">
            <span className="checkin-number">{data.counts.total}</span>
            <span className="muted">of {data.expected} students checked in</span>
          </div>
          <div className="row gap-sm wrap">
            {data.can_mark && (
              <Button variant="secondary" icon={<UserPlus size={16} />} onClick={() => setMarking(true)}>
                Mark manually
              </Button>
            )}
            {data.can_manage && (
              <Button variant="secondary" icon={<Shuffle size={16} />} loading={busy === 'roll'} onClick={roll} disabled={!data.counts.qr}>
                Random roll call
              </Button>
            )}
            {data.can_manage && data.open && (
              <Button variant="success" icon={<CheckCircle2 size={16} />} loading={busy === 'close'} onClick={close}>
                Close check-in
              </Button>
            )}
          </div>
        </Card>
        {!big && (
          <div className="stack">
            <Card title={`Checked in (${data.counts.total})`} padded={false} actions={<span className="muted small">{data.counts.qr} by phone · {data.counts.manual} manual</span>}>
              <DataTable
                rows={data.entries.map((e: any) => ({ ...e, id: e.student_id }))}
                searchKeys={['name', 'identifier', 'class_name']}
                empty="Nobody has checked in yet"
                columns={[
                  { key: 'name', header: 'Student', render: (e: any) => <><strong>{e.name}</strong><div className="muted small">{e.identifier} · {e.class_name}</div></> },
                  { key: 'method', header: 'How', render: (e: any) => <><Badge tone={METHOD[e.method]?.tone}>{METHOD[e.method]?.label || e.method}</Badge>{e.reason && <div className="muted small">{e.reason}{e.marked_by_name ? ` · ${e.marked_by_name}` : ''}</div>}</> },
                  { key: 'created_at', header: 'Time', hideOnMobile: true, render: (e: any) => new Date(e.created_at.replace(' ', 'T') + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
                  ...(data.can_manage
                    ? [{ key: '_x', header: '', align: 'right' as const, render: (e: any) => <IconButton label="Remove" className="danger" onClick={() => remove(e)}><X size={16} /></IconButton> }]
                    : []),
                ]}
              />
            </Card>
            {data.can_manage && (
              <Card title="Refused attempts" padded={!data.flags.length}>
                {!data.flags.length ? (
                  <EmptyState title="None so far" />
                ) : (
                  <ul className="flag-list">
                    {data.flags.map((f: any, i: number) => (
                      <li key={i}>
                        <strong>{f.name || 'Unknown student'}</strong> {f.identifier && <span className="muted">({f.identifier})</span>}
                        <div className="muted small">{FLAG[f.kind] || f.kind}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}
          </div>
        )}
      </div>
      {marking && <ManualMark id={cid} onClose={() => setMarking(false)} onDone={reload} />}
      {rollcall && (
        <Modal open title="Random roll call" onClose={() => setRollcall(null)} footer={<Button onClick={() => setRollcall(null)}>Done</Button>}>
          <p className="muted">Call these students. Remove anyone who is not in the room.</p>
          <ul className="name-list">
            {rollcall.map((s) => (
              <li key={s.id}>
                <strong>{s.name}</strong> <span className="muted">{s.identifier} · {s.class_name}</span>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  );
}
