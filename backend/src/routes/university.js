import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { requireRole } from '../auth.js';
import { config } from '../config.js';
import { q, update } from '../db.js';
import { badRequest, isTime, pick } from '../util.js';

const router = Router();

export function universityPayload(u) {
  if (!u) return null;
  return {
    ...u,
    logo_url: u.logo_path ? `/uploads/${u.logo_path}` : null,
    teaching_days: String(u.teaching_days || '').split(',').filter(Boolean).map(Number),
  };
}

export function validateUniversityFields(fields) {
  const out = { ...fields };
  for (const k of Object.keys(out)) if (typeof out[k] === 'string') out[k] = out[k].trim();
  if ('name' in out && !out.name) throw badRequest('University name is required');
  if (out.primary_color !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(out.primary_color)) throw badRequest('Primary colour must be a hex value like #1E5AA8');
    out.primary_color = out.primary_color.toUpperCase();
  }
  if (out.currency !== undefined) {
    out.currency = String(out.currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(out.currency)) throw badRequest('Currency must be a 3-letter code such as UGX');
  }
  const intIn = (k, min, max, label) => {
    if (out[k] === undefined) return;
    const n = Number(out[k]);
    if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${label} must be a whole number from ${min} to ${max}`);
    out[k] = n;
  };
  intIn('checkin_radius_m', 0, 20000, 'Check-in radius (m)');
  intIn('manual_mark_limit', 0, 100, 'Manual marks per term');
  intIn('correction_hours', 1, 720, 'Correction window (hours)');
  intIn('exam_min_attendance', 0, 100, 'Minimum attendance for exams (%)');
  intIn('coursework_min_percent', 0, 100, 'Minimum coursework mark (%)');
  if (out.claims_require_checkin !== undefined) out.claims_require_checkin = out.claims_require_checkin ? 1 : 0;
  for (const [k, lim] of [['checkin_latitude', 90], ['checkin_longitude', 180]]) {
    if (out[k] === undefined) continue;
    if (out[k] === '' || out[k] === null) out[k] = null;
    else if (!(Math.abs(Number(out[k])) <= lim)) throw badRequest('Enter the campus location as decimal latitude and longitude');
    else out[k] = Number(out[k]);
  }
  if (out.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: out.timezone });
    } catch {
      throw badRequest(`Unknown timezone "${out.timezone}"`);
    }
  }
  for (const k of ['day_start', 'day_end', 'lunch_start', 'lunch_end']) {
    if (out[k] === '' || out[k] === null) out[k] = k.startsWith('lunch') ? null : undefined;
    if (out[k] && !isTime(out[k])) throw badRequest(`${k} must use the HH:MM format`);
  }
  if (out.day_start && out.day_end && out.day_start >= out.day_end) throw badRequest('The teaching day must end after it starts');
  if (out.teaching_days !== undefined) {
    const days = (Array.isArray(out.teaching_days) ? out.teaching_days : String(out.teaching_days).split(','))
      .map(Number)
      .filter((d) => d >= 1 && d <= 7);
    if (!days.length) throw badRequest('Select at least one teaching day');
    out.teaching_days = [...new Set(days)].sort().join(',');
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

router.get('/', (req, res) => {
  res.json(universityPayload(q.get('SELECT * FROM universities WHERE id = ?', req.uid)));
});

router.put('/', requireRole('admin'), (req, res) => {
  const fields = validateUniversityFields(
    pick(req.body, [
      'name', 'short_name', 'address', 'email', 'phone', 'website', 'primary_color', 'timezone', 'currency',
      'checkin_latitude', 'checkin_longitude', 'checkin_radius_m', 'manual_mark_limit', 'correction_hours',
      'exam_min_attendance', 'coursework_min_percent', 'claims_require_checkin',
      'teaching_days', 'day_start', 'day_end', 'lunch_start', 'lunch_end',
    ]),
  );
  update('universities', req.uid, fields);
  res.json(universityPayload(q.get('SELECT * FROM universities WHERE id = ?', req.uid)));
});

const logoDir = path.join(config.uploadDir, 'logos');
const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(logoDir, { recursive: true });
      cb(null, logoDir);
    },
    filename: (req, file, cb) => cb(null, `uni-${req.uid}-${Date.now()}${EXT[file.mimetype]}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    EXT[file.mimetype] ? cb(null, true) : cb(badRequest('Logo must be a PNG, JPEG or WebP image')),
});

function removeLogoFile(logoPath) {
  if (!logoPath) return;
  fs.rm(path.join(config.uploadDir, logoPath), { force: true }, () => {});
}

router.post('/logo', requireRole('admin'), upload.single('logo'), (req, res) => {
  if (!req.file) throw badRequest('Attach an image in the "logo" field');
  const old = q.get('SELECT logo_path FROM universities WHERE id = ?', req.uid)?.logo_path;
  update('universities', req.uid, { logo_path: `logos/${req.file.filename}` });
  removeLogoFile(old);
  res.json(universityPayload(q.get('SELECT * FROM universities WHERE id = ?', req.uid)));
});

router.delete('/logo', requireRole('admin'), (req, res) => {
  const old = q.get('SELECT logo_path FROM universities WHERE id = ?', req.uid)?.logo_path;
  update('universities', req.uid, { logo_path: null });
  removeLogoFile(old);
  res.json(universityPayload(q.get('SELECT * FROM universities WHERE id = ?', req.uid)));
});

export default router;
