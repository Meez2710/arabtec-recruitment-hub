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
