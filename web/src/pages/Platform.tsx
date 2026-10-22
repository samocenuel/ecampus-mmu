// SaaS operator view: every university (tenant) on the platform.
import { useState } from 'react';
import { api, assetUrl } from '../api';
import { useFeedback } from '../components/feedback';
import { Badge, Button, Card, DataTable, ErrorNote, Modal, PageHeader, StatCard } from '../components/ui';
import { useFetch } from '../hooks';
import { TempInfo, TempPassword } from './Users';

/** A university's administrators; the platform owner resets one who is locked out. */
function Admins({ university, onClose }: { university: any; onClose: () => void }) {
  const { data, loading, error } = useFetch<any[]>(`/api/platform/universities/${university.id}/admins`);
  const { fail, confirm } = useFeedback();
  const [temp, setTemp] = useState<TempInfo | null>(null);
  const reset = async (a: any) => {
    if (!(await confirm({ title: `Reset ${a.name}'s password?`, message: 'Their current password stops working. Give them the temporary password; they choose a new one when they sign in.', confirmLabel: 'Reset password' }))) return;
    try {
      const r = await api<any>(`/api/platform/users/${a.id}/reset-password`, { method: 'POST' });
      setTemp({ name: r.name, email: r.email, password: r.temporary_password, reset: true });
    } catch (err) {
      fail(err);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Administrators: ${university.name}`} footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <ErrorNote error={error} />
      <DataTable
        rows={data}
        loading={loading}
        empty="No administrator accounts"
        columns={[
          { key: 'name', header: 'Administrator', render: (a: any) => <><strong>{a.name}</strong><div className="muted small">{a.email}</div></> },
          { key: 'active', header: 'Status', render: (a: any) => (a.active ? (a.must_change_password ? <Badge tone="warning">Temporary password</Badge> : <Badge tone="success">Active</Badge>) : <Badge>Inactive</Badge>) },
          { key: '_a', header: '', align: 'right', render: (a: any) => (a.demo ? <span className="muted small">Demo</span> : <Button size="sm" variant="secondary" onClick={() => reset(a)}>Reset password</Button>) },
        ]}
      />
      <TempPassword info={temp} onClose={() => setTemp(null)} />
    </Modal>
  );
}

export default function Platform() {
  const { data, loading, error, reload } = useFetch<any[]>('/api/platform/universities');
  const { toast, fail, confirm } = useFeedback();
  const [admins, setAdmins] = useState<any>(null);

  const toggle = async (u: any) => {
    if (u.active && !(await confirm({ title: `Suspend ${u.name}?`, message: 'Its users will not be able to sign in until it is reactivated.', confirmLabel: 'Suspend', tone: 'danger' }))) return;
    try {
      await api(`/api/platform/universities/${u.id}`, { method: 'PUT', body: { active: !u.active } });
      toast(u.active ? 'University suspended' : 'University reactivated');
      reload();
    } catch (err) {
      fail(err);
    }
  };

  const total = (k: string) => (data || []).reduce((n, u) => n + (u[k] || 0), 0);
  return (
    <>
      <PageHeader title="Universities" subtitle="All institutions using the platform. New universities sign up from the public registration page." />
      <ErrorNote error={error} />
      <div className="stat-grid">
        <StatCard label="Universities" value={data?.length ?? '-'} />
        <StatCard label="Faculties" value={total('faculties')} />
        <StatCard label="Lecturers" value={total('lecturers')} />
        <StatCard label="Students" value={total('students')} />
      </div>
      <Card padded={false}>
        <DataTable
          rows={data}
          loading={loading}
          searchKeys={['name', 'short_name', 'email']}
          columns={[
            {
              key: 'name',
              header: 'University',
              render: (u) => (
                <div className="row gap-sm">
                  {u.logo_url ? <img src={assetUrl(u.logo_url)!} alt="" className="mini-logo" /> : <span className="mini-logo" style={{ background: u.primary_color }} />}
                  <div>
                    <strong>{u.name}</strong>
                    <div className="muted small">
                      {u.email || '-'} · {u.phone || '-'}
                    </div>
                  </div>
                </div>
              ),
            },
            { key: 'faculties', header: 'Faculties', align: 'right' },
            { key: 'lecturers', header: 'Lecturers', align: 'right' },
            { key: 'students', header: 'Students', align: 'right' },
            { key: 'created_at', header: 'Joined', render: (u) => u.created_at.slice(0, 10), hideOnMobile: true },
            { key: 'active', header: 'Status', render: (u) => (u.active ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Suspended</Badge>) },
            {
              key: '_a',
              header: '',
              align: 'right',
              render: (u) => (
                <div className="row-actions">
                  <Button size="sm" variant="ghost" onClick={() => setAdmins(u)}>
                    Admins
                  </Button>
                  <Button size="sm" variant={u.active ? 'secondary' : 'primary'} onClick={() => toggle(u)}>
                    {u.active ? 'Suspend' : 'Reactivate'}
                  </Button>
                </div>
              ),
            },
          ]}
        />
      </Card>
      {admins && <Admins university={admins} onClose={() => setAdmins(null)} />}
    </>
  );
}
