// SaaS operator view: every university (tenant) on the platform.
import { api, assetUrl } from '../api';
import { useFeedback } from '../components/feedback';
import { Badge, Button, Card, DataTable, ErrorNote, PageHeader, StatCard } from '../components/ui';
import { useFetch } from '../hooks';

export default function Platform() {
  const { data, loading, error, reload } = useFetch<any[]>('/api/platform/universities');
  const { toast, fail, confirm } = useFeedback();

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
                <Button size="sm" variant={u.active ? 'secondary' : 'primary'} onClick={() => toggle(u)}>
                  {u.active ? 'Suspend' : 'Reactivate'}
                </Button>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}
