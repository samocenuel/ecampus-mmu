// Research supervision, from concept to clearance:
//  1. the student submits a concept to the department's research coordinator;
//  2. it is presented, supervisors are assigned (mentors the student proposes are confirmed), and
//     the HoD approves the work to start;
//  3. the student submits progress reports (supervisor, then HoD, approves each) up to the number
//     the HoD set for the programme;
//  4. an intent to submit is signed off by the supervisor, the coordinator and the HoD (or turned
//     back when the outputs are not clear);
//  5. the final work is approved by the supervisor, the coordinator and the HoD;
//  6. the defence is scheduled and its outcome recorded;
//  7. the HoD clears the student, who gets a verifiable clearance certificate.
// Undergraduates write a project, Master's students a dissertation and PhD students a thesis.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { insert, q } from '../db.js';
import { canManageDepartment } from '../scope.js';
import { badRequest } from '../util.js';
import { notify } from './notify.js';

export const KIND_LABEL = { project: 'Project', dissertation: 'Dissertation', thesis: 'Thesis' };

/** Master's students write a dissertation, PhD students a thesis, everyone else a project. */
export function kindForLevel(level) {
  const l = String(level || '').toLowerCase();
  if (l.includes('phd') || l.includes('doctor')) return 'thesis';
  if (l.includes('master')) return 'dissertation';
  return 'project';
}

export const STATUS_LABEL = {
  concept_submitted: 'Concept awaiting the research coordinator',
  concept_returned: 'Concept returned for revision',
  presentation_scheduled: 'Concept presentation scheduled',
  supervision: 'Assigning supervisors',
  in_progress: 'In progress: progress reports',
  intent_review: 'Intent to submit under review',
  intent_approved: 'Intent approved: submit the final work',
  final_review: 'Final submission under review',
  final_approved: 'Final work approved: awaiting defence date',
  defence_scheduled: 'Defence scheduled',
  corrections: 'Corrections after the defence',
  corrections_review: 'Corrections under review',
  defended: 'Defended: awaiting clearance',
  cleared: 'Approved and cleared',
  rejected: 'Not approved',
};

export const CLOSED = ['cleared', 'rejected'];
const SIGN_STEPS = ['supervisor', 'coordinator', 'hod'];
export const STEP_LABEL = { supervisor: 'Supervisor', coordinator: 'Research coordinator', hod: 'Head of Department' };

export const projectSelect = `
  SELECT rp.*, s.name AS student_name, s.identifier AS student_identifier, s.email AS student_email,
         c.name AS class_name, c.year_of_study, p.code AS program_code, p.name AS program_name, p.level AS program_level,
         d.name AS department_name, d.hod_id, d.faculty_id
    FROM research_projects rp
    JOIN users s ON s.id = rp.student_id
    LEFT JOIN classes c ON c.id = s.class_id
    LEFT JOIN programs p ON p.id = rp.program_id
    LEFT JOIN departments d ON d.id = rp.department_id`;

// ------------------------------------------------------------------ Who's who

export const coordinatorIds = (departmentId) => q.all('SELECT user_id FROM research_coordinators WHERE department_id = ?', departmentId).map((r) => r.user_id);
export const supervisorIds = (projectId) => q.all('SELECT user_id FROM research_supervisors WHERE project_id = ?', projectId).map((r) => r.user_id);

/** The people who act for the HoD step: the HoD, or the Dean when the department has none. */
function hodIds(project) {
  if (project.hod_id) return [project.hod_id];
  const dean = q.get('SELECT dean_id FROM faculties WHERE id = ?', project.faculty_id)?.dean_id;
  return dean ? [dean] : [];
}

/** Who acts for a step. With no coordinator appointed, the HoD acts as coordinator. */
export function actorsFor(project, step) {
  if (step === 'supervisor') return supervisorIds(project.id);
  if (step === 'coordinator') {
    const ids = coordinatorIds(project.department_id);
    return ids.length ? ids : hodIds(project);
  }
  return hodIds(project);
}

