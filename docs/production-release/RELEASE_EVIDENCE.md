# Release evidence — Arabtec ATS

**Release SHA (to deploy, exactly as verified):** `38f72cffdbb83d9284069d84de766f51cf37f5a9` (branch `codex/board-demo-readiness`, not pushed). Later docs-only commits record evidence and are not the deployed SHA.
**Deployed:** `5272780e054246e2c789e8cd1ecfe9ec267116f8` — **release not yet deployed** (see `DEPLOYMENT_PLAN.md`, permission outstanding).
Runtime code in `38f72cf` is identical to `03a1ddb` (`git diff 03a1ddb 38f72cf -- backend frontend` is empty); `38f72cf` adds docs and the release script only. Both were verified.

## Changes in this release (since deployed 5272780)

| Commit | Change |
|---|---|
| `e6dc269` | Role-controlled interactive interview assessment (baseline feature, never deployed) |
| `f6faaa9` | Candidate visibility limited to assignment scope (P0) |
| `04b4a1e` | Assessment review fixes AR-02..AR-08 (submit state, parent/child policy, print parity, tablet layout, unsaved edits, document CSP) |
| `2667942` | Interview schedule date/duration validation; refused updates never half-apply |
| `1aa0658` | Offer reads follow candidate scope (P0) |
| `bd87e87` | Test start-up wait (test only) |
| `6e3c492` | Candidate Review hidden from scoped roles |
| `eca7c9c` | Ollama client local-only guard restored; hosted host only via `OLLAMA_ALLOWED_HOSTS` + https |
| `752c804` | **PostgreSQL: final-decision save no longer 500s** (transaction-safe RETURNING-id fallback); PG test harness |
| `4b71e75` | Calmer interactive assessment form (styling only) |
| `03a1ddb` | Sign-in redesign merged from `d076d3d`; drawer shows "Candidate details", no repeated print title |
| `38f72cf` | Safe release script, plan, evidence (no runtime change) |

## Final verification on `38f72cf` (clean tracked tree, Node v22.23.3, macOS)

Logs: `evidence/verify-38f72cf/`. Run sequentially, nothing else loading the machine.

| Command (in `backend/`) | Engine | Exit | Result |
|---|---|---|---|
| `npm run build` | — | 0 | compiled |
| `npm run typecheck` | — | 0 | no errors |
| `npm test` (`run_tests.mjs`) | SQLite (per-suite scratch DB) | 0 | 77/77 suites |
| `npm run test:domain` (vitest) | PGlite (in-process PostgreSQL) | 0 | 798 passed, 0 failed, 9 skipped (43 files + 1 skipped) |
| `pg_tx_test.mjs --required` | PostgreSQL 16 (local Docker) | 0 | 55/0 |
| `pg_appnumber_race_test.mjs` | PostgreSQL 16 | 0 | 13/0 |
| `pg_sequence_test.mjs` | PostgreSQL 16 | 0 | 24/0 |
| `pg_reopen_race_test.mjs` | PostgreSQL 16 | 0 | 15/0 |
| `reconciliation_test.mjs` | PostgreSQL 16 | 0 | 44/0 |
| `pg_headcount_race_test.mjs` | PostgreSQL 16 | 0 | 31/0 |
| `pg_join_race_test.mjs` | PostgreSQL 16 | 0 | 45/0 |
| `run_pg_behavior.mjs` (8 suites) | PostgreSQL 16 | 0 | candidate scope 54/0, scheduler 28/0, calendar 26/0, assessment fixes 26/0, assessment PDF 121/0, assessment policy 77/0, phase 4 41/0, phase 5 72/0 |

PostgreSQL: each suite ran in a newly created, retained database `arabtec_scratch_test_*` on loopback (names in `evidence/verify-38f72cf/pg-databases-kept.txt`). Measured ready time 1.7–1.8 s.

**Skipped (not passes):** `cv_proposal_test`, `cv_intake_test` (no CV reader configured); `intake_route_http_test` 3 parse checks; `parser_seam_test` 2 checks; `bl03_test` 1 audit-trail assertion; vitest 9 skipped tests (concurrency tests needing multiple sessions under PGlite, plus one skipped file). `pg_tx_test` inside `npm test` skips without `PG_TEST_URL` but ran green above. HawkScan DAST: skipped, no `HAWK_API_KEY`.

