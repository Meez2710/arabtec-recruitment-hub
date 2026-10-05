# Claude handoff — ready for Codex's independent review (NOT deployed)

Date: 5 October 2026. Branch `codex/board-demo-readiness`.

## Commit
- **Verified code commit: `48afb5ae91ae0b7b93922ffd26457afd516cba28`**. All verification below ran on this exact SHA with a clean tracked tree (`tracked_dirty=0`).
- The commit that adds this file sits on top and changes only `docs/audits/2026-10-05-workflow/` (no runtime file). Check with `git diff --stat 48afb5a HEAD`.
- Live baseline, untouched: `2beef22243082d4fdba0065b16b684d191a6a5c1` (HEAD = DEPLOYED_SHA, verified read-only before work).
- **Deployment has not been performed.** It is stopped here for Codex's review, as instructed.

## What changed
The full table, with severity, reproduction, HR impact, root cause, fix and evidence for each finding, is in **`FINDINGS.md`**. In short:
- **Offers.** Stale send refused (WF-01). Every contractual term re-approves (WF-02). Sent offers are locked, and corrections go through withdraw + new offer (WF-03). Closed or cancelled requests cannot issue offers (WF-05). A decline never rewrites a rejected application (WF-06). Benefits follow salary permissions (WF-08). Edit and Preview letter actions added (WF-09).
- **Interviews.** Canonical terminal stages, including legacy aliases; the authorized override is kept (WF-04, WF-05).
- **Issuing vs delivery.** The real mailer outcome is recorded. The UI and the response say "issued" separately from "email queued" or "no email was sent: <reason>". The same fix covers rejection emails and interview invites (WF-07).
- **Offer letter.** Rebuilt from the three originals, with fixed text verbatim and only the variable fields changing. One model drives the preview, the issued letter, the email and its attachment. Dates are Cairo calendar days. Every variable value is escaped, and the letter needs salary-view permission (OT-01…OT-03).
- **Create/Edit offer.** The live letter is on the right half, with labelled blanks that fill in while typing (UX-01, owner request).
- **Assessment.** The recruitment team edits both sections. A change to a submitted evaluation needs a reason. "Reopen for revision" is audited, a history view lists who did what and why, a progress strip shows each part's state, and the layout holds on desktop and phone (AS-01…AS-03). Interviewer, hiring-manager and outsider restrictions and the salary protections are unchanged; negative tests prove it.
- **Schema.** Three nullable `offer` columns (`title_prefix`, `salutation_name`, `salary_components`) are added at startup by `addColumnIfMissing` on SQLite and PostgreSQL. Nothing is dropped or rewritten, and existing offers render with their single salary as Basic Salary.
- **Policy defaults.** The assessment HR audience gets edit on the technical section and its justification (owner decision). A stored policy override still wins.
- **Not changed (policy questions Q-01…Q-07 in FINDINGS.md):** on-hold requests, reference numbering against the paper series, the probation period, assessment-as-gate (owner: no), linking before approval, the application stage after a withdrawal, and offers from early stages.

## Verification on `48afb5a` (Node v22.23.3, the production runtime)
Script: `scratchpad/final_verify.sh`. Copies are in `evidence/verify-48afb5a/` (also in `docs/production-release/evidence/verify-48afb5a/`).

| Check | Command | Result | Exit |
|---|---|---|---|
| Build | `npm run build` | ok | 0 |
| Typecheck | `npm run typecheck` | ok | 0 |
| Full suite | `npm test` (`run_tests.mjs`, SQLite) | **83/83 suites** | 0 |
| Domain | `npm run test:domain` (vitest) | 798 passed, 0 failed, 9 skipped | 0 |
| PostgreSQL required gates | `pg_tx_test --required`, `pg_appnumber_race`, `pg_sequence`, `pg_reopen_race`, `reconciliation`, `pg_headcount_race`, `pg_join_race`, each on its own fresh DB | 7/7 | 0 each |
| PostgreSQL behaviour | `run_pg_behavior.mjs` (14 suites, including the 3 new ones) | **14/14** | 0 |

New and changed suites (SQLite and PostgreSQL):
- `workflow_integrity_test` (Codex, unmodified): red 0/22 at baseline (`evidence/workflow-red-node22.log`), now **22/0**.
- `offer_letter_test` (new): **60/0**. Earlier 52-check versions also ran under TZ Africa/Cairo, UTC, America/Los_Angeles and Pacific/Kiritimati, 52/0 each.
- `assessment_team_edit_test` (new): **31/0**.
- `ui_assessment_test`: **27/27** (3 new).
- `assessment_policy_test`: **77/0**. Two assertions changed to the new default policy, by owner decision.
- `assessment_pdf_test` 121/0; `assessment_review_fixes_test` 26/0 (the AR-02 behaviour is kept).

