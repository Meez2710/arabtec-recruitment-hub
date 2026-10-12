# On-premises workflow audit and correction plan

Date: 5 October 2026. Scope: existing backend/src/server.js and frontend/public.
Baseline checkout: 98129346f5370f7b4225970a8905f6fc077c9144.
Verified live baseline: 2beef22243082d4fdba0065b16b684d191a6a5c1.

## Purpose
Audit request creation through offer issuance as an HR process: ownership,
approval authority, page handoffs, state consistency, exception handling,
confidentiality, and persistence. Keep findings and evidence in this directory.

## Execution
- [x] Locate actual on-premises runtime; verify live readiness and revision.
- [x] Run baseline cross-page connections suite: 38 passed.
- [x] Reproduce boundary defects through real HTTP calls on synthetic data. (Claude, Node 22: 22 red reproduced — evidence/workflow-red-node22.log)
- [x] Correct confirmed defects in legacy routes; preserve established standalone flows. (WF-01…WF-09, see FINDINGS.md)
- [x] Verify request, candidate, interview, assessment, offer, permissions and notification suites. (npm test 83 suites; see CLAUDE_HANDOFF.md)
- [x] Exercise browser handoffs, including fresh reads after changes. (evidence/browser/: create offer with live letter, edit, preview, submit/approve/send, assessment desktop+phone)
- [x] Build, typecheck and run database-specific checks. (see CLAUDE_HANDOFF.md)
- [x] Record findings, HR ownership map, test evidence and residual limitations. (FINDINGS.md; ownership map stays in HR_WORKFLOW_REVIEW.md)
- [ ] Apply verified changes to the on-premises deployment and verify its revision/readiness. — STOPPED for Codex's independent review (CLAUDE_HANDOFF.md).

## First correction packet
Files: backend/workflow_integrity_test.mjs, backend/src/routes/offers.js,
backend/src/routes/interviews.js, backend/run_tests.mjs.
Tests must reproduce stale offer send reviving a stopped application,
changes to approved contractual terms retaining approval, sent-offer mutation,
and canonical offer_declined bypassing interview terminal-state validation.
Assertions cover both refused actions and unchanged persisted data.

## Policy boundary
Whether a final assessment decision is mandatory before an offer is a governance
choice. The user has been asked; no new mandatory assessment gate is assumed.
Tests use synthetic contacts and SMTP_TRANSPORT=json; no candidate mail is sent.
Local Node 24 differs from production Node 22; record that limitation until the
supported-runtime checks are available.

## Added during implementation (5 Oct, owner and Codex requests)
- Offer letter fidelity to the three originals (OFFER_TEMPLATE_REVIEW.md) — done, OT-01…OT-03.
- Live letter beside the Create/Edit offer form with blanks for missing values (owner) — done, UX-01.
- Issue vs delivery messaging for offers, rejection emails and interview invites — done, WF-07.
- Assessment: recruitment-team editing, reasoned changes after submission, reopen, history, progress strip — done, AS-01…AS-03.