## Failures found and how they were closed

| Finding | Evidence (failed) | Fix | Evidence (passing) |
|---|---|---|---|
| Final decision 500 on PostgreSQL (release blocker) | `evidence/pg-behaviour-2-FAILED-final-decision-500.log` (PDF 117/4, policy 75/2); root cause `evidence/pg-server-log-root-cause.txt`; `evidence/pgtx-RED-on-eca7c9c.log` | `752c804` savepoint around RETURNING-id probe, released after fallback; genuine errors still roll back | `evidence/pgtx-GREEN-on-fix.log` 55/0; behaviour suites 8/8 |
| PG suites timed out at 20 s on start | `evidence/pg-behaviour-1-FAILED-startup-timeout-and-final-decision.log` | none needed in product; occurred while a parallel UI replay loaded the Mac. Timeout made configurable and ready time logged (test only) | measured 1.7–2.5 s on every later run |
| Domain suite: Ollama guard test failed (796/1/9) | earlier report | `eca7c9c` | 798/0/9 |
| On `03a1ddb`: vitest `matching.test.ts` "socket hang up"; `pg_sequence_test` EADDRINUSE on its random backend port | `evidence/final-domain.log`, `evidence/final-pg-pg_sequence_test.log` | transient (no assertion failed) | reruns: domain 798/0/9 twice; pg_sequence 24/0; clean on `38f72cf` |

## Interactive assessment — review gate (real browser, local synthetic data)

`evidence/ui-journey-38f72cf/gate-assessment.json` and `gate.out`. HR and Technical × desktop 1440, tablet 768, phone 390: **6/6**.
Checked per run: Shift+Tab reaches a score, Space selects it (`aria-checked` true), focus ring 2 px solid green; click selection; notes typed; score guide visible within the form; bottom actions unobstructed; **Save draft** → status draft → refresh keeps the note → **Submit** → submitted → refresh shows Submitted. An incomplete submit is refused with "Answer every criterion (a score or N/A) before submitting."
Screenshots: before `docs/board-demo/evidence/release/before/`, after `…/release/after/`, bottom actions `evidence/ui-journey-38f72cf/gate-*-bottom.png`.

## End-to-end UI journey on `38f72cf` (local, synthetic, trusted mouse/keyboard)

`evidence/ui-journey-38f72cf/gp-*.json|png`. 12/12 stages, **0 console errors, 0 failed requests** each: sign-in (new screen) → request create/submit → HR Director approve → assign recruiter → add candidate → link → move to Interview → schedule (Mon 10:00 local stored as UTC) → technical evaluation → edit after submit → HR evaluation + final decision → interview completed → offer create/submit/approve → reports. Double-click **Schedule** created exactly one interview; **Cancel** requires a reason.

Restricted-role API probe (`rbac-direct-api.json`): Technical Interviewer — no salary values, HR section absent, offers/requests/CV intakes 403, unrelated candidate 403. Hiring Manager — empty pool and offer list. The interviewer also sees one candidate whose interview she was on and that was then cancelled (open decision Q1).

Note: after ~30 sign-ins in a few minutes the login limiter returned 429 (15-minute window) — the security control working; the local test server was restarted on the same database to continue.

## Known limitations (not changed in this release)

- Reschedule exists through the API only; there is no screen action.
- Score buttons are individual tab stops; arrow-key movement inside a score group is not implemented.
- A cancelled interview keeps the interviewer's access to that candidate (Q1); a request's named hiring manager is not part of scope rules (Q2).
- Interview panel chips are not keyboard-operable; minor wording issues (draft shown as "Pending Approval", offer heading leading space, calendar header).
- About 20 legacy suites still use fixed start-up sleeps.
- The legacy CV watcher can send CV text to DeepSeek when `DEEPSEEK_API_KEY` is set (pre-existing, separate from the Ollama guard).
- `09-safe-release.sh` is syntax-checked but has not been executed anywhere.

## Local test infrastructure

Docker container `arabtec-pg-scratch-test-20261004` (PostgreSQL 16, loopback 55439) is a disposable test database on this Mac — not a server dependency. Databases are retained. Git worktree `wt-red` (scratchpad, at `eca7c9c`) was used only for the red run.
