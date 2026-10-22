// Research supervision: projects (undergraduate), dissertations (Master's) and theses (PhD) from
// concept to clearance. See services/research.js for the stages and who acts at each.
import fs from 'node:fs';
import { Router } from 'express';
import multer from 'multer';
import { insert, q, tx } from '../db.js';
import { canManageDepartment, managedDepartmentIds, placeholders } from '../scope.js';
import { notify } from '../services/notify.js';
import { researchCertificatePdf } from '../services/exporter.js';
import { publicBase } from '../services/requisition.js';
import {
  actorsFor, canActAs, certificateSignOffs, CLOSED, DOC_EXT, documentPath, ensureVerifyCode, event, eventsOf,
  KIND_LABEL, kindForLevel, nextSigner, projectSelect, relationOf, removeUpload, requireStatus, researchDir, saveDocument,
  STATUS_LABEL, STEP_LABEL, supervisorIds, tell, EVENT_MINUTES, googleCalendarLink,
} from '../services/research.js';
import { localToUtc } from '../services/occurrences.js';
import { badRequest, forbidden, notFound, requireFields, slugify, toInt } from '../util.js';

const router = Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(researchDir(), { recursive: true });
      cb(null, researchDir());
    },
    filename: (req, file, cb) => cb(null, `r${req.user.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${DOC_EXT[file.mimetype]}`),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => (DOC_EXT[file.mimetype] ? cb(null, true) : cb(badRequest('Upload a PDF, Word or PowerPoint file'))),
});

const text = (v, max = 4000) => String(v || '').trim().slice(0, max);
const TEACHING = ['lecturer', 'hod', 'dean'];

function loadProject(req, id = req.params.id) {
  const p = q.get(`${projectSelect} WHERE rp.id = ? AND rp.university_id = ?`, toInt(id), req.uid);
  if (!p || !relationOf(req.user, p).length) throw notFound('Research project');
  return p;
}

const fresh = (id) => q.get(`${projectSelect} WHERE rp.id = ?`, id);
const approvedReports = (id) => q.get("SELECT COUNT(*) AS n FROM research_reports WHERE project_id = ? AND status = 'approved'", id).n;
const pendingReport = (id) => q.get("SELECT * FROM research_reports WHERE project_id = ? AND status IN ('submitted', 'supervisor_approved') ORDER BY id DESC LIMIT 1", id);
const nameOf = (id) => q.get('SELECT name FROM users WHERE id = ?', id)?.name || '';

/** What the user can do on the project right now, for the screens. */
function actionsFor(user, p) {
  const a = [];
  const student = user.id === p.student_id;
  const coord = canActAs(user, p, 'coordinator');
  const hod = canActAs(user, p, 'hod');
  const supervisor = canActAs(user, p, 'supervisor');
  switch (p.status) {
    case 'concept_submitted':
      if (coord) a.push('schedule_presentation', 'return_concept', 'reject');
      break;
    case 'concept_returned':
      if (student) a.push('resubmit_concept');
      break;
    case 'presentation_scheduled':
      if (coord) a.push('presentation_passed', 'presentation_revise', 'schedule_presentation', 'reject');
      break;
    case 'supervision':
      if (hod) a.push('approve_start');
      break;
    case 'in_progress': {
      if (student && !pendingReport(p.id)) a.push('submit_report');
      if (student && approvedReports(p.id) >= p.reports_required && !pendingReport(p.id)) a.push('submit_intent');
      const r = pendingReport(p.id);
      if (r && ((r.status === 'submitted' && supervisor) || (r.status === 'supervisor_approved' && hod))) a.push('review_report');
      break;
    }
    case 'intent_review':
    case 'final_review': {
      const stage = p.status === 'intent_review' ? 'intent' : 'final';
      const step = nextSigner(p.id, stage);
      if (step && canActAs(user, p, step)) a.push(`sign_${stage}`, `return_${stage}`);
      break;
    }
    case 'intent_approved':
      if (student) a.push('submit_final');
      break;
    case 'final_approved':
      if (coord) a.push('schedule_defence');
      break;
    case 'defence_scheduled':
      if (coord) a.push('defence_passed', 'defence_corrections', 'schedule_defence');
      break;
    case 'corrections':
      if (student) a.push('submit_corrections');
      break;
    case 'corrections_review':
      if (supervisor) a.push('approve_corrections', 'return_corrections');
      break;
    case 'defended':
      if (hod) a.push('clear');
      break;
    default:
  }
  if (!CLOSED.includes(p.status)) {
    if (coord && !['concept_submitted', 'concept_returned'].includes(p.status)) a.push('assign_supervisor');
    if (coord && q.get("SELECT 1 FROM research_mentors WHERE project_id = ? AND status = 'proposed'", p.id)) a.push('decide_mentor');
    if (student && !['concept_submitted', 'concept_returned', 'presentation_scheduled'].includes(p.status)) a.push('propose_mentor');
  }
  return a;
}