/** Can `user` act for `step` on the project? Administrators and the unit's managers can stand in for the HoD. */
export function canActAs(user, project, step) {
  if (user.id === project.student_id) return false;
  if (actorsFor(project, step).includes(user.id)) return true;
  if (step === 'hod' || step === 'coordinator') {
    return user.role === 'admin' || (['hod', 'dean'].includes(user.role) && canManageDepartment(user, project.department_id));
  }
  return false;
}

/** What the user's relationship to the project is (for scoping and the UI). */
export function relationOf(user, project) {
  const roles = [];
  if (user.id === project.student_id) roles.push('student');
  if (supervisorIds(project.id).includes(user.id)) roles.push('supervisor');
  if (coordinatorIds(project.department_id).includes(user.id)) roles.push('coordinator');
  if (hodIds(project).includes(user.id) || user.role === 'admin' || (['hod', 'dean'].includes(user.role) && canManageDepartment(user, project.department_id))) roles.push('manager');
  return roles;
}

// ------------------------------------------------------------------ Events and footprints

export function event(projectId, actorId, stage, step, action, note = null) {
  insert('research_events', { project_id: projectId, actor_id: actorId, stage, step: step || null, action, note: note || null });
  q.run("UPDATE research_projects SET updated_at = datetime('now') WHERE id = ?", projectId);
}

/** A sign-off's digital footprint: a keyed hash of the project, person, stage, step, action and time. */
export function footprint(projectId, e) {
  return crypto
    .createHmac('sha256', config.jwtSecret)
    .update(`research|${projectId}|${e.id}|${e.actor_id}|${e.stage}|${e.step || ''}|${e.action}|${e.created_at}`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase()
    .replace(/(.{4})(?=.)/g, '$1-');
}

export function eventsOf(projectId) {
  return q
    .all(
      `SELECT e.*, u.name AS actor_name, u.title AS actor_title FROM research_events e LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.project_id = ? ORDER BY e.id`,
      projectId,
    )
    .map((e) => ({ ...e, footprint: ['approved', 'signed', 'cleared', 'passed', 'confirmed'].includes(e.action) ? footprint(projectId, e) : null }));
}

/** The next signer in a three-step review (intent or final) since it was last submitted. */
export function nextSigner(projectId, stage) {
  const events = q.all('SELECT * FROM research_events WHERE project_id = ? AND stage = ? ORDER BY id', projectId, stage);
  const start = events.map((e) => e.action === 'submitted').lastIndexOf(true);
  const done = new Set(events.slice(start + 1).filter((e) => e.action === 'signed').map((e) => e.step));
  return SIGN_STEPS.find((s) => !done.has(s)) || null;
}

/** The sign-offs that the clearance certificate lists, newest of each. */
export function certificateSignOffs(projectId) {
  const events = eventsOf(projectId);
  const last = (pred) => [...events].reverse().find(pred);
  const line = (label, e) => ({ label, name: e ? [e.actor_title, e.actor_name].filter(Boolean).join(' ') : null, at: e?.created_at || null, footprint: e?.footprint || null });
  return [
    line('Concept approved after presentation (research coordinator)', last((e) => e.stage === 'presentation' && e.action === 'passed')),
    line('Approved to start (Head of Department)', last((e) => e.stage === 'start' && e.action === 'approved')),
    line('Intent to submit: supervisor', last((e) => e.stage === 'intent' && e.step === 'supervisor' && e.action === 'signed')),
    line('Intent to submit: research coordinator', last((e) => e.stage === 'intent' && e.step === 'coordinator' && e.action === 'signed')),
    line('Intent to submit: Head of Department', last((e) => e.stage === 'intent' && e.step === 'hod' && e.action === 'signed')),
    line('Final submission: supervisor', last((e) => e.stage === 'final' && e.step === 'supervisor' && e.action === 'signed')),
    line('Final submission: research coordinator', last((e) => e.stage === 'final' && e.step === 'coordinator' && e.action === 'signed')),
    line('Final submission: Head of Department', last((e) => e.stage === 'final' && e.step === 'hod' && e.action === 'signed')),
    line('Defence passed (research coordinator)', last((e) => e.stage === 'defence' && e.action === 'passed')),
    line('Approved and cleared (Head of Department)', last((e) => e.stage === 'clearance' && e.action === 'cleared')),
  ];
}

// ------------------------------------------------------------------ Documents

export const DOC_EXT = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
};
export const researchDir = () => path.join(config.privateDir, 'research');

