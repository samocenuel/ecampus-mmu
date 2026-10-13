import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

// Isolated in-memory database and upload folder for the test run.
process.env.DB_FILE = ':memory:';
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-test-'));
process.env.REMINDER_INTERVAL_MS = '3600000';

const { createApp } = await import('../src/app.js');
const { seedDemo, DEMO_PASSWORD } = await import('../src/seed.js');
const { q } = await import('../src/db.js');
const { runReminders } = await import('../src/services/schedule.js');
const { addDays, dowOf, zonedNow } = await import('../src/util.js');

let server;
let base;

async function api(method, url, { token, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data, type };
}

const login = async (email) => (await api('POST', '/api/auth/login', { body: { email, password: DEMO_PASSWORD } })).data.token;

before(async () => {
  seedDemo({ quiet: true });
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.closeAllConnections();
  server?.close();
});

describe('SaaS onboarding', () => {
  test('creates a university with its first administrator and enforces cross-cutting-first', async () => {
    const reg = await api('POST', '/api/auth/register-university', {
      body: {
        university: { name: 'Test University', short_name: 'TU', primary_color: '#aa3300', address: 'Main St', phone: '123' },
        admin: { name: 'Test Admin', email: 'admin@test.example', password: 'secret123' },
      },
    });
    assert.equal(reg.status, 201);
    assert.equal(reg.data.university.primary_color, '#AA3300');
    assert.equal(reg.data.user.role, 'admin');
    const token = reg.data.token;

    const fac = await api('POST', '/api/faculties', { token, body: { name: 'Faculty of Science', code: 'FOS' } });
    assert.equal(fac.status, 201);
    const dep = await api('POST', '/api/departments', { token, body: { name: 'Physics', faculty_id: fac.data.id } });
    assert.equal(dep.status, 201);
    assert.equal(dep.data.faculty_name, 'Faculty of Science');

    // No cross-cutting units yet: creating a programme-specific unit asks for confirmation.
    const warn = await api('POST', '/api/course-units', { token, body: { code: 'PHY101', name: 'Mechanics', department_id: dep.data.id } });
    assert.equal(warn.status, 409);
    assert.equal(warn.data.code, 'CROSS_CUTTING_FIRST');
    assert.equal(warn.data.requires_confirmation, true);
    const forced = await api('POST', '/api/course-units', { token, body: { code: 'PHY101', name: 'Mechanics', department_id: dep.data.id, force: true } });
    assert.equal(forced.status, 201);

    // Tenants are isolated from each other.
    const other = await api('GET', '/api/faculties', { token });
    assert.deepEqual(other.data.map((f) => f.name), ['Faculty of Science']);
  });

  test('rejects weak passwords and bad colours', async () => {
    const res = await api('POST', '/api/auth/register-university', {
      body: { university: { name: 'X', primary_color: 'blue' }, admin: { name: 'A', email: 'a@x.example', password: 'longenough' } },
    });
    assert.equal(res.status, 400);
  });
});