/** Who acts next, in words, for lists. */
function waitingFor(p) {
  const steps = {
    concept_submitted: 'coordinator', presentation_scheduled: 'coordinator', supervision: 'hod', final_approved: 'coordinator',
    defence_scheduled: 'coordinator', corrections_review: 'supervisor', defended: 'hod',
  };
  if (p.status === 'intent_review' || p.status === 'final_review') {
    const step = nextSigner(p.id, p.status === 'intent_review' ? 'intent' : 'final');
    return step ? STEP_LABEL[step] : null;
  }
  if (p.status === 'in_progress') {
    const r = pendingReport(p.id);
    if (r) return r.status === 'submitted' ? 'Supervisor (progress report)' : 'Head of Department (progress report)';
    return 'Student';
  }
  if (['concept_returned', 'intent_approved', 'corrections'].includes(p.status)) return 'Student';
  return steps[p.status] ? STEP_LABEL[steps[p.status]] : null;
}

function summarise(user, p) {
  const supervisors = q.all('SELECT u.id, u.name, u.title, rs.role FROM research_supervisors rs JOIN users u ON u.id = rs.user_id WHERE rs.project_id = ? ORDER BY rs.role, u.name', p.id);
  return {
    ...p,
    kind_label: KIND_LABEL[p.kind],
    status_label: STATUS_LABEL[p.status] || p.status,
    supervisors,
    approved_reports: approvedReports(p.id),
    waiting_for: waitingFor(p),
    relation: relationOf(user, p),
    actions: actionsFor(user, p),
  };
}

// ------------------------------------------------------------------ Starting

/** Whether the student may start research work now, and what it is called for their programme. */
function eligibility(user) {
  if (user.role !== 'student' || !user.class_id) return { eligible: false, reason: 'Only students start research work.' };
  const c = q.get(
    `SELECT c.year_of_study, p.id AS program_id, p.code, p.name, p.level, p.department_id, p.research_enabled, p.research_year, p.research_reports
       FROM classes c JOIN programs p ON p.id = c.program_id WHERE c.id = ?`,
    user.class_id,
  );
  const kind = kindForLevel(c?.level);
  const base = { kind, kind_label: KIND_LABEL[kind], program: c && { id: c.program_id, code: c.code, name: c.name }, reports_required: c?.research_reports ?? 3 };
  if (!c?.research_enabled) return { ...base, eligible: false, reason: `Research is not open for ${c?.code || 'your programme'} yet. Your HoD turns it on.` };
  if (c.research_year && c.year_of_study < c.research_year) return { ...base, eligible: false, reason: `Research starts in Year ${c.research_year} of ${c.code}.` };
  const active = q.get(`SELECT id FROM research_projects WHERE student_id = ? AND status NOT IN (${placeholders(CLOSED)})`, user.id, ...CLOSED);
  if (active) return { ...base, eligible: false, active_id: active.id, reason: `You already have a ${KIND_LABEL[kind].toLowerCase()} in progress.` };
  const coordinators = q.all('SELECT u.name, u.title FROM research_coordinators rc JOIN users u ON u.id = rc.user_id WHERE rc.department_id = ?', c.department_id);
  return { ...base, eligible: true, department_id: c.department_id, coordinators };
}

router.get('/eligibility', (req, res) => res.json(eligibility(req.user)));

