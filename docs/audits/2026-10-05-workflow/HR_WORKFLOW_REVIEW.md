# HR workflow review — working record

Owner: HR & Organization Consultant (Codex). Implementation: Claude.
Date: 5 October 2026. Status: IN PROGRESS; no overall acceptance yet.

## Agreed operating model
The owner explicitly selected flexible HR Director approval for offers.
A final assessment is useful decision support, not a new mandatory offer gate.
All findings belong inside this Arabtec repository. All runtime fixes target
the on-premises legacy application. The assessment should become clearer and
fully editable for the recruitment team; restricted external roles stay scoped.

## Handoffs to verify

| Step / page | Responsible action | Required handoff and dependency | Evidence status |
|---|---|---|---|
| Hiring Requests | Recruitment Manager records staffing need, project, department and headcount | Request ID and approval state visible to Director; approval-off setting remains explicit | Baseline HTTP create/submit/approve passed |
| Request approval | HR Director decides; reason for rejection | Approved request reaches sourcing; audit and notification identify decision | Baseline HTTP passed |
| Recruiter assignment | Recruitment Manager assigns/reassigns ownership | Recruiter's requests and candidate pipeline become usable; unassigned work remains visible | Baseline assignment passed; exceptions under review |
| Talent Pool / intake | Recruitment team creates or reviews a candidate | One candidate identity, contact details, duplicate warning, usable CV, correct request link | Baseline CV thread/link passed; intake coverage pending |
| Request pipeline | Recruiter links and advances application | Request, candidate and application identity remain aligned; stage history and request thread update | Baseline moves/history passed |
| Scheduler / Interviews | Recruitment team schedules with panel and time | Correct candidate/application, calendar visibility, interview opens assessment | Baseline panel-linked assessment passed; calendar journey pending |
| Assessment | Recruitment team records HR/technical evaluations and final decision | Clear draft/submitted state, editable authorized sections, persistence, attribution | User requested improved layout/control; implementation pending |
| Offers | Recruitment team prepares terms from pipeline or standalone candidate | Linked offer retains correct application/request; standalone meaning is visible | Actual browser Create offer form opened |
| Offer approval | HR Director approves terms | Approved terms must remain the same terms that are issued; contractual change invalidates approval | Confirmed gap: currency/benefits/title changes retain approval |
| Offer issue | Authorized HR sender issues approved offer | Application advances consistently; stopped application cannot silently revive; mail outcome must be clear | Confirmed stale-send gap; actual email delivery not yet verified |
| Offer outcome / joining | Authorized recruitment staff record result | Candidate decision and vacancy/headcount agree; no duplicate or overfilled joining | Existing coverage identified; independent rerun pending |
| Dashboards / reports / audit | Managers review workload and progress | Same saved state and scope as operational pages; no misleading counts | Basic dashboard and audit reads passed |

## Independently reproduced defects
All reproduced on local synthetic data against the same legacy routes.
Reproduction source: backend/workflow_integrity_test.mjs.
Evidence: evidence/workflow-red.log — 0 passed, 22 failed.

| ID | Priority | Finding | HR consequence | Required correction |
|---|---|---|---|---|
| WF-01 | P1 | Sending a previously approved offer resets rejected/on-hold/declined application to offer_sent | A stopped hiring process resumes without an explicit decision | Refuse stale sends; preserve both records |
| WF-02 | P1 | Approved currency, benefits or position can change without renewed approval | Issued commitment differs from the Director's decision | Reapprove contractual changes; clear obsolete approver attribution |
| WF-03 | P1 | Sent offer salary remains editable | The system no longer reliably records what was issued | Preserve issued terms; controlled correction path |
| WF-04 | P1 | Interview scheduling omits canonical offer_declined terminal state | Recruiting activity can continue after a declined outcome | Normalize terminal states; preserve explicit authorized overrides |

## Items needing evidence, not assumptions
- An application stage change can represent a manual event; do not automatically
  treat every manual move as an error or add unapproved rigid gates.
- Standalone offers are intentional, but the form must explain that they do not
  advance an application or fill a vacancy.
- The send route currently marks an offer sent before best-effort notification;
  distinguish issuance recording from actual delivery in UI and audit. Inspect
  disabled, missing-address and failed-transport cases before proposing a fix.
- On-hold/cancelled requests and existing appointments/offers need clear handling;
  flexible approval does not justify silently overwriting a candidate's outcome.
- Recruitment-team editing must preserve who changed an evaluation and when,
  including changes after submission. Check direct API access and nested reads.

## Verification baseline
Live readiness: HTTP 200; service active. SSH read confirmed HEAD and DEPLOYED_SHA
both 2beef22243082d4fdba0065b16b684d191a6a5c1. No tracked live edits reported.
Untracked live .config-baseline-20260910/ and package-lock.json preserved.
Local baseline: 98129346f5370f7b4225970a8905f6fc077c9144.
Connections suite: 38 passed, 0 failed, exit 0. Local Node 24.15.0; release gate
must separately address supported Node 22 and PostgreSQL behavior.

No fixes or assessment improvements have yet passed independent acceptance.
