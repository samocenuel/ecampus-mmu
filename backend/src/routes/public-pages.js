// Public pages required by app stores: privacy policy and account deletion instructions.
import { Router } from 'express';

const router = Router();
const APP = process.env.APP_NAME || 'eCampus MMU';
const CONTACT = process.env.SUPPORT_EMAIL || '';
const UPDATED = '12 October 2026';

const contactLine = CONTACT
  ? `<a href="mailto:${CONTACT}">${CONTACT}</a>`
  : 'your university\'s eCampus administrator';

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - ${APP}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; margin: 0; background: #f4f6f9; color: #101828; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 16px 64px; }
  header { background: #0d5e47; color: #fff; padding: 24px 16px; }
  header div { max-width: 760px; margin: 0 auto; }
  h1 { margin: 0; font-size: 26px; } h2 { font-size: 19px; margin-top: 28px; }
  .muted { color: #667085; } a { color: #0d5e47; }
  @media (prefers-color-scheme: dark) { body { background: #0f1720; color: #e5e7eb; } .muted { color: #9ca3af; } a { color: #5fd3a8; } }
</style></head>
<body><header><div><strong>${APP}</strong><h1>${title}</h1></div></header><main>${body}</main></body></html>`;

router.get('/privacy', (_req, res) => {
  res.type('html').send(
    page(
      'Privacy policy',
      `<p class="muted">Last updated ${UPDATED}</p>
<p>${APP} ("the app") helps universities manage teaching and learning: timetables, lecture allocation, attendance and lecture reminders. Each university that uses the app controls its own data. This policy explains what the app collects and why.</p>
<h2>Information we collect</h2>
<ul>
  <li><strong>Account details</strong> your university provides or you enter: name, email address, phone number, title, staff or registration number, role, faculty, department and class.</li>
  <li><strong>Academic records</strong> created while using the app: timetables, teaching allocations, attendance registers (who was present at which lecture) and their approval status.</li>
  <li><strong>Preferences</strong>: lecture reminder settings and in-app notifications.</li>
  <li><strong>University details</strong> entered by administrators, including the university logo.</li>
</ul>
<p>The app does not collect your location, contacts, photos, advertising identifiers or payment information, and it contains no advertising.</p>
<h2>How information is used</h2>
<p>Only to provide the service to your university: signing you in, showing your timetable, recording and approving attendance, producing reports for authorised staff (administrators, Deans and Heads of Department within their unit) and sending lecture reminders.</p>
<h2>Sharing</h2>
<p>Your information is visible only to authorised members of your own university according to their role. We do not sell personal data or share it with third parties for marketing. Data may be disclosed if required by law.</p>
<h2>Security and storage</h2>
<p>Data is sent over encrypted connections (HTTPS) and passwords are stored only as salted hashes. Data is kept while your university uses the service.</p>
<h2>Notifications</h2>
<p>If you allow notifications, the app schedules lecture reminders on your device. You can turn reminders off at any time under Alerts.</p>
<h2>Deleting your account</h2>
<p>You can delete your account in the app (More &rarr; Profile &amp; password &rarr; Delete my account) or on the web. See <a href="/account-deletion">how to delete your account</a>. Your personal details are erased; anonymised attendance statistics may be kept by your university.</p>
<h2>Children</h2>
<p>The app is intended for university staff and students and is not directed at children under 13.</p>
<h2>Contact</h2>
<p>Questions about your data: contact ${contactLine}.</p>`,
    ),
  );
});

router.get('/account-deletion', (_req, res) => {
  res.type('html').send(
    page(
      'Delete your account',
      `<p>You can delete your ${APP} account and personal data at any time.</p>
<h2>In the mobile app</h2>
<ol><li>Sign in and open <strong>More</strong>.</li><li>Tap <strong>Profile &amp; password</strong>.</li><li>Tap <strong>Delete my account</strong> and confirm with your password.</li></ol>
<h2>On the web</h2>
<ol><li>Sign in at <a href="/">${APP} on the web</a>.</li><li>Open your name (top right) &rarr; <strong>Profile &amp; password</strong>.</li><li>Choose <strong>Delete my account</strong> and confirm with your password.</li></ol>
<h2>What is deleted</h2>
<p>Your name, email address, phone number, staff/registration number, notifications and reminder settings are erased immediately and you can no longer sign in. Attendance and teaching records are kept only in anonymised form ("Deleted user") so your university's statistics stay correct.</p>
<p>If you cannot sign in, ask ${contactLine} to delete your account for you.</p>`,
    ),
  );
});

export default router;
