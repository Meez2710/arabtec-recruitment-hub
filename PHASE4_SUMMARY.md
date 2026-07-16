# Arabtec Recruitment Hub — Phase 4 Report
**Module:** Interviews & Feedback (only). **Not built:** Offers, Dashboards. Built on the existing Candidate/Application model.

**Tests:** full regression **178/178 passing** (P1 27 · P2 31 · P3 33 · P3-QA 49 · **P4 32** · static 6); frontend compiles clean.
Run: `cd backend && npm run reset && npm start` → http://localhost:4000.

---

## 1. Scope delivered
- **Interview entity** that **always links to Application + Candidate + Request** (enforced: an interview is created from an application and copies its candidate/request links; all three are NOT-NULL FKs with cascade).
- **Interview status is a separate lifecycle** — `scheduled / completed / no_show / cancelled / rescheduled` — and **never replaces or changes the application's pipeline status** (verified by test).
- **Panel management** — one or more interviewers per interview, with a lead.
- **Feedback / scorecards** — recommendation (strong_yes/yes/no/strong_no), 0–5 score, comments; one feedback per interviewer per interview; an advisory aggregate **outcome** (positive/mixed/negative) is derived but is **not** an application status.
- **Permission + scope controls** — feedback is permission-gated (`interview.feedback`) AND panel-scoped (only assigned panelists / organizer / full-view roles). Scheduling and reschedule/cancel are permission-gated.
- **Scoped visibility** — Hiring Managers & Interviewers see only interviews they're assigned to; recruiters/managers/HR see all. Enforced server-side on list, detail, and candidate-profile interviews.
- **Full audit logging** for schedule, status change, and feedback events.
- **UI** — Interviews nav + scoped list ("My Interviews" when scoped); interview detail (links, panel, feedback, activity); "Schedule Interview" quick action wired into the pipeline; candidate-profile Interviews tab populated; feedback modal.

## 2. Constraints from your brief — confirmation
| Requirement | Status |
|---|---|
| All interviews link to Application, Candidate, and Recruitment Request | ✅ enforced (FKs + serializer shows all three) |
| Interview status must not replace Application status | ✅ verified — completing/cancelling an interview leaves application status unchanged |
| Interview feedback permission-controlled and audit-logged | ✅ `interview.feedback` + panel scope; `interview.feedback_submitted` audited |
| HM & Interviewers only see interviews/candidates assigned to them / in scope | ✅ scoped list + 403 on unassigned detail; candidate-profile interviews filtered |
| Do not implement Offers / Dashboards | ✅ not built (Offers tab labeled Phase 5) |

## 3. Files changed / added
- **Added:** `backend/src/routes/interviews.js`; `backend/phase4_test.mjs`; `PHASE4_SUMMARY.md`.
- **Changed:** `backend/src/lib/schema.js` (+4 tables), `backend/src/lib/models.js` (Interviews/InterviewPanel/InterviewFeedback/InterviewActivity repositories), `backend/src/lib/permissions.js` (+3 interview permissions, +3 buttons, role grants), `backend/prisma/seed.js` (interview counter/prefix), `backend/src/server.js` (mount `/api/interviews`), `backend/src/routes/candidates.js` (scoped interviews on profile), `frontend/public/app.jsx` (Interviews page, schedule modal, detail, feedback modal, pipeline action, profile tab), `backend/prisma/schema.prisma` + `backend/docs/SCHEMA.sql` (Phase 4 parity), `README.md`. Updated `smoketest.mjs` permission count (40→43).

## 4. Schema changes (parity across SQLite / Prisma / Postgres)
New tables: `interview` (links application+candidate+request; own `status`; `overall_outcome`), `interview_panel` (PK interview+interviewer, `is_lead`), `interview_feedback` (`UNIQUE(interview_id, interviewer_id)`), `interview_activity`. New settings: `interview_prefix`, `interview_counter`. FKs are NOT-NULL with `ON DELETE CASCADE` → no orphan interviews/feedback.

## 5. Permissions added / role mapping
- **Added:** `interview.view_all`, `interview.view_assigned`, `interview.edit` (plus existing `interview.schedule`, `interview.feedback`).
- **Mapping:** HR Director/Manager/Recruitment Manager/Recruiter → `view_all` (+ schedule/edit/feedback as appropriate); **Hiring Manager & Interviewer → `view_assigned` + `feedback` only** (scoped, cannot schedule); Viewer → `view_all` read-only. All editable in Admin → Roles & Permissions.

## 6. Status / lifecycle rules
- Interview lifecycle is independent: scheduling/completing/cancelling/rescheduling changes only `interview.status`.
- Reschedule into the past is blocked; scheduling in the past is blocked; empty panel is blocked.
- Cancel requires a reason (audited). Cancelled/completed interviews can't be edited.
- Feedback is upsert (one per interviewer); aggregate outcome recomputed on each submission (advisory only).

## 7. Audit events added
`interview.scheduled`, `interview.updated`, `interview.status_changed`, `interview.feedback_submitted` — each with actor/role, entity id, before/after where relevant, and reason on cancel.

## 8. Phase 4 test coverage (32 checks)
Links to application/candidate/request; interview has its own id + status; **application status unchanged** after scheduling and after completing; past-date and empty-panel validation; **feedback permission + panel scope** (panelists can, viewer 403); aggregate outcome; **scope** (interviewer/HM see only assigned, recruiter sees all, 403 on unassigned detail); schedule RBAC (interviewer/HM cannot schedule); cancel-reason required; candidate-profile interviews scoped; audit events present.

## 9. Known limitations / not in this phase
- **Offers** and **Dashboards** intentionally excluded (your instruction) — Offers tab shows a Phase 5 placeholder.
- No calendar/email invites yet (notifications are a later phase); interview "calendar view" is a list, not a month grid.
- Panel double-booking / availability checks are not enforced (a later enhancement).
- Feedback does not auto-advance the application stage (by design — interview status must not drive application status; a recruiter moves the stage manually).

## 10. Manual testing checklist
1. As **recruiter**, open a request → Candidate Pipeline → a candidate card → **Actions ▾ → Schedule Interview**; pick type/mode/date, select panel (include **Mona Sami** the interviewer and **Nadia Fouad** the hiring manager), Schedule.
2. Confirm the candidate's **pipeline status is unchanged** after scheduling.
3. Go to **Interviews** (nav) → open the interview → **Mark Completed** → confirm the application's pipeline status is still unchanged.
4. Log in as **interviewer@arabtec.com** → **Interviews** shows "My Interviews" with only the assigned one; opening an unassigned interview's URL is blocked. Submit **feedback** (recommendation + score + comments).
5. Log in as **hiring.manager@arabtec.com** → sees the assigned interview, can submit feedback, but **cannot schedule** (no Schedule action).
6. Log in as **viewer@arabtec.com** → can view interviews (read-only) but cannot submit feedback.
7. Back as recruiter, open the interview → see both feedback entries and the aggregate **outcome** badge; **Cancel** another interview → reason required.
8. Open the candidate's profile → **Interviews** tab lists the interview(s).
9. Admin → **Audit Logs** → confirm `interview.scheduled`, `interview.status_changed`, `interview.feedback_submitted`.

## 11. Readiness
All Phase 4 constraints met and tested; 178/178 checks pass; schema parity maintained; permissions and scope enforced server-side; interview/application separation verified. Ready for QA.

**Stopping after Phase 4 as instructed. No Offers or Dashboards work will begin without your explicit approval.**
