# Interview scheduling and communications — findings

Date: 2026-10-06 · Branch `codex/board-demo-readiness` · Base `83e67b7` → `10f2f95` (Packet I) → `48aa37c` (Packet II) → `596ec54` (UI + lifecycle).
Scope: legacy on-prem runtime only (`backend/src`, `frontend/public/app.jsx`). Brief: `INTERVIEW_IMPLEMENTATION_BRIEF.md`.

All evidence below is **local** (SQLite and a scratch PostgreSQL container, synthetic `example.invalid` recipients, `SMTP_TRANSPORT=json`). Nothing has been deployed and no message reached a real person.

## 1. Source findings — reproduced and root causes

| # | Brief finding | Reproduced how | Root cause | Status |
|---|---|---|---|---|
| F1 | One interview per form; panel-only overlap warning | `before/schedule-form-new-candidate.png`; `interview-booking-red.log` (red run before the fix) | `findPanelClashes` only compared panel members; the server accepted any overlap and the client only warned | Fixed: separate records, candidate block, panel acknowledgement + reason, location warning |
| F2 | New candidate had name/email only, no phone/CV; retry could strand/duplicate | Red test: same submission twice → two interviews | Candidate → application → interview were three independent calls with no idempotency key and no resumable client state | Fixed: phone + CV in the form, resumable progress (`candidateId`, `cvDone`, `applicationId`, `interviewId`), server idempotency key with unique index |
| F3 | Scheduling auto-called `notifyEvent('interview.scheduled')`; no preview/recipient review; delivery ignored | `notification_e2e_test` previously expected an automatic mail | Route sent mail as a side effect of create | Fixed: create sends nothing unless `sendInvitations: true`; explicit Save vs Save & send |
| F4 | Update/cancel sent nothing | Traced `PUT /:id` and `PATCH /:id/status`: no dispatch path | No change-notice model | Fixed: material-change notice, update/cancel dialogs, removed panelist told without new details, calendar SEQUENCE bump |
| F5 | Clash lookup failure rendered as "no clashes"; no candidate check | Source + UI: `catch` set an empty list | Error and empty states shared one value | Fixed: `checking / ok / conflicts / unavailable` states; candidate conflicts returned by `/interviews/clashes` |
| F6 | WhatsApp settings ≠ a working integration | Traced settings: sender number only, no provider client | No provider exists | Manual hand-off only (Copy / Open WhatsApp), recorded as "opened", never "sent" |

## 2. Decisions applied (brief §Product decisions)

1. **Separate appointments.** One record per candidate. Same start time allowed when candidates and panels differ. "Schedule another" keeps time/type/duration/mode and clears candidate, CV, panel, recipients and personalised text.
2. **Conflicts.** Overlap uses half-open intervals, so back-to-back slots are fine. Only `scheduled` and `rescheduled` occupy a slot. The same candidate is blocked (409 `candidate_conflict`). A shared panelist needs `ackPanelOverlap` and a reason (409 `panel_conflict`; the reason is stored and shown on the interview). An identical location or link only warns. All rules are rechecked at save inside a transaction that holds `interview_booking_lock`, which serialises bookings on PostgreSQL.
3. **New candidate inside scheduling.**
   - The form takes name, email, international phone and an optional CV.
   - Existing duplicate detection is reused: a 409 shows "Use this candidate".
   - `POST /candidates/:id/resume?parse=0` stores the file without AI parsing.
   - Progress survives a failed step, so a retry continues instead of duplicating.
4. **CV.**
   - The interview detail shows "Open CV" through the existing review drawer (`openCvReview`).
   - Assigned panelists can open it through the existing `canSeeCandidate` scope. Unrelated users get 403.
   - Panel emails carry an authenticated Hub link. A CV attachment is added only when ticked for a specific authorised panelist.
   - Candidate emails and WhatsApp messages never carry a CV.
5. **Invitation review.**
   - The form has three steps and a live preview: candidate email plus a separate panel email.
   - Times are in Africa/Cairo throughout, with the offset shown (GMT+3 summer, GMT+2 winter; tested).
   - No Meet link is ever generated.
   - Mode-specific checks: video needs an https link; an email or phone number must be valid for its channel.