/** Record a file multer saved in the research folder. */
export function saveDocument(projectId, stage, file, userId) {
  if (!file) return null;
  return insert('research_documents', {
    project_id: projectId,
    stage,
    file_name: file.filename,
    original_name: String(file.originalname || 'document').slice(0, 180),
    mime: file.mimetype,
    size: file.size,
    uploaded_by: userId,
  });
}

export function documentPath(doc) {
  return path.join(researchDir(), path.basename(doc.file_name));
}

export function removeUpload(file) {
  if (file?.path) fs.rm(file.path, { force: true }, () => {});
}

// ------------------------------------------------------------------ Notifications

export function tell(userIds, project, title, body) {
  notify(userIds, { title, body, type: 'research', link: `/research/${project.id}` });
}

export function requireStatus(project, ...statuses) {
  if (!statuses.includes(project.status)) throw badRequest(`This ${KIND_LABEL[project.kind].toLowerCase()} is at "${STATUS_LABEL[project.status]}"`);
}

/** Verification code shared with requisitions' format, unique across both. */
export function ensureVerifyCode(projectId) {
  const existing = q.get('SELECT verify_code FROM research_projects WHERE id = ?', projectId)?.verify_code;
  if (existing) return existing;
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    const code = Array.from(crypto.randomBytes(10), (b) => ALPHABET[b % 32]).join('');
    if (!q.get('SELECT 1 FROM research_projects WHERE verify_code = ?', code) && !q.get('SELECT 1 FROM pay_claims WHERE verify_code = ?', code)) {
      q.run('UPDATE research_projects SET verify_code = ? WHERE id = ?', code, projectId);
      return code;
    }
  }
}

// ------------------------------------------------------------------ Calendar and reminders

export const EVENT_MINUTES = { presentation: 60, defence: 120 };

/** Participants of a project's presentation or defence: student, supervisors, coordinators and HoD. */
export function participantsOf(project) {
  return [...new Set([project.student_id, ...supervisorIds(project.id), ...coordinatorIds(project.department_id), ...hodIds(project)])];
}

/**
 * Concept presentations and defences the user takes part in between two local dates, with the
 * date and time in the university's local time ("YYYY-MM-DD HH:MM").
 */
export function researchEventsFor(user, from, to) {
  const rows = q.all(
    `${projectSelect} WHERE rp.university_id = ? AND (
        (rp.presentation_at IS NOT NULL AND substr(rp.presentation_at, 1, 10) BETWEEN ? AND ? AND rp.status = 'presentation_scheduled')
     OR (rp.defence_at IS NOT NULL AND substr(rp.defence_at, 1, 10) BETWEEN ? AND ? AND rp.status IN ('defence_scheduled', 'corrections', 'corrections_review', 'defended', 'cleared')))`,
    user.university_id,
    from,
    to,
    from,
    to,
  );
  const out = [];
  for (const p of rows) {
    if (!participantsOf(p).includes(user.id) && user.role !== 'admin') continue;
    const kind = KIND_LABEL[p.kind];
    if (p.status === 'presentation_scheduled' && p.presentation_at) {
      out.push({ type: 'presentation', project: p, at: p.presentation_at, venue: p.presentation_venue, title: `Concept presentation: ${p.student_name}`, minutes: EVENT_MINUTES.presentation });
    }
    if (p.defence_at && p.status !== 'presentation_scheduled') {
      out.push({ type: 'defence', project: p, at: p.defence_at, venue: p.defence_venue, title: `${kind} defence: ${p.student_name}`, minutes: EVENT_MINUTES.defence, panel: p.defence_panel });
    }
  }
  return out;
}

/** A Google Calendar "add event" link for one presentation or defence. */
export function googleCalendarLink(e, startUtc) {
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const end = new Date(startUtc.getTime() + e.minutes * 60000);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `${e.title}: ${e.project.title}`,
    dates: `${fmt(startUtc)}/${fmt(end)}`,
    details: [`${KIND_LABEL[e.project.kind]}: ${e.project.title}`, e.panel ? `Panel: ${e.panel}` : null].filter(Boolean).join('\n'),
    location: e.venue || '',
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}