describe('Course units and load allocation', () => {
  test('non cross-cutting units cannot be shared across programmes', async () => {
    const token = await login('admin@demo.edu');
    const programs = (await api('GET', '/api/programs', { token })).data;
    const bit = programs.find((p) => p.code === 'BIT');
    const csc = (await api('GET', '/api/course-units?q=CSC1102', { token })).data[0];
    const res = await api('POST', `/api/programs/${bit.id}/course-units`, { token, body: { course_unit_id: csc.id, year_of_study: 1, semester: 1 } });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /cross-cutting/);
  });

  test('warns when allocating programme units while cross-cutting units are pending', async () => {
    const token = await login('admin@demo.edu');
    const programs = (await api('GET', '/api/programs', { token })).data;
    const bba = programs.find((p) => p.code === 'BBA');
    const bcom = programs.find((p) => p.code === 'BCOM');
    const cc = await api('POST', '/api/course-units', {
      token,
      body: {
        code: 'CBE2103', name: 'Business Ethics', is_cross_cutting: true, hours_per_week: 2,
        programs: [{ program_id: bba.id, year_of_study: 2, semester: 1 }, { program_id: bcom.id, year_of_study: 2, semester: 1 }],
      },
    });
    assert.equal(cc.status, 201);
    assert.equal(cc.data.programs.length, 2);

    const reqs = (await api('GET', '/api/allocations/requirements', { token })).data;
    assert.equal(reqs.summary.cross_cutting_complete, false);
    assert.ok(reqs.cross_cutting.some((u) => u.code === 'CBE2103' && !u.fully_allocated));

    const classes = (await api('GET', '/api/classes', { token })).data;
    const bcom2 = classes.find((c) => c.name === 'BCOM Year 2');
    const bba2 = classes.find((c) => c.name === 'BBA Year 2');
    const lecturers = (await api('GET', '/api/users?roles=lecturer', { token })).data;
    const taxation = (await api('GET', '/api/course-units?q=ACC2102', { token })).data[0];

    const warn = await api('POST', '/api/allocations', { token, body: { course_unit_id: taxation.id, lecturer_id: lecturers[0].id, class_ids: [bcom2.id] } });
    assert.equal(warn.status, 409);
    assert.equal(warn.data.code, 'CROSS_CUTTING_PENDING');
    assert.ok(warn.data.pending.some((p) => p.code === 'CBE2103'));

    // Allocate the cross-cutting unit to both classes together, then the warning disappears.
    const ccAlloc = await api('POST', '/api/allocations', { token, body: { course_unit_id: cc.data.id, lecturer_id: lecturers[1].id, class_ids: [bcom2.id, bba2.id] } });
    assert.equal(ccAlloc.status, 201);
    assert.equal(ccAlloc.data.classes.length, 2);
    const ok = await api('POST', '/api/allocations', { token, body: { course_unit_id: taxation.id, lecturer_id: lecturers[0].id, class_ids: [bcom2.id] } });
    assert.equal(ok.status, 201);

    // The same unit cannot be allocated twice to the same class.
    const dup = await api('POST', '/api/allocations', { token, body: { course_unit_id: taxation.id, lecturer_id: lecturers[2].id, class_ids: [bcom2.id] } });
    assert.equal(dup.status, 409);
  });
});

describe('Timetable', () => {
  test('detects room, lecturer and class collisions', async () => {
    const token = await login('admin@demo.edu');
    const { sessions } = (await api('GET', '/api/timetable', { token })).data;
    assert.ok(sessions.length > 30);
    const existing = sessions.find((s) => s.course_code === 'CSC1101');
    const other = (await api('GET', '/api/allocations', { token })).data.find((a) => a.code === 'CSC1102');

    // Same room, same time, same class (BSCS Year 1) -> blocked.
    const clash = await api('POST', '/api/timetable/sessions', {
      token,
      body: { allocation_id: other.id, room_id: existing.room_id, day_of_week: existing.day_of_week, start_time: existing.start_time, end_time: existing.end_time },
    });
    assert.equal(clash.status, 409);
    assert.equal(clash.data.code, 'TIMETABLE_CONFLICT');
    const types = clash.data.conflicts.map((c) => c.type);
    assert.ok(types.includes('room'));
    assert.ok(types.includes('class'));
  });

  test('generated timetable has no double bookings', () => {
    const rows = q.all(
      `SELECT a.id, b.id AS other FROM timetable_sessions a JOIN timetable_sessions b
         ON a.term_id = b.term_id AND a.day_of_week = b.day_of_week AND a.id < b.id
        AND a.start_time < b.end_time AND a.end_time > b.start_time
       JOIN allocations aa ON aa.id = a.allocation_id JOIN allocations bb ON bb.id = b.allocation_id
       WHERE a.room_id = b.room_id OR aa.lecturer_id = bb.lecturer_id
          OR EXISTS (SELECT 1 FROM allocation_classes x JOIN allocation_classes y ON x.class_id = y.class_id
                      WHERE x.allocation_id = aa.id AND y.allocation_id = bb.id)`,
    );
    assert.deepEqual(rows, []);
  });

  test('generation schedules newly allocated units', async () => {
    const token = await login('admin@demo.edu');
    const res = await api('POST', '/api/timetable/generate', { token, body: {} });
    assert.equal(res.status, 200);
    assert.ok(res.data.placed >= 2, `placed ${res.data.placed}`);
    assert.deepEqual(res.data.unplaced, []);
  });

  test('exports PDF and Excel', async () => {
    const token = await login('hod.cs@demo.edu');
    const pdf = await api('GET', '/api/timetable/export?format=pdf&mine=1', { token });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.data.subarray(0, 4).toString(), '%PDF');
    const classes = (await api('GET', '/api/classes', { token })).data;
    const xlsx = await api('GET', `/api/timetable/export?format=xlsx&class_id=${classes[0].id}`, { token });
    assert.equal(xlsx.status, 200);
    assert.equal(xlsx.data.subarray(0, 2).toString(), 'PK');

    // Download tokens work from a plain URL (used by the mobile app).
    const dl = (await api('POST', '/api/auth/download-token', { token })).data.token;
    const viaUrl = await fetch(`${base}/api/timetable/export?format=pdf&mine=1&token=${dl}`);
    assert.equal(viaUrl.status, 200);
    // ...but a normal session token is not accepted in the URL.
    const bad = await fetch(`${base}/api/timetable/export?format=pdf&mine=1&token=${token}`);
    assert.equal(bad.status, 401);
  });

  test('students only see their own class timetable', async () => {
    const token = await login('student.bscs1@students.demo.edu');
    const mine = await api('GET', '/api/timetable', { token });
    assert.equal(mine.status, 200);
    assert.ok(mine.data.sessions.every((s) => s.classes.some((c) => c.name === 'BSCS Year 1')));
    const other = await api('GET', '/api/timetable?room_id=1', { token });
    assert.equal(other.status, 403);
  });
});

