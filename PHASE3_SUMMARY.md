# Arabtec Recruitment Hub — Phase 3 Summary
**Module:** Candidate Database, Applications & Candidate Pipeline · Built on Phases 1–2.

Automated tests (clean install): **Phase 1 = 27/27 · Phase 2 = 31/31 · Phase 3 = 33/33 · Static = 6/6 → 97 total, all passing.**
To run: `cd backend && npm run reset && npm start` → open http://localhost:4000.

---

## 1. Summary
A full Talent Pool + pipeline, with the candidate/application separation enforced at the database level:
- **Candidate Database / Talent Pool:** searchable, filterable list; table view; add/edit form with **live duplicate detection**; import placeholder.
- **Add/Edit Candidate** with validation (name required; email *or* phone required; email format; numeric experience; salary editable only by authorized roles) and duplicate warning + authorized override-with-reason.
- **Candidate Profile** with 6 tabs: Overview, CV & Attachments, **Applications** (all applications across requests with independent statuses), Interviews (Phase 4 placeholder), Offers (Phase 4 placeholder), Notes & Activity.
- **Link Candidate to Request** (from pipeline): link existing or create-new-and-link, set initial status, recruiter, match score, source — with duplicate-application prevention.
- **Candidate Pipeline inside Request Details** (replaces the Phase 2 placeholder): **Kanban / List / Compact** views with all 16 statuses, rich candidate/application cards, quick actions, **bulk actions**, reason modals, and a candidate **quick-view side panel**.
- **Status movement rules**, **vacancy automation** (Joined → fill seat → request Partially Filled/Filled), and **activity logging** throughout.

## 2. Files changed / added
- **Added:** `backend/src/routes/candidates.js`, `backend/src/routes/applications.js`, `backend/phase3_test.mjs`, `PHASE3_SUMMARY.md`.
- **Changed:** `schema.js` (+6 tables, +2 seat columns), `models.js` (Candidates/CandidateDocuments/Applications/StageHistory/CandidateNotes/CandidateActivity/RejectReasons repositories), `permissions.js` (+3 permissions, +6 buttons), `seed.js` (candidate/application counters, reject reasons, dup setting), `server.js` (mount routes), `frontend/public/app.jsx` (Talent Pool nav + page, candidate form with dedup, profile with 6 tabs, link modal, full pipeline replacing placeholder, dashboard KPI), `docs/SCHEMA.sql`, `README.md`. Updated `smoketest.mjs` permission count.

## 3. Schema changes
New tables: `candidate` (no status column), `candidate_document`, `application` (status lives here; **UNIQUE(candidate_id, request_id)**), `application_stage_history`, `candidate_note`, `candidate_activity`, `reject_reason`. Added `filled_by_application_id` + `filled_at` to `requisition_seat`. New counters/settings: `candidate_counter`, `application_counter`, `application_prefix`, `allow_duplicate_application`.

## 4. Candidate / Application separation — CONFIRMED
- The `candidate` table has **no application-status column**; its only state field is `candidate_state` (active / do_not_contact / blacklisted / merged), which is *not* a pipeline status.
- All pipeline status lives on `application.status`, with reasons in `rejection_reason` / `on_hold_reason` / `withdrawn_reason` and full `application_stage_history`.
- A candidate may have **many applications**, each independent. Verified by test: *Ahmed Mohamed* is linked to two requests with two different statuses (`shortlisted`/later `joined`, and `cv_screening`) simultaneously; the candidate object returned by the API contains no `status` field.
- `UNIQUE(candidate_id, request_id)` prevents the same candidate being linked to the same request twice (unless `allow_duplicate_application` is enabled **and** the user has `candidate.merge` and passes an override).

