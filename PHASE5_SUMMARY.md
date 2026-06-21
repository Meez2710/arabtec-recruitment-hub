# Arabtec Recruitment Hub — Phase 5 Report
**Module:** Offer Management, Offer Approval, Offer Result Tracking & Joining Workflow. **Not built:** Dashboards (Phase 6), Reports.

**Tests:** full regression **263/263 passing** (P1 27 · P2 31 · P3 33 · P3-QA 49 · P4 32 · P4-QA 36 · **P5 49** · static 6); frontend compiles clean.
Run: `cd backend && npm run reset && npm start` → http://localhost:4000.

---

## 1. What was implemented
- **Offer entity** linked to **application + candidate + request** (links derived from the application, non-spoofable), with all requested fields (offer id, position, salary, benefits, joining date, status, prepared/approved by, sent/accepted/rejected dates, rejection/withdrawal reasons, timestamps).
- **9 offer statuses:** Draft, Pending Approval, Approved, Rejected by Approver, Sent, Accepted, Rejected by Candidate, Withdrawn, Joined.
- **Offer approval workflow:** submit → HR Manager approval → (conditional) HR Director approval when salary > threshold → Approved → Sent. Reject-by-approver requires a reason; salary change after approval forces re-approval.
- **Result tracking:** Send, Accept, Reject by Candidate (reason), Withdraw (reason), Join.
- **Joining & vacancy automation:** marking an accepted offer Joined moves the application to Joined and fills a seat via the **shared, transactional Phase 3 automation** — no overfill, no double-count; request becomes Partially Filled / Filled.
- **Offers list page** (filters: status, joining-date; search; salary masking), **offer detail** (approval timeline, activity, result actions, reason modals), **create-offer modal** (from pipeline quick action), **candidate-profile Offers tab** with real data, dashboard Offers KPI.
- **Salary restricted server-side** by `offer.salary_view` / `offer.salary_edit`.

## 2. Files changed / added
- **Added:** `backend/src/routes/offers.js`; `backend/src/lib/vacancy.js` (shared seat automation, now used by both applications and offers); `backend/phase5_test.mjs`; `PHASE5_SUMMARY.md`.
- **Changed:** `schema.js` (+3 tables), `models.js` (Offers/OfferApprovals/OfferActivity repositories), `permissions.js` (+4 offer permissions, +6 buttons, role grants), `seed.js` (offer counter/prefix + director threshold), `server.js` (mount `/api/offers`), `candidates.js` (offers on profile, masked), `applications.js` (refactored to import shared vacancy helper), `frontend/public/app.jsx` (Offers page, detail, create modal, pipeline action, profile tab, dashboard KPI), `prisma/schema.prisma` + `docs/SCHEMA.sql` (Phase 5 parity), `README.md`. Updated `smoketest.mjs` permission count (43→47).

## 3. Schema changes (parity across SQLite / Prisma / Postgres)
New tables: `offer` (links application+candidate+request; own `status`; salary/benefits/joining/dates/reasons; `version` for optimistic locking), `offer_approval` (chain rows), `offer_activity`. New settings: `offer_prefix`, `offer_counter`, `offer_director_threshold`. FKs NOT-NULL with `ON DELETE CASCADE` → no orphan offers/approvals.

## 4. Permissions added / updated
- **Added:** `offer.edit`, `offer.result_update`, `offer.salary_view`, `offer.salary_edit` (plus existing `offer.view`, `offer.create`, `offer.approve`, `offer.send`).
- **Mapping:** Recruiter → prepare/edit/submit, result_update, salary view+edit (not approve/send). HR Manager → full (create/edit/approve/send/result/salary). Recruitment Manager → create/edit/send/result/salary. HR Director → view + approve + salary_view (high-value approvals). Hiring Manager → `offer.view` only (status yes, **salary no**). Interviewer → none. Viewer → none. All editable in Admin → Roles & Permissions.

## 5. Business rules implemented
- Offer links to application; candidate/request derived from it (non-spoofable).
- Cannot create an offer for a rejected/withdrawn/on-hold/joined application unless an authorized user (`candidate.merge`) overrides with a reason (audited).
- One active offer per application.
- Creating an offer moves the application to **Offer Preparation** (controlled). Sending → Offer Sent. Accepting → Offer Accepted. Joining → Joined. These are explicit, controlled transitions — interview/offer status never silently overwrites application status.
- Salary settable/visible only with `offer.salary_edit` / `offer.salary_view`.
- Approval chain conditional on salary threshold; reject-approval needs a reason; salary change after submission/approval forces re-approval.
- Result reasons required for: rejected-by-candidate, withdrawn, rejected-by-approver.
- **Joining is safe:** double-count blocked (seat already filled / app already joined → 409), overfill blocked (no open seat → 409), seat fill transactional, request status recomputed.

