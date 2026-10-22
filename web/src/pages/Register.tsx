import { FormEvent, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, ImagePlus } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Button, ErrorNote, Field, Input } from '../components/ui';
import { mix, PRESET_COLOURS } from '../theme';
import { AuthAside } from './Login';

const STEPS = ['University', 'Branding', 'Administrator'];

export function ColourPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="colour-picker">
      <div className="swatches">
        {PRESET_COLOURS.map((c) => (
          <button type="button" key={c} className={`swatch ${value.toUpperCase() === c ? 'selected' : ''}`} style={{ background: c }} onClick={() => onChange(c)} aria-label={`Use colour ${c}`}>
            {value.toUpperCase() === c && <Check size={14} color="#fff" />}
          </button>
        ))}
      </div>
      <div className="row gap-sm">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} aria-label="Custom colour" className="colour-input" />
        <Input value={value} onChange={(e) => onChange(e.target.value)} maxLength={7} style={{ width: 110 }} aria-label="Hex colour" />
      </div>
    </div>
  );
}

export function LogoPicker({ preview, onFile }: { preview: string | null; onFile: (f: File | null) => void }) {
  return (
    <label className="logo-picker">
      {preview ? <img src={preview} alt="Logo preview" /> : <ImagePlus size={28} />}
      <span>{preview ? 'Change logo' : 'Upload logo (PNG, JPG or WebP, max 2 MB)'}</span>
      <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => onFile(e.target.files?.[0] || null)} hidden />
    </label>
  );
}

export default function Register() {
  const { acceptSession, setUniversity } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [logo, setLogo] = useState<File | null>(null);
  const zones = useMemo(() => {
    try {
      return (Intl as any).supportedValuesOf('timeZone') as string[];
    } catch {
      return ['Africa/Kampala', 'Africa/Nairobi', 'Africa/Lagos', 'UTC'];
    }
  }, []);
  const [uni, setUni] = useState({
    name: '',
    short_name: '',
    address: '',
    email: '',
    phone: '',
    website: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Kampala',
    primary_color: '#1E5AA8',
  });
  const [admin, setAdmin] = useState({ name: '', email: '', password: '', confirm: '' });
  const preview = useMemo(() => (logo ? URL.createObjectURL(logo) : null), [logo]);

  const next = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (step === 1 && !logo) return setError("Upload your institution's logo: it appears on timetables, requisitions and the app");
    if (step === 1 && logo && logo.size > 2 * 1024 * 1024) return setError('The logo must be smaller than 2 MB');
    if (step === 1 && !/^#[0-9a-f]{6}$/i.test(uni.primary_color)) return setError('Enter a colour like #1E5AA8');
    if (step < 2) return setStep(step + 1);
    submit();
  };

  const submit = async () => {
    if (admin.password !== admin.confirm) return setError('Passwords do not match');
    setBusy(true);
    try {
      const { confirm: _c, ...adminBody } = admin;
      const session = await api('/api/auth/register-university', { method: 'POST', body: { university: uni, admin: adminBody } });
      acceptSession(session);
      if (logo) {
        const form = new FormData();
        form.append('logo', logo);
        try {
          setUniversity(await api('/api/university/logo', { method: 'POST', form }));
        } catch {
          // The university exists; send the administrator to upload the logo again.
          navigate('/setup/university', { replace: true });
          return;
        }
      }
      navigate('/', { replace: true });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const u = (k: keyof typeof uni) => ({ value: uni[k], onChange: (e: any) => setUni({ ...uni, [k]: e.target.value }) });
  const a = (k: keyof typeof admin) => ({ value: admin[k], onChange: (e: any) => setAdmin({ ...admin, [k]: e.target.value }) });

  return (
    <div className="auth">
      <AuthAside />
      <main className="auth-main">
        <form className="auth-card wide" onSubmit={next}>
          <h1>Create your university</h1>
          <p className="muted">Set up your institution's workspace. You'll become its first administrator.</p>
          <ol className="stepper">
            {STEPS.map((s, i) => (
              <li key={s} className={i === step ? 'current' : i < step ? 'done' : ''}>
                <span>{i < step ? <Check size={14} /> : i + 1}</span>
                {s}
              </li>
            ))}
          </ol>
          <ErrorNote error={error} />

          {step === 0 && (
            <div className="form-grid">
              <Field label="University name *" span={2}>
                <Input required {...u('name')} placeholder="e.g. Mountains of the Moon University" autoFocus />
              </Field>
              <Field label="Short name">
                <Input {...u('short_name')} placeholder="e.g. MMU" />
              </Field>
              <Field label="Timezone">
                <Input list="tz-list" {...u('timezone')} />
                <datalist id="tz-list">
                  {zones.map((z) => (
                    <option key={z} value={z} />
                  ))}
                </datalist>
              </Field>
              <Field label="Physical address" span={2}>
                <Input {...u('address')} placeholder="Street, town, country" />
              </Field>
              <Field label="Contact email">
                <Input type="email" {...u('email')} />
              </Field>
              <Field label="Phone">
                <Input type="tel" {...u('phone')} />
              </Field>
              <Field label="Website" span={2}>
                <Input type="url" {...u('website')} placeholder="https://" />
              </Field>
            </div>
          )}

          {step === 1 && (
            <div className="branding">
              <div>
                <Field label="Institution logo *" help="Shown on the sign-in screen, timetables, exports, requisition forms and the app.">
                  <LogoPicker preview={preview} onFile={setLogo} />
                </Field>
                <Field label="Primary theme colour">
                  <ColourPicker value={uni.primary_color} onChange={(c) => setUni({ ...uni, primary_color: c })} />
                </Field>
              </div>
              <div className="brand-preview" style={{ ['--p' as any]: uni.primary_color, ['--ps' as any]: mix(uni.primary_color, 255, 0.88) }}>
                <div className="bp-side">
                  <div className="bp-brand">
                    {preview ? <img src={preview} alt="" /> : <span>{(uni.short_name || uni.name || 'U').slice(0, 3).toUpperCase()}</span>}
                    <strong>{uni.name || 'Your university'}</strong>
                  </div>
                  <div className="bp-item active">Dashboard</div>
                  <div className="bp-item">Timetable</div>
                  <div className="bp-item">Attendance</div>
                </div>
                <div className="bp-main">
                  <div className="bp-title">Preview</div>
                  <div className="bp-btn">Primary button</div>
                  <div className="bp-chip">Badge</div>
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="form-grid">
              <Field label="Your full name *" span={2}>
                <Input required {...a('name')} autoFocus />
              </Field>
              <Field label="Email *" span={2}>
                <Input type="email" required autoComplete="username" {...a('email')} />
              </Field>
              <Field label="Password *" help="At least 8 characters">
                <Input type="password" required minLength={8} autoComplete="new-password" {...a('password')} />
              </Field>
              <Field label="Confirm password *">
                <Input type="password" required minLength={8} autoComplete="new-password" {...a('confirm')} />
              </Field>
            </div>
          )}

          <div className="row between">
            {step > 0 ? (
              <Button type="button" variant="secondary" icon={<ArrowLeft size={16} />} onClick={() => setStep(step - 1)}>
                Back
              </Button>
            ) : (
              <Link to="/login" className="muted small">
                Already registered? Sign in
              </Link>
            )}
            <Button type="submit" loading={busy} icon={step < 2 ? <ArrowRight size={16} /> : <Check size={16} />}>
              {step < 2 ? 'Continue' : 'Create university'}
            </Button>
          </div>
        </form>
      </main>
    </div>
  );
}
