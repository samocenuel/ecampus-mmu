import { q } from '../db.js';

/**
 * Create an in-app notification for one or more users. A `dedupeKey` makes the
 * call idempotent (used by lecture reminders so each fires once per user).
 */
export function notify(userIds, { title, body = null, type = 'info', link = null, dedupeKey = null }) {
  const ids = [...new Set([].concat(userIds).filter(Boolean))];
  let created = 0;
  for (const uid of ids) {
    const key = dedupeKey ? `${dedupeKey}:${uid}` : null;
    const res = q.run(
      'INSERT OR IGNORE INTO notifications (user_id, title, body, type, link, dedupe_key) VALUES (?, ?, ?, ?, ?, ?)',
      uid,
      title,
      body,
      type,
      link,
      key,
    );
    created += Number(res.changes);
  }
  return created;
}
