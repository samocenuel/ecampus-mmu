// Public check of a printed requisition form: opened from its QR code or by typing its code.
import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { BadgeCheck, CircleAlert, Clock, GraduationCap, ListChecks, Search } from 'lucide-react';
import { api, assetUrl } from '../api';
import { Badge, Button, Card, Field, Input, Spinner } from '../components/ui';

const niceDate = (d?: string | null) => (d ? new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const niceDateTime = (d?: string | null) => (d ? new Date(d.replace(' ', 'T') + (d.includes('Z') ? '' : 'Z')).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const money = (n: number, currency: string) => {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(n || 0);
  } catch {
    return `${currency} ${Number(n || 0).toLocaleString()}`;
  }
};

export default function Verify() {
  const { code } = useParams();
  const navigate = useNavigate();
  const [typed, setTyped] = useState(code || '');
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!code) return;
    setLoading(true);
    setError(null);
    setData(null);
    api(`/api/verify/${encodeURIComponent(code)}`)
      .then(setData)
      .catch((err) => setError(err.status === 404 ? 'No requisition in the system matches this code. The form may not be genuine, or the code was mistyped.' : err.message))
      .finally(() => setLoading(false));
  }, [code]);

  const check = (e: FormEvent) => {
    e.preventDefault();
    if (typed.trim()) navigate(`/verify/${typed.trim().toUpperCase()}`);
  };
  const r = data?.requisition;

  return (
    <div className="verify-page">
      <div className="verify-card">
        <div className="row gap-sm">
          {data?.university.logo_url ? <img src={assetUrl(data.university.logo_url)!} alt="" className="mini-logo" /> : <GraduationCap size={26} />}
          <div>
            <strong>{data?.university.name || 'eCampus'}</strong>
            <div className="muted small">Requisition verification</div>
          </div>
        </div>

        {loading && <Spinner label="Checking the requisition..." />}
        {error && (
          <div className="verify-result bad">
            <CircleAlert size={28} />
            <div>
              <strong>Not verified</strong>
              <p className="m0">{error}</p>
            </div>
          </div>
        )}
        {r && (
          <>
            <div className={`verify-result ${r.cleared ? 'good' : 'pending'}`}>
              {r.cleared ? <BadgeCheck size={28} /> : <Clock size={28} />}
              <div>
                <strong>{r.cleared ? 'Genuine requisition, cleared for payment' : 'Genuine requisition, not yet cleared'}</strong>
                <p className="m0">Code {data.code} · requisition #{r.id}</p>
              </div>
            </div>
            <dl className="details">
              <dt>Lecturer</dt>
              <dd>{r.lecturer}</dd>
              <dt>Amount claimed</dt>
              <dd><strong>{money(r.amount, r.currency)}</strong></dd>
              <dt>Approval status</dt>
              <dd><Badge tone={r.status === 'paid' || r.cleared ? 'success' : r.status === 'rejected' ? 'danger' : 'warning'}>{r.status_label}</Badge>{r.paid_at ? ` · paid ${niceDateTime(r.paid_at)}` : ''}</dd>
              <dt>Department</dt>
              <dd>{[r.department, r.faculty].filter(Boolean).join(', ')}</dd>
              <dt>Period</dt>
              <dd>{niceDate(r.period_start)} to {niceDate(r.period_end)}</dd>
              {r.vote && (
                <>
                  <dt>Vote</dt>
                  <dd>{r.vote}</dd>
                </>
              )}
            </dl>
            <Card title="Digital signatures" padded={false}>
              <ul className="footprints">
                {data.sign_offs.map((s: any) => (
                  <li key={s.step} className={s.footprint ? '' : 'missing'}>
                    <div>
                      <strong>{s.step}</strong>
                      <div className="muted small">{s.name ? `${s.name} · ${niceDateTime(s.at)}` : 'Not yet signed off'}</div>
                    </div>
                    {s.footprint && <code>{s.footprint}</code>}
                  </li>
                ))}
              </ul>
            </Card>
            <p className="muted small m0">The codes printed in the form's signature boxes must match the ones above. Any difference in names, amount or codes means the paper has been altered.</p>
            <a className="btn btn-secondary" href={data.completed_url}>
              <ListChecks size={16} /> Completed requisitions (sign in)
            </a>
          </>
        )}

        <form onSubmit={check} className="stack">
          <Field label="Check another requisition">
            <div className="copy-row">
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Code on the form, e.g. YHN66-ZF99N" />
              <Button type="submit" icon={<Search size={16} />}>Check</Button>
            </div>
          </Field>
        </form>
        <p className="center muted small m0">
          <Link to="/login">Sign in to eCampus</Link>
        </p>
      </div>
    </div>
  );
}
