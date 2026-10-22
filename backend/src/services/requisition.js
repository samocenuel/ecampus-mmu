// Requisition forms for part-time pay claims: each sign-off leaves a digital footprint (who, in
// which role, when, for what amount) and every requisition has a code that anyone holding the
// printed form can check against the system.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { q } from '../db.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Ten characters from an unambiguous alphabet (no 0/O, 1/I), about 50 bits of randomness. */
function newCode() {
  return Array.from(crypto.randomBytes(10), (b) => ALPHABET[b % 32]).join('');
}

export const formatCode = (code) => (code ? `${code.slice(0, 5)}-${code.slice(5)}` : '');
export const normaliseCode = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** The claim's verification code, created the first time it is needed. */
export function ensureVerifyCode(claimId) {
  const existing = q.get('SELECT verify_code FROM pay_claims WHERE id = ?', claimId)?.verify_code;
  if (existing) return existing;
  for (;;) {
    const code = newCode();
    if (!q.get('SELECT 1 FROM pay_claims WHERE verify_code = ?', code) && !q.get('SELECT 1 FROM research_projects WHERE verify_code = ?', code)) {
      q.run('UPDATE pay_claims SET verify_code = ? WHERE id = ?', code, claimId);
      return code;
    }
  }
}

/**
 * A sign-off's digital footprint: a keyed hash of the claim, the person, the action, the time and
 * the amount. Only the server can produce it, so a footprint printed on paper that matches the one
 * shown by the verification page proves that person signed off that amount at that time.
 */
export function footprint(claim, event) {
  return crypto
    .createHmac('sha256', config.jwtSecret)
    .update(`requisition|${claim.id}|${event.id}|${event.actor_id}|${event.action}|${event.created_at}|${Number(claim.total).toFixed(2)}`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase()
    .replace(/(.{4})(?=.)/g, '$1-');
}

const ROLE_STEP = [
  ['claimant', 'Signed off and submitted by claimant (Lecturer)'],
  ['hod', 'Verified by Head of Department'],
  ['dean', 'Signed off by Vote Controller (Dean)'],
  ['hr', 'Final approval by HR Officer'],
];

/** The sign-offs since the claim was last (re)submitted, each with its footprint. */
export function signOffs(claim) {
  const events = q.all(
    `SELECT e.*, u.name AS actor_name, u.title AS actor_title FROM pay_claim_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.claim_id = ? ORDER BY e.id`,
    claim.id,
  );
  const start = events.map((e) => ['submitted', 'resubmitted'].includes(e.action)).lastIndexOf(true);
  const recent = start >= 0 ? events.slice(start) : [];
  const latest = (pred) => [...recent].reverse().find(pred);
  const found = {
    claimant: recent[0],
    hod: latest((e) => e.action === 'approved' && e.stage === 'HoD'),
    dean: latest((e) => e.action === 'approved' && e.stage === 'Dean'),
    hr: latest((e) => e.action === 'verified'),
  };
  const out = {};
  for (const [key, step] of ROLE_STEP) {
    const e = found[key];
    out[key] = e ? { step, name: [e.actor_title, e.actor_name].filter(Boolean).join(' '), at: e.created_at, footprint: footprint(claim, e) } : { step, name: null, at: null, footprint: null };
  }
  return out;
}

/** The public address of the system, as seen by the person who asked for the file. */
export function publicBase(req) {
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}${config.basePath}`;
}
