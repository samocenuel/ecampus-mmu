import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import { authenticate, requireTenant } from './auth.js';
import { config } from './config.js';
import { q } from './db.js';
import { HttpError } from './util.js';
import authRoutes from './routes/auth.js';
import publicPages from './routes/public-pages.js';
import platformRoutes from './routes/platform.js';
import universityRoutes from './routes/university.js';
import structureRoutes from './routes/structure.js';
import userRoutes from './routes/users.js';
import academicRoutes from './routes/academics.js';
import allocationRoutes from './routes/allocations.js';
import timetableRoutes from './routes/timetable.js';
import attendanceRoutes from './routes/attendance.js';
import notificationRoutes from './routes/notifications.js';
import reportRoutes from './routes/reports.js';
import dashboardRoutes from './routes/dashboard.js';
import claimRoutes from './routes/claims.js';
import calendarRoutes from './routes/calendar.js';
import checkinRoutes from './routes/checkin.js';
import examRoutes from './routes/exams.js';
import opsRoutes from './routes/ops.js';

const UNIQUE_MESSAGES = {
  'users.email': 'A user with that email address already exists',
  'programs.university_id, programs.code': 'A programme with that code already exists',
  'course_units.university_id, course_units.code': 'A course unit with that code already exists',
  'program_course_units.program_id, program_course_units.course_unit_id': 'That course unit is already part of this programme',
  'universities.slug': 'A university with that short name already exists',
  'attendance_registers.session_id, attendance_registers.class_id, attendance_registers.lecture_date':
    'A register already exists for that lecture',
};

function errorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'The file is too large' });
  const msg = String(err?.message || '');
  const unique = msg.match(/UNIQUE constraint failed: (.+)$/);
  if (unique) return res.status(409).json({ error: UNIQUE_MESSAGES[unique[1]] || 'That record already exists' });
  if (msg.includes('FOREIGN KEY constraint failed')) {
    return res.status(400).json({ error: 'A referenced record does not exist or is still in use' });
  }
  if (msg.includes('CHECK constraint failed')) return res.status(400).json({ error: 'Invalid value supplied' });
  // Client errors raised by middleware (e.g. a missing static file is a 404).
  const status = err?.status || err?.statusCode;
  if (status >= 400 && status < 500) return res.status(status).json({ error: err.expose ? msg : 'Request failed' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
}

export function createApp({ basePath = config.basePath } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  // Under a sub-path (e.g. /ecampus) the routes below see paths without the prefix,
  // whether or not the host forwards it.
  if (basePath) {
    app.use((req, _res, next) => {
      if (req.url === basePath || req.url.startsWith(`${basePath}/`) || req.url.startsWith(`${basePath}?`)) {
        req.url = req.url.slice(basePath.length);
        if (!req.url.startsWith('/')) req.url = `/${req.url}`;
      }
      next();
    });
  }
  app.use(
    cors({
      origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map((s) => s.trim()),
      exposedHeaders: ['Content-Disposition'],
    }),
  );
  app.use(express.json({ limit: '2mb' }));

  fs.mkdirSync(config.uploadDir, { recursive: true });
  app.use('/uploads', express.static(config.uploadDir, { maxAge: '7d', fallthrough: false }));

  app.get('/api/health', (_req, res) =>
    res.json({
      ok: true,
      time: new Date().toISOString(),
      // Lets the sign-in screens offer the demo accounts when the demo tenant exists.
      demo: Boolean(q.get("SELECT 1 FROM universities WHERE slug = 'demo-university' AND active = 1")),
    }),
  );
  app.use('/', publicPages);
  app.use('/api/auth', authRoutes);
  app.use('/api/platform', authenticate, platformRoutes);
  // Calendar feeds are opened by calendar apps, so they use a secret link instead of a sign-in.
  app.use('/api/calendar', calendarRoutes);

  const tenant = express.Router();
  tenant.use(authenticate, requireTenant);
  tenant.use('/university', universityRoutes);
  tenant.use('/', structureRoutes);
  tenant.use('/users', userRoutes);
  tenant.use('/', academicRoutes);
  tenant.use('/allocations', allocationRoutes);
  tenant.use('/timetable', timetableRoutes);
  tenant.use('/attendance', attendanceRoutes);
  tenant.use('/notifications', notificationRoutes);
  tenant.use('/reports', reportRoutes);
  tenant.use('/dashboard', dashboardRoutes);
  tenant.use('/claims', claimRoutes);
  tenant.use('/checkin', checkinRoutes);
  tenant.use('/ops', opsRoutes);
  tenant.use('/exams', examRoutes);
  app.use('/api', tenant);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // The Flutter app's web build, if present, is served at /m/ (handy for demos).
  const mobileIndex = path.join(config.mobileWebDist, 'index.html');
  if (fs.existsSync(mobileIndex)) {
    app.use('/m', express.static(config.mobileWebDist, { index: 'index.html' }));
    app.use('/m', (req, res, next) => (req.method === 'GET' ? res.sendFile(mobileIndex) : next()));
  }

  // In production the API also serves the built web app.
  const index = path.join(config.webDist, 'index.html');
  if (fs.existsSync(index)) {
    app.use(express.static(config.webDist, { index: false }));
    app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(index) : next()));
  }

  app.use(errorHandler);
  return app;
}
