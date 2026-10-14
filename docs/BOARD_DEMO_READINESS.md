# Board demo readiness — Arabtec Recruitment Hub

Date: 2026-10-04. Branch `codex/board-demo-readiness`. Evidence: `docs/board-demo/evidence/`.

## Verdict

**Production: BLOCKED.** The company server `10.20.0.9:4001` (and SSH :22) times out from this machine. The deployed SHA is unknown, so the gate "final green SHA = deployed SHA" cannot be met. No deployment was attempted.

**Local demo: READY_LOCAL at `6e3c492`**, on a clean synthetic BOARD DEMO server, with the caveats below. CV parsing must not be shown live: no AI reader is configured, and those suites are SKIPPED.

## SHAs

| What | SHA |
|---|---|
| Baseline (independently confirmed) | `e6dc269` |
| AR-01 candidate scope (P0) | `f6faaa9` |
| AR-02..AR-08 assessment review fixes | `04b4a1e` |
| Scheduler date/duration validation | `2667942` |
| Offers follow candidate scope (AR-01 class) | `1aa0658` |
| phase6 test start-up wait | `bd87e87` |
| Candidate Review hidden from scoped roles | `6e3c492` |
| **Final code SHA tested** | **`6e3c492`** |
| Deployed SHA | unknown — BLOCKED |

## Gate results (final SHA, clean tree)

All commands run in `backend/` with Node 22.23.3, tree clean, nothing else running. Logs: `evidence/final-*.log`.

| Command | Exit | Result | Status |
|---|---|---|---|
| `npm run build` | 0 | compiled | PASS |
| `npm run typecheck` | 0 | no errors | PASS |
| `npm test` (`run_tests.mjs`) | 0 | 77/77 suites | PASS (with skips below) |
| `npm run test:domain` (vitest) | 1 | 796 passed, 1 failed, 9 skipped | **FAIL** — pre-existing, see open item 1 |
| `npm run test:pg:required` (disposable Docker `arabtec_scratch_test`) | 0 | 7 suites, 220 checks | PASS |
| Golden path, 12 stages, UI (`gp.mjs`) | 0 | 0 console errors, 0 failed requests | PASS |
| Restricted-role API probe | — | boundaries hold (below) | PASS |
| HawkScan DAST | — | no `HAWK_API_KEY` | SKIPPED |
| frontend-v2 | — | not deployed | N/A |

Skipped inside the passing `npm test`:
- **SKIPPED (no AI reader):** `cv_proposal_test`, `cv_intake_test`, `intake_route_http_test` (3 parse checks), `parser_seam_test` (2 checks).
- **Covered separately:** `pg_tx_test` skips without `PG_TEST_URL`; it ran green under `test:pg:required`.
- **Skipped assertion:** `bl03_test` (one audit-trail check): "assertion skipped, not passed".

Skipped is not a pass. The three CV suites exit 0 but print "This is NOT a pass".

## Defects fixed in this session

Each was reproduced first (red), then fixed and re-run (green).

| ID | Sev | Defect | Red → green |
|---|---|---|---|
| AR-01 | P0 | Restricted roles could list and open unrelated candidates, nested requests, notes and offers | 20/26 → 46/0 (`candidate_scope_RED_on_e6dc269.log`) |
| AR-01b | P0 | Hiring Manager could list, open and print every offer in the company | 49/5 → 54/0 (`offer_scope_RED_on_04b4a1e.log`) |
| AR-01c | P1 | Candidate Review still offered to scoped roles; its count called a refused endpoint (403 seen in golden path) | UI test added; 49/0 |
| AR-02 | P1 | A partial assessment update without `submitted` withdrew a submitted evaluation | review_fixes 12/14 → 26/0 |
| AR-03/08 | P1 | Field shown while its section was hidden; settings screen did its own policy maths | same suite + browser save/reload as admin |
| AR-04 | P1 | Printable form showed a justification the API hid | same suite |
| AR-05 | P1 | Tablet: drawer under the top bar; score and notes overlap; table wider than its box | browser at 768: table 636px = section |
| AR-06 | P1 | Unsaved assessment edits lost when the window crossed 900px | UI test + browser |
| AR-07 | P1 | Printable document had no CSP of its own (blob URL ignores the header) | suite + browser canary blocked |
| SCH-1 | P1 | POST/PUT accepted unparseable, rolled-over (Feb 30) and timezone-less dates | 7/21 → 28/0 (`scheduler_RED_on_04b4a1e.log`) |
| SCH-2 | P1 | Negative, zero, fractional and over-8h durations accepted | same suite |
| SCH-3 | P1 | A refused PUT (400) still saved the new time and status | same suite |
| T-1 | test | phase6 crashed under load (fixed 700ms sleep before login) | 3 isolated reruns green |

