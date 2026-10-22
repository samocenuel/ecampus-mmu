// Curriculum versions: a programme's course units by year and semester change over time, so each
// change is a new version. New intakes follow the latest version; running classes keep theirs.
import { insert, q } from '../db.js';

/** The version new intakes follow: the newest one that is not retired. */
export function latestVersion(programId) {
  return (
    q.get("SELECT * FROM curriculum_versions WHERE program_id = ? AND status <> 'retired' ORDER BY id DESC LIMIT 1", programId) ||
    q.get('SELECT * FROM curriculum_versions WHERE program_id = ? ORDER BY id DESC LIMIT 1', programId)
  );
}

/** The programme's latest version, creating "Version 1" for a programme that has none. */
export function ensureVersion(program) {
  const v = latestVersion(program.id);
  if (v) return v;
  const id = insert('curriculum_versions', { university_id: program.university_id, program_id: program.id, name: 'Version 1', status: 'active' });
  return q.get('SELECT * FROM curriculum_versions WHERE id = ?', id);
}

/**
 * Versions no running class follows any more retire; older versions still followed by a class are
 * phasing out. The latest version of each programme stays active.
 */
export function refreshVersionStatuses(universityId) {
  for (const v of q.all("SELECT * FROM curriculum_versions WHERE university_id = ? AND status <> 'retired'", universityId)) {
    const latest = latestVersion(v.program_id);
    if (latest && latest.id === v.id) {
      if (v.status !== 'active') q.run("UPDATE curriculum_versions SET status = 'active' WHERE id = ?", v.id);
      continue;
    }
    const inUse = q.get("SELECT 1 FROM classes WHERE curriculum_version_id = ? AND status = 'active'", v.id);
    const next = inUse ? 'phasing_out' : 'retired';
    if (v.status !== next) q.run('UPDATE curriculum_versions SET status = ? WHERE id = ?', next, v.id);
  }
}
