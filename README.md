# Arabtec Recruitment Hub — Phases 1–3

A real, runnable local application.
- **Phase 1** — platform foundation: auth, RBAC, admin, branding, org, audit.
- **Phase 2** — Recruitment Requests / Ticketing: controlled tickets, approval chain, budget validation, recruiter assignment, SLA/priority, reason-required lifecycle, audit.
- **Phase 3** — Candidate Database, Applications & Pipeline: the Talent Pool, the **candidate↔application separation** (status lives on the application, never the candidate), duplicate detection, link-to-request, and a Kanban/List/Compact **candidate pipeline** with quick + bulk actions and Joined→vacancy automation.

> Interviews and Offers are **not** in these phases (Phase 4); the pipeline and candidate profile show clearly-labeled placeholders for them.

---

## Tech stack
- **Backend:** Node.js + Express (REST API)
- **Database:** SQLite via Node's built-in `node:sqlite` (zero native deps, real file persistence)
- **Auth:** JWT (signed tokens) + server-side sessions + bcrypt password hashing
- **Frontend:** React (single-page app), Arabtec-branded enterprise UI
- **Migration-ready:** raw SQL in `backend/src/lib/schema.js`; PostgreSQL DDL in `backend/docs/SCHEMA.sql`; canonical data model in `backend/prisma/schema.prisma`

## Requirements
- **Node.js ≥ 22.5** (uses the built-in `node:sqlite` module — check with `node --version`)

---

## Install & run (one time)

```bash
cd backend
cp .env.example .env        # adjust JWT_SECRET for anything beyond local use
npm install                 # installs express, bcryptjs, jsonwebtoken, etc.
npm run seed                # creates the SQLite DB, tables, and seed data
npm start                   # starts the server on http://localhost:4000
```

Then open **http://localhost:4000** in your browser. The backend serves both the API and the React frontend, so there is nothing else to start.

> If you ever want a clean database: `npm run reset` (drops the db file and re-seeds).

---

## Seeded login accounts

| Role | Email | Password |
|------|-------|----------|
| **System Admin** | `admin@arabtec.com` | `Admin@12345` |
| HR Director | `hr.director@arabtec.com` | `Arabtec@123` |
| HR Manager | `hr.manager@arabtec.com` | `Arabtec@123` |
| Recruitment Manager | `rec.manager@arabtec.com` | `Arabtec@123` |
| Recruiter | `recruiter@arabtec.com` | `Arabtec@123` |
| Hiring Manager | `hiring.manager@arabtec.com` | `Arabtec@123` |
| Project Manager | `pm@arabtec.com` | `Arabtec@123` |
| Interviewer | `interviewer@arabtec.com` | `Arabtec@123` |
| Viewer | `viewer@arabtec.com` | `Arabtec@123` |

Log in as **admin** to see everything; log in as **recruiter** to see how the UI and API both restrict access.

---

## What you can do in Phase 1
- **Authentication:** branded login, remember-me, logout, protected routes, server-side sessions, forgot-password placeholder.
- **User management:** create/edit users, activate/deactivate, reset password, assign roles, department, and project/site access, view last login and per-user activity.
- **Roles & permissions:** 9 seeded roles, 32 permissions, edit any role's permission matrix (enforced server-side).
- **Org setup:** manage Projects, Sites, Departments.
- **Branding:** edit colors/typography/density/sidebar; **changes apply to the live UI** and persist.
- **Button & feature control:** toggle visibility/enabled/confirm/reason/audit per action.
- **Workflow & system settings:** view seeded workflow state machines; edit system defaults.
- **Audit logs:** searchable, filterable, with before/after diffs for every critical action.

## Project layout
```
arabtec-recruitment-hub/
├─ backend/
│  ├─ src/
│  │  ├─ server.js            # Express app, static hosting, route mounting
│  │  ├─ lib/                 # db (node:sqlite), schema, models, auth, audit, permissions
│  │  ├─ middleware/auth.js   # requireAuth + requirePermission (RBAC in logic)
│  │  └─ routes/              # auth, users, roles, org, settings, audit
│  ├─ prisma/
│  │  ├─ schema.prisma        # canonical data model (Postgres-ready, documentation)
│  │  └─ seed.js              # idempotent seed (run via `npm run seed`)
│  ├─ docs/SCHEMA.sql         # PostgreSQL DDL
│  ├─ smoketest.mjs           # backend API + RBAC + audit tests
│  └─ static_test.mjs         # static/SPA serving tests
└─ frontend/public/
   ├─ index.html              # SPA entry (React + Babel via CDN, no build step)
   ├─ styles.css              # enterprise theme (CSS variables driven by branding)
   └─ app.jsx                 # the full SPA
```

## Running the tests
```bash
cd backend
node --experimental-sqlite inproc_test.mjs   # Phase 1: API, RBAC, audit (27 checks)
node --experimental-sqlite phase2_test.mjs   # Phase 2: requisition lifecycle (31 checks)
node --experimental-sqlite phase3_test.mjs   # Phase 3: candidates/applications/pipeline (33 checks)
node --experimental-sqlite phase3_qa_test.mjs # Phase 3 QA: overfill, masking, RBAC, dedup (49 checks)
node --experimental-sqlite phase4_test.mjs   # Phase 4: interviews & feedback, scope, separation (32 checks)
node --experimental-sqlite phase4_qa_test.mjs # Phase 4 QA: integrity, scope, terminal-app, audit (36 checks)
node --experimental-sqlite phase5_test.mjs   # Phase 5: offers, approval, joining (49 checks)
node --experimental-sqlite phase6_test.mjs   # Phase 6: dashboards, scope, no-leak (21 checks)
node --experimental-sqlite static_test.mjs   # static + SPA fallback (6 checks)
```
Total: **284 automated checks**, all passing. See `PHASE6_SUMMARY.md` and prior phase docs.

