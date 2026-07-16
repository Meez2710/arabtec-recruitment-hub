# Phase 3 — QA, Security, Data-Integrity & ATS Workflow Audit
**Reviewed as:** Senior ATS architect · Recruitment-ops consultant · DB architect · Security reviewer · QA engineer · Enterprise UX auditor.
**Outcome:** 4 issues found and fixed; 49-check QA edge-case suite added; **full regression 146/146 passing**; Phase 3 is safe to approve.

---

## 1. Issues found
| # | Severity | Area | Finding |
|---|----------|------|---------|
| I-1 | 🔴 High | Vacancy automation | **Overfill was possible.** Marking a candidate *Joined* when all seats were already filled still set the application to Joined (the seat-fill silently no-oped). More candidates could be Joined than vacancies. |
| I-2 | 🟠 Medium | Data integrity | **Seat fill was not transactional.** `fillSeatAndCount` performed several writes (seat update + count + status) without a transaction; a mid-way failure could leave inconsistent counts. |
| I-3 | 🟠 Medium | Schema consistency | **Prisma schema was stale.** `schema.prisma` contained only Phase 1 tables — all Phase 2 (`recruitment_request`, `requisition_seat`, …) and Phase 3 (`candidate`, `application`, …) models were missing. (SQLite `schema.js` and Postgres `SCHEMA.sql` were already current; the running app uses node:sqlite, so this was a documentation-parity gap, not a runtime bug.) |
| I-4 | 🟡 Low | Audit completeness | QA asked for a distinct **“vacancy count changed”** audit event and **safe partial-failure reporting** on bulk. Previously the count change was folded into `request.seat_filled` and bulk returned only `affected`. |

**Not issues (verified correct, no change needed):**
- Candidate has **no** application-status field anywhere (schema/API/frontend). Only `candidate_state` (lifecycle: active/do_not_contact/blacklisted/merged) exists, which is not a pipeline status.
- Application owns status, stage dates, rejection/on-hold/withdrawn reasons, recruiter, and request linkage.
- `UNIQUE(candidate_id, request_id)` blocks duplicate applications; handled gracefully (409 + message) in API and UI.
- Reason required (server-side) for Rejected/On Hold/Withdrawn/Offer Rejected.
- Terminal statuses (Joined/Rejected/Withdrawn) are locked.
- Salary masked **server-side** (returned `null` + `salaryVisible:false`), not just hidden in UI; non-salary roles also cannot set it.
- RBAC enforced server-side for every candidate/application action; HM & Interviewer can view but cannot move the pipeline; Viewer read-only; hidden buttons cannot be triggered via API (routes guard independently).
- Duplicate detection works on email, phone, and LinkedIn (normalized); CV-hash dedup hook present on document upload.
- **Merge:** there is **no standalone non-functional “Merge” button.** `candidate.merge` gates the duplicate-**override-with-reason** flow, which is fully functional and audited. A full record-merge tool is intentionally out of scope (documented as a future enhancement), so nothing non-functional is exposed.
- FKs and orphan prevention: `application.candidate_id` and `application.request_id` are `NOT NULL` FKs with `ON DELETE CASCADE`; no orphan application can exist.

## 2. Fixes made
- **I-1 Overfill block:** added `hasOpenSeat(requestId)`; the single-move and bulk-move handlers now return **409** for a *Joined* move when no vacancy remains, **before** any mutation. Count is unchanged on a blocked attempt.
- **I-2 Transactional fill:** `fillSeatAndCount` now runs inside `tx()` (BEGIN/COMMIT/ROLLBACK) and throws if no seat is available — all-or-nothing.
- **I-3 Prisma parity:** appended all Phase 2 & 3 models to `schema.prisma` with relations and the `@@unique([candidateId, requestId])` constraint, matching `schema.js` and `SCHEMA.sql`.
- **I-4 Audit + bulk reporting:** added a distinct `request.vacancy_changed` audit event (old/new filled count, remaining, status); bulk now returns a `skipped[]` array (with reasons: terminal, no_vacancy, not_found) and the UI surfaces “N updated, M skipped”. Double-count is structurally impossible (Joined is terminal → re-move blocked).

## 3. Files changed
- `backend/src/routes/applications.js` — overfill guard, transactional seat fill, vacancy-changed audit, safe bulk partial-failure reporting, recruiter-existence check on bulk assign.
- `backend/prisma/schema.prisma` — added 10 Phase 2/3 models (parity).
- `frontend/public/app.jsx` — bulk toast reports skipped count.
- `backend/phase3_qa_test.mjs` — **new** 49-check QA edge-case suite.
- `PHASE3_QA_AUDIT.md` — this report.

## 4. Tests added / updated
New `phase3_qa_test.mjs` (49 checks) covering exactly the QA-requested edge cases:
- All **16** statuses accepted; status move updates status + stage date + last activity + stage history.
- **Reason required** for rejected/on_hold/withdrawn/offer_rejected.
- **Terminal locked**; invalid status → 400.
- **Vacancy automation:** join#1 → filled=1/partially_filled; join#2 → filled=2/filled; **overfill blocked (409)** with **count unchanged**; **re-join blocked (no double-count)**; remaining count correct.
- **Salary masking server-side** (recruiter null, HR 45000; recruiter cannot overwrite salary).
- **RBAC:** HM/Interviewer/Viewer cannot move pipeline (403); viewer cannot bulk/link; HM cannot add candidate.
- **Duplicate detection** on email/phone/LinkedIn; check-duplicate endpoint; authorized override (201) and **override audited**.
- **Separation:** candidate has no `status`; has `candidateState`; one candidate → 2 independent applications with different statuses; duplicate application blocked.
- **Audit coverage** for candidate.created/updated, application.created/status_changed, request.seat_filled, **request.vacancy_changed**, candidate.note_added, application.bulk_action; audit row shape (actor/role/entity/old/new/timestamp).