6. **Templates.**
   - "Invitation templates" is on Interviews and in Notifications settings.
   - Global defaults need `notification.manage`; per-interview edits need interview scheduling or editing rights.
   - A bounded placeholder set per audience. Unknown, forbidden or unmatched tokens are refused.
   - Plain text only, escaped into HTML.
7. **Explicit sending.**
   - Outcomes are recorded per recipient and channel: `queued`, `accepted`, `dry_run`, `not_sent` (with a reason), `failed` (with the error), `manual_handoff`. "Delivered" is never claimed.
   - "Retry failed" resends only the failures.
   - A batch key plus a unique `(batch_key, recipient_key, channel)` index makes double-clicks harmless.
   - A dry run is labelled "Test transport — not delivered".
8. **WhatsApp.** An editable message, E.164 validation, Copy message and Open WhatsApp (wa.me). It is recorded as `manual_handoff`. It never includes a CV or a private link. No provider integration is claimed.
9. **Changes and cancellations.**
   - "Reschedule / edit" detects material changes (date/time, duration, link/location, mode, panel), then opens "Send the update". Cancel opens "Send the cancellation".
   - "Don't send" needs a reason and is recorded as a decision.
   - The ICS UID `INT-xxxxx@arabtec-recruitment-hub` is stable and SEQUENCE rises on every change. Cancellation uses `STATUS:CANCELLED` with `METHOD:PUBLISH`; acceptance tracking is not promised.
10. **Workflow controls (Q-05).**
    - A request awaiting approval: matching is allowed, scheduling is refused (409 `request_awaiting_approval`).
    - On hold: scheduling and rescheduling are refused; cancelling is still allowed.
    - Closed or terminal: refused unless overridden with `candidate.merge` plus a reason.
    - Standalone interviews remain available.
    - The same guard covers create, reschedule and reopen.

## 3. Behaviour changes other suites had to absorb (deliberate)

- **`notification_e2e_test`:** creating an interview no longer mails by itself; the test now passes `sendInvitations: true` (decision 7).
- **`scheduler_validation_test`:** a same-candidate overlap now returns `candidate_conflict` (decision 2).
- **`offer_letter_test` / `phase4_qa_test`:** these fixtures booked the same person twice at the same instant and now use distinct slots.
- **`ui_interview_calendar_test`:** the old assertion "a clash must not disable Schedule" now asserts the new contract: the candidate blocks, the panel needs a reason, the location warns.

## 4. Issues found during UI evidence and fixed before commit

- **Conflict times** were shown in browser-local time. They now use Cairo time (`cairoTime`).
- **No position.** With no request or position, previews read "for the the advertised role". Empty values now leave no "the the", "— —", "()" or " ," gaps, with three new assertions in `interview_comms_test`.
- **Reschedule activity** wrote a raw ISO instant. It now reads "Moved to Thursday, 8 October 2026, 13:00 (Cairo time (GMT+3))".
- **Send result.** The per-recipient result appeared below the editors, out of sight. It now shows at the top of the dialog and scrolls into view. Afterwards Send is hidden and Done becomes the primary button.
- **Phone layout.** The form overlapped the preview because grid rows were squeezed by `min-height: 0`. Below 900px it is now one scrolling column.
- **Phone title.** The app top bar covered the dialog title on phones. Compose dialogs now render at page level, following the AR-05 precedent (`toPageLevel`).
- **Templates modal.** "Panel email" touched the placeholder chips above it; a 24px gap was added.

## 5. Known limits (not defects of this packet)

- **Shared `Modal`.** It still renders inside the page container, so on phones the top bar can cover short dialogs such as Reschedule and Templates. This predates the work (see the `before/` screenshot). The compose dialogs were fixed; a global portal for `Modal` is a separate, wider change.
- **Delivery.** Real delivery depends on the production SMTP configuration. Locally it is a dry run by design.