describe('Attendance', () => {
  test('class rep submits, lecturer approves, student sees history', async () => {
    const repToken = await login('rep.bscs1@students.demo.edu');
    const me = (await api('GET', '/api/auth/me', { token: repToken })).data.user;
    assert.equal(me.is_class_rep, true);

    // Pick last week's occurrence of a BSCS Year 1 lecture and clear its register.
    const { sessions } = (await api('GET', '/api/timetable', { token: repToken })).data;
    const s = sessions[0];
    const today = zonedNow('Africa/Kampala').date;
    let date = addDays(today, -1);
    while (dowOf(date) !== s.day_of_week) date = addDays(date, -1);
    q.run('DELETE FROM attendance_registers WHERE session_id = ? AND lecture_date = ?', s.id, date);

    const sheet = (await api('GET', `/api/attendance/sessions/${s.id}/sheet?class_id=${me.class_id}&date=${date}`, { token: repToken })).data;
    assert.equal(sheet.can_edit, true);
    const presentIds = sheet.students.slice(0, 10).map((st) => st.id);

    const wrongDay = await api('POST', '/api/attendance/registers', {
      token: repToken,
      body: { session_id: s.id, class_id: me.class_id, date: addDays(date, 1), present_student_ids: presentIds },
    });
    assert.equal(wrongDay.status, 400);

    const submit = await api('POST', '/api/attendance/registers', {
      token: repToken,
      body: { session_id: s.id, class_id: me.class_id, date, present_student_ids: presentIds, topic: 'Loops' },
    });
    assert.equal(submit.status, 201);
    assert.equal(submit.data.status, 'submitted');
    assert.equal(submit.data.present_count, 10);

    // A classmate who is not the rep cannot submit.
    const mateToken = await login('student.bscs1@students.demo.edu');
    const notRep = await api('POST', '/api/attendance/registers', {
      token: mateToken,
      body: { session_id: s.id, class_id: me.class_id, date, present_student_ids: [] },
    });
    assert.equal(notRep.status, 403);

    const lecturer = q.get('SELECT email FROM users WHERE id = ?', s.lecturer_id).email;
    const lecToken = await login(lecturer);
    const pending = (await api('GET', '/api/attendance/registers?status=submitted', { token: lecToken })).data;
    assert.ok(pending.some((r) => r.id === submit.data.id));
    const approve = await api('POST', `/api/attendance/registers/${submit.data.id}/review`, { token: lecToken, body: { action: 'approve' } });
    assert.equal(approve.status, 200);
    assert.equal(approve.data.status, 'approved');

    const locked = await api('POST', '/api/attendance/registers', {
      token: repToken,
      body: { session_id: s.id, class_id: me.class_id, date, present_student_ids: [] },
    });
    assert.equal(locked.status, 409);

    const history = (await api('GET', '/api/attendance/my-history', { token: mateToken })).data;
    assert.ok(history.summary.total > 0);
    assert.ok(history.records.some((r) => r.register_id === submit.data.id));
  });
});