## 5. Final test count and result
| Suite | Checks | Result |
|-------|--------|--------|
| Phase 1 (`inproc_test.mjs`) | 27 | ✅ pass |
| Phase 2 (`phase2_test.mjs`) | 31 | ✅ pass |
| Phase 3 (`phase3_test.mjs`) | 33 | ✅ pass |
| **Phase 3 QA (`phase3_qa_test.mjs`)** | **49** | ✅ pass |
| Static/SPA (`static_test.mjs`) | 6 | ✅ pass |
| **Total** | **146** | **✅ all passing** |
Frontend `app.jsx` compiles cleanly with `@babel/preset-react`.

## 6. Schema consistency confirmation
SQLite (`src/lib/schema.js`), Prisma (`prisma/schema.prisma`), and PostgreSQL (`docs/SCHEMA.sql`) now all contain the same Phase 2 & 3 tables, including the `requisition_seat.filled_by_application_id` / `filled_at` columns and `application`'s `UNIQUE(candidate_id, request_id)`. FKs are `NOT NULL` with `ON DELETE CASCADE` where appropriate — orphan applications are impossible.
**Reset/re-seed note:** `npm run reset` drops the local SQLite file and re-seeds — convenient for local demo only. **Production must use migrations** (Prisma Migrate or versioned SQL) rather than reset; the canonical models live in `schema.prisma`/`SCHEMA.sql` for that purpose.

## 7. Permission enforcement confirmation
All enforced **server-side** via `requirePermission(...)` and per-route checks: `candidate.view/add/edit/link/move_stage/note/merge`, `application.bulk_action`, and salary visibility (field-level, masked in serializers). Verified by direct-API tests for Recruiter, Hiring Manager, Interviewer, and Viewer — unauthorized pipeline movement returns 403, and UI-hidden actions are still blocked at the API.

## 8. Candidate / Application separation confirmation
**Confirmed.** Candidate = person (no pipeline status; only `candidate_state` lifecycle). Application = candidate↔request link that owns status, stage/last-activity dates, the three reason fields, recruiter, and request linkage. One candidate → many independent applications across requests (tested: two different statuses simultaneously). Same candidate cannot be linked twice to the same request (`UNIQUE` + graceful 409).

## 9. Remaining limitations (unchanged scope, documented)
- File uploads / embedded CV viewer are **Phase 4** (document metadata + CV-hash hook exist now).
- Interviews & Offers tabs are **Phase 4** placeholders.
- Full candidate **record-merge** tool (combining two candidates' applications) is a future enhancement; only the audited duplicate-override flow is implemented.
- Kanban stage changes are click-driven (Actions menu), not drag-and-drop.
- Candidate visibility is permission-based, not yet project-scoped.
- `node:sqlite` transactions are synchronous and DB-file local (single-process); production Postgres gives full concurrent transactional guarantees.

## 10. Manual testing checklist
1. **Overfill:** create a request with headcount 1, approve/budget/assign, link 2 candidates, mark both *Joined* → the **second is blocked** with a clear message; request shows Filled with count 1.
2. **No double-count:** open a Joined application's Actions → it offers no move (terminal); via API a re-join returns 409; count stays correct.
3. **Partial vs full fill:** headcount 2, join one → **Partially Filled (1/2)**; join the other → **Filled (2/2)**.
4. **Reasons:** try Reject / On Hold / Withdrawn from a card without a reason → reason modal blocks submit; with a reason it succeeds and shows in Timeline + Audit.
5. **Salary masking:** as **recruiter**, candidate Expected Salary shows 🔒 Restricted / blank; as **hr.manager**, the value is visible. Confirm via API that recruiter responses return `expectedSalary: null`.
6. **RBAC:** as **hiring.manager** / **interviewer**, open a pipeline — you can view but the move actions are absent and the API returns 403 if called directly. **viewer** is read-only everywhere.
7. **Duplicate:** add a candidate with an email/phone/LinkedIn that matches an existing one → live warning; as recruiter you can't override, as hr.manager you can with a reason (check Audit for the override note).
8. **Separation:** link the same candidate to two requests at different stages → the candidate profile **Applications** tab shows both with independent statuses; re-linking to the same request is blocked.
9. **Bulk:** select several applications (Compact view) → bulk move; include a Joined/terminal one → toast reports "N updated, M skipped"; bulk reject requires a reason.
10. **Audit:** Admin → Audit Logs → confirm `application.status_changed`, `request.seat_filled`, `request.vacancy_changed`, `candidate.created/updated`, `candidate.note_added`, `application.bulk_action`, each with actor/role/entity/old/new/timestamp/reason.

## 11. Is Phase 3 safe to approve for Phase 4?
**Yes.** All findings are fixed and covered by automated tests; 146/146 checks pass; schema files are in parity; permissions and salary masking are enforced server-side; the candidate/application separation and vacancy automation (including overfill and double-count protection) are verified. No blocking issues remain. The remaining limitations are intentional Phase 4 scope (interviews, offers, file storage, record-merge) and are clearly marked as placeholders.

*Phase 4 will begin only on your explicit instruction: “Approved. Continue to Phase 4.”*
