import { ChangeEvent, FormEvent, useRef, useState } from 'react';
import { Camera, GraduationCap, KeyRound, LogOut, Trash2 } from 'lucide-react';
import { api, assetUrl } from '../api';
import { useAuth } from '../auth';
import { useFeedback } from '../components/feedback';
import { Alert, Avatar, Button, Card, Field, Input, Modal, PageHeader, Textarea } from '../components/ui';
import { useFetch } from '../hooks';
import { ROLE_LABELS } from '../types';

const niceDateTime = (d?: string | null) => (d ? new Date(d.replace(' ', 'T') + (d.includes('Z') ? '' : 'Z')).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

/** Deletion is a request: the systems administrator approves it, then the account is archived before it is erased. */
function DeleteAccount() {
  const { toast, fail } = useFeedback();
  const { data, reload } = useFetch<{ request: any; archive_days: number }>('/api/auth/delete-account');
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = data?.request?.status === 'pending' ? data.request : null;
  const days = data?.archive_days ?? 30;
  const run = async () => {
    setBusy(true);
    try {
      await api('/api/auth/delete-account', { method: 'POST', body: { password, reason } });
      toast('Request sent to your systems administrator');
      setOpen(false);
      setPassword('');
      reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  const withdraw = async () => {
    try {
      await api('/api/auth/delete-account', { method: 'DELETE' });
      toast('Deletion request withdrawn');
      reload();
    } catch (err) {
      fail(err);
    }
  };
  return (
    <Card title="Delete account">
      {pending ? (
        <>
          <Alert tone="warning">
            You asked to delete your account on {niceDateTime(pending.requested_at)}. Your systems administrator has not decided yet.
          </Alert>
          <div>
            <Button variant="secondary" onClick={withdraw}>
              Withdraw the request
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="muted m0">
            Ask for your account to be deleted. Your systems administrator approves the request; the account is then archived for {days} days (you cannot sign in, but it can still be
            restored) and your personal details are erased after that.
          </p>
          {data?.request?.status === 'rejected' && <Alert tone="info">Your last request was not approved: {data.request.decision_note}</Alert>}
          <div>
            <Button variant="danger" onClick={() => setOpen(true)}>
              Delete my account
            </Button>
          </div>
        </>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Ask to delete your account?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} disabled={!password} onClick={run}>
              Send request
            </Button>
          </>
        }
      >
        <p>
          Once your administrator approves, you can no longer sign in. After {days} days your name, email, phone numbers and other personal details are erased; anonymised attendance
          records are kept for your university.
        </p>
        <Field label="Reason (optional)">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Field label="Confirm with your password">
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      </Modal>
    </Card>
  );
}

/** Current password + new password twice. Used on the profile and for the first sign-in. */
export function ChangePasswordForm({ onDone, submitLabel = 'Update password' }: { onDone?: () => void; submitLabel?: string }) {
  const { refresh } = useAuth();
  const { toast, fail } = useFeedback();
  const [form, setForm] = useState({ current_password: '', new_password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (form.new_password !== form.confirm) return fail(new Error('The new passwords do not match'));
    setBusy(true);
    try {
      await api('/api/auth/change-password', { method: 'POST', body: form });
      toast('Password changed');
      setForm({ current_password: '', new_password: '', confirm: '' });
      await refresh();
      onDone?.();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="stack">
      <Field label="Current password">
        <Input type="password" autoComplete="current-password" required value={form.current_password} onChange={(e) => setForm({ ...form, current_password: e.target.value })} />
      </Field>
      <Field label="New password" help="At least 8 characters, different from the current one">
        <Input type="password" autoComplete="new-password" minLength={8} required value={form.new_password} onChange={(e) => setForm({ ...form, new_password: e.target.value })} />
      </Field>
      <Field label="Confirm new password">
        <Input type="password" autoComplete="new-password" minLength={8} required value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
      </Field>
      <div>
        <Button type="submit" loading={busy} icon={<KeyRound size={16} />}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** Shown instead of the app until someone replaces a password that another person set. */
export function ForcedPasswordChange() {
  const { user, logout } = useAuth();
  return (
    <div className="auth">
      <main className="auth-main" style={{ gridColumn: '1 / -1' }}>
        <div className="auth-card">
          <div className="auth-mobile-brand" style={{ display: 'flex' }}>
            <GraduationCap size={24} /> eCampus
          </div>
          <h1>Choose your password</h1>
          <p className="muted">
            Welcome{user ? `, ${user.name.split(' ')[0]}` : ''}. Your account was set up with a temporary password, so please replace it with one only you know.
          </p>
          <Alert tone="info">Enter the temporary password as your current password.</Alert>
          <ChangePasswordForm submitLabel="Save my password" />
          <Button variant="ghost" icon={<LogOut size={16} />} onClick={logout}>
            Sign out
          </Button>
        </div>
      </main>
    </div>
  );
}

const CONTACTS = [
  ['phone', 'Phone', 'tel'],
  ['alt_phone', 'Other phone', 'tel'],
  ['contact_email', 'Contact email (other than your sign-in email)', 'email'],
  ['office', 'Office / location', 'text'],
  ['emergency_name', 'Emergency contact name', 'text'],
  ['emergency_phone', 'Emergency contact phone', 'tel'],
] as const;

/** Who corrects a person's name and position. */
const NAME_KEEPER: Record<string, string> = { hod: 'your Dean or the administrator', dean: 'the administrator', admin: 'another administrator', hr: 'the administrator' };

function ProfileDetails() {
  const { user, refresh } = useAuth();
  const { toast, fail } = useFeedback();
  const [form, setForm] = useState<Record<string, string>>(() =>
    Object.fromEntries([...CONTACTS.map(([k]) => k), 'address'].map((k) => [k, ((user as any)?.[k] as string) || ''])),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  if (!user) return null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('save');
    try {
      await api('/api/auth/me', { method: 'PUT', body: form });
      await refresh();
      toast('Contacts updated');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };
  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) return fail(new Error('Choose a photo smaller than 3 MB'));
    setBusy('photo');
    try {
      const data = new FormData();
      data.append('photo', file);
      await api('/api/auth/me/photo', { method: 'POST', form: data });
      await refresh();
      toast('Profile picture updated');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };
  const removePhoto = async () => {
    setBusy('photo');
    try {
      await api('/api/auth/me/photo', { method: 'DELETE' });
      await refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <div className="profile-head">
        <button type="button" className="profile-photo" onClick={() => fileRef.current?.click()} title="Change profile picture" disabled={busy === 'photo'}>
          <Avatar name={user.name} size={84} src={assetUrl(user.photo_url)} />
          <span className="profile-photo-edit">
            <Camera size={15} />
          </span>
        </button>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={upload} />
        <div className="grow">
          <h3 className="m0">
            {user.title ? `${user.title} ` : ''}
            {user.name}
          </h3>
          {user.designation && <div>{user.designation}</div>}
          <div className="muted">{user.email}</div>
          <div className="row gap-sm wrap" style={{ marginTop: 8 }}>
            <Button size="sm" variant="secondary" icon={<Camera size={14} />} loading={busy === 'photo'} onClick={() => fileRef.current?.click()}>
              {user.photo_url ? 'Change photo' : 'Add photo'}
            </Button>
            {user.photo_url && (
              <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={removePhoto}>
                Remove
              </Button>
            )}
          </div>
        </div>
      </div>
      <form onSubmit={save} className="form-grid" style={{ marginTop: 14 }}>
        <div className="span-2 field-label">Your contacts</div>
        {CONTACTS.map(([k, label, type]) => (
          <Field key={k} label={label}>
            <Input type={type} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
          </Field>
        ))}
        <Field label="Address" span={2}>
          <Textarea rows={2} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </Field>
        <div className="span-2">
          <Button type="submit" loading={busy === 'save'}>
            Save contacts
          </Button>
        </div>
      </form>
      <dl className="details">
        <dt>Name</dt>
        <dd>
          {user.title ? `${user.title} ` : ''}
          {user.name}
        </dd>
        {user.role !== 'student' && (
          <>
            <dt>Position</dt>
            <dd>{user.designation || '-'}</dd>
          </>
        )}
        <dt>Role</dt>
        <dd>
          {ROLE_LABELS[user.role]}
          {user.employment_type === 'part_time' ? ' · Part-time' : ''}
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
      <p className="muted small m0">
        Your name, title, position and status are updated by {NAME_KEEPER[user.role] || 'your HoD or Dean'}; your email, role and unit by your university administrator.
      </p>
    </Card>
  );
}

export default function Profile() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <>
      <PageHeader title="Profile" subtitle="Your profile picture, contacts and password." />
      <div className="grid-2 align-start">
        <ProfileDetails />
        <div className="stack">
          <Card title="Change password">
            <ChangePasswordForm />
          </Card>
          {user.role !== 'super_admin' && <DeleteAccount />}
        </div>
      </div>
    </>
  );
}
