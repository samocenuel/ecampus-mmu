import { FormEvent, useEffect, useState } from 'react';
import { Save, Trash2 } from 'lucide-react';
import { api, assetUrl } from '../../api';
import { useAuth } from '../../auth';
import { useFeedback } from '../../components/feedback';
import { Button, Card, Checkbox, Field, Input, PageHeader } from '../../components/ui';
import { DAY_NAMES } from '../../types';
import { ColourPicker, LogoPicker } from '../Register';

export default function UniversitySettings() {
  const { university, setUniversity } = useAuth();
  const { toast, fail } = useFeedback();
  const [form, setForm] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (university && !form) setForm({ ...university, lunch_start: university.lunch_start || '', lunch_end: university.lunch_end || '' });
  }, [university, form]);
  if (!form) return null;

  const set = (k: string) => ({ value: form[k] ?? '', onChange: (e: any) => setForm({ ...form, [k]: e.target.value }) });
  const toggleDay = (d: number, on: boolean) =>
    setForm({ ...form, teaching_days: on ? [...form.teaching_days, d].sort() : form.teaching_days.filter((x: number) => x !== d) });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { id, logo_url, logo_path, slug, active, created_at, ...body } = form;
      const updated = await api('/api/university', { method: 'PUT', body });
      setUniversity(updated);
      toast('University profile saved');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    try {
      const data = new FormData();
      data.append('logo', file);
      const updated = await api('/api/university/logo', { method: 'POST', form: data });
      setUniversity(updated);
      setForm((f: any) => ({ ...f, logo_url: updated.logo_url }));
      toast('Logo updated');
    } catch (err) {
      fail(err);
    } finally {
      setUploading(false);
    }
  };

  const removeLogo = async () => {
    try {
      const updated = await api('/api/university/logo', { method: 'DELETE' });
      setUniversity(updated);
      setForm((f: any) => ({ ...f, logo_url: null }));
    } catch (err) {
      fail(err);
    }
  };

  return (
    <form onSubmit={save}>
      <PageHeader
        title="University profile"
        subtitle="Name, contacts, branding and teaching hours used across the system, exports and the mobile app."
        actions={
          <Button type="submit" icon={<Save size={16} />} loading={busy}>
            Save changes
          </Button>
        }
      />
      <div className="grid-2 align-start">
        <Card title="Details">
          <div className="form-grid">
            <Field label="University name *" span={2}>
              <Input required {...set('name')} />
            </Field>
            <Field label="Short name">
              <Input {...set('short_name')} />
            </Field>
            <Field label="Timezone">
              <Input {...set('timezone')} />
            </Field>
            <Field label="Currency" help="3-letter code used for part-time pay, e.g. UGX, KES, USD.">
              <Input maxLength={3} {...set('currency')} />
            </Field>
            <Field label="Physical address" span={2}>
              <Input {...set('address')} />
            </Field>
            <Field label="Email">
              <Input type="email" {...set('email')} />
            </Field>
            <Field label="Phone">
              <Input type="tel" {...set('phone')} />
            </Field>
            <Field label="Website" span={2}>
              <Input type="url" {...set('website')} />
            </Field>
          </div>
        </Card>
        <div className="stack">
          <Card title="Branding">
            <Field label="Logo">
              <LogoPicker preview={assetUrl(form.logo_url)} onFile={upload} />
            </Field>
            {form.logo_url && (
              <Button type="button" variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={removeLogo} loading={uploading}>
                Remove logo
              </Button>
            )}
            <Field label="Primary theme colour" help="Applied to the web app, the mobile app and exported timetables.">
              <ColourPicker value={form.primary_color} onChange={(c) => setForm({ ...form, primary_color: c })} />
            </Field>
          </Card>
          <Card title="Teaching week">
            <div className="field-label">Teaching days</div>
            <div className="check-grid">
              {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                <Checkbox key={d} label={DAY_NAMES[d]} checked={form.teaching_days.includes(d)} onChange={(v) => toggleDay(d, v)} />
              ))}
            </div>
            <div className="form-grid">
              <Field label="Day starts">
                <Input type="time" {...set('day_start')} />
              </Field>
              <Field label="Day ends">
                <Input type="time" {...set('day_end')} />
              </Field>
              <Field label="Lunch break from" help="Leave empty for no break">
                <Input type="time" {...set('lunch_start')} />
              </Field>
              <Field label="Lunch break to">
                <Input type="time" {...set('lunch_end')} />
              </Field>
            </div>
          </Card>
          <Card title="Attendance and exam rules">
            <div className="form-grid">
              <Field label="Minimum attendance to sit exams (%)">
                <Input type="number" min={0} max={100} {...set('exam_min_attendance')} />
              </Field>
              <Field label="Minimum coursework to sit exams (%)" help="Of each programme's coursework total, e.g. 50% = 20/40">
                <Input type="number" min={0} max={100} {...set('coursework_min_percent')} />
              </Field>
              <Field label="Manual check-in marks per student per term" help="The HoD is told when a student passes it">
                <Input type="number" min={0} max={100} {...set('manual_mark_limit')} />
              </Field>
              <Field label="Correction requests accepted for (hours)">
                <Input type="number" min={1} max={720} {...set('correction_hours')} />
              </Field>
            </div>
            <Checkbox
              label="Part-time teaching claims only count lectures confirmed by student QR check-ins"
              checked={Boolean(form.claims_require_checkin)}
              onChange={(v) => setForm({ ...form, claims_require_checkin: v ? 1 : 0 })}
            />
          </Card>
        </div>
      </div>
    </form>
  );
}