## Golden path (fresh, through the UI)

Server: `localhost:4410`, scratch DB, synthetic data only (`docs/board-demo/scripts/board_demo_fixture.mjs`). Driven by real mouse and keyboard events (`gp.mjs`, `gp_stages.mjs`). Every stage: 0 console errors, 0 failed requests.

| # | Who | Step | Screenshot |
|---|---|---|---|
| 1 | HR Manager | Sign in, dashboard | `gp-01-login.png`, `gp-02-dashboard.png` |
| 2 | HR Manager | Create request "Site Planning Engineer (BOARD DEMO)", then **Submit for approval** | `gp-03`, `gp-04` |
| 3 | HR Director | **Approve** → status Sourcing | `gp-05-director-review.png` |
| 4 | Recruitment Mgr | **Assign recruiter** → Karim Adel | `gp-06-request-assigned.png` |
| 5 | Recruiter | CV Inbox (view only), **Add manually** "Omar Hassan (BOARD DEMO)", profile | `gp-07`, `gp-08`, `gp-09` |
| 6 | Recruiter | Request → Candidates → **Add Candidate** (Sourced) → Move to Screening → Move to Interview | `gp-10`, `gp-11` |
| 7 | Recruiter | Actions → **Schedule Interview**, Mon 5 Oct 10:00, 60 min, panel Mona Sami | `gp-12`, `gp-13-interviews-calendar.png`, `gp-14` |
| 8 | Interviewer | **Open assessment**, score 5 criteria, Proceed, submit; edit to add justification (stays submitted) | `gp-15`, `gp-16`, `gp-17` |
| 9 | HR Manager | HR evaluation, submit; **Record Final Decision** = Proceed | `gp-18`, `gp-19-final-decision.png` |
| 10 | HR Manager | **Mark Completed**; Actions → **Generate Offer** 42,000 EGP; **Submit for approval** | `gp-20`, `gp-21` |
| 11 | HR Director | **Approve** offer → Approved | `gp-22-offer-approved.png` |
| 12 | HR Manager | Reports, dashboard | `gp-23-reports.png`, `gp-24` |

Scheduler extras: a double-click on **Schedule** created exactly one interview; **Cancel** requires a reason and set status Cancelled (`gp-25`, `gp-26`). Intentional panel overlap is a warning, never a block (API suites).

## Restricted-role proof (direct API, golden-path data)

`evidence/golden-path/rbac-direct-api.json`.

- **Technical Interviewer:** no salary values (`salaryVisible` false, salary fields null); HR evaluation absent; requests, offers, offer letter and CV intakes 403; unrelated candidate 403.
- **Hiring Manager** (no request of their own here): empty Talent Pool and offer list; every record 403.
- The interviewer also sees Youssef Kamal. That is because the scheduler test above put her on his panel before cancelling it. See open question Q1.

## Open items (not fixed — reported)

1. **Domain test FAIL (pre-existing, `25547bc`):** the Ollama local-only guard was disabled on purpose for hosted Ollama (Runpod). CV text can go to any configured host. No host is configured locally. Owner decision; PII risk.
2. **CV parse/intake suites SKIPPED:** no AI reader configured.
3. **Reschedule has no UI.** `PUT /api/interviews/:id` is API-only (now validated).
4. **Wording (P2):** a draft request is labelled "Pending Approval / Awaiting approval" before it is submitted; offer heading has a leading space; calendar header reads "3 – Oct 8, 2026".
5. **Accessibility (P2):** interview panel chips are plain `span` elements — not keyboard-operable.
6. **Test fragility:** about 20 suites wait a fixed sleep for start-up (same pattern as phase6). Green when the machine is idle.
7. **PostgreSQL:** required PG suites cover transactions and races. The new scope and scheduler rules were verified on SQLite only.
8. **HawkScan DAST:** SKIPPED — no `HAWK_API_KEY`.

## Questions for the owner

- **Q1.** Should a cancelled interview end the interviewer's access to that candidate? Today it does not (same as interview visibility).
- **Q2.** Should a request's named hiring manager (`hiring_manager_id`) see its candidates? Today neither the request list nor candidate scope includes it.

## Preview servers

- `localhost:4400`: older synthetic preview (seed.js demo users + scratch fixture). Contains an escaped HTML-injection test name — **do not use for presentation**.
- `localhost:4410`: clean BOARD DEMO server used above. Demo users come from `backend/prisma/seed.js` (`SEED_DEMO_DATA=true`); passwords are not reproduced here.
