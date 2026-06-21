# Arabtec Recruitment Hub — Phase 2 Summary
**Module:** Recruitment Requests / Ticketing · Built on the accepted Phase 1 foundation · No candidates/applications.

Automated tests: **Phase 1 = 27/27 · Phase 2 = 31/31 · Static/SPA = 6/6 (64 total, all passing).**

---

## 1. What was implemented
A complete Recruitment Request (ticket) module:
- **Recruitment Request entity** with **auto-generated ticket ID** (`REQ-YYYY-#####` via a counter in system settings).
- **Multi-vacancy seats:** one `requisition_seat` row per headcount (foundation for partial fill / reopen).
- **Create form** (modal wizard) with project/site/department, headcount, priority, discipline, employment type, staff category, grade, target join date, skills, justification, job description, and salary band (only for salary-authorized roles).
- **List views:** **table** and **card**, with **search** (title/ticket/discipline), **filters** (status, priority), and **sorting** (created/priority/title/status/ticket, asc/desc).
- **Detail page with 5 tabs:** Overview, Job Description, Approval Workflow, Timeline/Activity, and **Candidate Pipeline placeholder** (Phase 3).
- **Status workflow:** Draft → Pending Approval → Budget Validation → Approved → In Sourcing → In Progress → Partially Filled → Filled → Closed, plus On Hold / Rejected / Cancelled / Reopened.
- **Priority + SLA indicators** (badge colors; SLA countdown / overdue / breached).
- **Approval chain:** HM/PM → Department Head → HR Manager → Budget Validation, with a **conditional HR Director** level (high salary band, headcount ≥ threshold, or critical priority).
- **Budget validation** step (validate/reject with reason) gated by `request.budget_approve`.
- **Recruiter assignment** (moves Approved → In Sourcing).
- **Reason-required actions:** reject, cancel, hold (+ resume), close, reopen — each writes a reason to the audit trail.
- **Material-change re-approval:** editing headcount/salary band/grade after approval resets the chain to Pending.
- **Full audit logging** and a per-request **activity timeline**.

## 2. Files changed / added
- **Added:** `backend/src/routes/requests.js` (full lifecycle API); `backend/phase2_test.mjs` (31 checks); `PHASE2_SUMMARY.md`.
- **Changed:** `backend/src/lib/schema.js` (+4 tables), `backend/src/lib/models.js` (+Requests/Seats/Approvals/RequestActivity repositories), `backend/src/lib/permissions.js` (+5 permissions, +9 buttons), `backend/prisma/seed.js` (request counter + SLA/threshold settings), `backend/src/server.js` (mount `/api/requests`), `frontend/public/app.jsx` (Requests nav, list, form, detail+tabs, dashboard KPIs), `README.md`, `.gitignore`.
- **Updated test:** `backend/smoketest.mjs` (permission count 32→37).

## 3. Database / schema changes
New tables (in `schema.js`; Postgres-portable):
- `recruitment_request` — the ticket: org links, requester/owner, employment/discipline/staff category, headcount + filled, priority, grade, **salary band**, budget status, justification, job description, skills (JSON), status, SLA fields, close reason, `version` (optimistic locking).
- `requisition_seat` — one row per vacancy (`open/reserved/filled/cancelled/reopened`).
- `request_approval` — approval chain rows (level, name, role_code, decision, comment).
- `request_activity` — per-request timeline events.

New system settings: `request_counter`, `sla_approval_hours`, `sla_sourcing_days`, `salary_band_max_threshold`, `director_approval_headcount`.

## 4. Permissions added / updated
**Added:** `request.budget_approve`, `request.hold`, `request.cancel`, `request.close`, `request.reopen`.
**Mapped (defaults):** HR Director & HR Manager get budget/cancel/close (+ HR Manager: hold/reopen); Recruitment Manager gets hold/close/reopen; Project Manager gets budget_approve; existing create/edit/submit/approve/reject/assign retained. All editable at runtime in **Admin → Roles & Permissions**.

