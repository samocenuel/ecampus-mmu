# MMU Lecture Management System

A multi-tenant (SaaS) system for managing **teaching and learning** in universities: staff, faculties and departments, programmes and course units, rooms, load allocation, clash-free timetables, class-rep attendance with lecturer approval, lecture reminders and unit-scoped reports.

It has three parts that share one REST API:

| Part | Tech | Folder |
| --- | --- | --- |
| API + database | Node.js 24, Express 5, SQLite (built into Node), JWT | [`backend/`](backend) |
| Web app (all roles, full administration) | React 19, TypeScript, Vite | [`web/`](web) |
| Mobile app (Android / iOS, also runs in a browser) | Flutter 3.47 | [`mobile/`](mobile) |

## Features

| Requirement | Where |
| --- | --- |
| **Create a university** with logo, name, address, contacts and primary theme colour | Public "Create your university" wizard (web + mobile). The colour themes the web UI, the mobile app and the exported timetables. Admins can edit everything under *Setup → University*. |
| **Faculties linked to departments**, managed by a **Dean** and **HoD** | *Setup → Faculties / Departments*. Deans manage their faculty's departments; HoDs manage their department. |
| **Lecturer, Administrator and Student accounts** | *Users* (individual or CSV bulk import, temporary passwords). Roles: Administrator, Dean, HoD, Lecturer, Student, plus a platform owner for the SaaS. |
| Lecturers **view their teaching times** | *My timetable* (week grid or list), Excel/PDF export, "today's lectures" on the dashboard. |
| **Collision management** in timetabling | Every session is checked for room, lecturer and class double-booking (hard block), plus capacity, lunch and teaching-hours warnings. The auto-generator never creates a clash. |
| **Appoint class representatives** | *Setup → Classes* → crown icon. The student is notified. |
| Class rep **marks students present**, **lecturer approves** | *Attendance → Take attendance* (rep) → the lecturer gets a notification and approves or rejects with a note; rejected lists can be corrected and resubmitted; approved lists are locked. |
| Students **view their attendance history** | *Attendance → My attendance*: overall %, per course unit, full history, below-75% warning. |
| Admin / Dean / HoD **reports per unit** | *Reports*: Admins see the whole university, Deans their faculty (with a per-department breakdown), HoDs their department, lecturers their own teaching. Covers workload, attendance by course and class, students at risk, room utilisation and allocation progress. Exports to Excel. |
| **Programmes and course units** with codes and details; **cross-cutting units** shared across programmes | *Setup → Programmes / Course units*. Programme-specific units belong to one programme; cross-cutting units can be linked to many (per year and semester) and are taught to combined classes. |
| **Cross-cutting units allocated first**, with a **warning** otherwise | *Load allocation* is split into Step 1 (cross-cutting) and Step 2 (programme units). Creating a programme unit before any cross-cutting unit exists, or allocating one while cross-cutting allocations are pending, triggers a confirmation warning (API returns `409 requires_confirmation`). |
| **Timetable generated** and exported to **Excel or PDF** | *Timetable → Generate* places all allocations (cross-cutting first, smallest fitting room, spread across the week). Export any view (master, class, lecturer, room, department) as `.xlsx` or `.pdf`. |
| **Part-time pay claims** | *Pay claims*: the Dean sets the faculty's rates (teaching per contact hour; tasks such as marking per script or internship supervision per student). Part-time lecturers (Users → Employment: Part-time) raise a monthly claim: lectures whose attendance they approved are added automatically with the date, time, classes and students present, and they add tasks. The claim goes HoD → Dean → **HR (Directorate)**, who verifies it and records the payment reference. Any stage can return it with a reason; every step is logged and the lecturer is notified. A lecture can only be claimed once. HR exports the payment schedule to Excel. |
| Students and lecturers **set lecture reminders** | *Notifications*: on/off plus lead time (5 min to 2 h). The server sends in-app/browser reminders; the mobile app schedules real phone notifications that fire even when the app is closed. |

## Quick start (local)

Requirements: **Node.js 22.13+** (24 recommended). Flutter is only needed for the mobile app.

```bash
# 1. API (http://localhost:4000)
cd backend
npm install
npm run seed      # optional: demo university with timetable and attendance
npm run dev

# 2. Web app (http://localhost:5173), in a second terminal
cd web
npm install
npm run dev
```

For a single-server setup, run `npm run build` in `web/`. The API then serves the web app at `http://localhost:4000`, and serves the mobile app's web build at `/m/` if `mobile/build/web` exists.

### Demo accounts