router.post('/', upload.single('document'), (req, res) => {
  try {
    const e = eligibility(req.user);
    if (!e.eligible) throw badRequest(e.reason);
    requireFields(req.body, ['title', 'problem', 'objectives']);
    const id = tx(() => {
      const pid = insert('research_projects', {
        university_id: req.uid,
        student_id: req.user.id,
        program_id: e.program.id,
        department_id: e.department_id,
        kind: e.kind,
        title: text(req.body.title, 300),
        problem: text(req.body.problem),
        objectives: text(req.body.objectives),
        methodology: text(req.body.methodology),
        reports_required: e.reports_required,
        submitted_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      });
      saveDocument(pid, 'concept', req.file, req.user.id);
      event(pid, req.user.id, 'concept', null, 'submitted');
      return pid;
    });
    const p = fresh(id);
    tell(actorsFor(p, 'coordinator'), p, `New ${e.kind_label.toLowerCase()} concept: ${req.user.name}`, p.title);
    res.status(201).json(summarise(req.user, p));
  } catch (err) {
    removeUpload(req.file);
    throw err;
  }
});

/** The student revises a returned concept and sends it back. */
router.put('/:id/concept', upload.single('document'), (req, res) => {
  try {
    const p = loadProject(req);
    if (req.user.id !== p.student_id) throw forbidden();
    requireStatus(p, 'concept_returned');
    tx(() => {
      q.run(
        "UPDATE research_projects SET title = ?, problem = ?, objectives = ?, methodology = ?, status = 'concept_submitted', updated_at = datetime('now') WHERE id = ?",
        text(req.body.title || p.title, 300),
        text(req.body.problem ?? p.problem),
        text(req.body.objectives ?? p.objectives),
        text(req.body.methodology ?? p.methodology),
        p.id,
      );
      saveDocument(p.id, 'concept', req.file, req.user.id);
      event(p.id, req.user.id, 'concept', null, 'resubmitted');
    });
    tell(actorsFor(p, 'coordinator'), p, `Revised concept: ${p.student_name}`, p.title);
    res.json(summarise(req.user, fresh(p.id)));
  } catch (err) {
    removeUpload(req.file);
    throw err;
  }
});

// ------------------------------------------------------------------ Coordinators

const canAppoint = (user, departmentId) => user.role === 'admin' || (['hod', 'dean'].includes(user.role) && canManageDepartment(user, departmentId));

router.get('/coordinators', (req, res) => {
  const depts = managedDepartmentIds(req.user);
  const rows = q.all(
    `SELECT rc.*, u.name, u.title, u.email, d.name AS department_name FROM research_coordinators rc
       JOIN users u ON u.id = rc.user_id JOIN departments d ON d.id = rc.department_id
      WHERE rc.university_id = ? ${depts === null ? '' : depts.length ? `AND rc.department_id IN (${placeholders(depts)})` : 'AND rc.user_id = ?'}
      ORDER BY d.name, u.name`,
    req.uid,
    ...(depts === null ? [] : depts.length ? depts : [req.user.id]),
  );
  res.json(rows);
});

/** The HoD appoints the department's research coordinators from its teaching staff. */
router.post('/coordinators', (req, res) => {
  requireFields(req.body, ['department_id', 'user_id']);
  const dept = q.get('SELECT * FROM departments WHERE id = ? AND university_id = ?', toInt(req.body.department_id), req.uid);
  if (!dept) throw notFound('Department');
  if (!canAppoint(req.user, dept.id)) throw forbidden('The HoD appoints research coordinators');
  const user = q.get('SELECT * FROM users WHERE id = ? AND university_id = ? AND active = 1', toInt(req.body.user_id), req.uid);
  if (!user || !TEACHING.includes(user.role)) throw badRequest('Choose a lecturer');
  q.run('INSERT OR IGNORE INTO research_coordinators (university_id, department_id, user_id, appointed_by) VALUES (?, ?, ?, ?)', req.uid, dept.id, user.id, req.user.id);
  notify(user.id, { title: `Research coordinator: ${dept.name}`, body: 'Students of the department now send you their research concepts.', type: 'research', link: '/research' });
  res.status(201).json(q.get('SELECT rc.*, u.name FROM research_coordinators rc JOIN users u ON u.id = rc.user_id WHERE rc.department_id = ? AND rc.user_id = ?', dept.id, user.id));
});

