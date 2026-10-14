# Interview scheduling and communications — handoff for Codex review

**Status:** implemented and verified **locally** at `596ec5449886588c7fe9b22eb096dcf3c192e307`. **Not deployed.** No real candidate or panelist was contacted, and no production system was touched. Stopped at the Codex release-review gate.

- Live production: `2beef22243082d4fdba0065b16b684d191a6a5c1` (unchanged).
- Release candidate branch: `release/20261006a` at `596ec54`, 8 commits ahead of live.
- Bundle: `/private/tmp/claude-501/arabtec-release-i.bundle` (sha256 `6fa6c998383024a2f4dfb951e6c7dc26d2a6dbe34216808cf9c72519511b9a62`, range `2beef22..release/20261006a`, `git bundle verify` OK).
- The release also carries the earlier un-deployed, Codex-pending commits `48afb5a` (request-to-offer integrity), `83e67b7` (Q-01/Q-03) and their docs.

Root causes, decisions and the defects fixed are in [INTERVIEW_FINDINGS.md](INTERVIEW_FINDINGS.md).

## Commits

| SHA | Content |
|---|---|
| `10f2f95` | Packet I backend: simultaneous appointments, candidate/panel/location conflict rules, booking lock, idempotent create, Q-05 request guard, CV upload without parsing, CV on interview detail |
| `48aa37c` | Packet II backend: templates (global + per interview), explicit per-recipient sending with persisted outcomes, retry, ICS revisions, update/cancel notices, WhatsApp hand-off |
| `596ec54` | UI: three-step schedule form, detail, reschedule→update, cancel→cancellation, templates, communication history, phone layout; message wording fixes; calendar test contract |

## Changed files (`83e67b7..596ec54`, 25 files)

**New backend modules**
- `backend/src/lib/interview-rules.js` — scheduling guard and conflict evaluation.
- `backend/src/lib/interview-messages.js` — templates, placeholders, Cairo time, ICS, WhatsApp link.
- `backend/src/lib/interview-dispatch.js` — recipients, rendering, sending, outcomes.

**Changed backend**
- `backend/src/routes/interviews.js`, `backend/src/routes/candidates.js` (`?parse=0` upload).
- `backend/src/lib/{interview-clashes,models,schema,notify,notification-catalog,email_templates}.js`.

**Frontend**
- `frontend/public/app.jsx`.
- `claude-system.css` §24 (geometry only) and `arabtec-design-system.css` (colour and type for `.iv-*`).
- `index.html` / `component-gallery.html` (cache token `20261006b`).

**Tests**
- New: `interview_booking_test.mjs` (26), `interview_comms_test.mjs` (46).
- Adjusted: `notification_e2e_test`, `scheduler_validation_test`, `offer_letter_test`, `phase4_qa_test`, `ui_interview_calendar_test` (reasons in the findings, §3).
- Both new suites are registered in `run_tests.mjs` and `run_pg_behavior.mjs`.

## Migrations (additive and idempotent; run at server start by `schema.js`)

- **`interview` columns:** `idempotency_key` (unique index `ux_interview_idempotency`), `overlap_reason`, `calendar_seq INTEGER DEFAULT 0`, `notice_state`.
- **New tables:** `interview_message` (per-interview edited text, unique `(interview_id, kind, audience)`) and `interview_dispatch` (one row per recipient per channel per send action, unique `(batch_key, recipient_key, channel)`, indexed `(interview_id, created_at)`).
- **`system_setting` rows:** `interview_booking_lock` (the row locked to serialise bookings) and `interview_message_templates` (written only when an admin saves templates).
- **Notification catalog:** adds `interview.updated` and `interview.cancelled` (enabled by default, email + in-app).
- No column is dropped or rewritten, and no existing row is modified.

## Permissions (no new permission; no role changes)

- **Schedule / reschedule / reopen:** `interview.schedule` / `interview.edit`, as before. A terminal-application override additionally needs `candidate.merge` plus a reason.
- **Per-interview message edits and sending:** the same interview rights.
- **Global templates:** `notification.manage`.
- **CV on an interview:** existing `canSeeCandidate` scope; assigned panelists yes, unrelated users 403.

## Verification (Node v22.23.3, `docs/production-release/evidence/verify-596ec54/`)

