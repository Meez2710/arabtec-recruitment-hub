# Supervisor status — board-demo readiness

Updated: 2026-10-04. Evidence logs: `docs/board-demo/evidence/`.

## Baseline
- Repo: `/Users/moutazadly/Documents/Codex/2026-10-01/referenced-chatgpt-conversation-this-is-an-3/work/repo`
- Branch `codex/board-demo-readiness`; initial HEAD `e6dc2691a455f57e063a14b19ece5b8c56108a3e` (not a deployed SHA).
- Login redesign (P2) parked unchanged on branch `p2/login-redesign` at `d076d3d`.
- Company server `10.20.0.9:4001` and SSH :22: **BLOCKED** — timeouts from this Mac (home network 192.168.1.x). Deployed SHA unknown; no known-good deployed rollback verified.
- Local preview `localhost:4400`: synthetic data only (scratchpad SQLite + `backend/prisma/seed.js` demo users + fixture script). Port 4317 (coordinator) currently down.

## Current phase
All gates run on final code SHA `6e3c492` (clean tree). Local demo READY_LOCAL; production BLOCKED. Report: `docs/BOARD_DEMO_READINESS.md`.

## AR-01 (P0) — candidate scope: FIXED, commit `f6faaa9`
- Rule: `backend/src/lib/candidate-scope.js` (broad = request.view_all / interview.view_all / candidate.add; others see only candidates on own requests or own interviews).
- Applied: candidate list, search, smart-search, every `/:id` route (one guard; non-canonical ids → 400), duplicate check, CV intakes, nested applications/notes/activity/offers, request smart-match pool, anyhelp tools.
- API red `candidate_scope_RED_on_e6dc269.log` 20/26 → green `candidate_scope_GREEN.log` 46/0; `anyhelp_GREEN.log` 4/4.
- Browser (4400, interviewer): unrelated candidate absent from Talent Pool; direct `/api/candidates/:id` → 403 (`ar01-05-06-07-AFTER.json`, `ar01-interviewer-talent-pool.png`).

## AR-02..AR-08 (P1) — FIXED, commit `04b4a1e`
- AR-02 omitted `submitted` keeps state. AR-03 one parent/child rule + refusal of contradictory overrides. AR-08 settings use server preview. AR-04 print = API. AR-05 drawer portal + table fits at 768. AR-06 unsaved edits survive resize. AR-07 meta CSP in printable doc.
- Red `review_fixes_RED_on_f6faaa9.log` 12/14 → green `review_fixes_GREEN.log` 26/0.
- Suites on `04b4a1e` tree (all exit 0, logs `ar0207-*.log`): review_fixes 26/0, assessment_pdf 121/0, assessment_policy 77/0, ui_assessment 24/0, ui_layout_rules 18/0, ui_form_controls 22/0, ui_responsive 28/0, ui_layout_containers 13/0, ui_overlays 27/0, ui_gallery 53/0, ui_compile 4/0, ui_readiness 35/0.
- Browser: AR-05 at 768 — header below bar, Close clickable, score/notes no overlap, table 636px = section 636px (`ar05-tablet-768.png`). AR-06 note restored after 1280→768. AR-07 meta CSP present, canary script blocked.
- Browser as admin (`ar03-settings-browser.json`, `ar03-settings-hidden-unsaved.png`): hiding Final Recommendation shows Technical Justification unticked + locked; persists after fresh load; server effective view=false; Restore defaults → overrides `{}`.

## Scheduler — FIXED, commit `2667942`
- Reproduced: unparseable / Feb-30 / no-timezone dates and ≤0, fractional, >8h durations accepted on POST/PUT; `PUT {scheduledAt:""}` blanked the date; a refused PUT still saved the new time and status.
- Red `scheduler_RED_on_04b4a1e.log` 7/21 → green `scheduler_GREEN.log` 28/0 (registered in `run_tests.mjs`).
- UI: duration input has min/max/step. Intentional overlap still a warning; double-click Schedule → 1 interview (golden path).

## Offers scope — FIXED, commit `1aa0658` (AR-01 class, P0)
- Found via phase5 regression: Hiring Manager could list/open/print every offer (unrelated candidate names, request titles, notes).
- Red `offer_scope_RED_on_04b4a1e.log` 49/5 → green 54/0. phase5 72/0 (its HM assertions now use the HM's own request; 403 asserted for unrelated).

## Candidate Review nav — FIXED, commit `6e3c492`
- Interviewer's sidebar count called `/candidates/intakes` (403 in golden path network log) and the menu offered a refused page. Now gated on the same broad-access rule. ui_behavior 49/0.

## Golden path (4410, synthetic) — PASS
- 12 stages through the UI, real mouse/keyboard events, 0 console errors, 0 failed requests per stage. Screenshots `evidence/golden-path/gp-01..26`.
- Direct API RBAC probe: `evidence/golden-path/rbac-direct-api.json` (interviewer: no salary values, HR section absent, unrelated 403).

## Regression so far
- `npm run build` exit 0; `npm run typecheck` exit 0.
- `npm run test:domain` exit 1: 796 passed, 1 failed, 9 skipped — pre-existing Ollama local-only guard disabled in `25547bc` (owner decision, not changed).
- `npm run test:pg:required` exit 0 (disposable `arabtec_scratch_test`, 7 suites, 220 checks).
- `npm test` on `1aa0658`: 76/77 — phase6 start-up race under load; fixed `bd87e87`, 3 isolated reruns 21/0.

## Skipped / blocked
- HawkScan DAST: SKIPPED — no `HAWK_API_KEY`.
- CV proposal/intake suites: SKIPPED — no AI reader configured (exit 0 is not a pass).

## Final regression on `6e3c492`
- build 0 · typecheck 0 · `npm test` 77/77 exit 0 · domain exit 1 (796/1/9, pre-existing Ollama guard) · PG required exit 0 (220 checks).

## Pending
- Production deploy: BLOCKED (company server unreachable).