## 6. UI components added
Offers nav + list (status/joining filters, search, salary masking, status badges, salary 🔒 indicator); offer detail (links, approval timeline, activity, status-aware action buttons, reason modals); create-offer modal (pipeline quick action, salary fields gated); candidate-profile Offers tab (real data, masked); dashboard Offers KPI; toasts/empty/loading/error states; Arabtec enterprise styling.

## 7. Audit logs added
`offer.created`, `offer.edited`, `offer.submitted`, `offer.approval_decision`, `offer.approved`, `offer.rejected_by_approver`, `offer.sent`, `offer.accepted`, `offer.rejected_by_candidate`, `offer.withdrawn`, `offer.joined`, `offer.salary_changed`, plus the shared `application.status_changed`, `request.seat_filled`, `request.vacancy_changed` on joining. Each with actor/role, entity id, before/after where relevant, and reason.

## 8. Still placeholder
- **Dashboards** (Phase 6) and **Reports** not built.
- Offer-letter PDF generation / e-signature not built (offer is data-only; the "Sent" status is a tracking flag, no document/email is generated yet).
- Notifications/email on offer events not built (later phase).

## 9. Assumptions made
- Offer salary visibility uses a dedicated `offer.salary_view` (separate from the requisition `salary.view`) so Hiring Managers can see offer status without seeing the amount.
- Director approval threshold defaults to 50,000 (system setting `offer_director_threshold`, editable).
- "Send" is an HR Manager/Recruitment-Manager action (recruiters prepare but don't send), matching the stated role expectations; all approver-level steps are actionable by `offer.approve` holders and the approver identity is recorded.
- Application stage auto-advances on offer milestones (creation/send/accept/join) as the brief permits ("if workflow allows"); these are explicit, audited transitions.

## 10. Known limitations
- In this build any `offer.approve` holder may action the Director-level step; per-level role binding/delegation is a later enhancement (the level name and approver are recorded).
- No counter-offer/revision versioning beyond re-approval on salary change.
- Joining via offer and via the pipeline both use the shared safe automation; there is intentionally no way to "un-join" (would require seat rollback — future enhancement).

## 11. Manual testing checklist
1. As **recruiter**, open a request → Pipeline → candidate card → **Actions ▾ → Generate Offer**; set position/salary/joining/benefits → application moves to **Offer Preparation**.
2. As recruiter, open the offer → **Submit for Approval**. Confirm a low-salary offer has a 1-step chain (HR Manager); create a high-salary offer (> 50,000) and confirm a 2-step chain (HR Manager + HR Director).
3. As **hr.manager**, **Approve**. Try **Send** as recruiter (blocked) then **Send** as hr.manager → application → Offer Sent.
4. As recruiter (has result_update), **Mark Accepted** → application → Offer Accepted; then **Mark Joined** → application → Joined, request count increments, request → Partially Filled / Filled.
5. On a 1-seat request, accept two offers and try to Join both → the **second join is blocked** (no overfill); re-joining the first → blocked (no double-count).
6. Edit an approved offer's salary → it resets to **Pending Approval** (re-approval).
7. **Reject by Approver** (reason required), **Reject by Candidate** (reason), **Withdraw** (reason) → confirm reasons recorded.
8. As **hiring.manager**, open Offers → you see status but salary shows 🔒; as **interviewer**, offer detail is 403; as **viewer**, offers list is 403.
9. Candidate profile → **Offers** tab shows the offers (salary masked for unauthorized roles).
10. Admin → **Audit Logs** → confirm offer.created/submitted/approved/sent/accepted/joined, offer.salary_changed, request.seat_filled, request.vacancy_changed.

## 12. Readiness for Phase 5 QA
All Phase 5 scope implemented and tested; 263/263 checks pass; schema parity maintained across SQLite/Prisma/Postgres; salary restricted server-side; joining reuses the proven safe (transactional, no-overfill, no-double-count) automation; approval and all critical actions audited. Ready for QA.

**Stopping after Phase 5 as instructed. No Phase 6 (Dashboards) or Reports work will begin without your explicit approval.**