## 5. Business rules implemented
- Auto, gap-free ticket numbering per year.
- Validation: title/project/department required; headcount ≥ 1; salary min ≤ max; target join date not in the past; project/department must exist.
- **Salary field-level security:** salary band is only returned (and only settable) when the user has `salary.view`; otherwise masked to `null` with `salaryVisible:false`. Enforced server-side in every serializer.
- A request can't enter sourcing until **Approved + Budget Validated**.
- Conditional Director approval injection by salary/headcount/priority.
- Reason mandatory for reject/cancel/hold/close/reopen.
- Material change after approval → re-approval.
- View scoping: `request.view_all` sees everything; `request.view_own` sees only owned/requested/created.
- Edit only allowed in Draft/Pending/Approved/Reopened states.

## 6. UI components added
Requests nav entry; table+card list with toolbar (search/filter/sort/view toggle); create form modal; request detail header with **status-aware, permission-resolved action buttons**; 5 tabs (Overview with seat tracker, Job Description, Approval Workflow table, Timeline, Pipeline placeholder); reason-capture confirm dialog; assign-recruiter modal; status/priority/SLA badges; dashboard Open/Total Requests KPIs.

## 7. Audit logs added
`request.created`, `request.updated`, `request.submitted`, `request.approval_decision`, `request.rejected`, `request.budget_decision`, `request.recruiter_assigned`, `request.on_hold`, `request.resumed`, `request.cancelled`, `request.closed`, `request.reopened` — each with actor, entity id, before/after where relevant, and reason in `comments`. All visible in **Admin → Audit Logs** with diffs.

## 8. Still placeholder
- **Candidate Pipeline tab** — a styled "coming in Phase 3" placeholder (no candidate/application logic).
- SLA timers are computed/displayed but not yet auto-escalated by a scheduler (escalation is designed for a later phase).
- Seats exist but are only filled by Phase 3 (joining); partial-fill auto-transition hooks are present but exercised in Phase 3.

## 9. Assumptions made
- Default approval chain & thresholds from the architecture are used (salary band > 50,000; headcount ≥ 10; critical priority → Director level). All are editable system settings.
- "Department Head" approval level is represented in the chain; in Phase 2 any holder of `request.approve` can action the current non-budget step (granular per-approver routing is a later enhancement).
- Currency default EGP (Arabtec Egypt); editable per request.

## 10. Known limitations
- Approval steps are sequential and actioned by permission, not yet bound to a specific named approver/delegation (designed for a later phase).
- No email notifications yet (Phase 4); notifications are in-app/audit only.
- `node:sqlite` requires **Node ≥ 22.5**; in the build sandbox the mounted folder couldn't host the SQLite file (tests used a local path) — on a normal machine the default path works.

## 11. Manual testing checklist
1. Log in as **hiring.manager@arabtec.com** → Recruitment Requests → **+ Create Request** → fill and create → note the `REQ-2026-#####` id; confirm salary fields are **hidden** for this role.
2. Open the request → **Submit for Approval** → status becomes Pending Approval; check the **Approval Workflow** tab shows the chain.
3. Log in as **hr.manager@arabtec.com** → open the request → **Approve** three times → status reaches **Budget Validation** → **Validate Budget** → **Approved**; confirm salary band is now **visible**.
4. Log in as **rec.manager@arabtec.com** → **Assign Recruiter** → status → In Sourcing.
5. Try **Put On Hold** with no reason (blocked) then with a reason → **Resume** → returns to In Sourcing.
6. **Close** with a reason → Closed → **Reopen** with a reason → Reopened.
7. Create a second request, Submit, then **Reject** with a reason → Rejected.
8. Toggle list **Table/Card** views; use **search**, **status/priority filters**, and **sort**.
9. Open **Timeline/Activity** tab → see every step; open **Admin → Audit Logs** → confirm matching entries with reasons and diffs.
10. Log in as **recruiter@arabtec.com** → confirm you only see owned requests and cannot Assign/Approve; log in as **viewer@arabtec.com** → cannot create.
11. Open any request → **Candidate Pipeline** tab → see the Phase 3 placeholder.

## 12. Readiness for Phase 2 QA
All 64 automated checks pass from a clean install. RBAC, salary masking, validation, the approval/budget/assignment flow, reason-required actions, view scoping, activity timeline and audit are enforced server-side and exercised by `phase2_test.mjs`. The frontend compiles cleanly and is served by the same Node server. Ready for QA and for Phase 3 (Candidate Database, Applications, Pipeline).
