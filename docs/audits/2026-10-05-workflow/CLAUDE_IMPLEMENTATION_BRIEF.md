# Authorized implementation brief — 5 October 2026

The owner asked Codex to act as HR & Organization Consultant, audit the entire
on-premises Arabtec Recruitment Hub from creating a request through issuing an
offer, save all findings inside this repository, and apply fixes to the on-premises
version. The owner now explicitly directs heavy implementation work to Claude;
Codex retains inspection and HR workflow recommendations.

## Owner decisions
- Keep the flexible HR Director offer approval route. Do not introduce a mandatory
  completed final-assessment prerequisite or a new rigid request approval gate.
- Show how an offer is created. Codex has opened a synthetic local instance on
  localhost:4398 and shown Offers > Create offer. Improve discoverability if needed.
- Assessment form needs visual and structural improvement and must be fully
  controllable/editable by the recruitment team. Implement this for recruitment
  roles, including technical/HR sections and appropriate final-decision editing,
  with clear save/reopen behavior. Preserve existing restricted interviewer access
  and salary protections for outsiders; no blanket all-user access.
- Work through the workflow from the start; prioritize broken handoffs and logic.

## Verified starting facts
- Checkout HEAD 98129346f5370f7b4225970a8905f6fc077c9144,
  branch codex/board-demo-readiness.
- Codex SSH read verified live HEAD=DEPLOYED_SHA=
  2beef22243082d4fdba0065b16b684d191a6a5c1; service active; readiness HTTP 200.
- Existing untracked board-demo documents predate this task. Preserve them.
- docs/audits/2026-10-05-workflow is the authoritative new audit folder.
- Connections suite independently run by Codex: 38 passed, 0 failed.
- New backend/workflow_integrity_test.mjs executes real HTTP paths and records
  22 failed checks against current code; see evidence/workflow-red.log.
  First run had a fixture recruiter scope problem, corrected before final red run.
- Local Codex runtime is Node 24.15; use supported Node 22 for release verification
  if available in your environment. Use the real legacy server/frontend.
- Codex local synthetic preview server uses port 4398 and
  /tmp/arabtec_hr_audit_preview_20261005.db. Do not stop it.
- New regression suite uses port 4397; keep test runs sequential where ports/DBs overlap.

## First confirmed defects (reproduce then fix)
1. Approved offer send can overwrite rejected, on_hold, or offer_declined
   application status to offer_sent. Refuse invalid stale sends without mutation.
2. Changing approved currency, benefits, or position retains approval; salary
   alone re-approves. Apply contractual-term reapproval consistently, including
   dates where appropriate, preserving the configured approval-off behavior.
3. Sent offers are editable, so recorded issued salary can change silently.
   Preserve issued terms; corrections require a controlled withdrawal/new offer.
4. Interviews still use old terminal aliases and allow canonical offer_declined.
   Reuse canonical normalization/terminal definitions, preserving authorized
   override + reason behavior.

## Broader audit and implementation
Map pages, role ownership, inputs/outputs and exceptions across requests,
approvals, recruiter assignment, candidate intake/Talent Pool, linking and
pipeline, scheduler/interviews, assessments, offer drafting/approval/issue,
notifications, dashboards/reports, and audit history. Test relevant create/edit/
hold/reject/cancel/reopen/duplicate paths and refresh persistence. Avoid broad
refactoring or unrelated SaaS work. Fix reproducible inconsistencies; document
policy questions separately rather than inventing rules.

Assessment: inspect current form and policy first. Use a calm, readable structure,
clear section progression, visible draft/submitted status and save actions, and
consistent desktop/mobile layout. Honor existing UI rules (40px controls,
8/16px spacing, no decorative side bars). Keep authorized recruitment-team editing
available after submission using explicit edit/reopen, preserving audit/version
history and sensible permission policy. Verify each recruitment role directly,
plus negative tests for unrelated/technical-only users.

## Acceptance and handoff
Use synthetic data with SMTP_TRANSPORT=json throughout tests. No real outbound
mail or production fixture writes. Run focused regression suites, build,
typecheck, full npm test, supported-runtime tests, real disposable PostgreSQL
behavior/required gates; avoid deletion of existing databases. Capture actual
browser journeys and screenshots for request-to-offer and improved assessment.
Never call API-only checks browser proof.

Update PLAN.md and write FINDINGS.md with severity, reproduction, HR impact,
root cause, exact fix, evidence, residual issues, and test commands/counts/exits.
Keep logs in evidence/. Commit only task changes once verified.

STOP BEFORE DEPLOYMENT for Codex's independent review. This is an internal review
gate, not a request for repeated owner approval. Provide commit SHA, files,
test summary and evidence paths in CLAUDE_HANDOFF.md. Codex will inspect and then
authorize the already-requested on-premises release using the established safe
script and verify live SHA/readiness/rollback evidence.
