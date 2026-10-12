import { Router } from 'express';
import { q } from '../db.js';
import { notify } from '../services/notify.js';
import { notificationPrefs, upcomingForUser } from '../services/schedule.js';
import { badRequest, toInt, truthy } from '../util.js';

const router = Router();

router.get('/', (req, res) => {
  const limit = Math.min(toInt(req.query.limit) || 50, 200);
  const unreadOnly = truthy(req.query.unread);
  const items = q.all(
    `SELECT * FROM notifications WHERE user_id = ? ${unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY id DESC LIMIT ${limit}`,
    req.user.id,
  );
  const unread = q.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', req.user.id).n;
  res.json({ items, unread_count: unread });
});

router.post('/read-all', (req, res) => {
  q.run("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL", req.user.id);
  res.json({ ok: true });
});

router.post('/:id/read', (req, res) => {
  q.run("UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND user_id = ? AND read_at IS NULL", req.params.id, req.user.id);
  res.json({ ok: true });
});

router.get('/preferences', (req, res) => {
  const p = notificationPrefs(req.user.id);
  res.json({ enabled: Boolean(p.enabled), minutes_before: p.minutes_before });
});

router.put('/preferences', (req, res) => {
  const current = notificationPrefs(req.user.id);
  const enabled = req.body?.enabled !== undefined ? (truthy(req.body.enabled) ? 1 : 0) : current.enabled;
  const minutes = req.body?.minutes_before !== undefined ? toInt(req.body.minutes_before) : current.minutes_before;
  if (!(minutes >= 1 && minutes <= 120)) throw badRequest('Reminder time must be between 1 and 120 minutes');
  q.run(
    `INSERT INTO notification_prefs (user_id, enabled, minutes_before) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET enabled = excluded.enabled, minutes_before = excluded.minutes_before`,
    req.user.id,
    enabled,
    minutes,
  );
  res.json({ enabled: Boolean(enabled), minutes_before: minutes });
});

/** Upcoming lecture occurrences - the mobile app schedules local alarms from this. */
router.get('/upcoming', (req, res) => {
  res.json(upcomingForUser(req.user, Math.min(toInt(req.query.days) || 7, 28)));
});

/** Sends the user a sample notification so they can check their device/browser settings. */
router.post('/test', (req, res) => {
  notify(req.user.id, { title: 'Test notification', body: 'Lecture reminders are working on this device.', type: 'info' });
  res.json({ ok: true });
});

export default router;