## 5. Pipeline status rules
- **16 statuses:** Applied, CV Screening, Shortlisted, Phone/Technical/Client/Final Interview, Reference Check, Offer Preparation, Offer Sent, Offer Accepted, Offer Rejected, Joined, Rejected, On Hold, Withdrawn.
- Each move updates current status, **stage date**, **last activity date**, writes `application_stage_history`, a candidate-activity entry, and an audit log.
- **Reason required** (enforced server-side) for: Rejected, On Hold, Withdrawn, Offer Rejected.
- **Terminal** statuses (Joined, Rejected, Withdrawn) block further moves.
- **Vacancy automation:** moving an application to **Joined** fills the next open seat, increments `headcount_filled`, and sets the request to **Partially Filled** (some filled) or **Filled** (all filled) — all logged.

## 6. Permission rules
- `candidate.view/add/edit/link/move_stage/note/merge` and `application.bulk_action`, all enforced server-side and editable in Admin → Roles & Permissions.
- **Recruiter:** add/edit/link candidates, move stages, notes, bulk.
- **Recruitment/HR Manager:** the above plus `candidate.merge` (override duplicates) and salary visibility.
- **Hiring Manager:** view + notes only — **cannot move the pipeline** (per spec).
- **Interviewer:** view + interview feedback only — **cannot move the pipeline**.
- **Viewer:** read-only (cannot create candidates or move stages).
- **Salary field-level security:** `expected_salary` is returned/settable only for `salary.view` roles; masked to `null` (`salaryVisible:false`) otherwise — applied in candidate list, profile, and pipeline cards.

## 7. Known limitations
- **File uploads** (CV/attachments) are metadata-only in Phase 3; the embedded CV viewer and real binary storage are Phase 4 (the API accepts document metadata + optional file hash for dedup).
- **Interviews & Offers** tabs are Phase 4 placeholders (and the pipeline's "Schedule Interview"/"Generate Offer" quick actions are labeled as such).
- Kanban uses click-driven "Actions ▾" stage moves rather than HTML5 drag-and-drop (more reliable and accessible; drag-drop can be added later).
- Candidate **merge** detection is implemented (override flow); a full merge-records tool (combining two candidates' applications) is a later enhancement.
- View scoping for candidates is permission-based (`candidate.view`), not yet project-scoped.

## 8. Ready checklist for Phase 4
- ✅ Applications, stage history and per-candidate activity exist — interviews/offers can attach to an `application` id.
- ✅ Reject reasons lookup table seeded and exposed.
- ✅ Pipeline statuses already include interview/offer stages, so Phase 4 interview/offer modules slot into existing transitions.
- ✅ `candidate_document` table ready for real file storage; `file_hash` field ready for CV-hash dedup.
- ✅ Audit + notification hooks are consistent and ready to extend (notifications are Phase 4).
- ✅ All 97 automated checks green; JSX compiles; served by the same Node server.

## Manual testing checklist
1. Log in as **recruiter@arabtec.com** → **Talent Pool** → **+ Add Candidate**. Enter a name and email; try an email that matches an existing candidate → see the **duplicate warning**. (As recruiter you can't override; as **hr.manager** you can, with a reason.)
2. Confirm the candidate row shows no status; open the profile → **Applications** tab is empty initially.
3. Prepare a request: as **hr.manager** create a request, submit, approve ×3, validate budget; as **rec.manager** assign a recruiter.
4. Open that request → **Candidate Pipeline** tab → **Link to Request** → pick the candidate, set initial status + match score → it appears in the Kanban.
5. Use a card's **Actions ▾** → Shortlist / Move / **Reject** (reason required) / **On Hold** (reason required). Switch **Kanban / List / Compact** views.
6. Link the **same candidate** to a **second** request → confirm the candidate profile **Applications** tab now shows two applications with **independent statuses**.
7. Try linking the same candidate to the **same** request twice → blocked.
8. Move an application to **Joined** → open the request Overview → **headcount_filled** increased and status became **Partially Filled** (or **Filled** when all seats done).
9. Select multiple cards (Compact view checkboxes) → **Bulk move**; bulk reject requires a reason.
10. As **interviewer** or **hiring.manager**: confirm you can view but **cannot** move the pipeline. As **viewer**: read-only.
11. Admin → **Audit Logs**: confirm `candidate.created`, `application.created`, `application.status_changed`, `request.seat_filled`, `candidate.note_added`, `application.bulk_action`.
