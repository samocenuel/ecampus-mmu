// The research process in plain words: the seven steps, who acts at each, and what the next
// person has to do now. Web and mobile show the same text.
import { KIND_LABEL } from './research.js';

const lower = (kind) => KIND_LABEL[kind].toLowerCase();

/** The seven steps for a project, dissertation or thesis. */
export function processSteps(kind = 'project', reportsRequired = 3) {
  const k = lower(kind);
  return [
    {
      n: 1,
      title: 'Concept',
      who: 'Student, then research coordinator',
      text: `The student submits the concept (title, problem, objectives, methodology) to the department's research coordinator, who schedules a presentation or returns the concept for revision.`,
    },
    {
      n: 2,
      title: 'Presentation and supervisors',
      who: 'Research coordinator, then HoD',
      text: `The student presents the concept. If it passes, the coordinator assigns a main supervisor (and co-supervisors) and confirms any mentors the student proposes. The HoD then approves the work to start.`,
    },
    {
      n: 3,
      title: 'Progress reports',
      who: 'Student, supervisor, HoD',
      text: `The student submits ${reportsRequired} progress report${reportsRequired === 1 ? '' : 's'}, one at a time. Each is reviewed by the supervisor and then approved by the HoD.`,
    },
    {
      n: 4,
      title: 'Intent to submit',
      who: 'Supervisor, coordinator, HoD',
      text: `With all reports approved, the student submits an intent to submit listing the outputs. The supervisor, the research coordinator and the HoD sign it off in turn, or return it if the outputs are not clear.`,
    },
    {
      n: 5,
      title: `Final ${k}`,
      who: 'Supervisor, coordinator, HoD',
      text: `The student submits the final ${k}. The supervisor, the research coordinator and the HoD approve it in turn, or return it with what must change.`,
    },
    {
      n: 6,
      title: 'Defence',
      who: 'Research coordinator',
      text: `The coordinator schedules the defence (date, venue and panel). Afterwards the coordinator records a pass, or the corrections required, which the supervisor checks.`,
    },
    {
      n: 7,
      title: 'Clearance',
      who: 'HoD',
      text: `The HoD approves and clears the student, who gets a clearance certificate with a QR code anyone can verify.`,
    },
  ];
}

const STEP_OF = {
  concept_submitted: 1, concept_returned: 1,
  presentation_scheduled: 2, supervision: 2,
  in_progress: 3,
  intent_review: 4,
  intent_approved: 5, final_review: 5,
  final_approved: 6, defence_scheduled: 6, corrections: 6, corrections_review: 6,
  defended: 7,
  cleared: 8,
};

const SIGNER = { supervisor: 'Supervisor', coordinator: 'Research coordinator', hod: 'Head of Department' };
const when = (v) => (v ? String(v).replace('T', ' ').slice(0, 16) : '');

/**
 * Where the work is and what happens next: `next` says who acts and what they do; `you` says what
 * the viewer has to do now (or that they are waiting for someone else).
 * `ctx`: { approved, pendingReport, signer, hasMainSupervisor, actions, isStudent }.
 */
export function researchGuide(p, ctx) {
  const k = lower(p.kind);
  const n = p.reports_required;
  const r = ctx.pendingReport;
  let next = null;
  switch (p.status) {
    case 'concept_submitted':
      next = ['Research coordinator', 'Review the concept: schedule the presentation, return it for revision, or do not approve it.'];
      break;
    case 'concept_returned':
      next = ['Student', 'Revise the concept as the coordinator asked and resubmit it.'];
      break;
    case 'presentation_scheduled':
      next = ['Research coordinator', `Hold the presentation${p.presentation_at ? ` on ${when(p.presentation_at)}` : ''}, then record the outcome: passed, or revise the concept.`];
      break;
    case 'supervision':
      next = ctx.hasMainSupervisor
        ? ['Head of Department', 'Approve the work to start (supervisors are assigned).']
        : ['Research coordinator', 'Assign a main supervisor (and co-supervisors if needed) and confirm any mentors the student proposed.'];
      break;
    case 'in_progress':
      if (r?.status === 'submitted') next = ['Supervisor', `Review progress report ${r.number}: approve it or return it.`];
      else if (r?.status === 'supervisor_approved') next = ['Head of Department', `Approve progress report ${r.number} (the supervisor has approved it).`];
      else if (ctx.approved < n) next = ['Student', `Submit progress report ${ctx.approved + 1} of ${n}.`];
      else next = ['Student', `All ${n} progress reports are approved: submit the intent to submit.`];
      break;
    case 'intent_review':
      next = [SIGNER[ctx.signer] || 'Reviewers', 'Sign off the intent to submit, or return it if the outputs are not clear.'];
      break;
    case 'intent_approved':
      next = ['Student', `Submit the final ${k}.`];
      break;
    case 'final_review':
      next = [SIGNER[ctx.signer] || 'Reviewers', `Approve the final ${k}, or return it with what must change.`];
      break;
    case 'final_approved':
      next = ['Research coordinator', 'Schedule the defence: date, venue and panel.'];
      break;
    case 'defence_scheduled':
      next = ['Research coordinator', `Hold the defence${p.defence_at ? ` on ${when(p.defence_at)}` : ''}, then record a pass or the corrections required.`];
      break;
    case 'corrections':
      next = ['Student', `Make the corrections asked for at the defence and submit the corrected ${k}.`];
      break;
    case 'corrections_review':
      next = ['Supervisor', 'Check the corrections: accept them or return them.'];
      break;
    case 'defended':
      next = ['Head of Department', 'Approve and clear the student.'];
      break;
    default:
  }
  const step = p.status === 'rejected' ? 0 : STEP_OF[p.status] || 1;
  const steps = processSteps(p.kind, n).map((s) => ({
    ...s,
    state: step === 0 ? 'todo' : s.n < step ? 'done' : s.n === step ? 'current' : 'todo',
    detail: s.n === 3 && step >= 3 ? `${Math.min(ctx.approved, n)} of ${n} approved` : null,
  }));
  const mine = ctx.actions.filter((a) => !['propose_mentor', 'assign_supervisor', 'decide_mentor'].includes(a)).length > 0
    || (p.status === 'supervision' && !ctx.hasMainSupervisor && ctx.actions.includes('assign_supervisor'));
  let you = null;
  if (next) {
    if (mine) you = next[1];
    else if (ctx.isStudent && next[0] !== 'Student') you = `Nothing to do for now: waiting for the ${next[0].toLowerCase()}. You are notified when it is your turn.`;
  } else if (p.status === 'cleared') you = ctx.isStudent ? 'You are cleared. Download your clearance certificate.' : null;
  return {
    step,
    total: 7,
    title: step === 8 ? 'Cleared' : step === 0 ? 'Not approved' : steps[step - 1].title,
    steps,
    next: next ? { who: next[0], text: next[1] } : null,
    you,
    your_turn: mine,
  };
}
