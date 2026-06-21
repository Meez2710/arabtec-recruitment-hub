# Phase 4 — QA, Security, Data-Integrity, ATS Workflow & UX Audit
**Reviewed as:** Senior ATS architect · Recruitment-ops consultant · Interview-workflow consultant · DB architect · Security reviewer · QA engineer · Enterprise UX auditor.
**Governance noted:** Phase 5 = **Offers & Joining only**; Dashboards = **Phase 6**. Neither built.
**Outcome:** 4 issues found and fixed; +36-check QA suite added; **full regression 214/214 passing**. Phase 4 is safe to approve for closure.

---

## 1. Issues found
| # | Severity | Area | Finding |
|---|----------|------|---------|
| I-1 | 🟠 Medium | Workflow integrity | **Scheduling for a terminal application was allowed.** An interview could be scheduled for a `rejected`/`withdrawn`/`joined`/`offer_rejected` application. The brief requires this be blocked unless an authorized user explicitly overrides. |
| I-2 | 🟡 Low | Audit granularity | **Feedback update was not distinguished from submit.** Re-submitting feedback (upsert) logged `interview.feedback_submitted` both times; the QA wants `feedback updated` distinct. |
| I-3 | 🟡 Low | Audit granularity | **Panel change had no dedicated audit event.** Editing the panel logged only `interview.updated`; the QA lists "Interview panel changed". |
| I-4 | 🟡 Low | Scope completeness | **Hiring-Manager scope was panel-only.** A Hiring Manager who *requested/owns* a requisition but was not placed on the panel could not see its interviews. The brief says HM scope = "their own requests **or** assigned interviews". |