## Phase 6 — Dashboards
- Role-aware analytics dashboard (read-only) at `/api/dashboard`, replacing the placeholder home page.
- KPIs: open requests, fill rate, candidates in pipeline, upcoming interviews, offers, offer-acceptance rate, joined, avg time-to-fill.
- Charts (inline SVG, no external libraries): requests-by-status, requisition aging, pipeline funnel, offer outcomes, recruiter load, and a "My Work" panel.
- **Scope-enforced server-side:** `request.view_all` → org-wide; `request.view_own` → only the user's own requests. **No salary or restricted field is ever returned.** Gated by `dashboard.view`.

## Phase 5 — Offers & Joining
- **Offer** links to application + candidate + request; offer status is a separate lifecycle (draft → pending_approval → approved → sent → accepted → joined; plus rejected-by-approver / rejected-by-candidate / withdrawn).
- **Approval chain:** HR Manager always; **HR Director** added automatically when salary exceeds the configurable threshold. Salary change after approval forces **re-approval**.
- **Result tracking:** send, accept, reject-by-candidate (reason), withdraw (reason), join. Application stage moves (offer_preparation / offer_sent / offer_accepted / joined) are **controlled**, not auto-overwritten.
- **Joining reuses the Phase 3 safe vacancy automation** (now shared in `lib/vacancy.js`): transactional seat fill, **no overfill**, **no double-count**, request → Partially Filled / Filled.
- **Salary is restricted server-side** by `offer.salary_view` / `offer.salary_edit` — masked everywhere unauthorized (list, detail, candidate profile).

> Roadmap: **Phase 6 = Dashboards** · **Reports** (not built yet).

## Phase 4 — Interviews & Feedback
- Schedule interviews from the pipeline; each interview links to **application + candidate + request**.
- **Interview status is a separate lifecycle** (scheduled / completed / no_show / cancelled / rescheduled) and never changes the application's pipeline status.
- **Feedback** is permission-controlled and panel-scoped: only assigned panel members (or the organizer / full-view roles) can submit; reasons required to cancel.
- **Scoped visibility:** Hiring Managers and Interviewers see only interviews where they are on the panel; recruiters/HR see all. Enforced server-side.
- Interviews list ("My Interviews" when scoped), interview detail with panel + feedback + activity, and a populated candidate-profile **Interviews** tab.

## Phase 3 — Candidate Database, Applications & Pipeline
- **Talent Pool** with search/filters, add/edit (live duplicate detection + authorized override-with-reason), and a candidate profile with 6 tabs (Overview, CV & Attachments, **Applications**, Interviews*, Offers*, Notes & Activity). *= Phase 4 placeholder.
- **Candidate↔Application separation:** status lives on the application; one candidate ↔ many independent applications. `UNIQUE(candidate_id, request_id)` blocks duplicate applications.
- **Pipeline** inside a request: Kanban / List / Compact views, 16 statuses, candidate cards (with match score, masked salary), quick actions (shortlist, send to HM, move, hold, reject), bulk actions, reason modals, and a quick-view side panel.
- **Reason required** for Rejected / On Hold / Withdrawn / Offer Rejected. **Joined** auto-fills a seat and flips the request to Partially Filled / Filled.

## Phase 2 — Recruitment Requests
- **Create** a request (auto ID `REQ-YYYY-#####`), with project/site/department, headcount (one **seat** per vacancy), priority, discipline, salary band (salary fields only for authorized roles).
- **Views:** table + card, with search, status/priority filters, and sorting.
- **Detail page tabs:** Overview, Job Description, Approval Workflow, Timeline/Activity, and a **Candidate Pipeline placeholder** (Phase 3).
- **Lifecycle:** Draft → Pending Approval → Budget Validation → Approved → In Sourcing → … with On Hold / Reject / Cancel / Close / Reopen. A conditional **HR Director** approval level is inserted for high salary band, large headcount, or critical priority.
- **Actions requiring a reason** (recorded in audit): reject, cancel, hold, close, reopen.
- **Buttons** shown on the detail page are resolved from the admin button configuration **and** the user's permissions **and** the request's current status.

## Migrating to PostgreSQL later
1. Provision Postgres and run `backend/docs/SCHEMA.sql` (or use `prisma/schema.prisma` with `provider = "postgresql"`).
2. Replace `node:sqlite` in `src/lib/db.js` with a `pg` pool exposing the same `get/all/run` helpers — the repository (`models.js`) and routes are unchanged.

## Security notes (Phase 1)
- Passwords hashed with bcrypt; JWT secret read from env; sessions revoked on logout/deactivate/password-reset.
- RBAC is enforced **server-side** on every protected route — the UI hiding is convenience only.
- Basic login rate-limiting per IP. For production: set a strong `JWT_SECRET`, enable HTTPS (`NODE_ENV=production`), and consider MFA (seeded flag present).
