// Research supervision: Project (undergraduate), Dissertation (Master's) and Thesis (PhD) from
// concept to clearance.
import { FormEvent, ReactNode, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Award, CalendarPlus, Check, Download, FileText, FileUp, Plus, Trash2, Undo2, UserPlus, X } from 'lucide-react';
import { api, download } from '../api';
import { useAuth } from '../auth';
import { useFeedback } from '../components/feedback';
import { CalendarSync } from '../components/Lectures';
import { Alert, Badge, Button, Card, DataTable, EmptyState, ErrorNote, Field, IconButton, Input, Modal, PageHeader, Progress, Select, Spinner, Tabs, Textarea } from '../components/ui';
import { useFetch, usePersistentState } from '../hooks';

const niceDate = (d?: string | null) => (d ? new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const niceDateTime = (d?: string | null) => (d ? new Date(d.replace(' ', 'T') + (d.length > 16 || d.includes('Z') ? (d.includes('Z') ? '' : 'Z') : '')).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
/** Presentation and defence times are local times ("YYYY-MM-DD HH:MM"). */
const localWhen = (d?: string | null) => (d ? `${niceDate(d)}${d.length > 10 ? `, ${d.slice(11, 16)}` : ''}` : '');

const STEPS: [string, string][] = [
  ['concept', 'Concept'],
  ['presentation', 'Presentation'],
  ['supervision', 'Supervisors'],
  ['reports', 'Progress reports'],
  ['intent', 'Intent to submit'],
  ['final', 'Final submission'],
  ['defence', 'Defence'],
  ['cleared', 'Cleared'],
];
const STEP_OF: Record<string, number> = {
  concept_submitted: 0, concept_returned: 0, presentation_scheduled: 1, supervision: 2, in_progress: 3, intent_review: 4,
  intent_approved: 5, final_review: 5, final_approved: 6, defence_scheduled: 6, corrections: 6, corrections_review: 6, defended: 7, cleared: 8, rejected: -1,
};
const STATUS_TONE = (s: string): 'success' | 'danger' | 'warning' | 'info' => (s === 'cleared' ? 'success' : s === 'rejected' ? 'danger' : ['concept_returned', 'corrections'].includes(s) ? 'warning' : 'info');

type FieldKey = 'date' | 'venue' | 'panel' | 'note';
type ActionDef = { label: string; title: string; tone?: 'primary' | 'success' | 'danger' | 'secondary'; fields?: FieldKey[]; noteRequired?: boolean; noteLabel?: string; help?: string };
const ACTIONS: Record<string, ActionDef> = {
  schedule_presentation: { label: 'Schedule presentation', title: 'Schedule the concept presentation', fields: ['date', 'venue', 'note'], help: 'The student, coordinators and HoD get it in their calendar and are reminded before it.' },
  return_concept: { label: 'Return for revision', title: 'Return the concept for revision', tone: 'secondary', fields: ['note'], noteRequired: true, noteLabel: 'What should the student change?' },
  reject: { label: 'Not approve', title: 'Do not approve this concept', tone: 'danger', fields: ['note'], noteRequired: true, noteLabel: 'Reason' },
  presentation_passed: { label: 'Presentation passed', title: 'Approve the concept after the presentation', tone: 'success', fields: ['note'], help: 'Next, assign supervisors; the HoD then approves the work to start.' },
  presentation_revise: { label: 'Revise after presentation', title: 'Ask for a revised concept', tone: 'secondary', fields: ['note'], noteRequired: true, noteLabel: 'What should change?' },
  approve_start: { label: 'Approve to start', title: 'Approve the work to start', tone: 'success', fields: ['note'], help: 'The student can then submit progress reports.' },
  sign_intent: { label: 'Sign off intent', title: 'Sign off the intent to submit', tone: 'success', fields: ['note'] },
  return_intent: { label: 'Return: outputs not clear', title: 'Return the intent to submit', tone: 'secondary', fields: ['note'], noteRequired: true, noteLabel: 'Which outputs are not clear?' },
  sign_final: { label: 'Approve final submission', title: 'Approve the final submission', tone: 'success', fields: ['note'] },
  return_final: { label: 'Return final submission', title: 'Return the final submission', tone: 'secondary', fields: ['note'], noteRequired: true, noteLabel: 'What must change?' },
  schedule_defence: { label: 'Schedule defence', title: 'Schedule the defence', fields: ['date', 'venue', 'panel', 'note'], help: 'Everyone involved gets it in their calendar and is reminded before it.' },
  defence_passed: { label: 'Defence passed', title: 'Record that the defence was passed', tone: 'success', fields: ['note'] },
  defence_corrections: { label: 'Corrections required', title: 'Corrections required after the defence', tone: 'secondary', fields: ['note'], noteRequired: true, noteLabel: 'Corrections to make' },
  approve_corrections: { label: 'Accept corrections', title: 'Accept the corrections', tone: 'success', fields: ['note'] },
  return_corrections: { label: 'Return corrections', title: 'Return the corrections', tone: 'secondary', fields: ['note'], noteRequired: true, noteLabel: 'What is still missing?' },
  clear: { label: 'Approve and clear', title: 'Approve and clear the student', tone: 'success', fields: ['note'], help: 'The student gets a clearance certificate that can be verified by its QR code.' },
};
type UploadDef = { label: string; title: string; path: string; method?: 'POST' | 'PUT'; fileRequired?: boolean; summaryLabel: string; help?: string; withTitle?: boolean };
const UPLOADS = (kind: string): Record<string, UploadDef> => ({
  submit_report: { label: 'Submit progress report', title: 'Submit a progress report', path: 'reports', withTitle: true, summaryLabel: 'What you did, found and plan next', help: 'Your supervisor reviews it, then the HoD approves it.' },
  submit_intent: { label: 'Submit intent to submit', title: 'Intent to submit', path: 'intent', summaryLabel: 'The outputs you will submit (e.g. report, prototype, data, paper)', help: 'Your supervisor, the research coordinator and the HoD sign it off.' },
  submit_final: { label: `Submit final ${kind.toLowerCase()}`, title: `Submit your final ${kind.toLowerCase()}`, path: 'final', fileRequired: true, summaryLabel: 'Abstract or note', help: 'Approved by your supervisor, the research coordinator and the HoD; then the defence is scheduled.' },
  submit_corrections: { label: 'Submit corrections', title: 'Submit the corrected work', path: 'corrections', fileRequired: true, summaryLabel: 'What you corrected', help: 'Your supervisor checks the corrections.' },
});

// ------------------------------------------------------------------ Forms

function ConceptForm({ project, kind, onClose, onDone }: { project?: any; kind: string; onClose: () => void; onDone: (p: any) => void }) {
  const { fail } = useFeedback();
  const [form, setForm] = useState({ title: project?.title || '', problem: project?.problem || '', objectives: project?.objectives || '', methodology: project?.methodology || '' });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => ({ value: form[k], onChange: (e: any) => setForm({ ...form, [k]: e.target.value }) });
  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const data = new FormData();
      for (const [k, v] of Object.entries(form)) data.append(k, v);
      if (file) data.append('document', file);
      const p = await api<any>(project ? `/api/research/${project.id}/concept` : '/api/research', { method: project ? 'PUT' : 'POST', form: data });
      onDone(p);
      onClose();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open wide onClose={onClose} title={project ? 'Revise your concept' : `Submit your ${kind.toLowerCase()} concept`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="concept-form" loading={busy}>{project ? 'Resubmit concept' : 'Submit concept'}</Button></>}>
      <form id="concept-form" className="form-grid" onSubmit={send}>
        <Field label="Title *" span={2}>
          <Input required maxLength={300} {...set('title')} />
        </Field>
        <Field label="Problem statement *" span={2}>
          <Textarea required rows={4} {...set('problem')} />
        </Field>
        <Field label="Objectives *" span={2}>
          <Textarea required rows={3} {...set('objectives')} />
        </Field>
        <Field label="Methodology" span={2}>
          <Textarea rows={3} {...set('methodology')} />
        </Field>
        <Field label="Concept paper (PDF or Word, optional)" span={2}>
          <input type="file" accept=".pdf,.doc,.docx,.ppt,.pptx" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </Field>
      </form>
    </Modal>
  );
}

function ActionModal({ project, action, onClose, onDone }: { project: any; action: string; onClose: () => void; onDone: () => void }) {
  const { fail, toast } = useFeedback();
  const def = ACTIONS[action];
  const [form, setForm] = useState({ date: '', venue: '', panel: '', note: '' });
  const [busy, setBusy] = useState(false);
  const go = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/api/research/${project.id}/action`, { method: 'POST', body: { action, ...form, date: form.date.replace('T', ' ') } });
      toast(`${def.label}: done`);
      onDone();
      onClose();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  const has = (f: FieldKey) => def.fields?.includes(f);
  return (
    <Modal open onClose={onClose} title={def.title} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="research-action" loading={busy} variant={def.tone === 'danger' ? 'danger' : def.tone === 'success' ? 'success' : 'primary'}>{def.label}</Button></>}>
      <form id="research-action" className="stack" onSubmit={go}>
        <p className="muted m0">{project.student_name}: {project.title}</p>
        {def.help && <Alert tone="info">{def.help}</Alert>}
        {has('date') && (
          <Field label="Date and time *">
            <Input type="datetime-local" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </Field>
        )}
        {has('venue') && (
          <Field label="Venue">
            <Input value={form.venue} placeholder="e.g. Seminar Room A, or an online link" onChange={(e) => setForm({ ...form, venue: e.target.value })} />
          </Field>
        )}
        {has('panel') && (
          <Field label="Panel">
            <Textarea value={form.panel} placeholder="Examiners and chair" onChange={(e) => setForm({ ...form, panel: e.target.value })} />
          </Field>
        )}
        {has('note') && (
          <Field label={`${def.noteLabel || 'Note'}${def.noteRequired ? ' *' : ' (optional)'}`}>
            <Textarea required={def.noteRequired} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </Field>
        )}
      </form>
    </Modal>
  );
}

function UploadModal({ project, def, onClose, onDone }: { project: any; def: UploadDef; onClose: () => void; onDone: () => void }) {
  const { fail, toast } = useFeedback();
  const [title, setTitle] = useState(def.withTitle ? `Progress report ${project.approved_reports + 1}` : '');
  const [summary, setSummary] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async (e: FormEvent) => {
    e.preventDefault();
    if (def.fileRequired && !file) return fail(new Error('Attach the document'));
    setBusy(true);
    try {
      const data = new FormData();
      if (def.withTitle) data.append('title', title);
      data.append('summary', summary);
      if (file) data.append('document', file);
      await api(`/api/research/${project.id}/${def.path}`, { method: def.method || 'POST', form: data });
      toast('Submitted');
      onDone();
      onClose();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={def.title} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="research-upload" loading={busy}>{def.label}</Button></>}>
      <form id="research-upload" className="stack" onSubmit={go}>
        {def.help && <Alert tone="info">{def.help}</Alert>}
        {def.withTitle && (
          <Field label="Title *">
            <Input required value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
        )}
        <Field label={def.summaryLabel}>
          <Textarea rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} />
        </Field>
        <Field label={`Document (PDF or Word, up to 25 MB)${def.fileRequired ? ' *' : ''}`}>
          <input type="file" accept=".pdf,.doc,.docx,.ppt,.pptx" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </Field>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ List

function Coordinators() {
  const { user } = useAuth();
  const { fail, toast, confirm } = useFeedback();
  const { data, reload } = useFetch<any[]>('/api/research/coordinators');
  const { data: departments } = useFetch<any[]>('/api/departments');
  const { data: staff } = useFetch<any[]>('/api/users?roles=lecturer,hod,dean&active=1');
  const [form, setForm] = useState({ department_id: '', user_id: '' });
  const depts = (departments || []).filter((d) => user?.role === 'admin' || user?.role === 'dean' || d.hod_id === user?.id || d.id === user?.department_id);
  const dept = form.department_id || String(depts[0]?.id || '');
  const add = async () => {
    try {
      await api('/api/research/coordinators', { method: 'POST', body: { department_id: dept, user_id: form.user_id } });
      toast('Research coordinator appointed');
      setForm({ ...form, user_id: '' });
      reload();
    } catch (err) {
      fail(err);
    }
  };
  const remove = async (c: any) => {
    if (!(await confirm({ title: `Remove ${c.name}?`, message: 'They stop receiving the department\'s research concepts.', confirmLabel: 'Remove', tone: 'danger' }))) return;
    try {
      await api(`/api/research/coordinators/${c.id}`, { method: 'DELETE' });
      reload();
    } catch (err) {
      fail(err);
    }
  };
  return (
    <Card title="Research coordinators" padded={false}>
      <div className="pad-x muted small">Coordinators receive the department's concepts, schedule presentations and defences, and sign off intents and final submissions. Without one, the HoD does it.</div>
      <DataTable
        rows={data}
        empty="No research coordinators yet"
        columns={[
          { key: 'name', header: 'Coordinator', render: (c: any) => <><strong>{[c.title, c.name].filter(Boolean).join(' ')}</strong><div className="muted small">{c.email}</div></> },
          { key: 'department_name', header: 'Department' },
          { key: '_a', header: '', align: 'right', render: (c: any) => <IconButton label="Remove" className="danger" onClick={() => remove(c)}><Trash2 size={16} /></IconButton> },
        ]}
      />
      <div className="pad-x row gap-sm wrap" style={{ paddingBottom: 14 }}>
        {depts.length > 1 && <Select value={dept} onChange={(e) => setForm({ ...form, department_id: e.target.value })} options={depts.map((d) => ({ value: String(d.id), label: d.name }))} />}
        <Select value={form.user_id} placeholder="Choose a lecturer..." onChange={(e) => setForm({ ...form, user_id: e.target.value })} options={(staff || []).filter((s) => !dept || String(s.department_id) === dept).map((s) => ({ value: String(s.id), label: [s.title, s.name].filter(Boolean).join(' ') }))} />
        <Button icon={<UserPlus size={16} />} disabled={!form.user_id} onClick={add}>
          Appoint
        </Button>
      </div>
    </Card>
  );
}

function ProjectTable({ rows, loading, student }: { rows?: any[]; loading: boolean; student?: boolean }) {
  const navigate = useNavigate();
  return (
    <DataTable
      rows={rows}
      loading={loading}
      onRowClick={(p: any) => navigate(`/research/${p.id}`)}
      searchKeys={['title', 'student_name', 'student_identifier', 'program_code']}
      empty={student ? 'You have not started any research work yet' : 'Nothing here'}
      columns={[
        ...(student ? [] : [{ key: 'student_name', header: 'Student', render: (p: any) => <><strong>{p.student_name}</strong><div className="muted small">{p.student_identifier} · {p.program_code}</div></> }]),
        { key: 'title', header: 'Title', render: (p: any) => <><Badge>{p.kind_label}</Badge> {p.title}</> },
        { key: 'status', header: 'Stage', render: (p: any) => <><Badge tone={STATUS_TONE(p.status)}>{p.status_label}</Badge>{p.waiting_for && !['cleared', 'rejected'].includes(p.status) && <div className="muted small">Waiting for: {p.waiting_for}</div>}</> },
        { key: 'approved_reports', header: 'Reports', align: 'right', hideOnMobile: true, render: (p: any) => `${p.approved_reports}/${p.reports_required}` },
        { key: 'supervisors', header: 'Supervisors', hideOnMobile: true, render: (p: any) => p.supervisors.map((s: any) => s.name).join(', ') || <span className="muted">-</span> },
      ]}
    />
  );
}

type View = 'awaiting' | 'supervising' | 'all' | 'cleared' | 'coordinators';

export default function Research() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const isStudent = user?.role === 'student';
  const manages = ['admin', 'dean', 'hod'].includes(user?.role || '');
  const [view, setView] = usePersistentState<View>('lms_research_view', 'awaiting');
  const [starting, setStarting] = useState(false);
  const { data: eligibility } = useFetch<any>(isStudent ? '/api/research/eligibility' : null);
  const current = view === 'coordinators' && !manages ? 'awaiting' : view;
  const { data, loading, error } = useFetch<any[]>(current === 'coordinators' ? null : `/api/research?view=${isStudent ? 'mine' : current}`);
  const tabs: { value: View; label: string }[] = [
    { value: 'awaiting', label: 'Awaiting me' },
    { value: 'supervising', label: 'I supervise' },
    { value: 'all', label: 'All' },
    { value: 'cleared', label: 'Cleared' },
    ...(manages ? [{ value: 'coordinators' as View, label: 'Coordinators' }] : []),
  ];

  return (
    <>
      <PageHeader
        title="Research"
        subtitle={isStudent ? 'Your project, dissertation or thesis: from concept and supervision to defence and clearance.' : 'Project (undergraduate), Dissertation (Master\'s) and Thesis (PhD): concepts, supervision, progress reports, sign-offs and defences.'}
        actions={isStudent && eligibility?.eligible && <Button icon={<Plus size={16} />} onClick={() => setStarting(true)}>Start your {eligibility.kind_label.toLowerCase()}</Button>}
      />
      <ErrorNote error={error} />
      {isStudent && eligibility && !eligibility.eligible && !data?.length && <Alert tone="info">{eligibility.reason}</Alert>}
      {isStudent && eligibility?.eligible && (
        <Alert tone="info" title={`Your ${eligibility.kind_label.toLowerCase()}`}>
          Submit a concept to {eligibility.coordinators?.length ? eligibility.coordinators.map((c: any) => [c.title, c.name].filter(Boolean).join(' ')).join(', ') : 'your department\'s research coordinator'}. After the presentation, supervisors are assigned; then you submit {eligibility.reports_required} progress report{eligibility.reports_required === 1 ? '' : 's'}, your intent to submit, the final work and defend it.
        </Alert>
      )}
      {!isStudent && <Tabs value={current} onChange={setView} tabs={tabs} />}
      {current === 'coordinators' && !isStudent ? (
        <Coordinators />
      ) : (
        <Card padded={false}>
          <ProjectTable rows={data ?? undefined} loading={loading} student={isStudent} />
        </Card>
      )}
      {starting && eligibility && <ConceptForm kind={eligibility.kind_label} onClose={() => setStarting(false)} onDone={(p) => navigate(`/research/${p.id}`)} />}
    </>
  );
}

// ------------------------------------------------------------------ Detail

function People({ project, reload }: { project: any; reload: () => void }) {
  const { fail, toast } = useFeedback();
  const { data: staff } = useFetch<any[]>(project.actions.includes('assign_supervisor') ? '/api/users?roles=lecturer,hod,dean&active=1' : null);
  const [sup, setSup] = useState({ user_id: '', role: 'main' });
  const [mentor, setMentor] = useState<any>(null);
  const call = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
      reload();
    } catch (err) {
      fail(err);
    }
  };
  return (
    <Card title="People">
      <div className="stack">
        <div>
          <div className="field-label">Supervisors</div>
          {project.supervisors.length === 0 && <div className="muted small">Not assigned yet</div>}
          <ul className="name-list">
            {project.supervisors.map((s: any) => (
              <li key={s.id}>
                {[s.title, s.name].filter(Boolean).join(' ')} <Badge>{s.role === 'main' ? 'Main' : 'Co-supervisor'}</Badge>
                {project.actions.includes('assign_supervisor') && (
                  <IconButton label="Remove" onClick={() => call(() => api(`/api/research/${project.id}/supervisors/${s.id}`, { method: 'DELETE' }), 'Supervisor removed')}>
                    <X size={14} />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
          {project.actions.includes('assign_supervisor') && (
            <div className="row gap-sm wrap">
              <Select value={sup.user_id} placeholder="Choose a lecturer..." onChange={(e) => setSup({ ...sup, user_id: e.target.value })} options={(staff || []).map((s) => ({ value: String(s.id), label: `${[s.title, s.name].filter(Boolean).join(' ')}${s.department_name ? ` (${s.department_name})` : ''}` }))} />
              <Select value={sup.role} onChange={(e) => setSup({ ...sup, role: e.target.value })} options={[{ value: 'main', label: 'Main supervisor' }, { value: 'co', label: 'Co-supervisor' }]} />
              <Button size="sm" icon={<UserPlus size={14} />} disabled={!sup.user_id} onClick={() => call(() => api(`/api/research/${project.id}/supervisors`, { method: 'POST', body: sup }), 'Supervisor assigned')}>
                Assign
              </Button>
            </div>
          )}
        </div>
        <div>
          <div className="field-label">Mentors</div>
          {project.mentors.length === 0 && <div className="muted small">None proposed</div>}
          <ul className="name-list">
            {project.mentors.map((m: any) => (
              <li key={m.id}>
                {m.name}
                {m.institution ? <span className="muted small"> · {m.institution}</span> : null} <Badge tone={m.status === 'confirmed' ? 'success' : m.status === 'declined' ? 'danger' : 'warning'}>{m.status}</Badge>
                {m.status === 'proposed' && project.actions.includes('decide_mentor') && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => call(() => api(`/api/research/${project.id}/mentors/${m.id}/decision`, { method: 'POST', body: { decision: 'confirm' } }), 'Mentor confirmed')}>Confirm</Button>
                    <Button size="sm" variant="ghost" onClick={() => call(() => api(`/api/research/${project.id}/mentors/${m.id}/decision`, { method: 'POST', body: { decision: 'decline' } }), 'Mentor declined')}>Decline</Button>
                  </>
                )}
              </li>
            ))}
          </ul>
          {project.actions.includes('propose_mentor') && (
            <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={() => setMentor({ name: '', institution: '', email: '', phone: '' })}>
              Propose a mentor
            </Button>
          )}
        </div>
        <div>
          <div className="field-label">Research coordinators</div>
          <div className="small">{project.coordinators.map((c: any) => [c.title, c.name].filter(Boolean).join(' ')).join(', ') || 'The HoD (no coordinator appointed)'}</div>
        </div>
      </div>
      {mentor && (
        <Modal
          open
          onClose={() => setMentor(null)}
          title="Propose a mentor"
          footer={<><Button variant="secondary" onClick={() => setMentor(null)}>Cancel</Button><Button disabled={!mentor.name.trim()} onClick={() => call(() => api(`/api/research/${project.id}/mentors`, { method: 'POST', body: mentor }), 'Mentor proposed; the coordinator will confirm').then(() => setMentor(null))}>Propose</Button></>}
        >
          <p className="muted m0">A mentor guides you alongside your supervisors, for example from industry or another institution. The research coordinator confirms them.</p>
          <div className="form-grid">
            {(['name', 'institution', 'email', 'phone'] as const).map((k) => (
              <Field key={k} label={`${k[0].toUpperCase()}${k.slice(1)}${k === 'name' ? ' *' : ''}`}>
                <Input value={mentor[k]} onChange={(e) => setMentor({ ...mentor, [k]: e.target.value })} />
              </Field>
            ))}
          </div>
        </Modal>
      )}
    </Card>
  );
}

function Reports({ project, reload }: { project: any; reload: () => void }) {
  const { fail, toast } = useFeedback();
  const [reviewing, setReviewing] = useState<{ r: any; action: 'approve' | 'return' } | null>(null);
  const [note, setNote] = useState('');
  const review = async () => {
    try {
      await api(`/api/research/reports/${reviewing!.r.id}/review`, { method: 'POST', body: { action: reviewing!.action, note } });
      toast(reviewing!.action === 'approve' ? 'Report approved' : 'Report returned');
      setReviewing(null);
      setNote('');
      reload();
    } catch (err) {
      fail(err);
    }
  };
  const LABEL: Record<string, string> = { submitted: 'With supervisor', supervisor_approved: 'With HoD', approved: 'Approved', returned: 'Returned' };
  return (
    <Card title={<span className="row gap-sm">Progress reports <Badge tone={project.approved_reports >= project.reports_required ? 'success' : 'info'}>{project.approved_reports}/{project.reports_required} approved</Badge></span>} padded={false}>
      <div className="pad-x">
        <Progress value={project.approved_reports} total={Math.max(project.reports_required, 1)} />
      </div>
      <DataTable
        rows={project.reports}
        empty="No progress reports yet"
        columns={[
          { key: 'number', header: '#', width: '40px' },
          { key: 'title', header: 'Report', render: (r: any) => <><strong>{r.title}</strong>{r.summary && <div className="muted small">{r.summary}</div>}{(r.supervisor_note || r.hod_note) && <div className="small">Note: {r.hod_note || r.supervisor_note}</div>}</> },
          { key: 'status', header: 'Status', render: (r: any) => <><Badge tone={r.status === 'approved' ? 'success' : r.status === 'returned' ? 'danger' : 'warning'}>{LABEL[r.status]}</Badge><div className="muted small">{niceDate(r.created_at)}</div></> },
          {
            key: '_a',
            header: '',
            align: 'right',
            render: (r: any) => (
              <div className="row-actions">
                {r.document_id && (
                  <IconButton label="Download" onClick={() => download(`/api/research/documents/${r.document_id}`, `${r.title}.pdf`)}>
                    <Download size={16} />
                  </IconButton>
                )}
                {project.actions.includes('review_report') && ['submitted', 'supervisor_approved'].includes(r.status) && (
                  <>
                    <Button size="sm" variant="success" onClick={() => setReviewing({ r, action: 'approve' })}>Approve</Button>
                    <Button size="sm" variant="ghost" onClick={() => setReviewing({ r, action: 'return' })}>Return</Button>
                  </>
                )}
              </div>
            ),
          },
        ]}
      />
      {reviewing && (
        <Modal
          open
          onClose={() => setReviewing(null)}
          title={`${reviewing.action === 'approve' ? 'Approve' : 'Return'} progress report ${reviewing.r.number}`}
          footer={<><Button variant="secondary" onClick={() => setReviewing(null)}>Cancel</Button><Button variant={reviewing.action === 'approve' ? 'success' : 'danger'} disabled={reviewing.action === 'return' && !note.trim()} onClick={review}>{reviewing.action === 'approve' ? 'Approve' : 'Return'}</Button></>}
        >
          <Field label={reviewing.action === 'return' ? 'What should the student change? *' : 'Comment (optional)'}>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </Modal>
      )}
    </Card>
  );
}

const EVENT_TEXT: Record<string, string> = {
  submitted: 'submitted', resubmitted: 'resubmitted', approved: 'approved', returned: 'returned', rejected: 'did not approve', passed: 'passed',
  signed: 'signed off', scheduled: 'scheduled', assigned: 'assigned', removed: 'removed', proposed: 'proposed', confirmed: 'confirmed', declined: 'declined',
  corrections: 'asked for corrections', cleared: 'approved and cleared',
};

export function ResearchDetail() {
  const { id } = useParams();
  const { fail } = useFeedback();
  const { data: p, loading, error, reload } = useFetch<any>(`/api/research/${id}`);
  const [action, setAction] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [revising, setRevising] = useState(false);
  const [sync, setSync] = useState(false);

  if (loading && !p) return <Spinner />;
  if (error) return <ErrorNote error={error} />;
  if (!p) return null;
  const step = STEP_OF[p.status] ?? 0;
  const uploads = UPLOADS(p.kind_label);
  const stageButtons: ReactNode[] = [];
  for (const a of p.actions as string[]) {
    if (ACTIONS[a]) stageButtons.push(<Button key={a} variant={ACTIONS[a].tone === 'danger' ? 'danger' : ACTIONS[a].tone === 'secondary' ? 'secondary' : ACTIONS[a].tone === 'success' ? 'success' : 'primary'} icon={ACTIONS[a].tone === 'secondary' ? <Undo2 size={16} /> : <Check size={16} />} onClick={() => setAction(a)}>{ACTIONS[a].label}</Button>);
    else if (uploads[a]) stageButtons.push(<Button key={a} icon={<FileUp size={16} />} onClick={() => setUploading(a)}>{uploads[a].label}</Button>);
    else if (a === 'resubmit_concept') stageButtons.push(<Button key={a} icon={<FileUp size={16} />} onClick={() => setRevising(true)}>Revise and resubmit concept</Button>);
  }

  return (
    <>
      <Link to="/research" className="back-link no-print">
        <ArrowLeft size={16} /> Research
      </Link>
      <PageHeader
        title={<>{p.title} <Badge tone={STATUS_TONE(p.status)}>{p.status_label}</Badge></>}
        subtitle={`${p.kind_label} · ${p.student_name}${p.student_identifier ? ` (${p.student_identifier})` : ''} · ${p.program_code || ''} · ${p.department_name || ''}`}
        actions={
          <div className="page-actions">
            {p.status === 'cleared' && (
              <Button icon={<Award size={16} />} onClick={() => download(`/api/research/${p.id}/certificate`, `clearance-${p.id}.pdf`).catch(fail)}>
                Clearance certificate
              </Button>
            )}
            <Button variant="secondary" icon={<CalendarPlus size={16} />} onClick={() => setSync(true)}>
              Calendar sync
            </Button>
          </div>
        }
      />
      {p.status !== 'rejected' && (
        <ol className="stepper claim-steps">
          {STEPS.map(([key, label], i) => (
            <li key={key} className={i < step ? 'done' : i === step ? 'current' : ''}>
              <span>{i < step ? <Check size={13} /> : i + 1}</span>
              {label}
            </li>
          ))}
        </ol>
      )}
      <div className="stack">
        {p.status === 'rejected' && <Alert tone="danger" title="Not approved">{p.outcome_note}</Alert>}
        {p.waiting_for && !['cleared', 'rejected'].includes(p.status) && (
          <Alert tone={stageButtons.length ? 'warning' : 'info'} title={stageButtons.length ? 'Your step' : `Waiting for: ${p.waiting_for}`} action={stageButtons.length ? <div className="row gap-sm wrap">{stageButtons}</div> : undefined}>
            {p.status_label}
            {p.next_signer ? `. Next to sign off: ${p.waiting_for}.` : '.'}
          </Alert>
        )}
        {p.status === 'cleared' && p.verify_code && (
          <Alert tone="success" title="Approved and cleared">
            Verification code <strong>{p.verify_code}</strong>. <a href={p.verify_url} target="_blank" rel="noreferrer">Check it on the verification page</a>.
          </Alert>
        )}
        {(p.calendar?.presentation || p.calendar?.defence) && (
          <Card title="Coming up">
            <div className="stack">
              {p.calendar.presentation && (
                <div className="row between wrap gap-sm">
                  <div><strong>Concept presentation</strong><div className="muted small">{localWhen(p.presentation_at)}{p.presentation_venue ? ` · ${p.presentation_venue}` : ''}</div></div>
                  <a className="btn btn-sm btn-secondary" href={p.calendar.presentation} target="_blank" rel="noreferrer"><CalendarPlus size={14} /> Add to Google Calendar</a>
                </div>
              )}
              {p.calendar.defence && (
                <div className="row between wrap gap-sm">
                  <div><strong>Defence</strong><div className="muted small">{localWhen(p.defence_at)}{p.defence_venue ? ` · ${p.defence_venue}` : ''}{p.defence_panel ? ` · Panel: ${p.defence_panel}` : ''}</div></div>
                  <a className="btn btn-sm btn-secondary" href={p.calendar.defence} target="_blank" rel="noreferrer"><CalendarPlus size={14} /> Add to Google Calendar</a>
                </div>
              )}
              <p className="muted small m0">Presentations and defences are also in your calendar subscription (Calendar sync), and eCampus reminds you before them. Change reminder times under Notifications.</p>
            </div>
          </Card>
        )}
        <div className="grid-2 align-start">
          <div className="stack">
            <Card title="Concept">
              <dl className="details">
                <dt>Problem</dt>
                <dd>{p.problem}</dd>
                <dt>Objectives</dt>
                <dd>{p.objectives}</dd>
                {p.methodology && (
                  <>
                    <dt>Methodology</dt>
                    <dd>{p.methodology}</dd>
                  </>
                )}
                <dt>Submitted</dt>
                <dd>{niceDateTime(p.submitted_at)}</dd>
              </dl>
            </Card>
            {step >= 3 && <Reports project={p} reload={reload} />}
            <Card title="Documents" padded={false}>
              <DataTable
                rows={p.documents}
                empty="No documents yet"
                columns={[
                  { key: 'original_name', header: 'File', render: (d: any) => <><FileText size={14} /> {d.original_name}<div className="muted small">{d.stage} · {d.uploaded_by_name} · {niceDateTime(d.created_at)}</div></> },
                  { key: '_d', header: '', align: 'right', render: (d: any) => <IconButton label="Download" onClick={() => download(`/api/research/documents/${d.id}`, d.original_name).catch(fail)}><Download size={16} /></IconButton> },
                ]}
              />
            </Card>
          </div>
          <div className="stack">
            <People project={p} reload={reload} />
            <Card title="History and digital signatures">
              <ol className="timeline">
                {p.events.map((e: any) => (
                  <li key={e.id} className={e.action === 'returned' || e.action === 'rejected' ? 'tl-returned' : e.footprint ? 'tl-verified' : ''}>
                    <strong>
                      {e.actor_name || 'eCampus'} {EVENT_TEXT[e.action] || e.action} · {e.stage}
                      {e.step ? ` (${e.step === 'hod' ? 'HoD' : e.step})` : ''}
                    </strong>
                    {e.note && <span className="small">{e.note}</span>}
                    <span className="muted small">
                      {niceDateTime(e.created_at)}
                      {e.footprint && <> · <code className="footprint">{e.footprint}</code></>}
                    </span>
                  </li>
                ))}
              </ol>
            </Card>
          </div>
        </div>
      </div>
      {action && <ActionModal project={p} action={action} onClose={() => setAction(null)} onDone={reload} />}
      {uploading && <UploadModal project={p} def={uploads[uploading]} onClose={() => setUploading(null)} onDone={reload} />}
      {revising && <ConceptForm project={p} kind={p.kind_label} onClose={() => setRevising(false)} onDone={reload} />}
      {sync && <CalendarSync onClose={() => setSync(false)} />}
    </>
  );
}