**Verified correct — no change required (and now test-locked):**
- **No spoofing.** `candidate_id` and `request_id` are derived server-side from the looked-up application, never from the client body (test sends bogus ids; server uses the application's). 
- **FK integrity / no orphans.** `interview.application_id/candidate_id/request_id` are NOT-NULL FKs with `ON DELETE CASCADE`; `interview_feedback`/`interview_panel`/`interview_activity` cascade from `interview`.
- **Status separation.** Interview status (scheduled/completed/no_show/cancelled/rescheduled) never changes application status — verified for completing, cancelling, no-show. Application status still lives only on `application`. Aggregate outcome badge is advisory only.
- **Duplicate feedback** handled as **update** (upsert; `UNIQUE(interview_id, interviewer_id)`), not a duplicate row.
- **Validation** present: past date blocked, empty panel blocked, invalid application 404, cancel-reason required.
- **RBAC server-side:** interviewer/viewer cannot schedule or edit; only panelists/organizer/full-view can feedback; unauthorized detail and feedback return 403.

## 2. Fixes made
- **I-1:** `POST /interviews` now blocks scheduling when `application.status` ∈ {rejected, withdrawn, joined, offer_rejected} → **409**. An override path requires the `candidate.merge` permission **and** a reason; the override is audited (`Terminal-app override: <reason>`).
- **I-2:** feedback endpoint detects an existing entry and emits `interview.feedback_updated` (vs `interview.feedback_submitted`), with matching activity types.
- **I-3:** reschedule/edit now diffs the panel and, on change, writes `interview.panel_changed` (old/new panel) plus a `panel_changed` activity entry. Edit also now blocks an empty panel.
- **I-4:** scope helper `canViewInterview` and the list/profile queries now also grant access when the user is the **requester/owner/creator of the request** (not only a panelist/organizer). Verified: an HM sees interviews on their own requisition without being on the panel.
- **UX:** added **Mark No-Show** action; feedback is allowed on **completed** interviews (not just active); No-Show carries a note.

## 3. Files changed
- `backend/src/routes/interviews.js` — terminal-app block + override, feedback submit/update audit split, panel-change audit, request-owner scope, empty-panel guard on edit.
- `backend/src/routes/candidates.js` — candidate-profile interviews now include request-owner scope.
- `frontend/public/app.jsx` — Mark No-Show action; feedback allowed when completed.
- `backend/phase4_qa_test.mjs` — **new** 36-check QA suite.
- `PHASE4_QA_AUDIT.md` — this report.

## 4. Tests added / updated
New `phase4_qa_test.mjs` (36 checks): no-spoofing (links derived from application); no-show does not change application status; terminal-app scheduling blocked + authorized override + override audited; validation (no panel, past date, invalid application); reschedule sets rescheduled; panel update; feedback submit vs update; viewer/non-panelist feedback 403; interviewer scope (sees assigned, not others, 403 on unassigned detail); **HM sees own-request interviews without being on panel**; schedule/edit RBAC; cancel-reason required; candidate-profile interviews scoped; audit coverage (scheduled, status_changed, feedback_submitted, **feedback_updated**, **panel_changed**, updated); feedback uniqueness (no dup rows).

## 5. Final test count and result
| Suite | Checks | Result |
|-------|--------|--------|
| Phase 1 | 27 | ✅ |
| Phase 2 | 31 | ✅ |
| Phase 3 | 33 | ✅ |
| Phase 3 QA | 49 | ✅ |
| Phase 4 | 32 | ✅ |
| **Phase 4 QA** | **36** | ✅ |
| Static / SPA | 6 | ✅ |
| **Total** | **214** | **✅ all passing** |
Frontend `app.jsx` compiles cleanly with `@babel/preset-react`.

## 6. Schema consistency confirmation
Phase 4 tables (`interview`, `interview_panel`, `interview_feedback`, `interview_activity`) are present and aligned across **SQLite** (`src/lib/schema.js`), **Prisma** (`prisma/schema.prisma`), and **PostgreSQL** (`docs/SCHEMA.sql`), including `UNIQUE(interview_id, interviewer_id)` on feedback and the NOT-NULL FKs with cascade. New counters `interview_prefix` / `interview_counter` seeded.
**Production note:** `npm run reset` is **local-demo only** (drops + reseeds the SQLite file). Production must use **migrations** (Prisma Migrate or versioned SQL from `docs/SCHEMA.sql`) — never reset.

## 7. Permission enforcement confirmation
Enforced server-side: `interview.view_all`, `interview.view_assigned`, `interview.schedule`, `interview.edit`, `interview.feedback`. Salary/candidate visibility inside the interview context reuses the same field-level masking as elsewhere (interview serializer exposes only non-sensitive candidate fields; salary is not included in interview payloads). Direct-API tests for Recruiter, Hiring Manager, Interviewer, and Viewer confirm: full-view roles see all; recruiter manages in scope; HM sees own-request/assigned only; interviewer sees assigned only; viewer read-only; unauthorized detail/feedback → 403; hidden actions blocked at the API.

## 8. Interview / Application status separation confirmation
**Confirmed.** Interview status is a separate lifecycle column on `interview`. Scheduling, completing, no-showing, cancelling, and rescheduling change only `interview.status` and never touch `application.status` (test-verified). The derived `overall_outcome` is advisory and is not an application status. Application status remains solely on `application`.

## 9. Remaining limitations
- **Offers & Joining** (Phase 5) and **Dashboards** (Phase 6) intentionally not built.
- No email/calendar invites yet (notifications are a later phase); the interview "calendar" is a list, not a month grid.
- Panel **double-booking / availability** checks are not enforced (future enhancement).
- Interview feedback does **not** auto-advance the application stage (by design — interview status must not drive application status; recruiters move stages manually).
- "Unauthorized access attempt" auditing: 403s are returned and standard auth-failure events are logged, but a dedicated per-resource access-denied audit record is not written (future hardening).

## 10. Manual testing checklist
1. As **recruiter**, schedule an interview from a pipeline card; confirm the candidate's pipeline status is unchanged.
2. **Mark No-Show**, then **Mark Completed** on (different) interviews → confirm application status stays unchanged either way.
3. Try scheduling for a **rejected** application → blocked (409). As **hr.manager**, retry with override reason → succeeds and shows in Audit with the reason.
4. **Reschedule** an interview → status becomes Rescheduled (audited); change the **panel** → `interview.panel_changed` appears in Audit.
5. As **interviewer**, submit feedback then update it → confirm one feedback row and both `feedback_submitted` + `feedback_updated` audit events.
6. As **viewer**, attempt feedback → 403; as a **non-panelist HM on someone else's request** → 403.
7. As **hiring.manager** who *requested* a requisition, open Interviews → you see its interviews even without being on the panel; opening an interview on a request you don't own → 403.
8. As **interviewer**, confirm "My Interviews" shows only assigned interviews; the candidate profile **Interviews** tab shows only those you may see.
9. Admin → **Audit Logs** → confirm scheduled / status_changed / feedback_submitted / feedback_updated / panel_changed / updated, each with actor, role, entity, old/new, timestamp, reason.

## 11. Is Phase 4 safe to approve for closure?
**Yes.** All findings fixed and covered by automated tests; 214/214 passing; schema parity confirmed across all three files; permissions and scope enforced server-side; interview/application status separation verified; data-integrity links derived from the application (non-spoofable) with FK/orphan protection. Remaining items are intentional later-phase scope or noted future hardening.

*Phase 5 (Offers & Joining) will begin only on your explicit instruction: "Approved. Continue to Phase 5."*
