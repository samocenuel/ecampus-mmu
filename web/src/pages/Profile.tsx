import { FormEvent, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useFeedback } from '../components/feedback';
import { Avatar, Button, Card, Field, Input, Modal, PageHeader } from '../components/ui';
import { ROLE_LABELS } from '../types';

function DeleteAccount() {
  const { logout } = useAuth();
  const { fail } = useFeedback();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await api('/api/auth/delete-account', { method: 'POST', body: { password } });
      logout();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Delete account">
      <p className="muted m0">Permanently erase your personal details and sign out. Anonymised attendance records are kept for your university.</p>
      <div>
        <Button variant="danger" onClick={() => setOpen(true)}>
          Delete my account
        </Button>
      </div>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Delete your account?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} disabled={!password} onClick={run}>
              Delete account
            </Button>
          </>
        }
      >
        <p>This cannot be undone. Your name, email, phone and other personal details are erased.</p>
        <Field label="Confirm with your password">
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      </Modal>
    </Card>
  );
}

export default function Profile() {
  const { user } = useAuth();
  const { toast, fail } = useFeedback();
  const [form, setForm] = useState({ current_password: '', new_password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  if (!user) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (form.new_password !== form.confirm) return fail(new Error('New passwords do not match'));
    setBusy(true);
    try {
      await api('/api/auth/change-password', { method: 'POST', body: form });
      toast('Password changed');
      setForm({ current_password: '', new_password: '', confirm: '' });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Profile" />
      <div className="grid-2 align-start">
        <Card>
          <div className="row gap">
            <Avatar name={user.name} size={56} />
            <div>
              <h3 className="m0">
                {user.title ? `${user.title} ` : ''}
                {user.name}
              </h3>
              <div className="muted">{user.email}</div>
            </div>
          </div>
          <dl className="details">
            <dt>Role</dt>
            <dd>
              {ROLE_LABELS[user.role]}
              {user.is_class_rep ? ` · Class representative (${user.rep_classes?.map((c) => c.name).join(', ')})` : ''}
            </dd>
            {user.identifier && (
              <>
                <dt>{user.role === 'student' ? 'Registration no.' : 'Staff no.'}</dt>
                <dd>{user.identifier}</dd>
              </>
            )}
            {user.faculty_name && (
              <>
                <dt>Faculty</dt>
                <dd>{user.faculty_name}</dd>
              </>
            )}
            {user.department_name && (
              <>
                <dt>Department</dt>
                <dd>{user.department_name}</dd>
              </>
            )}
            {user.class_name && (
              <>
                <dt>Class</dt>
                <dd>{user.class_name}</dd>
              </>
            )}
          </dl>
        </Card>
        <Card title="Change password">
          <form onSubmit={submit} className="stack">
            <Field label="Current password">
              <Input type="password" autoComplete="current-password" required value={form.current_password} onChange={(e) => setForm({ ...form, current_password: e.target.value })} />
            </Field>
            <Field label="New password" help="At least 8 characters">
              <Input type="password" autoComplete="new-password" minLength={8} required value={form.new_password} onChange={(e) => setForm({ ...form, new_password: e.target.value })} />
            </Field>
            <Field label="Confirm new password">
              <Input type="password" autoComplete="new-password" minLength={8} required value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
            </Field>
            <div>
              <Button type="submit" loading={busy}>
                Update password
              </Button>
            </div>
          </form>
        </Card>
        {user.role !== 'super_admin' && <DeleteAccount />}
      </div>
    </>
  );
}
