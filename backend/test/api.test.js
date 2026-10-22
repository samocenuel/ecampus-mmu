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
    // The request waits for the administrator; the person can still sign in until it is approved.
    const ok = await api('POST', '/api/auth/delete-account', { token, body: { password: DEMO_PASSWORD, reason: 'Leaving the university' } });
    assert.equal(ok.status, 201);
    assert.equal(ok.data.request.status, 'pending');
    assert.equal((await api('POST', '/api/auth/delete-account', { token, body: { password: DEMO_PASSWORD } })).status, 400); // one at a time
    assert.equal((await api('GET', '/api/auth/me', { token })).status, 200);
    const admin = await login('admin@demo.edu');
    const queue = await api('GET', '/api/users/deletions/list', { token: admin });
    const reqRow = queue.data.items.find((r) => r.user_id === me.id);
    assert.equal(reqRow.status, 'pending');
    assert.equal(queue.data.archive_days, 30);
    // The HoD cannot approve; the administrator archives it.
    assert.equal((await api('POST', `/api/users/deletions/${reqRow.id}/approve`, { token: await login('hod.cs@demo.edu') })).status, 403);
    const approved = await api('POST', `/api/users/deletions/${reqRow.id}/approve`, { token: admin, body: { note: 'Confirmed with registry' } });
    assert.equal(approved.data.status, 'archived');
    assert.ok(approved.data.purge_after > new Date().toISOString().slice(0, 10));
    const relogin = await api('POST', '/api/auth/login', { body: { email, password: DEMO_PASSWORD } });
    assert.equal(relogin.status, 403);
    assert.match(relogin.data.error, /archived for deletion/);
    // Archived: the data is still there and can be restored.
    assert.equal(q.get('SELECT name FROM users WHERE id = ?', me.id).name, me.name);
    const restored = await api('POST', `/api/users/deletions/${reqRow.id}/restore`, { token: admin });
    assert.equal(restored.data.status, 'restored');
    assert.equal((await api('POST', '/api/auth/login', { body: { email, password: DEMO_PASSWORD } })).status, 200);
    // Ask again, approve, and let the archive period pass: the scheduler erases the account.
    const again = await api('POST', '/api/auth/delete-account', { token: await login(email), body: { password: DEMO_PASSWORD } });
    await api('POST', `/api/users/deletions/${again.data.request.id}/approve`, { token: admin });
    const { runAccountPurge } = await import('../src/services/people.js');
    assert.equal(runAccountPurge(addDays(new Date().toISOString().slice(0, 10), 31)), 1);
    const row = q.get('SELECT name, email, phone, identifier, active FROM users WHERE id = ?', me.id);
    assert.deepEqual(row, { name: 'Deleted user', email: `deleted-${me.id}@deleted.invalid`, phone: null, identifier: null, active: 0 });
    assert.equal(q.get('SELECT status FROM account_deletions WHERE id = ?', again.data.request.id).status, 'purged');
    // The shared demo administrator cannot be deleted (the last-admin rule is checked after this).
    const demoAdmin = await api('POST', '/api/auth/delete-account', { token: admin, body: { password: DEMO_PASSWORD } });
    assert.equal(demoAdmin.status, 403); // shared demo accounts cannot be deleted
  });

  test('privacy policy and account deletion pages are public', async () => {
    for (const path of ['/privacy', '/account-deletion']) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /eCampus/);
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

describe('Role scopes and demo access', () => {
  const codes = (rows, key = 'code') => rows.map((r) => r[key]).sort();

  test('a HoD sees only their department, its programmes and the course units that concern it', async () => {
    const token = await login('hod.cs@demo.edu');
    const depts = (await api('GET', '/api/departments', { token })).data;
    assert.deepEqual(codes(depts), ['CS']);
    assert.deepEqual(codes((await api('GET', '/api/faculties', { token })).data), ['FST']);
    assert.deepEqual(codes((await api('GET', '/api/programs', { token })).data), ['BSCS']);
    const units = codes((await api('GET', '/api/course-units', { token })).data);
    assert.ok(units.includes('CSC1101') && units.includes('CCS1101'), 'own units and cross-cutting units taught to BSCS');
    assert.ok(!units.includes('BIT1101') && !units.includes('ACC1101'), 'no other departments\' own units');
    const classes = (await api('GET', '/api/classes', { token })).data;
    assert.ok(classes.length > 0 && classes.every((c) => c.program_code === 'BSCS'));
  });

  test('course units say whether they are shared in or out, and only the owner may change them', async () => {
    const token = await login('hod.cs@demo.edu');
    const all = (await api('GET', '/api/course-units', { token })).data;
    const byCode = Object.fromEntries(all.map((u) => [u.code, u]));
    assert.equal(byCode.CCS1101.sharing, 'in');
    assert.equal(byCode.CCS1101.can_manage, false);
    assert.equal(byCode.CEP2102.sharing, 'out');
    assert.equal(byCode.CSC1101.sharing, 'own');
    assert.equal(byCode.CSC1101.can_manage, true);
    const shared = (await api('GET', '/api/course-units?sharing=in', { token })).data;
    assert.ok(shared.length > 0 && shared.every((u) => u.sharing === 'in'));
    assert.equal((await api('PUT', `/api/course-units/${byCode.CCS1101.id}`, { token, body: { name: 'Renamed' } })).status, 403);
  });

  test('people lists show only the people attached to the viewer', async () => {
    const hod = await login('hod.cs@demo.edu');
    const csUsers = (await api('GET', '/api/users', { token: hod })).data;
    assert.ok(csUsers.length > 3 && csUsers.every((u) => u.department_name === 'Computer Science' || u.email === 'hod.cs@demo.edu'));
    const itHod = q.get("SELECT id FROM users WHERE email = 'hod.it@demo.edu'");
    assert.equal((await api('GET', `/api/users/${itHod.id}`, { token: hod })).status, 404);

    const dean = await login('dean.fst@demo.edu');
    const fst = (await api('GET', '/api/users', { token: dean })).data;
    const deptNames = new Set(fst.map((u) => u.department_name).filter(Boolean));
    assert.deepEqual([...deptNames].sort(), ['Computer Science', 'Information Technology']);
    assert.deepEqual(codes((await api('GET', '/api/programs', { token: dean })).data), ['BIT', 'BSCS']);

    const lecturer = await login('brian.kato@demo.edu');
    const mine = (await api('GET', '/api/users', { token: lecturer })).data;
    assert.ok(mine.every((u) => u.role === 'student' || u.email === 'brian.kato@demo.edu'), 'a lecturer sees only their own students');
  });

  test('the owning department plans a cross-cutting unit for every class; others see only their own classes', async () => {
    const owner = (await api('GET', '/api/allocations/requirements', { token: await login('hod.ba@demo.edu') })).data;
    const ccsForOwner = owner.units.find((u) => u.code === 'CCS1101');
    assert.ok(ccsForOwner.classes.some((c) => c.program_code === 'BSCS') && ccsForOwner.classes.some((c) => c.program_code === 'BBA'));
    const cs = (await api('GET', '/api/allocations/requirements', { token: await login('hod.cs@demo.edu') })).data;
    const ccsForCs = cs.units.find((u) => u.code === 'CCS1101');
    assert.ok(ccsForCs && ccsForCs.classes.every((c) => c.program_code === 'BSCS'));
    assert.ok(!cs.units.some((u) => u.code === 'BIT1101'));
  });

  test('visitors can try any demo role without an account, and the demo accounts stay usable', async () => {
    const info = (await api('GET', '/api/auth/demo')).data;
    assert.equal(info.available, true);
    assert.deepEqual(info.roles.map((r) => r.key), ['admin', 'dean', 'hod', 'lecturer', 'part_time', 'class_rep', 'student', 'hr']);
    const s = await api('POST', '/api/auth/demo', { body: { role: 'hod' } });
    assert.equal(s.status, 200);
    assert.equal(s.data.user.email, 'hod.cs@demo.edu');
    assert.equal(s.data.demo, true);
    assert.equal((await api('POST', '/api/auth/demo', { body: { role: 'nope' } })).status, 400);
    const change = await api('POST', '/api/auth/change-password', { token: s.data.token, body: { current_password: DEMO_PASSWORD, new_password: 'Something-new-1' } });
    assert.equal(change.status, 403);
    const rep = q.get("SELECT id FROM users WHERE email = 'rep.bscs1@students.demo.edu'");
    const admin = await login('admin@demo.edu');
    assert.equal((await api('PUT', `/api/users/${rep.id}`, { token: admin, body: { email: 'x@y.example' } })).status, 403);
    assert.equal((await api('DELETE', `/api/users/${rep.id}`, { token: admin })).status, 403);
  });
});

describe('Part-time pay claims', () => {
  const claimOf = async (token, id) => (await api('GET', `/api/claims/${id}`, { token })).data;

  test('the Dean sets the faculty rates; HoDs cannot, and lecturers see their own faculty only', async () => {
    const dean = await login('dean.fst@demo.edu');
    const fst = q.get("SELECT id FROM faculties WHERE code = 'FST'").id;
    const fbm = q.get("SELECT id FROM faculties WHERE code = 'FBM'").id;
    const created = await api('POST', '/api/claims/rates', { token: dean, body: { faculty_id: fst, name: 'Practical demonstration', unit: 'hour', amount: 20000 } });
    assert.equal(created.status, 201);
    assert.equal((await api('POST', '/api/claims/rates', { token: dean, body: { faculty_id: fbm, name: 'X', amount: 1 } })).status, 403);
    assert.equal((await api('POST', '/api/claims/rates', { token: dean, body: { faculty_id: fst, kind: 'teaching', name: 'Teaching 2', amount: 1 } })).status, 400, 'one teaching rate per faculty');
    assert.equal((await api('POST', '/api/claims/rates', { token: await login('hod.cs@demo.edu'), body: { faculty_id: fst, name: 'X', amount: 1 } })).status, 403);
    const seen = (await api('GET', '/api/claims/rates', { token: await login('esther.atim@demo.edu') })).data;
    assert.ok(seen.length > 0 && seen.every((r) => r.faculty_id === fst));
  });

  test('only part-time lecturers raise claims, built from attendance-approved lectures that are never claimed twice', async () => {
    assert.equal((await api('POST', '/api/claims', { token: await login('brian.kato@demo.edu'), body: { period_start: '2026-01-01', period_end: '2026-01-31' } })).status, 403);
    const esther = await login('esther.atim@demo.edu');
    const today = zonedNow('Africa/Kampala').date;
    const res = await api('POST', '/api/claims', { token: esther, body: { period_start: addDays(today, -30), period_end: today } });
    assert.equal(res.status, 201);
    const claim = await claimOf(esther, res.data.id);
    const keys = claim.lines.filter((l) => l.kind === 'teaching').map((l) => `${l.session_id}@${l.work_date}`);
    const claimedElsewhere = q.all("SELECT session_id || '@' || work_date AS k FROM pay_claim_lines WHERE kind = 'teaching' AND claim_id <> ?", claim.id).map((r) => r.k);
    assert.ok(keys.every((k) => !claimedElsewhere.includes(k)), 'no lecture appears on two claims');
    assert.ok(claim.lines.every((l) => l.students_total > 0 && l.students_present <= l.students_total));
    assert.equal(claim.status, 'draft');

    const marking = (await api('GET', '/api/claims/rates', { token: esther })).data.find((r) => r.name === 'Marking');
    const added = await api('POST', `/api/claims/${claim.id}/lines`, { token: esther, body: { rate_id: marking.id, quantity: 30, work_date: today, description: 'CSC1103 quiz scripts' } });
    assert.equal(added.status, 201);
    assert.equal((await api('GET', `/api/claims/${claim.id}`, { token: await login('hod.cs@demo.edu') })).status, 404, 'drafts are private');
    assert.equal((await api('DELETE', `/api/claims/${claim.id}`, { token: esther })).status, 200);
  });

  test('HoD, Dean and HR approve in turn, a returned claim can be resubmitted, and HR records the payment', async () => {
    const id = q.get("SELECT pc.id FROM pay_claims pc JOIN users u ON u.id = pc.lecturer_id WHERE u.email = 'esther.atim@demo.edu' AND pc.status = 'submitted'").id;
    const [esther, hod, dean, otherDean, hr] = await Promise.all(['esther.atim@demo.edu', 'hod.cs@demo.edu', 'dean.fst@demo.edu', 'dean.fbm@demo.edu', 'hr@demo.edu'].map(login));

    assert.equal((await api('POST', `/api/claims/${id}/approve`, { token: dean })).status, 403, 'the Dean waits for the HoD');
    const bare = await fetch(`${base}/api/claims/${id}/reject`, { method: 'POST', headers: { Authorization: `Bearer ${hod}` } });
    assert.equal(bare.status, 400, 'actions posted without a body are validated, not a server error');
    assert.equal((await api('POST', `/api/claims/${id}/reject`, { token: hod, body: {} })).status, 400, 'returning needs a reason');
    assert.equal((await api('POST', `/api/claims/${id}/reject`, { token: hod, body: { note: 'Add the test date' } })).data.status, 'rejected');
    assert.equal((await api('POST', `/api/claims/${id}/submit`, { token: esther })).data.status, 'submitted');

    assert.equal((await api('POST', `/api/claims/${id}/approve`, { token: hod })).data.status, 'hod_approved');
    assert.equal((await api('GET', `/api/claims/${id}`, { token: otherDean })).status, 404, 'other faculties cannot see it');
    // The Dean signs off as Vote Controller: the claim must be charged to a vote, which the Dean can create.
    assert.equal((await api('POST', `/api/claims/${id}/approve`, { token: dean })).status, 400, 'the Dean must choose a vote');
    const fst = q.get("SELECT id FROM faculties WHERE code = 'FST'").id;
    const vote = await api('POST', '/api/claims/votes', { token: dean, body: { faculty_id: fst, code: 'FST-TEST-01', name: 'Test vote', amount: 1000000, financial_year: '2026/2027' } });
    assert.equal(vote.status, 201);
    assert.equal((await api('POST', '/api/claims/votes', { token: otherDean, body: { faculty_id: fst, code: 'X', name: 'X', amount: 1 } })).status, 403, 'only the faculty Dean creates its votes');
    const signed = await api('POST', `/api/claims/${id}/approve`, { token: dean, body: { vote_id: vote.data.id } });
    assert.equal(signed.data.status, 'dean_approved');
    const pending = await api('GET', `/api/claims/${id}/requisition`, { token: hr });
    assert.equal(pending.type, 'application/pdf', 'the requisition can be previewed before clearing');
    assert.equal((await api('POST', `/api/claims/${id}/approve`, { token: hr })).data.status, 'hr_verified');
    const detail = (await api('GET', `/api/claims/${id}`, { token: hr })).data;
    assert.equal(detail.cleared, true);
    assert.equal(detail.vote.code, 'FST-TEST-01');
    assert.equal(detail.vote.balance, 1000000 - detail.total);
    assert.equal((await api('GET', `/api/claims/${id}/requisition`, { token: esther })).type, 'application/pdf');
    // Anyone holding the printed form checks it against the system without signing in.
    assert.match(detail.verify_code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    const check = await api('GET', `/api/verify/${detail.verify_code.toLowerCase()}`);
    assert.equal(check.status, 200);
    assert.equal(check.data.requisition.amount, detail.total);
    assert.equal(check.data.requisition.cleared, true);
    assert.match(check.data.requisition.lecturer, /Esther Atim/);
    assert.deepEqual(check.data.sign_offs.map((s) => Boolean(s.footprint)), [true, true, true, true], 'claimant, HoD, Dean and HR each left a footprint');
    assert.deepEqual(check.data.sign_offs.map((s) => s.footprint), Object.values(detail.sign_offs).map((s) => s.footprint));
    assert.equal((await api('GET', '/api/verify/ABCDE-FGHJK')).status, 404);
    assert.ok((await api('GET', '/api/claims?view=completed', { token: hr })).data.some((c) => c.id === id));
    assert.equal((await api('POST', `/api/claims/${id}/approve`, { token: hr })).status, 400, 'payment needs a reference');
    const paid = await api('POST', `/api/claims/${id}/approve`, { token: hr, body: { payment_reference: 'PV-TEST-1' } });
    assert.equal(paid.data.status, 'paid');

    const claim = await claimOf(esther, id);
    assert.deepEqual(claim.events.map((e) => e.action), ['created', 'submitted', 'returned', 'resubmitted', 'approved', 'approved', 'verified', 'paid']);
    assert.equal(claim.payment_reference, 'PV-TEST-1');
    const line = claim.lines.find((l) => l.kind === 'teaching');
    const att = (await api('GET', `/api/claims/${id}/lines/${line.id}/attendance`, { token: hr })).data;
    assert.ok(att.registers.length > 0 && att.registers[0].students.length > 0, 'approvers can see who attended');
    assert.ok(q.get("SELECT COUNT(*) AS n FROM notifications WHERE user_id = (SELECT id FROM users WHERE email = 'esther.atim@demo.edu') AND title = 'Claim paid'").n >= 1);
  });

  test('HR exports the payment schedule and sees claims awaiting them on the dashboard', async () => {
    const hr = await login('hr@demo.edu');
    const xlsx = await api('GET', '/api/claims/export?status=dean_approved,hr_verified,paid', { token: hr });
    assert.equal(xlsx.status, 200);
    assert.ok(xlsx.type.includes('spreadsheetml'));
    const dash = (await api('GET', '/api/dashboard', { token: hr })).data;
    assert.ok(dash.claims.awaiting_me >= 1);
    assert.equal((await api('GET', '/api/users', { token: hr })).status, 403, 'HR only handles claims');
  });
});

describe('Teaching operations, exams and profiles', async () => {
  const { startCheckin, currentCode } = await import('../src/services/checkin.js');
  const { occurrences } = await import('../src/services/occurrences.js');
  const ExcelJS = (await import('exceljs')).default;
  const uniId = () => q.get("SELECT id FROM universities WHERE slug = 'demo-university'").id;
  const today = () => zonedNow('Africa/Kampala').date;
  const bscs1 = () => q.get("SELECT id FROM classes WHERE name = 'BSCS Year 1'").id;
  const userByEmail = (email) => q.get('SELECT * FROM users WHERE email = ?', email);

  /** The next BSCS Year 1 lecture of a course unit at least `days` ahead. */
  const nextLecture = (code, days = 7) =>
    occurrences(uniId(), { from: addDays(today(), days), to: addDays(today(), days + 13), classId: bscs1() }).find((o) => o.course_code === code);

  test('QR check-in: one phone per student per lecture, one automatic phone change per term, manual marks and closing', async () => {
    const occ = nextLecture('CSC1101');
    const lecturer = userByEmail('brian.kato@demo.edu');
    const cs = startCheckin(lecturer, occ);
    const { code } = currentCode(cs);
    const [student, rep] = await Promise.all(['student.bscs1@students.demo.edu', 'rep.bscs1@students.demo.edu'].map(login));
    const classmates = q.all("SELECT id, email FROM users WHERE class_id = ? AND role = 'student' ORDER BY id", bscs1());
    // Start from phones nobody has registered (the demo registers phones for recent check-ins).
    q.run('DELETE FROM student_devices WHERE user_id IN (SELECT id FROM users WHERE class_id = ?)', bscs1());

    const scan = (token, device, c = code) => api('POST', '/api/checkin/scan', { token, body: { code: c, device_id: device } });
    assert.equal((await scan(student, 'phone-brian-0001')).status, 200);
    assert.equal((await scan(student, 'phone-brian-0001')).data.already, true, 'scanning twice is harmless');
    const borrowed = await scan(rep, 'phone-brian-0001');
    assert.equal(borrowed.status, 403, 'a classmate cannot use the same phone');
    assert.equal(borrowed.data.code, 'device_belongs_to_other');
    assert.equal((await scan(rep, 'phone-aisha-0001')).status, 200);
    assert.equal((await scan(student, 'phone-brian-0001', `EC1.${cs.id}.123.forged`)).status, 400, 'forged or old codes fail');

    // Phone change: allowed once per term automatically, then needs the HoD.
    const other = classmates.find((c) => !['student.bscs1@students.demo.edu', 'rep.bscs1@students.demo.edu'].includes(c.email));
    q.run('UPDATE users SET email = ? WHERE id = ?', 'third.bscs1@students.demo.edu', other.id);
    const third = await login('third.bscs1@students.demo.edu');
    const lecture2 = startCheckin(lecturer, nextLecture('CSC1101', 14));
    assert.equal((await scan(third, 'old-phone-third', code)).status, 200);
    assert.equal((await scan(third, 'new-phone-third', currentCode(lecture2).code)).data.phone_changed, true);
    const lecture3 = startCheckin(lecturer, nextLecture('CSC1101', 21));
    assert.equal((await scan(third, 'another-phone-third', currentCode(lecture3).code)).data.code, 'device_other_account');
    const hod = await login('hod.cs@demo.edu');
    assert.equal((await api('POST', `/api/users/${other.id}/reset-device`, { token: hod })).status, 200);
    assert.equal((await scan(third, 'another-phone-third', currentCode(lecture3).code)).status, 200);

    // Manual marks (flat battery): the class rep can mark; past the limit the HoD is told.
    const absent = classmates.find((c) => !q.get('SELECT 1 FROM checkins WHERE checkin_session_id = ? AND student_id = ?', cs.id, c.id));
    const manual = await api('POST', `/api/checkin/${cs.id}/manual`, { token: rep, body: { student_id: absent.id, reason: 'Flat battery, ID card checked' } });
    assert.equal(manual.status, 201);
    q.run('UPDATE universities SET manual_mark_limit = 1 WHERE id = ?', uniId());
    const lecturerToken = await login('brian.kato@demo.edu');
    const again = await api('POST', `/api/checkin/${lecture2.id}/manual`, { token: lecturerToken, body: { student_id: absent.id, reason: 'Phone stolen' } });
    assert.equal(again.data.over_limit, true);
    q.run('UPDATE universities SET manual_mark_limit = 3 WHERE id = ?', uniId());

    const view = (await api('GET', `/api/checkin/${cs.id}`, { token: lecturerToken })).data;
    assert.equal(view.counts.qr, 3);
    assert.equal(view.counts.manual, 1);
    assert.ok(view.flags.some((f) => f.kind === 'device_belongs_to_other'));
    assert.equal((await api('POST', `/api/checkin/${cs.id}/close`, { token: lecturerToken })).status, 200);
    const reg = q.get('SELECT * FROM attendance_registers WHERE session_id = ? AND lecture_date = ? AND class_id = ?', occ.session_id, occ.date, bscs1());
    assert.equal(reg.status, 'approved');
    assert.equal(reg.source, 'qr');
    assert.equal(reg.self_checkins, 3);
    const methods = q.all('SELECT method FROM attendance_records WHERE register_id = ? AND present = 1', reg.id).map((r) => r.method).sort();
    assert.deepEqual(methods, ['manual', 'qr', 'qr', 'qr']);

    // A student marked absent asks for a correction within 48 hours; the lecturer approves it.
    const missing = classmates.find((c) => !q.get('SELECT present FROM attendance_records WHERE register_id = ? AND student_id = ? AND present = 1', reg.id, c.id));
    q.run('UPDATE users SET email = ? WHERE id = ?', 'fourth.bscs1@students.demo.edu', missing.id);
    const fourth = await login('fourth.bscs1@students.demo.edu');
    const corr = await api('POST', '/api/attendance/corrections', { token: fourth, body: { register_id: reg.id, note: 'I was there but my phone had no network' } });
    assert.equal(corr.status, 201);
    const review = await api('POST', `/api/attendance/corrections/${corr.data.id}/review`, { token: lecturerToken, body: { action: 'approve' } });
    assert.equal(review.data.status, 'approved');
    assert.equal(q.get('SELECT method FROM attendance_records WHERE register_id = ? AND student_id = ?', reg.id, missing.id).method, 'correction');

    // A scan made while the phone was offline arrives after closing and still counts.
    const offline = { code: currentCode(lecture2).code, scanned_at: new Date().toISOString() };
    assert.equal((await api('POST', `/api/checkin/${lecture2.id}/close`, { token: lecturerToken })).status, 200);
    const late = await api('POST', '/api/checkin/scan', { token: student, body: { ...offline, device_id: 'phone-brian-0001' } });
    assert.equal(late.status, 200);
    const lecture2Reg = q.get('SELECT id FROM attendance_registers WHERE session_id = ? AND lecture_date = ? AND class_id = ?', lecture2.session_id, lecture2.lecture_date, bscs1());
    const me = userByEmail('student.bscs1@students.demo.edu');
    assert.deepEqual(q.get('SELECT present, method FROM attendance_records WHERE register_id = ? AND student_id = ?', lecture2Reg.id, me.id), { present: 1, method: 'qr' });
  });

  test('lecturers cancel or move a lecture with clash checks; holidays remove lectures', async () => {
    const ivan = userByEmail('ivan.ssemwogerere@demo.edu');
    const lecturer = await login('ivan.ssemwogerere@demo.edu');
    const occ = occurrences(uniId(), { from: addDays(today(), 22), to: addDays(today(), 35), lecturerId: ivan.id })[0];
    const busy = occurrences(uniId(), { from: occ.date, to: addDays(occ.date, 6), classId: occ.classes[0].id }).find((o) => o.session_id !== occ.session_id);
    const clash = await api('POST', '/api/ops/changes', { token: lecturer, body: { session_id: occ.session_id, date: occ.date, action: 'move', new_date: busy.date, new_start: busy.start_time, reason: 'Testing a clash' } });
    assert.equal(clash.status, 409, 'a class cannot have two lectures at once');
    const slots = (await api('GET', `/api/ops/sessions/${occ.session_id}/suggestions?date=${occ.date}&from=${addDays(occ.date, 1)}`, { token: lecturer })).data;
    assert.ok(slots.length > 0);
    const moved = await api('POST', '/api/ops/changes', { token: lecturer, body: { session_id: occ.session_id, date: occ.date, action: 'move', new_date: slots[0].date, new_start: slots[0].start_time, new_room_id: slots[0].room_id, reason: 'Clash with a faculty meeting' } });
    assert.equal(moved.status, 201);
    const after = occurrences(uniId(), { from: slots[0].date, to: slots[0].date, sessionId: occ.session_id })[0];
    assert.equal(after.status, 'rescheduled');
    assert.equal(occurrences(uniId(), { from: occ.date, to: occ.date, sessionId: occ.session_id }).filter((o) => o.date === occ.date).length, 0);
    const student = q.get("SELECT id FROM users WHERE class_id = ? AND role = 'student' LIMIT 1", occ.classes[0].id);
    assert.ok(q.get("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE 'Rescheduled:%'", student.id));

    const admin = await login('admin@demo.edu');
    let holiday = null;
    for (let i = 15; i < 45 && !holiday; i++) if (occurrences(uniId(), { from: addDays(today(), i), to: addDays(today(), i) }).length) holiday = addDays(today(), i);
    assert.ok(holiday, 'a teaching day to turn into a holiday');
    assert.equal((await api('POST', '/api/ops/calendar-events', { token: lecturer, body: { title: 'X', start_date: holiday } })).status, 403);
    assert.equal((await api('POST', '/api/ops/calendar-events', { token: admin, body: { title: 'Martyrs Day', start_date: holiday } })).status, 201);
    assert.equal(occurrences(uniId(), { from: holiday, to: holiday }).length, 0);
  });

  test('leave: the HoD checks, the Dean approves, and a cover lecturer takes the lectures', async () => {
    const ivanId = userByEmail('ivan.ssemwogerere@demo.edu').id;
    const [hod, dean, ivan] = await Promise.all(['hod.cs@demo.edu', 'dean.fst@demo.edu', 'ivan.ssemwogerere@demo.edu'].map(login));
    const id = q.get("SELECT id FROM leave_requests WHERE lecturer_id = ? AND status = 'submitted'", ivanId).id;
    assert.equal((await api('POST', `/api/ops/leave/${id}/review`, { token: dean, body: { action: 'approve' } })).status, 403, 'the Dean waits for the HoD');
    assert.equal((await api('POST', `/api/ops/leave/${id}/review`, { token: hod, body: { action: 'approve', note: 'Workload covered' } })).data.status, 'hod_checked');
    const detail = (await api('GET', `/api/ops/leave/${id}`, { token: hod })).data;
    const lecture = detail.lectures.find((l) => l.candidates?.length);
    assert.ok(lecture, 'free colleagues are suggested as cover');
    const cover = lecture.candidates[0];
    assert.equal((await api('PUT', `/api/ops/leave/${id}/covers`, { token: hod, body: { session_id: lecture.session_id, date: lecture.date, substitute_id: cover.id } })).status, 200);
    assert.equal((await api('POST', `/api/ops/leave/${id}/review`, { token: dean, body: { action: 'approve' } })).data.status, 'approved');
    const theirs = occurrences(uniId(), { from: lecture.date, to: lecture.date, lecturerId: cover.id });
    assert.ok(theirs.some((o) => o.session_id === lecture.session_id && o.covered), 'the cover lecturer now teaches it');
    assert.ok(!occurrences(uniId(), { from: lecture.date, to: lecture.date, lecturerId: ivanId }).some((o) => o.session_id === lecture.session_id));
    assert.ok((await api('GET', '/api/ops/leave?view=mine', { token: ivan })).data.length >= 1);
  });

  test('missed lectures are listed for the HoD and calendar feeds work by secret link', async () => {
    const hod = await login('hod.cs@demo.edu');
    const past = occurrences(uniId(), { from: addDays(today(), -12), to: addDays(today(), -5), classId: bscs1() })[0];
    q.run('DELETE FROM attendance_registers WHERE session_id = ? AND lecture_date = ?', past.session_id, past.date);
    q.run('DELETE FROM checkin_sessions WHERE session_id = ? AND lecture_date = ?', past.session_id, past.date);
    const missed = (await api('GET', '/api/ops/missed', { token: hod })).data.items;
    assert.ok(missed.some((m) => m.session_id === past.session_id && m.date === past.date));

    const student = await login('student.bscs1@students.demo.edu');
    const link = (await api('GET', '/api/ops/calendar-link', { token: student })).data;
    assert.match(link.webcal, /^webcal:/);
    const ics = await fetch(base + new URL(link.url).pathname).then((r) => r.text());
    assert.match(ics, /BEGIN:VCALENDAR/);
    assert.ok((ics.match(/BEGIN:VEVENT/g) || []).length > 5);
    assert.match(ics, /Exam: /, 'exams are in the student calendar');
    assert.equal((await fetch(`${base}/api/calendar/not-a-real-token-1234567890.ics`)).status, 404);
  });

  test('exam timetable, eligibility (75% attendance and 50% coursework) and HoD override', async () => {
    const exams = q.all('SELECT e.*, cu.code FROM exams e JOIN course_units cu ON cu.id = e.course_unit_id');
    assert.ok(exams.length >= 15);
    const sameDay = q.get(
      `SELECT ac.class_id, e.exam_date FROM exams e JOIN allocations a ON a.course_unit_id = e.course_unit_id AND a.term_id = e.term_id
         JOIN allocation_classes ac ON ac.allocation_id = a.id GROUP BY ac.class_id, e.exam_date HAVING COUNT(DISTINCT e.id) > 1`,
    );
    assert.equal(sameDay, undefined, 'no class sits two exams in a day');
    const hod = await login('hod.cs@demo.edu');
    assert.equal((await api('POST', '/api/exams/generate', { token: hod, body: {} })).status, 403);

    const exam = exams.find((e) => e.code === 'CSC1101');
    const el = (await api('GET', `/api/exams/${exam.id}/eligibility`, { token: hod })).data;
    assert.equal(el.thresholds.exam_min_attendance, 75);
    assert.equal(el.thresholds.coursework_min_percent, 50);
    const blocked = el.students.find((s) => !s.eligible);
    assert.ok(blocked && blocked.reasons.length);
    assert.equal((await api('POST', `/api/exams/${exam.id}/overrides`, { token: await login('brian.kato@demo.edu'), body: { student_id: blocked.id, reason: 'Medical leave' } })).status, 403, 'lecturers cannot override');
    assert.equal((await api('POST', `/api/exams/${exam.id}/overrides`, { token: hod, body: { student_id: blocked.id, reason: 'Medical leave with a hospital letter' } })).status, 201);
    const now = (await api('GET', `/api/exams/${exam.id}/eligibility`, { token: hod })).data.students.find((s) => s.id === blocked.id);
    assert.equal(now.eligible, true);
    const mine = (await api('GET', '/api/exams/mine', { token: await login('student.bscs1@students.demo.edu') })).data;
    assert.ok(mine.exams.length > 0 && mine.exams.every((e) => e.eligibility));
  });

  test('coursework: download the template, upload marks out of any total, converted per programme', async () => {
    const term = q.get('SELECT id FROM academic_terms WHERE is_current = 1');
    const unit = q.get("SELECT id FROM course_units WHERE code = 'CEP2102'"); // taught to BSCS (out of 40) and BIT (out of 30)
    const lecturer = await login('dean.fst@demo.edu');
    const tpl = await api('GET', `/api/exams/coursework/template?term_id=${term.id}&course_unit_id=${unit.id}`, { token: lecturer });
    assert.equal(tpl.status, 200);
    assert.ok(tpl.type.includes('spreadsheetml'));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(tpl.data);
    const ws = wb.worksheets[0];
    const regs = [];
    ws.eachRow((row, n) => {
      if (n > 4 && regs.length < 2) {
        row.getCell(6).value = regs.length === 0 ? 80 : 30;
        regs.push(String(row.getCell(1).value));
      }
    });
    const form = new FormData();
    form.append('term_id', String(term.id));
    form.append('course_unit_id', String(unit.id));
    form.append('out_of', '100');
    form.append('file', new Blob([Buffer.from(await wb.xlsx.writeBuffer())]), 'marks.xlsx');
    const up = await fetch(`${base}/api/exams/coursework/upload`, { method: 'POST', headers: { Authorization: `Bearer ${lecturer}` }, body: form }).then((r) => r.json());
    assert.ok(up.updated >= 2, 'the template comes back with every mark, including the two changed');
    assert.deepEqual(up.errors, []);
    const s0 = up.students.find((s) => s.identifier === regs[0]);
    assert.equal(s0.mark, (80 / 100) * s0.coursework_max, '80/100 becomes 32/40 or 24/30');
    const student = await login('student.bscs1@students.demo.edu');
    assert.equal((await api('GET', `/api/exams/coursework/template?term_id=${term.id}&course_unit_id=${unit.id}`, { token: student })).status, 403);
  });

  test('payslips, budgets, profile updates and the forced password change', async () => {
    const hr = await login('hr@demo.edu');
    const paid = q.get("SELECT id FROM pay_claims WHERE status = 'paid' LIMIT 1");
    const pdf = await api('GET', `/api/claims/${paid.id}/payslip`, { token: hr });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.type, 'application/pdf');
    const dean = await login('dean.fst@demo.edu');
    const budgets = (await api('GET', '/api/claims/budgets', { token: dean })).data;
    assert.ok(budgets.departments.length === 2 && budgets.departments.every((d) => d.amount > 0 && d.can_set));
    const cs = budgets.departments.find((d) => d.name === 'Computer Science');
    assert.equal((await api('PUT', '/api/claims/budgets', { token: dean, body: { department_id: cs.id, term_id: budgets.term.id, amount: 100 } })).data.amount, 100);
    const claim = (await api('GET', `/api/claims/${paid.id}`, { token: hr })).data;
    assert.ok(claim.verification && claim.budget);

    const admin = await login('admin@demo.edu');
    const created = await api('POST', '/api/users', { token: admin, body: { name: 'New Lecturer', email: 'new.lecturer@demo.edu', role: 'lecturer', department_id: q.get("SELECT id FROM departments WHERE code = 'CS'").id } });
    const temp = created.data.temporary_password;
    const first = await api('POST', '/api/auth/login', { body: { email: 'new.lecturer@demo.edu', password: temp } });
    assert.equal(first.data.user.must_change_password, true);
    const changed = await api('POST', '/api/auth/change-password', { token: first.data.token, body: { current_password: temp, new_password: 'MyOwnPass-2026' } });
    assert.equal(changed.data.user.must_change_password, false);
    // People keep their contacts up to date; the name and position are changed by the HoD / Dean.
    const renamed = await api('PUT', '/api/auth/me', { token: first.data.token, body: { name: 'Dr. New Lecturer Updated' } });
    assert.equal(renamed.status, 403);
    const prof = await api('PUT', '/api/auth/me', {
      token: first.data.token,
      body: { phone: '+256 700 000000', alt_phone: '+256 780 111222', contact_email: 'me@personal.example', office: 'Block B, Room 12', emergency_name: 'Next of kin', emergency_phone: '+256 701 999999' },
    });
    assert.equal(prof.data.user.phone, '+256 700 000000');
    assert.equal(prof.data.user.office, 'Block B, Room 12');
    assert.equal((await api('PUT', '/api/auth/me', { token: first.data.token, body: { contact_email: 'not-an-email' } })).status, 400);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a90000000049454e44ae426082', 'hex');
    const form = new FormData();
    form.append('photo', new Blob([png], { type: 'image/png' }), 'me.png');
    const photo = await fetch(`${base}/api/auth/me/photo`, { method: 'POST', headers: { Authorization: `Bearer ${first.data.token}` }, body: form }).then((r) => r.json());
    assert.match(photo.user.photo_url, /^\/uploads\/photos\//);

    // An administrator resets a forgotten password; the user must choose a new one again.
    const lecturerId = userByEmail('new.lecturer@demo.edu').id;
    const reset = await api('POST', `/api/users/${lecturerId}/reset-password`, { token: admin });
    assert.equal(reset.status, 200);
    assert.equal((await api('POST', '/api/auth/login', { body: { email: 'new.lecturer@demo.edu', password: 'MyOwnPass-2026' } })).status, 401, 'the old password stops working');
    const again = await api('POST', '/api/auth/login', { body: { email: 'new.lecturer@demo.edu', password: reset.data.temporary_password } });
    assert.equal(again.data.user.must_change_password, true);
    // The shared demo accounts keep signing in without a password prompt.
    const demoLecturer = userByEmail('brian.kato@demo.edu');
    assert.equal((await api('POST', `/api/users/${demoLecturer.id}/reset-password`, { token: admin })).status, 403);
    assert.equal((await api('PUT', `/api/users/${demoLecturer.id}`, { token: admin, body: { password: 'Something-123' } })).status, 403);
  });

  test('attendance downloads: one lecture as PDF or Excel, and a term sheet per course unit and class', async () => {
    const lecturer = await login('brian.kato@demo.edu');
    const reg = q.get(
      `SELECT r.id FROM attendance_registers r JOIN timetable_sessions s ON s.id = r.session_id JOIN allocations a ON a.id = s.allocation_id
        WHERE a.lecturer_id = ? AND r.status = 'approved' LIMIT 1`,
      userByEmail('brian.kato@demo.edu').id,
    );
    const pdf = await api('GET', `/api/attendance/registers/${reg.id}/export?format=pdf`, { token: lecturer });
    assert.equal(pdf.type, 'application/pdf');
    const xlsx = await api('GET', `/api/attendance/registers/${reg.id}/export?format=xlsx`, { token: lecturer });
    assert.equal(xlsx.status, 200);
    assert.match(xlsx.type, /spreadsheetml/);

    const sheets = (await api('GET', '/api/attendance/sheets', { token: lecturer })).data;
    assert.ok(sheets.items.length > 0, 'the lecturer sees their course units');
    const item = sheets.items.find((i) => i.registers > 0);
    const sheet = await api('GET', `/api/attendance/sheets/export?allocation_id=${item.allocation_id}&class_id=${item.classes[0].id}&format=xlsx`, { token: lecturer });
    assert.equal(sheet.status, 200);
    assert.equal((await api('GET', `/api/attendance/sheets/export?allocation_id=${item.allocation_id}&class_id=${item.classes[0].id}&format=pdf`, { token: lecturer })).type, 'application/pdf');
    const student = await login('student.bscs1@students.demo.edu');
    assert.equal((await api('GET', `/api/attendance/sheets/export?allocation_id=${item.allocation_id}&class_id=${item.classes[0].id}`, { token: student })).status, 403);
  });

  test('teaching rates by programme level: each lecture is paid at its classes\' level rate, else the general rate', async () => {
    const dean = await login('dean.fst@demo.edu');
    const fst = q.get("SELECT id FROM faculties WHERE code = 'FST'").id;
    const rates = (await api('GET', '/api/claims/rates', { token: dean })).data.filter((r) => r.kind === 'teaching' && r.faculty_id === fst);
    assert.ok(rates.some((r) => !r.program_level) && rates.some((r) => r.program_level === 'Masters'));
    const dup = await api('POST', '/api/claims/rates', { token: dean, body: { faculty_id: fst, kind: 'teaching', name: 'Masters again', amount: 1, program_level: 'Masters' } });
    assert.equal(dup.status, 400, 'one teaching rate per level');
    assert.equal((await api('POST', '/api/claims/rates', { token: dean, body: { faculty_id: fst, kind: 'teaching', name: 'Bad', amount: 1, program_level: 'Kindergarten' } })).status, 400);
    const bachelor = await api('POST', '/api/claims/rates', { token: dean, body: { faculty_id: fst, kind: 'teaching', name: 'Teaching: Bachelor', amount: 55000, program_level: 'Bachelor' } });
    assert.equal(bachelor.status, 201);

    // Esther teaches Bachelor classes, so her lectures move to the Bachelor rate.
    const esther = await login('esther.atim@demo.edu');
    const { refreshTeachingLines } = await import('../src/services/pay.js');
    const claim = q.get(
      "SELECT * FROM pay_claims WHERE lecturer_id = ? AND EXISTS (SELECT 1 FROM pay_claim_lines l WHERE l.claim_id = pay_claims.id AND l.kind = 'teaching') LIMIT 1",
      userByEmail('esther.atim@demo.edu').id,
    );
    refreshTeachingLines(claim);
    const lines = q.all("SELECT unit_price, program_level FROM pay_claim_lines WHERE claim_id = ? AND kind = 'teaching'", claim.id);
    assert.ok(lines.length > 0);
    assert.ok(lines.every((l) => l.unit_price === 55000 && l.program_level === 'Bachelor'));
    const preview = (await api('GET', `/api/claims/preview?from=${addDays(today(), -20)}&to=${today()}`, { token: esther })).data;
    assert.ok(preview.rates.length >= 2 && typeof preview.estimate === 'number');
  });
});

describe('Academic years, curriculum versions, leadership handover and rollover', () => {
  const uniId = () => q.get("SELECT id FROM universities WHERE slug = 'demo-university'").id;
  const userByEmail = (email) => q.get('SELECT * FROM users WHERE email = ?', email);
  const today = () => zonedNow('Africa/Kampala').date;
  const cs = () => q.get("SELECT * FROM departments WHERE code = 'CS'");

  test('a Dean appoints a new HoD: the previous HoD goes back to lecturer and approvals follow the role', async () => {
    const dean = await login('dean.fst@demo.edu');
    const brian = userByEmail('brian.kato@demo.edu');
    const oldHod = userByEmail('hod.cs@demo.edu');
    const other = await login('dean.fbm@demo.edu');
    assert.equal((await api('PUT', `/api/departments/${cs().id}`, { token: other, body: { hod_id: brian.id } })).status, 403, 'only the faculty Dean appoints its HoDs');

    const res = await api('PUT', `/api/departments/${cs().id}`, { token: dean, body: { hod_id: brian.id } });
    assert.equal(res.status, 200);
    assert.equal(res.data.handed_over_from.id, oldHod.id);
    assert.equal(userByEmail('brian.kato@demo.edu').role, 'hod');
    assert.equal(userByEmail('hod.cs@demo.edu').role, 'lecturer');
    assert.equal(userByEmail('hod.cs@demo.edu').department_id, cs().id, 'the former HoD keeps teaching in the department');
    assert.equal(cs().hod_id, brian.id);

    // A claim waiting for the HoD now waits for the new one.
    const pending = q.get("SELECT id FROM pay_claims WHERE status = 'submitted' AND department_id = ? LIMIT 1", cs().id);
    if (pending) {
      assert.equal((await api('GET', `/api/claims/${pending.id}`, { token: await login('brian.kato@demo.edu') })).data.can_act, true);
    }

    // The administrator puts the original HoD back; Brian returns to lecturer.
    const admin = await login('admin@demo.edu');
    assert.equal((await api('PUT', `/api/departments/${cs().id}`, { token: admin, body: { hod_id: oldHod.id } })).status, 200);
    assert.equal(userByEmail('brian.kato@demo.edu').role, 'lecturer');
    assert.equal(userByEmail('hod.cs@demo.edu').role, 'hod');
  });

  test('curriculum versions: a new version starts as a copy, and classes keep the version they started on', async () => {
    const hod = await login('hod.cs@demo.edu');
    const bscs = q.get("SELECT * FROM programs WHERE code = 'BSCS'");
    const v1 = q.get('SELECT * FROM curriculum_versions WHERE program_id = ? ORDER BY id LIMIT 1', bscs.id);
    const v1Units = q.get('SELECT COUNT(*) AS n FROM program_course_units WHERE version_id = ?', v1.id).n;
    const created = await api('POST', `/api/programs/${bscs.id}/versions`, { token: hod, body: { name: '2027 curriculum', starts_academic_year: '2027/2028' } });
    assert.equal(created.status, 201);
    assert.equal(created.data.unit_count, v1Units, 'starts as a copy of the latest version');

    const unit = await api('POST', '/api/course-units', { token: hod, body: { code: 'CSC1199', name: 'Cloud Fundamentals', hours_per_week: 3, department_id: cs().id } });
    assert.equal(unit.status, 201);
    const link = await api('POST', `/api/programs/${bscs.id}/course-units`, { token: hod, body: { course_unit_id: unit.data.id, year_of_study: 1, semester: 1, version_id: created.data.id } });
    assert.equal(link.status, 201);
    const detailV2 = (await api('GET', `/api/programs/${bscs.id}`, { token: hod })).data;
    assert.equal(detailV2.version.id, created.data.id, 'the latest version is shown by default');
    assert.ok(detailV2.course_units.some((u) => u.code === 'CSC1199'));
    const detailV1 = (await api('GET', `/api/programs/${bscs.id}?version_id=${v1.id}`, { token: hod })).data;
    assert.ok(!detailV1.course_units.some((u) => u.code === 'CSC1199'), 'the running version is unchanged');
    assert.equal(q.get("SELECT status FROM curriculum_versions WHERE id = ?", v1.id).status, 'phasing_out', 'still followed by running classes');

    // Running classes follow version 1, so the new unit is not required of them this term.
    const reqs = (await api('GET', '/api/allocations/requirements', { token: hod })).data;
    assert.ok(!reqs.units.some((u) => u.code === 'CSC1199'));
  });

  test('academic years are created with their semesters, and dates are checked', async () => {
    const admin = await login('admin@demo.edu');
    assert.equal((await api('POST', '/api/academic-years', { token: admin, body: { academic_year: '2027-2028', semesters: [] } })).status, 400);
    const overlap = await api('POST', '/api/academic-years', {
      token: admin,
      body: { academic_year: '2027/2028', semesters: [{ semester: 1, start_date: today(), end_date: addDays(today(), 100) }, { semester: 2, start_date: addDays(today(), 50), end_date: addDays(today(), 200) }] },
    });
    assert.equal(overlap.status, 400, 'semesters cannot overlap');
    const made = await api('POST', '/api/academic-years', {
      token: admin,
      body: { academic_year: '2027/2028', semesters: [{ semester: 1, start_date: today(), end_date: addDays(today(), 110) }, { semester: 2, start_date: addDays(today(), 140), end_date: addDays(today(), 250) }] },
    });
    assert.equal(made.status, 201);
    assert.deepEqual(made.data.map((t) => t.name), ['2027/2028 Semester 1', '2027/2028 Semester 2']);
  });

  test('when the new academic year starts, classes move up, finalists complete, and last year is drafted for the HoD', async () => {
    const { rollover } = await import('../src/services/rollover.js');
    const uid = uniId();
    // A two-year programme so that one class finishes this time.
    q.run("UPDATE programs SET duration_years = 2 WHERE code = 'BBA'");
    const before = {
      bscs1: q.get("SELECT * FROM classes WHERE name = 'BSCS Year 1' AND status = 'active'"),
      bscs2: q.get("SELECT * FROM classes WHERE name = 'BSCS Year 2' AND status = 'active'"),
      bba2: q.get("SELECT * FROM classes WHERE name = 'BBA Year 2' AND status = 'active'"),
    };
    const studentsInBscs1 = q.get("SELECT COUNT(*) AS n FROM users WHERE class_id = ? AND role = 'student'", before.bscs1.id).n;
    const oldTerm = q.get("SELECT * FROM academic_terms WHERE university_id = ? AND academic_year = '2026/2027' AND semester = 1", uid);
    const oldCsc1101 = q.get(
      'SELECT a.* FROM allocations a JOIN course_units cu ON cu.id = a.course_unit_id WHERE a.term_id = ? AND cu.code = ?',
      oldTerm.id,
      'CSC1101',
    );

    const out = rollover(uid, today());
    assert.equal(out.promoted.academic_year, '2027/2028');
    assert.equal(out.current, '2027/2028 Semester 1', 'the new term becomes current on its start date');

    const after = (id) => q.get('SELECT * FROM classes WHERE id = ?', id);
    assert.equal(after(before.bscs1.id).year_of_study, 2);
    assert.equal(after(before.bscs1.id).name, 'BSCS Year 2');
    assert.equal(q.get("SELECT COUNT(*) AS n FROM users WHERE class_id = ? AND role = 'student'", before.bscs1.id).n, studentsInBscs1, 'students move up with their class');
    assert.equal(after(before.bscs2.id).name, 'BSCS Year 3');
    assert.equal(after(before.bba2.id).status, 'completed', 'finalists complete their programme');
    const newYear1 = q.get("SELECT * FROM classes WHERE name = 'BSCS Year 1' AND status = 'active'");
    assert.ok(newYear1 && newYear1.id !== before.bscs1.id, 'a new Year 1 class opens for the intake');
    const latest = q.get("SELECT id FROM curriculum_versions WHERE program_id = ? ORDER BY id DESC LIMIT 1", newYear1.program_id).id;
    assert.equal(newYear1.curriculum_version_id, latest, 'the new intake follows the latest curriculum');
    assert.equal(after(before.bscs1.id).curriculum_version_id, before.bscs1.curriculum_version_id, 'running classes keep their curriculum');

    // Last year's Semester 1 teaching is drafted with the same lecturers, matched to this year's classes.
    const newTerm = q.get("SELECT * FROM academic_terms WHERE university_id = ? AND academic_year = '2027/2028' AND semester = 1", uid);
    const draft = q.get(
      `SELECT a.* FROM allocations a JOIN course_units cu ON cu.id = a.course_unit_id WHERE a.term_id = ? AND cu.code = 'CSC1101'`,
      newTerm.id,
    );
    assert.equal(draft.status, 'draft');
    assert.equal(draft.lecturer_id, oldCsc1101.lecturer_id);
    assert.deepEqual(q.all('SELECT class_id FROM allocation_classes WHERE allocation_id = ?', draft.id).map((r) => r.class_id), [newYear1.id]);

    // Running again changes nothing.
    const again = rollover(uid, today());
    assert.equal(again.promoted, null);
    assert.equal(again.carried.length, 0);

    // Drafts are not timetabled until the HoD confirms them.
    const hod = await login('hod.cs@demo.edu');
    const reqs = (await api('GET', `/api/allocations/requirements?term_id=${newTerm.id}`, { token: hod })).data;
    assert.ok(reqs.units.some((u) => u.classes.some((c) => c.draft)));
    const confirm = await api('POST', '/api/allocations/confirm-drafts', { token: hod, body: { term_id: newTerm.id } });
    assert.equal(confirm.status, 200);
    assert.ok(confirm.data.confirmed > 0);
    assert.equal(q.get('SELECT status FROM allocations WHERE id = ?', draft.id).status, 'confirmed');

    // Finished classes leave everyday lists but stay available.
    const admin = await login('admin@demo.edu');
    const active = (await api('GET', '/api/classes', { token: admin })).data;
    assert.ok(!active.some((c) => c.id === before.bba2.id));
    assert.ok((await api('GET', '/api/classes?status=completed', { token: admin })).data.some((c) => c.id === before.bba2.id));
  });
});

describe('Research: project, dissertation or thesis from concept to clearance', () => {
  const pdf = () => new Blob([Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF')], { type: 'application/pdf' });
  async function upload(method, url, token, fields, withFile = true) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    if (withFile) form.append('document', pdf(), 'work.pdf');
    const res = await fetch(base + url, { method, headers: { Authorization: `Bearer ${token}` }, body: form });
    return { status: res.status, data: await res.json() };
  }
  const act = (token, id, action, extra = {}) => api('POST', `/api/research/${id}/action`, { token, body: { action, ...extra } });

  test('the kind of work follows the programme level', async () => {
    const { kindForLevel } = await import('../src/services/research.js');
    assert.equal(kindForLevel('Bachelor'), 'project');
    assert.equal(kindForLevel('Diploma'), 'project');
    assert.equal(kindForLevel('Masters'), 'dissertation');
    assert.equal(kindForLevel('PhD'), 'thesis');
  });

  test('concept, presentation, supervisors, progress reports, intent, final, defence and clearance', async () => {
    const [hod, coord, supervisor, student, other] = await Promise.all(
      ['hod.cs@demo.edu', 'brian.kato@demo.edu', 'ivan.ssemwogerere@demo.edu', 'student.bscs1@students.demo.edu', 'esther.atim@demo.edu'].map(login),
    );
    const bscs = q.get("SELECT * FROM programs WHERE code = 'BSCS'");
    const cs = q.get("SELECT * FROM departments WHERE code = 'CS'");
    // The demo opens research for BSCS; close it to see that only the HoD's setting opens it.
    assert.equal((await api('PUT', `/api/programs/${bscs.id}`, { token: hod, body: { research_enabled: false } })).status, 200);
    assert.equal((await api('GET', '/api/research/eligibility', { token: student })).data.eligible, false, 'closed until the HoD turns it on');
    assert.equal((await api('PUT', `/api/programs/${bscs.id}`, { token: hod, body: { research_enabled: true, research_year: 1, research_reports: 2 } })).status, 200);
    const elig = (await api('GET', '/api/research/eligibility', { token: student })).data;
    assert.equal(elig.eligible, true);
    assert.equal(elig.kind_label, 'Project');
    assert.equal(elig.reports_required, 2);

    // The HoD appoints the research coordinator.
    const ivan = q.get("SELECT id FROM users WHERE email = 'ivan.ssemwogerere@demo.edu'").id;
    const brian = q.get("SELECT id FROM users WHERE email = 'brian.kato@demo.edu'").id;
    assert.equal((await api('POST', '/api/research/coordinators', { token: other, body: { department_id: cs.id, user_id: brian } })).status, 403);
    assert.equal((await api('POST', '/api/research/coordinators', { token: hod, body: { department_id: cs.id, user_id: brian } })).status, 201);
    assert.ok((await api('GET', '/api/research?view=awaiting', { token: coord })).data.some((p) => p.status === 'concept_submitted'), 'the demo concept waits for the coordinator');

    // 1. Concept to the coordinator.
    const concept = await upload('POST', '/api/research', student, { title: 'Offline-first attendance for rural campuses', problem: 'Connectivity is poor.', objectives: 'Design and evaluate.', methodology: 'Design science.' });
    assert.equal(concept.status, 201);
    const id = concept.data.id;
    assert.equal(concept.data.status, 'concept_submitted');
    assert.equal((await upload('POST', '/api/research', student, { title: 'Second', problem: 'x', objectives: 'y' })).status, 400, 'one active project at a time');
    assert.equal((await act(student, id, 'schedule_presentation', { date: '2026-11-02 10:00' })).status, 403);
    const returned = await act(coord, id, 'return_concept', { note: 'Narrow the scope to one district' });
    assert.equal(returned.data.status, 'concept_returned');
    assert.equal((await upload('PUT', `/api/research/${id}/concept`, student, { title: 'Offline-first attendance in Kabarole district' }, false)).data.status, 'concept_submitted');

    // 2. Presentation, supervisors and mentors, then the HoD approves the start.
    assert.equal((await act(coord, id, 'schedule_presentation', { date: '2026-11-02 10:00', venue: 'Seminar Room A' })).data.status, 'presentation_scheduled');

    // The presentation is in everyone's calendar feed, with a Google Calendar link and reminders.
    const withLinks = (await api('GET', `/api/research/${id}`, { token: student })).data;
    assert.match(withLinks.calendar.presentation, /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE/);
    const feedUrl = (await api('GET', '/api/ops/calendar-link', { token: coord })).data.url;
    const ics = await (await fetch(feedUrl.replace(/^https?:\/\/[^/]+/, base))).text();
    assert.match(ics, /SUMMARY:Concept presentation: /);
    assert.match(ics, /BEGIN:VALARM/);
    const prefs = await api('PUT', '/api/notifications/preferences', { token: student, body: { research_minutes_before: 45, research_day_before: true } });
    assert.equal(prefs.data.research_minutes_before, 45);
    const { runResearchReminders } = await import('../src/services/schedule.js');
    const { localToUtc } = await import('../src/services/occurrences.js');
    const start = localToUtc('2026-11-02', '10:00', 'Africa/Kampala');
    runResearchReminders(new Date(start.getTime() - 20 * 3600000));
    runResearchReminders(new Date(start.getTime() - 30 * 60000));
    runResearchReminders(new Date(start.getTime() - 25 * 60000));
    const sid = q.get("SELECT id FROM users WHERE email = 'student.bscs1@students.demo.edu'").id;
    assert.equal(q.get("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND title LIKE 'Tomorrow: Concept presentation%'", sid).n, 1);
    assert.equal(q.get("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND title LIKE 'Starting soon: Concept presentation%'", sid).n, 1, 'each reminder fires once');
    assert.equal((await act(coord, id, 'presentation_passed', { note: 'Well argued' })).data.status, 'supervision');
    const mentor = await api('POST', `/api/research/${id}/mentors`, { token: student, body: { name: 'Grace Atuhaire', institution: 'Kabarole District ICT Office', email: 'grace@example.org' } });
    assert.equal(mentor.status, 201);
    assert.equal((await api('POST', `/api/research/${id}/mentors/${mentor.data.id}/decision`, { token: coord, body: { decision: 'confirm' } })).data.status, 'confirmed');
    assert.equal((await act(hod, id, 'approve_start')).status, 400, 'needs a main supervisor');
    assert.equal((await api('POST', `/api/research/${id}/supervisors`, { token: coord, body: { user_id: ivan, role: 'main' } })).status, 201);
    assert.equal((await act(hod, id, 'approve_start')).data.status, 'in_progress');

    // 3. Progress reports: supervisor, then HoD; intent only after the number the HoD set.
    assert.equal((await upload('POST', `/api/research/${id}/intent`, student, { summary: 'Too early' }, false)).status, 400);
    for (const n of [1, 2]) {
      const report = await upload('POST', `/api/research/${id}/reports`, student, { title: `Progress report ${n}`, summary: 'Work done this month' });
      assert.equal(report.status, 201);
      assert.equal(report.data.number, n);
      assert.equal((await api('POST', `/api/research/reports/${report.data.id}/review`, { token: hod, body: { action: 'approve' } })).status, 403, 'the supervisor reviews first');
      assert.equal((await api('POST', `/api/research/reports/${report.data.id}/review`, { token: supervisor, body: { action: 'approve' } })).data.status, 'supervisor_approved');
      assert.equal((await api('POST', `/api/research/reports/${report.data.id}/review`, { token: hod, body: { action: 'approve' } })).data.status, 'approved');
    }

    // 4. Intent to submit: supervisor, coordinator, HoD; returned when the outputs are not clear.
    assert.equal((await upload('POST', `/api/research/${id}/intent`, student, { summary: 'A working prototype and a field evaluation' }, false)).data.status, 'intent_review');
    assert.equal((await act(coord, id, 'sign_intent')).status, 403, 'the supervisor signs first');
    assert.equal((await act(supervisor, id, 'sign_intent')).status, 200);
    assert.equal((await act(coord, id, 'return_intent', { note: 'State the evaluation outputs clearly' })).data.status, 'in_progress');
    await upload('POST', `/api/research/${id}/intent`, student, { summary: 'Prototype, field evaluation with 3 schools, a usage report' }, false);
    for (const t of [supervisor, coord, hod]) assert.equal((await act(t, id, 'sign_intent')).status, 200);
    assert.equal(q.get('SELECT status FROM research_projects WHERE id = ?', id).status, 'intent_approved');

    // 5. Final work: supervisor, coordinator, HoD.
    assert.equal((await upload('POST', `/api/research/${id}/final`, student, {}, false)).status, 400, 'the final document is required');
    assert.equal((await upload('POST', `/api/research/${id}/final`, student, { summary: 'Final report' })).data.status, 'final_review');
    for (const t of [supervisor, coord, hod]) assert.equal((await act(t, id, 'sign_final')).status, 200);

    // 6. Defence, with corrections; 7. cleared.
    assert.equal((await act(coord, id, 'schedule_defence', { date: '2026-12-10 09:00', venue: 'Board Room', panel: 'Dr. A, Dr. B' })).data.status, 'defence_scheduled');
    assert.equal((await act(coord, id, 'defence_corrections', { note: 'Fix chapter 4 tables' })).data.status, 'corrections');
    assert.equal((await upload('POST', `/api/research/${id}/corrections`, student, { summary: 'Fixed' })).data.status, 'corrections_review');
    assert.equal((await act(supervisor, id, 'approve_corrections')).data.status, 'defended');
    assert.equal((await act(coord, id, 'clear')).status, 403, 'the HoD clears');
    const cleared = await act(hod, id, 'clear');
    assert.equal(cleared.data.status, 'cleared');

    const detail = (await api('GET', `/api/research/${id}`, { token: student })).data;
    assert.ok(detail.documents.length >= 4);
    const cert = await api('GET', `/api/research/${id}/certificate`, { token: student });
    assert.equal(cert.type, 'application/pdf');
    const verify = await api('GET', `/api/verify/${detail.verify_code}`);
    assert.equal(verify.data.type, 'research');
    assert.equal(verify.data.research.cleared, true);
    assert.ok(verify.data.sign_offs.filter((s) => s.footprint).length >= 9, 'every sign-off leaves a footprint');

    // Documents are private to the people on the project.
    const doc = detail.documents[0];
    const dl = await api('GET', `/api/research/documents/${doc.id}`, { token: supervisor });
    assert.equal(dl.status, 200);
    assert.equal((await api('GET', `/api/research/documents/${doc.id}`, { token: await login('rep.bscs1@students.demo.edu') })).status, 404);
    assert.ok((await api('GET', '/api/research?view=supervising', { token: supervisor })).data.some((p) => p.id === id));
  });
});

describe('Filtered reports, workload limits and internal part-time load', () => {
  test('reports filter by department, year and sections, and export as PDF and Excel', async () => {
    const admin = await login('admin@demo.edu');
    const opts = (await api('GET', '/api/reports/options', { token: admin })).data;
    const cs = opts.departments.find((d) => d.name === 'Computer Science');
    assert.ok(opts.faculties.length >= 2 && opts.lecturers.length > 0 && opts.sections.missed);
    const all = (await api('GET', '/api/reports/overview', { token: admin })).data;
    const r = (await api('GET', `/api/reports/overview?department_id=${cs.id}&year_of_study=2&threshold=80&sections=summary,workload,at_risk`, { token: admin })).data;
    assert.deepEqual(r.filters.labels, ['Department: Computer Science', 'Year 2', 'At risk below 80%']);
    assert.deepEqual(r.sections, ['summary', 'workload', 'at_risk']);
    assert.ok(r.counts.classes >= 1 && r.counts.classes < all.counts.classes);
    assert.equal(r.attendance.at_risk_threshold, 80);
    assert.ok(r.attendance.at_risk.every((s) => s.rate < 80));
    assert.equal(r.rooms.length, 0); // not asked for
    // Cross-cutting units taught to the class bring their lecturers from other departments.
    assert.ok(r.workload.some((w) => w.department !== 'Computer Science'));
    assert.ok(r.workload.every((w) => 'max_hours' in w && 'status' in w));

    const pdf = await api('GET', `/api/reports/export?format=pdf&department_id=${cs.id}&year_of_study=2`, { token: admin });
    assert.equal(pdf.status, 200);
    assert.match(pdf.type, /pdf/);
    assert.equal(pdf.data.subarray(0, 4).toString(), '%PDF');
    const xlsx = await api('GET', `/api/reports/export?department_id=${cs.id}`, { token: admin });
    assert.match(xlsx.type, /spreadsheetml/);
    assert.equal(xlsx.data.subarray(0, 2).toString(), 'PK');

    // A lecturer filters within their own teaching only.
    const lec = await login('brian.kato@demo.edu');
    const mine = (await api('GET', '/api/reports/options', { token: lec })).data;
    assert.equal(mine.lecturers.length, 0);
    assert.ok(mine.course_units.length > 0);
    const one = (await api('GET', `/api/reports/overview?course_unit_id=${mine.course_units[0].id}`, { token: lec })).data;
    assert.equal(one.attendance.by_course.length, 1);
  });

  test('allocating above the maximum load needs an override and becomes claimable internal part-time load', async () => {
    const admin = await login('admin@demo.edu');
    const hod = await login('hod.cs@demo.edu');
    const brian = q.get("SELECT * FROM users WHERE email = 'brian.kato@demo.edu'");
    const set = await api('PUT', '/api/university', { token: admin, body: { workload_min_hours: 2, workload_max_hours: 8 } });
    assert.equal(set.status, 200);
    // One of Brian's allocations with approved lectures (the current term may be a later one by now).
    const target = q.get(
      `SELECT a.* FROM allocations a WHERE a.lecturer_id = ? AND EXISTS (SELECT 1 FROM timetable_sessions s JOIN attendance_registers r ON r.session_id = s.id
        WHERE s.allocation_id = a.id AND r.status = 'approved') ORDER BY a.hours_per_week LIMIT 1`,
      brian.id,
    );
    const loads = (await api('GET', `/api/allocations/workloads?term_id=${target.term_id}`, { token: hod })).data;
    assert.equal(loads.items.find((w) => w.id === brian.id).max, 8);
    const others = q.get('SELECT COALESCE(SUM(hours_per_week), 0) AS h FROM allocations WHERE lecturer_id = ? AND term_id = ? AND id != ?', brian.id, target.term_id, target.id).h;
    const newHours = 8 - others + 2; // two hours over the maximum
    const blocked = await api('PUT', `/api/allocations/${target.id}`, { token: admin, body: { hours_per_week: newHours } });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.code, 'WORKLOAD_OVER_MAX');
    assert.equal(blocked.data.workload.excess, 2);
    const over = await api('PUT', `/api/allocations/${target.id}`, { token: admin, body: { hours_per_week: newHours, override_workload: true } });
    assert.equal(over.status, 200);
    assert.equal(over.data.part_time_hours, 2);
    assert.equal((await api('GET', `/api/allocations/workloads?term_id=${target.term_id}`, { token: hod })).data.items.find((w) => w.id === brian.id).status, 'over');

    // Brian (full-time) can now claim the part-time share of that unit's lectures only.
    const token = await login('brian.kato@demo.edu');
    assert.equal((await api('GET', '/api/auth/me', { token })).data.user.internal_part_time, true);
    const today = zonedNow('Africa/Kampala').date;
    const preview = (await api('GET', `/api/claims/preview?from=${addDays(today, -60)}&to=${today}`, { token })).data;
    const unit = q.get('SELECT code FROM course_units WHERE id = ?', target.course_unit_id).code;
    assert.ok(preview.lectures.length > 0);
    assert.ok(preview.lectures.every((l) => l.course_unit_code === unit));
    assert.ok(preview.lectures.every((l) => Math.abs(l.internal_share - 2 / newHours) < 0.01));

    // Restore the demo defaults for the other tests.
    await api('PUT', `/api/allocations/${target.id}`, { token: admin, body: { hours_per_week: target.hours_per_week, override_workload: true } });
    q.run('UPDATE allocations SET part_time_hours = 0 WHERE id = ?', target.id);
    await api('PUT', '/api/university', { token: admin, body: { workload_min_hours: 10, workload_max_hours: 20 } });
  });

  test('a unit can be offered to full-time staff as an internal part-time call', async () => {
    const admin = await login('admin@demo.edu');
    const reqs = (await api('GET', '/api/allocations/requirements', { token: admin })).data;
    const unit = [...reqs.cross_cutting, ...reqs.program_specific].find((u) => u.classes.some((c) => !c.allocation_id));
    assert.ok(unit, 'the demo data has an unallocated unit');
    const classIds = unit.classes.filter((c) => !c.allocation_id).map((c) => c.class_id);
    const call = await api('POST', '/api/allocations/part-time-calls', { token: admin, body: { course_unit_id: unit.course_unit_id, class_ids: classIds, note: 'Evening slot' } });
    assert.equal(call.status, 201);
    assert.ok(call.data.notified > 0);
    const deptId = call.data.department_id;
    const volunteer = q.get("SELECT * FROM users WHERE department_id = ? AND role = 'lecturer' AND employment_type = 'full_time' AND active = 1 ORDER BY id LIMIT 1", deptId);
    const vt = await login(volunteer.email);
    const open = (await api('GET', '/api/allocations/part-time-calls', { token: vt })).data;
    assert.ok(open.some((c) => c.id === call.data.id));
    assert.equal((await api('POST', `/api/allocations/part-time-calls/${call.data.id}/respond`, { token: vt, body: { note: 'Happy to' } })).data.responded, true);
    const seen = (await api('GET', '/api/allocations/part-time-calls', { token: admin })).data.find((c) => c.id === call.data.id);
    assert.equal(seen.responses[0].user_id, volunteer.id);
    assert.ok(seen.responses[0].workload);
    const assigned = await api('POST', `/api/allocations/part-time-calls/${call.data.id}/assign`, { token: admin, body: { user_id: volunteer.id } });
    assert.equal(assigned.status, 200);
    assert.equal(assigned.data.call.status, 'filled');
    assert.equal(assigned.data.allocation.part_time_hours, assigned.data.allocation.hours_per_week);
    q.run('DELETE FROM allocations WHERE id = ?', assigned.data.allocation.id);
  });

  test('the HoD sets a lecturer position and personal workload limits', async () => {
    const hod = await login('hod.cs@demo.edu');
    const esther = q.get("SELECT * FROM users WHERE email = 'esther.atim@demo.edu'");
    const res = await api('PUT', `/api/users/${esther.id}`, { token: hod, body: { designation: 'Assistant Lecturer', workload_max: 12 } });
    assert.equal(res.status, 200);
    assert.equal(res.data.designation, 'Assistant Lecturer');
    assert.equal(res.data.workload_max, 12);
    assert.equal((await api('PUT', `/api/users/${esther.id}`, { token: hod, body: { workload_min: 14, workload_max: 12 } })).status, 400);
    await api('PUT', `/api/users/${esther.id}`, { token: hod, body: { designation: '', workload_max: '' } });
  });
});