router.delete('/coordinators/:id', (req, res) => {
  const rc = q.get('SELECT * FROM research_coordinators WHERE id = ? AND university_id = ?', toInt(req.params.id), req.uid);
  if (!rc) throw notFound('Coordinator');
  if (!canAppoint(req.user, rc.department_id)) throw forbidden();
  q.run('DELETE FROM research_coordinators WHERE id = ?', rc.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ Lists and detail

router.get('/', (req, res) => {
  const view = req.query.view || (req.user.role === 'student' ? 'mine' : 'awaiting');
  let rows;
  if (req.user.role === 'student' || view === 'mine') {
    rows = q.all(`${projectSelect} WHERE rp.university_id = ? AND rp.student_id = ? ORDER BY rp.id DESC`, req.uid, req.user.id);
  } else {
    const depts = managedDepartmentIds(req.user);
    const coordinated = q.all('SELECT department_id FROM research_coordinators WHERE user_id = ?', req.user.id).map((r) => r.department_id);
    const conds = ['rp.id IN (SELECT project_id FROM research_supervisors WHERE user_id = ?)'];
    const params = [req.user.id];
    if (depts === null) conds.push('1 = 1');
    else if (depts.length) {
      conds.push(`rp.department_id IN (${placeholders(depts)})`);
      params.push(...depts);
    }
    if (coordinated.length) {
      conds.push(`rp.department_id IN (${placeholders(coordinated)})`);
      params.push(...coordinated);
    }
    rows = q.all(`${projectSelect} WHERE rp.university_id = ? AND (${conds.join(' OR ')}) ORDER BY rp.updated_at DESC LIMIT 500`, req.uid, ...params);
  }
  let list = rows.map((p) => summarise(req.user, p));
  if (view === 'awaiting') list = list.filter((p) => p.actions.some((a) => !['propose_mentor', 'assign_supervisor'].includes(a)));
  if (view === 'supervising') list = list.filter((p) => p.relation.includes('supervisor'));
  if (view === 'cleared') list = list.filter((p) => p.status === 'cleared');
  res.json(list);
});

router.get('/:id', (req, res) => {
  const p = loadProject(req);
  const out = summarise(req.user, p);
  out.mentors = q.all('SELECT m.*, u.name AS decided_by_name FROM research_mentors m LEFT JOIN users u ON u.id = m.decided_by WHERE m.project_id = ? ORDER BY m.id', p.id);
  out.reports = q.all(
    `SELECT r.*, sv.name AS supervisor_name, h.name AS hod_name FROM research_reports r
       LEFT JOIN users sv ON sv.id = r.supervisor_id LEFT JOIN users h ON h.id = r.hod_id WHERE r.project_id = ? ORDER BY r.id`,
    p.id,
  );
  out.documents = q.all('SELECT d.id, d.stage, d.original_name, d.size, d.created_at, u.name AS uploaded_by_name FROM research_documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.project_id = ? ORDER BY d.id DESC', p.id);
  out.events = eventsOf(p.id);
  out.coordinators = q.all('SELECT u.id, u.name, u.title FROM research_coordinators rc JOIN users u ON u.id = rc.user_id WHERE rc.department_id = ?', p.department_id);
  out.next_signer = p.status === 'intent_review' ? nextSigner(p.id, 'intent') : p.status === 'final_review' ? nextSigner(p.id, 'final') : null;
  const tz = q.get('SELECT timezone FROM universities WHERE id = ?', req.uid)?.timezone || 'UTC';
  const calendar = (type, atText, venue, title) =>
    atText ? googleCalendarLink({ project: p, title, venue, minutes: EVENT_MINUTES[type], panel: type === 'defence' ? p.defence_panel : null }, localToUtc(atText.slice(0, 10), atText.slice(11, 16) || '09:00', tz)) : null;
  out.calendar = {
    presentation: p.status === 'presentation_scheduled' ? calendar('presentation', p.presentation_at, p.presentation_venue, `Concept presentation: ${p.student_name}`) : null,
    defence: p.defence_at ? calendar('defence', p.defence_at, p.defence_venue, `${KIND_LABEL[p.kind]} defence: ${p.student_name}`) : null,
  };
  if (p.status === 'cleared') {
    out.verify_code = ensureVerifyCode(p.id).replace(/^(.{5})/, '$1-');
    out.verify_url = `${publicBase(req)}/verify/${out.verify_code}`;
  }
  res.json(out);
});

router.get('/documents/:docId', (req, res) => {
  const doc = q.get('SELECT * FROM research_documents WHERE id = ?', toInt(req.params.docId));
  if (!doc) throw notFound('Document');
  loadProject(req, doc.project_id);
  const file = documentPath(doc);
  if (!fs.existsSync(file)) throw notFound('Document file');
  // The private folder may sit under a dot-folder (as in tests); it is not served publicly either way.
  res.download(file, doc.original_name, { dotfiles: 'allow' });
});

// ------------------------------------------------------------------ Stage actions

const isDateTime = (v) => /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?$/.test(v || '');
const when = (v) => String(v).replace('T', ' ').slice(0, 16);

router.post('/:id/action', (req, res) => {
  const p = loadProject(req);
  const b = req.body || {};
  const note = text(b.note, 2000) || null;
  const allowed = actionsFor(req.user, p);
  if (!allowed.includes(b.action)) throw forbidden('That step is not yours to take now');
  const kind = KIND_LABEL[p.kind];
  const set = (status, extra = {}) => {
    const keys = Object.keys(extra);
    q.run(
      `UPDATE research_projects SET status = ?${keys.map((k) => `, ${k} = ?`).join('')}, updated_at = datetime('now') WHERE id = ?`,
      status,
      ...keys.map((k) => extra[k]),
      p.id,
    );
  };
  const needNote = () => {
    if (!note) throw badRequest('Add a note saying what needs to change');
  };
  const supervisors = supervisorIds(p.id);
  const student = [p.student_id];

  tx(() => {
    switch (b.action) {
      case 'schedule_presentation': {
        if (!isDateTime(b.date)) throw badRequest('Choose the presentation date and time');
        set('presentation_scheduled', { presentation_at: when(b.date), presentation_venue: text(b.venue, 200) || null });
        event(p.id, req.user.id, 'concept', 'coordinator', 'approved', `Presentation ${when(b.date)}${b.venue ? `, ${text(b.venue, 200)}` : ''}${note ? `. ${note}` : ''}`);
        tell(student, p, 'Concept presentation scheduled', `${when(b.date)}${b.venue ? ` in ${text(b.venue, 200)}` : ''}: ${p.title}`);
        break;
      }
      case 'return_concept':
      case 'presentation_revise':
        needNote();
        set('concept_returned');
        event(p.id, req.user.id, b.action === 'return_concept' ? 'concept' : 'presentation', 'coordinator', 'returned', note);
        tell(student, p, 'Concept returned for revision', note);
        break;
      case 'reject':
        needNote();
        set('rejected', { outcome_note: note });
        event(p.id, req.user.id, 'concept', 'coordinator', 'rejected', note);
        tell(student, p, `${kind} concept not approved`, note);
        break;
      case 'presentation_passed':
        set('supervision');
        event(p.id, req.user.id, 'presentation', 'coordinator', 'passed', note);
        tell([...student, ...actorsFor(p, 'hod')], p, 'Concept approved after presentation', `${p.student_name}: ${p.title}. Supervisors are being assigned.`);
        break;
      case 'approve_start':
        if (!q.get("SELECT 1 FROM research_supervisors WHERE project_id = ? AND role = 'main'", p.id)) throw badRequest('Assign a main supervisor first');
        set('in_progress');
        event(p.id, req.user.id, 'start', 'hod', 'approved', note);
        tell([...student, ...supervisors], p, `${kind} approved to start`, `Submit ${p.reports_required} progress report${p.reports_required === 1 ? '' : 's'}, then your intent to submit.`);
        break;
      case 'sign_intent':
      case 'sign_final': {
        const stage = b.action === 'sign_intent' ? 'intent' : 'final';
        const step = nextSigner(p.id, stage);
        event(p.id, req.user.id, stage, step, 'signed', note);
        const after = nextSigner(p.id, stage);
        if (!after) {
          set(stage === 'intent' ? 'intent_approved' : 'final_approved');
          tell(stage === 'intent' ? student : [...student, ...actorsFor(p, 'coordinator')], p, stage === 'intent' ? 'Intent to submit approved' : `Final ${kind.toLowerCase()} approved`, stage === 'intent' ? `Upload your final ${kind.toLowerCase()}.` : 'The defence date will be scheduled.');
        } else {
          tell(actorsFor(p, after), p, `${stage === 'intent' ? 'Intent to submit' : `Final ${kind.toLowerCase()}`} to sign off`, `${p.student_name}: ${p.title}`);
        }
        break;
      }
      case 'return_intent':
      case 'return_final': {
        needNote();
        const stage = b.action === 'return_intent' ? 'intent' : 'final';
        event(p.id, req.user.id, stage, nextSigner(p.id, stage), 'returned', note);
        set(stage === 'intent' ? 'in_progress' : 'intent_approved');
        tell(student, p, stage === 'intent' ? 'Intent to submit returned' : `Final ${kind.toLowerCase()} returned`, note);
        break;
      }
      case 'schedule_defence': {
        if (!isDateTime(b.date)) throw badRequest('Choose the defence date and time');
        const panel = text(b.panel, 1000) || null;
        set('defence_scheduled', { defence_at: when(b.date), defence_venue: text(b.venue, 200) || null, defence_panel: panel });
        event(p.id, req.user.id, 'defence', 'coordinator', 'scheduled', `${when(b.date)}${b.venue ? `, ${text(b.venue, 200)}` : ''}${panel ? `. Panel: ${panel}` : ''}`);
        tell([...student, ...supervisors, ...actorsFor(p, 'hod')], p, `Defence scheduled: ${when(b.date)}`, `${p.student_name}: ${p.title}${b.venue ? `, ${text(b.venue, 200)}` : ''}`);
        break;
      }
      case 'defence_passed':
        set('defended', { outcome_note: note });
        event(p.id, req.user.id, 'defence', 'coordinator', 'passed', note);
        tell([...student, ...actorsFor(p, 'hod')], p, 'Defence passed', `${p.student_name} is ready to be cleared.`);
        break;
      case 'defence_corrections':
        needNote();
        set('corrections', { outcome_note: note });
        event(p.id, req.user.id, 'defence', 'coordinator', 'corrections', note);
        tell(student, p, 'Corrections required after the defence', note);
        break;
      case 'approve_corrections':
        set('defended');
        event(p.id, req.user.id, 'corrections', 'supervisor', 'approved', note);
        tell([...student, ...actorsFor(p, 'hod')], p, 'Corrections accepted', `${p.student_name} is ready to be cleared.`);
        break;
      case 'return_corrections':
        needNote();
        set('corrections');
        event(p.id, req.user.id, 'corrections', 'supervisor', 'returned', note);
        tell(student, p, 'Corrections returned', note);
        break;
      case 'clear':
        set('cleared', { cleared_at: new Date().toISOString().replace('T', ' ').slice(0, 19) });
        ensureVerifyCode(p.id);
        event(p.id, req.user.id, 'clearance', 'hod', 'cleared', note);
        tell(student, p, `Approved and cleared: ${kind}`, 'Your clearance certificate is ready to download.');
        break;
      default:
        throw badRequest('Unknown action');
    }
  });
  res.json(summarise(req.user, fresh(p.id)));
});

// ------------------------------------------------------------------ Supervisors and mentors

router.post('/:id/supervisors', (req, res) => {
  const p = loadProject(req);
  if (!actionsFor(req.user, p).includes('assign_supervisor')) throw forbidden('The research coordinator or HoD assigns supervisors');
  const user = q.get('SELECT * FROM users WHERE id = ? AND university_id = ? AND active = 1', toInt(req.body?.user_id), req.uid);
  if (!user || !TEACHING.includes(user.role)) throw badRequest('Choose a lecturer as supervisor');
  if (user.id === p.student_id) throw badRequest('A student cannot supervise their own work');
  const role = req.body.role === 'co' ? 'co' : 'main';
  q.run(
    `INSERT INTO research_supervisors (project_id, user_id, role, assigned_by) VALUES (?, ?, ?, ?)
     ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role`,
    p.id,
    user.id,
    role,
    req.user.id,
  );
  event(p.id, req.user.id, 'supervision', 'coordinator', 'assigned', `${user.name} (${role === 'main' ? 'main supervisor' : 'co-supervisor'})`);
  tell([user.id], p, `You are supervising: ${p.student_name}`, p.title);
  tell([p.student_id], p, 'Supervisor assigned', `${user.name} will ${role === 'main' ? 'supervise' : 'co-supervise'} your ${KIND_LABEL[p.kind].toLowerCase()}.`);
  res.status(201).json(summarise(req.user, fresh(p.id)));
});

router.delete('/:id/supervisors/:userId', (req, res) => {
  const p = loadProject(req);
  if (!actionsFor(req.user, p).includes('assign_supervisor')) throw forbidden();
  const removed = q.run('DELETE FROM research_supervisors WHERE project_id = ? AND user_id = ?', p.id, toInt(req.params.userId)).changes;
  if (!removed) throw notFound('Supervisor');
  event(p.id, req.user.id, 'supervision', 'coordinator', 'removed', nameOf(toInt(req.params.userId)));
  res.json(summarise(req.user, fresh(p.id)));
});

/** The student proposes a mentor (e.g. from industry); the coordinator confirms them. */
router.post('/:id/mentors', (req, res) => {
  const p = loadProject(req);
  if (!actionsFor(req.user, p).includes('propose_mentor')) throw forbidden('Mentors are proposed by the student once the concept is approved');
  requireFields(req.body, ['name']);
  const id = insert('research_mentors', {
    project_id: p.id,
    name: text(req.body.name, 120),
    email: text(req.body.email, 160) || null,
    phone: text(req.body.phone, 40) || null,
    institution: text(req.body.institution, 160) || null,
    proposed_by: req.user.id,
  });
  event(p.id, req.user.id, 'mentor', null, 'proposed', text(req.body.name, 120));
  tell(actorsFor(p, 'coordinator'), p, `Mentor proposed: ${p.student_name}`, `${text(req.body.name, 120)}${req.body.institution ? `, ${text(req.body.institution, 160)}` : ''}`);
  res.status(201).json(q.get('SELECT * FROM research_mentors WHERE id = ?', id));
});

router.post('/:id/mentors/:mentorId/decision', (req, res) => {
  const p = loadProject(req);
  if (!canActAs(req.user, p, 'coordinator')) throw forbidden('The research coordinator confirms mentors');
  const m = q.get('SELECT * FROM research_mentors WHERE id = ? AND project_id = ?', toInt(req.params.mentorId), p.id);
  if (!m) throw notFound('Mentor');
  const decision = req.body?.decision === 'decline' ? 'declined' : 'confirmed';
  q.run("UPDATE research_mentors SET status = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?", decision, req.user.id, m.id);
  event(p.id, req.user.id, 'mentor', 'coordinator', decision, m.name);
  tell([p.student_id], p, `Mentor ${decision}: ${m.name}`, p.title);
  res.json(q.get('SELECT * FROM research_mentors WHERE id = ?', m.id));
});

// ------------------------------------------------------------------ Submissions

function submission(stage, { needsDoc, statuses, next, notifyStep, title }) {
  return (req, res) => {
    try {
      const p = loadProject(req);
      if (req.user.id !== p.student_id) throw forbidden();
      requireStatus(p, ...statuses);
      if (needsDoc && !req.file) throw badRequest('Attach the document (PDF or Word)');
      if (stage === 'intent' && approvedReports(p.id) < p.reports_required) {
        throw badRequest(`${p.reports_required} approved progress reports are needed first (${approvedReports(p.id)} so far)`);
      }
      tx(() => {
        saveDocument(p.id, stage, req.file, req.user.id);
        q.run("UPDATE research_projects SET status = ?, updated_at = datetime('now') WHERE id = ?", next, p.id);
        event(p.id, req.user.id, stage, null, 'submitted', text(req.body?.summary, 2000) || null);
      });
      tell(actorsFor(p, notifyStep), p, `${title}: ${p.student_name}`, p.title);
      res.status(201).json(summarise(req.user, fresh(p.id)));
    } catch (err) {
      removeUpload(req.file);
      throw err;
    }
  };
}

router.post('/:id/intent', upload.single('document'), submission('intent', { needsDoc: false, statuses: ['in_progress'], next: 'intent_review', notifyStep: 'supervisor', title: 'Intent to submit to sign off' }));
router.post('/:id/final', upload.single('document'), submission('final', { needsDoc: true, statuses: ['intent_approved'], next: 'final_review', notifyStep: 'supervisor', title: 'Final submission to approve' }));
router.post('/:id/corrections', upload.single('document'), submission('corrections', { needsDoc: true, statuses: ['corrections'], next: 'corrections_review', notifyStep: 'supervisor', title: 'Corrected work to check' }));

/** Progress reports: up to the number the HoD set; the supervisor, then the HoD, approves each. */
router.post('/:id/reports', upload.single('document'), (req, res) => {
  try {
    const p = loadProject(req);
    if (req.user.id !== p.student_id) throw forbidden();
    requireStatus(p, 'in_progress');
    if (pendingReport(p.id)) throw badRequest('Your last progress report is still being reviewed');
    requireFields(req.body, ['title']);
    if (!req.file && !text(req.body.summary)) throw badRequest('Write a summary or attach the report');
    const id = tx(() => {
      const docId = saveDocument(p.id, 'report', req.file, req.user.id);
      const rid = insert('research_reports', { project_id: p.id, number: approvedReports(p.id) + 1, title: text(req.body.title, 200), summary: text(req.body.summary), document_id: docId });
      event(p.id, req.user.id, 'report', null, 'submitted', `Progress report ${approvedReports(p.id) + 1}: ${text(req.body.title, 200)}`);
      return rid;
    });
    tell(supervisorIds(p.id), p, `Progress report to review: ${p.student_name}`, text(req.body.title, 200));
    res.status(201).json(q.get('SELECT * FROM research_reports WHERE id = ?', id));
  } catch (err) {
    removeUpload(req.file);
    throw err;
  }
});

router.post('/reports/:reportId/review', (req, res) => {
  const r = q.get('SELECT * FROM research_reports WHERE id = ?', toInt(req.params.reportId));
  if (!r) throw notFound('Progress report');
  const p = loadProject(req, r.project_id);
  const step = r.status === 'submitted' ? 'supervisor' : r.status === 'supervisor_approved' ? 'hod' : null;
  if (!step || !canActAs(req.user, p, step)) throw forbidden('This report is not waiting for you');
  const action = req.body?.action === 'return' ? 'return' : 'approve';
  const note = text(req.body?.note, 2000) || null;
  if (action === 'return' && !note) throw badRequest('Say what the student should change');
  const at = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const status = action === 'return' ? 'returned' : step === 'supervisor' ? 'supervisor_approved' : 'approved';
  if (step === 'supervisor') q.run('UPDATE research_reports SET status = ?, supervisor_id = ?, supervisor_at = ?, supervisor_note = ? WHERE id = ?', status, req.user.id, at, note, r.id);
  else q.run('UPDATE research_reports SET status = ?, hod_id = ?, hod_at = ?, hod_note = ? WHERE id = ?', status, req.user.id, at, note, r.id);
  event(p.id, req.user.id, 'report', step, action === 'return' ? 'returned' : 'approved', `Progress report ${r.number}${note ? `: ${note}` : ''}`);
  if (action === 'return') tell([p.student_id], p, `Progress report ${r.number} returned`, note);
  else if (step === 'supervisor') tell(actorsFor(p, 'hod'), p, `Progress report to approve: ${p.student_name}`, `Report ${r.number}: ${r.title}`);
  else {
    const done = approvedReports(p.id);
    tell([p.student_id], p, `Progress report ${r.number} approved`, done >= p.reports_required ? 'All progress reports are approved: you can submit your intent to submit.' : `${done} of ${p.reports_required} approved.`);
  }
  res.json(q.get('SELECT * FROM research_reports WHERE id = ?', r.id));
});

// ------------------------------------------------------------------ Certificate

router.get('/:id/certificate', async (req, res) => {
  const p = loadProject(req);
  if (p.status !== 'cleared') throw badRequest('The certificate is issued once the student is cleared');
  const code = ensureVerifyCode(p.id);
  const pretty = `${code.slice(0, 5)}-${code.slice(5)}`;
  const url = `${publicBase(req)}/verify/${pretty}`;
  const university = q.get('SELECT * FROM universities WHERE id = ?', req.uid);
  const supervisors = q.all('SELECT u.name, u.title, rs.role FROM research_supervisors rs JOIN users u ON u.id = rs.user_id WHERE rs.project_id = ? ORDER BY rs.role, u.name', p.id);
  const qrText = [
    `${university.short_name || university.name} research clearance #${p.id}`,
    `Student: ${p.student_name}${p.student_identifier ? ` (${p.student_identifier})` : ''}`,
    `${KIND_LABEL[p.kind]}: ${p.title}`,
    `Status: ${STATUS_LABEL.cleared}`,
    `Verify: ${url}`,
  ].join('\n');
  const buf = await researchCertificatePdf(university, { ...p, kind_label: KIND_LABEL[p.kind] }, { supervisors, signOffs: certificateSignOffs(p.id), verify: { code: pretty, url, qrText } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="clearance-${p.id}-${slugify(p.student_name)}.pdf"`);
  res.send(buf);
});

export default router;
