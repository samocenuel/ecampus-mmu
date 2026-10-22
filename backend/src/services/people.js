// People's own contact details, and account deletion: requested, approved by the university's
// administrator, archived (restorable) for the university's archive period, then erased.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashPassword } from '../auth.js';
import { config } from '../config.js';
import { q, tx } from '../db.js';
import { addDays, badRequest } from '../util.js';
import { notify } from './notify.js';

/** Contacts a person maintains themselves (the photo has its own endpoint). */
export const CONTACT_FIELDS = ['phone', 'alt_phone', 'contact_email', 'office', 'address', 'emergency_name', 'emergency_phone'];

export function cleanContacts(data) {
  const out = {};
  for (const k of CONTACT_FIELDS) {
    if (data[k] === undefined) continue;
    const v = String(data[k] ?? '').trim().slice(0, k === 'address' ? 300 : 120);
    if (v && k === 'contact_email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw badRequest('Enter a valid contact email address');
    if (v && /phone/.test(k) && !/^[+\d][\d\s()-]{5,}$/.test(v)) throw badRequest('Enter a valid phone number');
    out[k] = v || null;
  }
  return out;
}

const adminIds = (universityId) => q.all("SELECT id FROM users WHERE university_id = ? AND role = 'admin' AND active = 1", universityId).map((r) => r.id);

/** Opens a deletion request (one at a time per person) and tells the administrators. */
export function requestDeletion(user, requester, reason) {
  const open = q.get("SELECT * FROM account_deletions WHERE user_id = ? AND status IN ('pending','archived')", user.id);
  if (open) throw badRequest(open.status === 'pending' ? 'A deletion request for this account is already waiting for the administrator' : 'This account is already archived for deletion');
  const id = q.run(
    'INSERT INTO account_deletions (university_id, user_id, requested_by, reason) VALUES (?, ?, ?, ?)',
    user.university_id,
    user.id,
    requester.id,
    String(reason || '').trim().slice(0, 500) || null,
  ).lastInsertRowid;
  const by = requester.id === user.id ? `${user.name} asked to delete their account` : `${requester.name} asked to delete ${user.name}'s account`;
  notify(adminIds(user.university_id).filter((a) => a !== user.id), { title: 'Account deletion to approve', body: by, type: 'account', link: '/users?tab=deletions' });
  return q.get('SELECT * FROM account_deletions WHERE id = ?', id);
}

/** The administrator approves: the account is disabled now and erased after the archive period. */
export function approveDeletion(request, admin, note) {
  const uni = q.get('SELECT account_archive_days FROM universities WHERE id = ?', request.university_id);
  const days = Math.max(0, uni?.account_archive_days ?? 30);
  const purgeAfter = addDays(new Date().toISOString().slice(0, 10), days);
  tx(() => {
    q.run(
      "UPDATE account_deletions SET status = 'archived', decided_by = ?, decided_at = datetime('now'), decision_note = ?, purge_after = ? WHERE id = ?",
      admin.id,
      note || null,
      purgeAfter,
      request.id,
    );
    q.run('UPDATE users SET active = 0 WHERE id = ?', request.user_id);
    q.run('UPDATE classes SET class_rep_id = NULL WHERE class_rep_id = ?', request.user_id);
  });
  if (days === 0) purgeAccount(request.user_id, request.id);
  return q.get('SELECT * FROM account_deletions WHERE id = ?', request.id);
}

/** Restores an archived account before it is erased. */
export function restoreAccount(request, admin, note) {
  tx(() => {
    q.run("UPDATE account_deletions SET status = 'restored', decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?", admin.id, note || null, request.id);
    q.run('UPDATE users SET active = 1 WHERE id = ?', request.user_id);
  });
  notify(request.user_id, { title: 'Your account was restored', body: 'The deletion was cancelled and you can sign in again.', type: 'account', link: '/profile' });
}

/** Erases the person's data; anonymised teaching and attendance records stay for the statistics. */
export function purgeAccount(userId, requestId) {
  const user = q.get('SELECT id, photo_path FROM users WHERE id = ?', userId);
  if (!user) return;
  tx(() => {
    q.run(
      `UPDATE users SET name = 'Deleted user', email = ?, password_hash = ?, phone = NULL, identifier = NULL, title = NULL, designation = NULL,
              alt_phone = NULL, contact_email = NULL, office = NULL, address = NULL, emergency_name = NULL, emergency_phone = NULL,
              photo_path = NULL, calendar_token = NULL, active = 0 WHERE id = ?`,
      `deleted-${userId}@deleted.invalid`,
      hashPassword(crypto.randomBytes(24).toString('hex')),
      userId,
    );
    q.run('UPDATE classes SET class_rep_id = NULL WHERE class_rep_id = ?', userId);
    q.run('UPDATE faculties SET dean_id = NULL WHERE dean_id = ?', userId);
    q.run('UPDATE departments SET hod_id = NULL WHERE hod_id = ?', userId);
    q.run('DELETE FROM notifications WHERE user_id = ?', userId);
    q.run('DELETE FROM notification_prefs WHERE user_id = ?', userId);
    q.run('DELETE FROM student_devices WHERE user_id = ?', userId);
    if (requestId) q.run("UPDATE account_deletions SET status = 'purged', purged_at = datetime('now'), reason = NULL WHERE id = ?", requestId);
  });
  if (user.photo_path) fs.rm(path.join(config.uploadDir, user.photo_path), { force: true }, () => {});
}

/** Scheduler: erase accounts whose archive period has ended. */
export function runAccountPurge(today = new Date().toISOString().slice(0, 10)) {
  let n = 0;
  for (const r of q.all("SELECT id, user_id FROM account_deletions WHERE status = 'archived' AND purge_after <= ?", today)) {
    purgeAccount(r.user_id, r.id);
    n++;
  }
  return n;
}