describe('Account deletion and public pages', () => {
  test('users can delete their own account; personal data is erased', async () => {
    // Use a student no other test relies on.
    const { email } = q.get(
      "SELECT u.email FROM users u JOIN classes c ON c.id = u.class_id WHERE c.name = 'BBA Year 2' AND u.id != c.class_rep_id ORDER BY u.id LIMIT 1",
    );
    const token = await login(email);
    const me = (await api('GET', '/api/auth/me', { token })).data.user;
    const wrong = await api('POST', '/api/auth/delete-account', { token, body: { password: 'nope' } });
    assert.equal(wrong.status, 400);
    const ok = await api('POST', '/api/auth/delete-account', { token, body: { password: DEMO_PASSWORD } });
    assert.equal(ok.status, 200);
    const row = q.get('SELECT name, email, phone, identifier, active FROM users WHERE id = ?', me.id);
    assert.deepEqual(row, { name: 'Deleted user', email: `deleted-${me.id}@deleted.invalid`, phone: null, identifier: null, active: 0 });
    const relogin = await api('POST', '/api/auth/login', { body: { email, password: DEMO_PASSWORD } });
    assert.equal(relogin.status, 401);
    // The only administrator cannot delete themselves.
    const admin = await api('POST', '/api/auth/delete-account', { token: await login('admin@demo.edu'), body: { password: DEMO_PASSWORD } });
    assert.equal(admin.status, 400);
  });

  test('privacy policy and account deletion pages are public', async () => {
    for (const path of ['/privacy', '/account-deletion']) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /eCampus MMU/);
    }
  });
});

describe('Reports and notifications', () => {
  test('reports are scoped to the viewer’s unit', async () => {
    const admin = (await api('GET', '/api/reports/overview', { token: await login('admin@demo.edu') })).data;
    const dean = (await api('GET', '/api/reports/overview', { token: await login('dean.fst@demo.edu') })).data;
    const hod = (await api('GET', '/api/reports/overview', { token: await login('hod.cs@demo.edu') })).data;
    assert.equal(admin.counts.departments, 4);
    assert.equal(dean.counts.departments, 2);
    assert.equal(hod.counts.departments, 1);
    assert.equal(hod.scope, 'Computer Science');
    assert.ok(admin.attendance.average_rate > 50);
    assert.ok(admin.attendance.at_risk.length > 0);
    const student = await api('GET', '/api/reports/overview', { token: await login('student.bscs1@students.demo.edu') });
    assert.equal(student.status, 403);
  });

  test('reminders respect each user’s lead time', async () => {
    const token = await login('student.bscs1@students.demo.edu');
    const prefs = await api('PUT', '/api/notifications/preferences', { token, body: { enabled: true, minutes_before: 30 } });
    assert.equal(prefs.data.minutes_before, 30);
    const upcoming = (await api('GET', '/api/notifications/upcoming?days=7', { token })).data;
    assert.ok(upcoming.items.length > 0);

    // Simulate the clock 20 minutes before the student's next lecture.
    const next = upcoming.items.find((i) => !i.in_progress);
    const [h, m] = next.start_time.split(':').map(Number);
    const at = new Date(`${next.date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+03:00`);
    at.setMinutes(at.getMinutes() - 20);
    runReminders(at);
    runReminders(at); // idempotent
    const { items } = (await api('GET', '/api/notifications?unread=1', { token })).data;
    const reminders = items.filter((n) => n.type === 'reminder' && n.title.startsWith(next.course_code));
    assert.equal(reminders.length, 1);
  });
});

describe('Hosting under a sub-path', () => {
  test('serves the API and public pages under BASE_PATH, with or without the prefix', async () => {
    const sub = createApp({ basePath: '/ecampus' }).listen(0);
    await new Promise((r) => sub.once('listening', r));
    const root = `http://127.0.0.1:${sub.address().port}`;
    try {
      const health = await fetch(`${root}/ecampus/api/health`);
      assert.equal(health.status, 200);
      assert.equal((await health.json()).ok, true);
      const privacy = await fetch(`${root}/ecampus/privacy`);
      assert.equal(privacy.status, 200);
      assert.match(await privacy.text(), /Privacy policy/);
      const login = await fetch(`${root}/ecampus/api/auth/login?x=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@demo.edu', password: DEMO_PASSWORD }),
      });
      assert.equal(login.status, 200);
      // A host that strips the prefix itself still works.
      assert.equal((await fetch(`${root}/api/health`)).status, 200);
      // Paths that only start with the same letters are not rewritten to the API.
      const lookalike = await fetch(`${root}/ecampusx/api/health`);
      assert.doesNotMatch(lookalike.headers.get('content-type') || '', /json/);
    } finally {
      sub.closeAllConnections();
      sub.close();
    }
  });
});