Disposable PostgreSQL databases created and **kept**, never dropped. They are listed in `evidence/verify-48afb5a/pg-databases-kept.txt` and `evidence/pg-databases-kept.txt`. They live in container `arabtec-pg-scratch-test-20261004` on 127.0.0.1:55439, which is stopped after use with its data retained. No other Docker workload was touched. Codex's preview server on port 4398 was left running; one test's default port was moved off 4398 to avoid it.

Run history, kept for honesty:
- The first PostgreSQL attempt for the new suites ran before the database had finished starting (`evidence/pg-new-suites-attempt1-db-starting.log`). It was re-run after `pg_isready`, 3/3 (`evidence/pg-new-suites.log`).
- An earlier full-suite run failed only `dashboard_director_test` with EADDRINUSE on 4398, Codex's preview port. The port was moved and the suite re-run, 13/0.

## Browser evidence (real UI, local synthetic server on :4410, Chrome via DevTools protocol)
`evidence/browser/`:
- `offer-create-1-empty.png`: Create offer with the empty letter; blanks for title, name, first name, position, total and amounts.
- `offer-create-2-partly-filled.png`, `offer-create-3-filled.png`: the letter filling in as fields are typed; form total = letter total (EGP 34,800.00); both footnotes appear.
- `offer-detail-draft.png`: draft detail with **Preview letter** and **Edit**.
- `offer-preview-letter.png`: the saved letter (reference `26/HR/DM/MH-ofr/00002`, "not issued yet" banner).
- `offer-edit-draft.png`: the Edit form with the letter.
- `offer-issued-toast.png`: after submit → Director approve → send in the UI. The offer is Sent, and the activity shows "Delivery — Email queued to synthetic.offer@example.invalid".
- `offer-issued-no-email-toast.png`: a candidate with no email. The toast read "Offer issued. No email was sent: The candidate has no email address on file." (captured by polling the DOM).
- `assessment-desktop-1-open.png` / `-2-edit-needs-reason.png` / `-3-history.png` and the same for `assessment-phone-*` (390px): progress strip; editing a submitted section shows the required reason, with Submit disabled until it is given; history with the reason.

Letter renders (`evidence/letter/`, synthetic values only): two-page A4 PDFs with and without Area Allowance, one with a long name, plus the draft with blanks. Compare these with the Bishoy, Basem and Heba originals (both pages).

API checks are reported as API checks; the screenshots above are the browser proof.

## Release preparation (for Codex, after review)
- Bundle: `/private/tmp/claude-501/arabtec-release-h.bundle`, ref `release/20261005a` → `48afb5a`, prerequisite `2beef22` (live). sha256 `6ceb4f12f94ab1f654fb8456bcde80cc544120132cde77bfb9188f4304fbc99d`.
- The established safe release script, unchanged since deployment 7 (host copy sha256 `fdbf6fd3…` matches the repo):
  ```
  scp /private/tmp/claude-501/arabtec-release-h.bundle ats@10.20.0.9:~/arabtec-release/
  ssh ats@10.20.0.9 'cd ~/arabtec-release && ATS_SHA=48afb5ae91ae0b7b93922ffd26457afd516cba28 ATS_BUNDLE=$HOME/arabtec-release/arabtec-release-h.bundle bash ./09-safe-release.sh'
  ```
  The script takes a fresh `pg_dump`, builds in a separate worktree, switches, and auto-recovers if the new process never becomes ready.
- Post-deploy checks: HEAD = DEPLOYED_SHA = `48afb5a`, service active, `/api/health` and `/api/health/ready` 200, cache token `20261005a` served. In the log, confirm the three `offer` columns exist (`addColumnIfMissing`).
- **Rollback (code):** `ATS_SHA=2beef22243082d4fdba0065b16b684d191a6a5c1 ATS_BUNDLE=$HOME/arabtec-release/arabtec-release-g.bundle bash ./09-safe-release.sh`. The added columns are nullable and unused by the old code, so a code rollback is safe without a schema change. The assessment policy default reverts with the code.

## Not done / limits
- No deployment. No production read or write beyond the read-only baseline check.
- HawkScan not run (`HAWK_API_KEY` not set).
- Real SMTP/Graph delivery not exercised (json transport by rule).
- The letterhead is the vector mark plus a text wordmark, not a raster copy of the scanned letterhead. No real signature is embedded.
- `HR_WORKFLOW_REVIEW.md` and `OFFER_TEMPLATE_REVIEW.md` are Codex's records and were not edited.