| Gate | Result |
|---|---|
| `npm run build` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm test` (SQLite) | exit 0 — **85 suites, 85 passed** |
| `npm run test:domain` | exit 0 |
| PostgreSQL: `pg_tx_test --required`, `pg_appnumber_race_test`, `pg_sequence_test`, `pg_reopen_race_test`, `reconciliation_test`, `pg_headcount_race_test`, `pg_join_race_test` | all exit 0 |
| `run_pg_behavior.mjs` (real PostgreSQL 16 scratch container) | exit 0 — **16 suites, 16 passed** (incl. interview booking + comms) |

Focused runs during development:

- **Interview suites:** `interview_booking_test` 26/0, `interview_comms_test` 46/0, `notification_e2e_test` 29/0, `scheduler_validation_test` 28/0, `phase4_qa_test` 36/0, `offer_letter_test` 63/0.
- **UI guards:** layout rules 19, form controls 22, overlays 27, toolbar 10, badge/tab 16, gallery 53, containers 13, responsive 28, behaviour 49, calendar 30, readiness 35, compile 4, admin UI 22 — all 0 failed.

Other facts about the run:

- `tracked_dirty=1` is Codex's `evidence/preview-server.log`, deliberately not committed.
- 23 scratch PostgreSQL databases were kept (`pg-databases-kept.txt`). The container was stopped with its data kept.
- The password was redacted from the logs; 0 matches on a re-check.

## UI evidence (real legacy UI, local synthetic server on port 4410, `SMTP_TRANSPORT=json`)

Screenshots are in `evidence/interview-ui/`.

**`before/`**
- Calendar, old schedule form, old detail.

**`after/` — scheduling**
- `schedule-1…3`: new candidate + CV, then details with "no conflicts", then the preview, then Save & send. The result shows per-recipient "Test transport — not delivered".
- `schedule-4`: a second candidate at the same 10:00 with a different panel.
- `schedule-5`: a shared panelist requires acknowledgement and a reason.
- `schedule-6`: duplicate email offers "Use this candidate".
- `calendar-simultaneous-interviews`.

**`after/` — interview detail and lifecycle**
- `detail-1…3`: Cairo "When", "Open CV — synthetic-journey-cv.txt", communications history, then activity after an update.
- `reschedule-1…3`: +1h with no conflicts, then "Send the update" (preview shows "What changed: date and time"), then the result at the top of the dialog.
- `cancel-1…2`: the reason recorded, then "Send the cancellation" (the panel sees the reason; the candidate does not), then the result.

**`after/` — templates and phone**
- `templates-1`: organisation templates (Invitation / Update / Cancellation tabs; placeholder chips).
- `phone-1…3` (390px): one scrolling column, title visible above the top bar, preview after the form.

## Not done / blockers

1. **Real delivery.** Locally everything is a dry run. Production delivery depends on the existing SMTP settings, which have not been exercised by this change. No WhatsApp provider exists, so WhatsApp is a manual hand-off by design.
2. **CV reader.** Locally `ANTHROPIC_API_KEY` is not set, so CV upload during scheduling stores the file without parsing (`?parse=0`), as the brief requires.
3. **Shared `Modal` on phones.** It can sit under the top bar. This is pre-existing and was raised as a separate task; the interview compose dialogs are fixed.
4. **HawkScan DAST.** Not run, because `HAWK_API_KEY` is not configured in this environment.
5. **Backlog retained (not in this brief).**
   - Q-02 reference numbering format.
   - Q-04 assessment visibility, HM/TI recommendation, HR critical flags.
   - Q-05 remainder: approval protection for interviews is done here; the rest of the request-approval dependencies are not.
   - Q-06 Offer Withdrawn state.
   - Q-07 early-stage offer authorisation.

## Release steps (for Codex; do not run without the release gate)

1. On `ats@10.20.0.9`: copy `arabtec-release-i.bundle`, verify the sha256 above, then `git bundle verify`.
2. Run `~/arabtec-release/09-safe-release.sh` with `release/20261006a`. It takes the database backup first, then deploys. The schema migrations above apply on start.
3. Smoke test:
   - `/api/health`;
   - Interviews page loads;
   - "Invitation templates" opens;
   - schedule a **synthetic** interview to an `example.invalid` address and confirm the recorded outcome matches the configured transport.

## Rollback

- **Code:** redeploy `2beef22` (the current live SHA) with the same script, following the rollback procedure in the existing deployment runbook (`ROLLBACK.md` / previous deployment docs). Confirm on the host how `09-safe-release.sh` retains the previous checkout before relying on it.
- **Data:** the migrations are additive, so the old code ignores the new columns and tables and no data restore is needed. If a restore is still wanted, use the backup the script takes before deploying.
- **Behaviour to expect after rollback:** interviews created on the new version keep their rows. Recorded dispatch history stays in `interview_dispatch` but is not shown by the old UI.