`npm run seed` (or `SEED_DEMO=true`) creates **Demo University**. Visitors open it from **Try the demo (no account needed)** under the sign-in form, pick a role and are signed in without a password (`GET/POST /api/auth/demo`). The shared demo accounts can't have their password, email, role or status changed, or be deleted. For local testing the accounts below also sign in with `Passw0rd!`:

| Role | Email |
| --- | --- |
| Administrator | `admin@demo.edu` |
| Dean, Faculty of Science & Technology | `dean.fst@demo.edu` |
| HoD, Computer Science | `hod.cs@demo.edu` |
| Lecturer | `brian.kato@demo.edu` |
| Class representative (BSCS Year 1) | `rep.bscs1@students.demo.edu` |
| Student (BSCS Year 1) | `student.bscs1@students.demo.edu` |
| Part-time lecturer (Computer Science) | `esther.atim@demo.edu` |
| HR (Directorate) | `hr@demo.edu` |
| Platform owner (SaaS operator) | `owner@lms-platform.example` (local `npm run seed` only; hosted servers use `SUPER_ADMIN_PASSWORD`) |

The seed is relative to today's date, so there is always a running semester with three weeks of attendance history and some registers waiting for approval.

## Mobile app (Flutter)

```bash
cd mobile
flutter pub get
flutter run                                  # on a connected Android phone / emulator
flutter build apk --release                  # APK at build/app/outputs/flutter-apk/app-release.apk
flutter build web --release --base-href /m/  # browser build, served by the API at /m/
```

The app connects to `http://10.0.2.2:4000` (the Android emulator's address for your PC) by default. On a real phone, open **Server** on the sign-in screen and enter your PC's LAN address (e.g. `http://192.168.1.20:4000`), or build with `--dart-define=API_URL=https://your-server`.

Mobile covers every role: dashboards, timetables (with generate and add-session for managers), Excel/PDF export, attendance taking and approval, attendance history, reminders with phone notifications, reports, load allocation, and the full setup (university profile with logo upload, faculties, departments, programmes, course units, classes and class reps, rooms, terms, users).

## Deployment

* **Docker:** `docker build -t mmu-lms . && docker run -p 4000:4000 -v lms-data:/data -e JWT_SECRET=change-me mmu-lms`
* **Render:** the included [`render.yaml`](render.yaml) deploys the Docker image (set `SEED_DEMO=true` to start with demo data).
* **cPanel (e.g. Namecheap) under a sub-path:** build the web app with `VITE_API_URL=/ecampus npx vite build --base=/ecampus/`, then in *Setup Node.js App* use Node 22.13+ (or 24), application root `…/backend`, application URL `/ecampus`, startup file `start.cjs`, and set `BASE_PATH=/ecampus` and `JWT_SECRET`. Run *NPM Install* and restart.
* **CI:** [GitHub Actions](.github/workflows/ci.yml) runs the API tests, builds the web app, analyses/tests the Flutter app and uploads a release **APK** as a build artifact.

Environment variables (API): `PORT` (4000), `JWT_SECRET` (**set in production**), `DB_FILE`, `UPLOAD_DIR`, `CORS_ORIGIN` (default `*`), `SEED_DEMO`, `BASE_PATH` (sub-path such as `/ecampus`), `SUPER_ADMIN_EMAIL` + `SUPER_ADMIN_PASSWORD` (creates that platform owner account if it doesn't exist yet; with `SEED_DEMO` the demo owner gets this password, or a random one).

## Architecture notes

* **Multi-tenancy:** every record carries a `university_id`, and every API query is scoped to the signed-in user's university. The platform owner can suspend a tenant.
* **Scope rules:** see `backend/src/scope.js`. Admin covers the whole university; a Dean covers one faculty and its departments; a HoD covers one department, its programmes and classes, the units it owns (including ones shared out to other departments) and cross-cutting units shared in to its programmes. Units owned elsewhere are read-only. People lists show only the people attached to the viewer: a HoD their department, a Dean their faculty, a lecturer the students they teach.
* **Cross-cutting policy:** see `backend/src/services/allocation-rules.js`. It works out which (course unit, class) pairs the curriculum requires each semester and which are still unallocated.
* **Collision checks and generator:** see `backend/src/services/timetable.js`.
* **Exports:** see `backend/src/services/exporter.js` (ExcelJS and PDFKit, branded with the university's colour and logo).
* **Reminders:** see `backend/src/services/schedule.js` (a server loop runs every minute and is idempotent per user, session and day) and `mobile/lib/core/notifications.dart` (scheduled local notifications).

## Tests

```bash
cd backend && npm test   # onboarding, cross-cutting rules, collisions, generator, exports, attendance flow, scoping, reminders
cd mobile && flutter analyze && flutter test
cd web && npm run build  # type-check + production build
```
