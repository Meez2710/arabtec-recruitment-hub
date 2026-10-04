# Deployment record — 4 October 2026

**Deployed:** `38f72cffdbb83d9284069d84de766f51cf37f5a9` to `ats@10.20.0.9` (service `arabtec-ats`, port 4001).
**Previous:** `5272780e054246e2c789e8cd1ecfe9ec267116f8`.
**Run by:** the owner from his terminal, using `deploy/on-prem/09-safe-release.sh` (Claude Code's permission review refused to run the switch step itself).

## Release run (`/home/ats/releases/20261004-093506-38f72cf/`)

- Preflight: deployed 5272780, service pid 1833 ready on :4001.
- Fresh backup: `/home/ats/backups/pre-release-20261004-093506-38f72cf.dump`, 61,291,704 bytes, 53 table-data entries, readable by `pg_restore --list`, sha256 `6c1337a148009ef9…`. (Harmless perl locale warnings from pg_dump.)
- Code from a thin git bundle (`5272780..release/20261004`, sha256 `16ace9e516071e4f…`, matched local copy); nothing pushed to GitHub.
- Built in a separate worktree: `npm ci` (395 packages) and `npm run build` succeeded; the live checkout was untouched until then.
- Switch and restart: new pid 20765, ready. Previous dependencies kept at `node_modules.prev` in the run folder (nothing deleted).

## Post-deploy checks (read-only, by Claude over SSH)

| Check | Result |
|---|---|
| `git rev-parse HEAD` in /opt/arabtec-ats | `38f72cffdbb83d9284069d84de766f51cf37f5a9` |
| `/opt/arabtec-ats/DEPLOYED_SHA` | `38f72cffdbb83d9284069d84de766f51cf37f5a9` |
| Tracked edits in live checkout | 0 |
| `systemctl is-active arabtec-ats` | active, pid 20765, since 09:35:33 UTC |
| `GET /api/health` | 200 `{"ok":true,"service":"arabtec-recruitment-hub","db":"up"}` |
| `GET /api/health/ready` | 200 `{"ok":true,"ready":true}` |
| `GET /` stylesheet token | `styles.css?v=20261004c` (new release assets) |
| Unauthenticated `/api/interviews`, `/api/candidates`, `/api/assessments/meta`, `/api/offers` | 401 each (routes alive, auth enforced) |
| Service log errors since restart | not checked — `/var/log/arabtec-ats/ats.log` is not readable by `ats` |

**Tested SHA = deployed SHA: yes** (`38f72cf`, verification in `RELEASE_EVIDENCE.md`).

## Still to do by the owner (needs a real login)

Sign in on http://10.20.0.9:4001; open Interviews and one interview; open an assessment (check the calmer form, save a draft only on a record you intend to edit); spot-check a restricted user (e.g. a technical interviewer sees only assigned candidates, no salary); open Reports. No test data was put into production.

## Rollback

Code: `ssh ats@10.20.0.9 'cd ~/arabtec-release && ATS_SHA=5272780e054246e2c789e8cd1ecfe9ec267116f8 bash ./09-safe-release.sh'` (fetches from origin, where 5272780 exists; takes another backup first).
Database: not needed for a code rollback (startup schema changes are additive). A restore from the dump above discards data written after 09:35 UTC and is an owner decision.

---

# Deployment 2 — 4 October 2026, 10:13 UTC

**Deployed:** `6bd501a1acfe507a6fad7351e92a3354f9c1485e` (was `38f72cf`). Run by Claude with `09-safe-release.sh` after the owner enabled command permissions.

Why: owner found interviews scheduled from the Interviews page had no assessment (only "Add Feedback"), and asked for an undo after "Mark Completed".

Changes: interviews scheduled with a hiring request are linked to the candidate's application; "Open assessment" is the primary action on every interview, and an unlinked one asks which request it is for; the assessment unlocks once an active interview exists; "Reopen interview" for completed / no-show; Control Center tab renamed "Footer quotes".

Verification on `6bd501a` before release (`evidence/verify-6bd501a/`): build 0, typecheck 0, `npm test` 78/78, domain 798/0/9, required PostgreSQL suites 7/7 (227 checks), PostgreSQL behaviour suites 9/9 (incl. new interview-assessment suite 18/0). Browser check (local synthetic, `evidence/ui-interview-assessment/`): schedule with request → sheet opens; schedule without request → link dialog → sheet opens; mark completed → reopen → Scheduled; 0 console errors, 0 failed requests.

Release run `/home/ats/releases/20261004-101314-6bd501a/`: backup `pre-release-20261004-101314-6bd501a.dump` (61,292,253 bytes, 53 table-data entries); built outside the live checkout; new pid 21557 ready.

Post-deploy (read-only): HEAD = DEPLOYED_SHA = `6bd501a`; 0 tracked edits; active; `/api/health` 200 db up; `/api/health/ready` 200; assets token `20261004d`; new UI present; unauthenticated `POST /api/interviews/1/link-application` → 401.

Rollback: `ssh ats@10.20.0.9 'cd ~/arabtec-release && ATS_SHA=38f72cffdbb83d9284069d84de766f51cf37f5a9 ATS_BUNDLE=$HOME/arabtec-release/arabtec-release.bundle bash ./09-safe-release.sh'`.

---

# Deployment 3 — 4 October 2026, 11:05 UTC

**Deployed:** `4504ecf76fd56c372685b49b9d02d5999efa5398` (was `6bd501a`), by Claude with `09-safe-release.sh`.
Changes: owner's new footer quote list (150 lines) as the built-in list; Control Center › Footer quotes becomes a row editor (search, add, edit, remove, save, discard, reset, paste a list).
Verification on `4504ecf` (`evidence/verify-4504ecf/`): build 0, typecheck 0, `npm test` 78/78, domain 798/0/9, PostgreSQL required 7/7, PostgreSQL behaviour 9/9. Browser check (local): load 150, search, add, edit, remove, save, reload persists, reset → built-in (`evidence/ui-footer-quotes/`).
Backup `pre-release-20261004-110549-4504ecf.dump` (53 table-data entries). Post-deploy: HEAD = DEPLOYED_SHA = `4504ecf`, active, health/ready 200, db up, token `20261004e`. Live editor shows "Built-in list in use · 150 quotes".
Rollback: `ATS_SHA=6bd501a1acfe507a6fad7351e92a3354f9c1485e ATS_BUNDLE=$HOME/arabtec-release/arabtec-release-b.bundle bash ./09-safe-release.sh`.

---

# Deployment 4 — 4 October 2026, 11:25 UTC

**Deployed:** `facce8b26d4e5ea7dd9f27eae29db461d23c9654` (was `4504ecf`). Light grey desktop sidebar (`#E8EAED`, darker than the `#F4F5F7` canvas), per owner.
Verification (`evidence/verify-facce8b/`): build 0, typecheck 0, `npm test` 78/78, PostgreSQL 7/7 + behaviour 9/9; domain first run 797/1/9 (`api.test.ts` "refuses to overfill a requisition" timed out at 5 s — transient; CSS-only change), rerun 798/0/9.
Backup `pre-release-20261004-112535-facce8b.dump`. Post-deploy: HEAD = DEPLOYED_SHA = `facce8b`, active, health/ready 200, token `20261004f`; live computed colours sidebar rgb(232,234,237), canvas rgb(244,245,247).
Rollback: `ATS_SHA=4504ecf76fd56c372685b49b9d02d5999efa5398 ATS_BUNDLE=$HOME/arabtec-release/arabtec-release-c.bundle bash ./09-safe-release.sh`.

---

# Deployment 5 — 4 October 2026, 11:49 UTC

**Deployed:** `bae6912e001d07e84caa5a647390430ea2452481` (was `facce8b`). Director dashboard rebuilt by priority with project/department/recruiter narrowing; age from approval only; no emoji icons; top-bar brand only when the sidebar is collapsed.
Verification (`evidence/verify-bae6912/`): build 0, typecheck 0, `npm test` 79/79, domain 798/0/9, PostgreSQL 7/7 + behaviour 10/10 (new `dashboard_director_test` 13/0).
Backup `pre-release-20261004-114936-bae6912.dump`. Post-deploy: HEAD = DEPLOYED_SHA = `bae6912`, active, health/ready 200, token `20261004g`, unauthenticated filtered dashboard → 401. Live view: "Approve RQ-26-001 — waiting 20 days", "3 CVs waiting in Candidate Review", primary "Review approvals (1)", Open roles 0 (+1 awaiting approval).
Rollback: `ATS_SHA=facce8b26d4e5ea7dd9f27eae29db461d23c9654 ATS_BUNDLE=$HOME/arabtec-release/arabtec-release-d.bundle bash ./09-safe-release.sh`.
