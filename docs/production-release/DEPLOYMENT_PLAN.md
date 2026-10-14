# Production release plan — Arabtec ATS on ats@10.20.0.9

Status: **prepared, not executed.** Target SHA is the final verified commit recorded in `RELEASE_EVIDENCE.md`.

## Current production (read-only baseline, 4 Oct 2026)

- Deployed: `5272780e054246e2c789e8cd1ecfe9ec267116f8` (HEAD = DEPLOYED_SHA, clean tracked tree).
- Service `arabtec-ats` active; Node v22.23.2; disk 11% used.
- Latest existing dump: `~/backups/pre-deploy-20261001-074657.dump` (61 MB). Not a substitute for a fresh backup.

## Why not `08-redeploy.sh`

It resets the live checkout **before** building. A failed build restores `node_modules` but leaves the new source in place. Recovery needs the running process to read the database DSN, which is unavailable if the new process never starts. It is not presented as fully recoverable.

## Procedure: `deploy/on-prem/09-safe-release.sh`

1. **Preflight, read-only.** Records the previous SHA, refuses a dirty tracked tree, refuses if the service is not ready. Captures the DSN once, while healthy, into a private file (mode 600) under `~/releases/<run>/`.
2. **Fresh backup.** `pg_dump --format=custom` to `~/backups/pre-release-<ts>-<sha7>.dump`, then checks it is readable with `pg_restore --list` and records its size and hash.
3. **Build outside the live checkout.** Fetches the exact SHA from a git bundle (no GitHub push needed) into the repository objects. Adds a separate worktree and runs `npm ci && npm run build` there. A failed build stops here; production is untouched.
4. **Switch.** Moves the previous `node_modules` and `dist` aside (never deleted), moves the live checkout to the exact SHA, moves the prebuilt dependencies in, writes DEPLOYED_SHA and ends the process. `Restart=always` starts the new one.
5. **Verify or recover.** Waits up to 120 s for a **new** PID answering `/api/health/ready` with HEAD = target SHA. If that never happens, it restores the previous source, dependencies and build automatically, restarts, and waits for readiness again.

Uploads, CV inbox and configuration (`/var/lib/arabtec-ats`, `/etc/arabtec-ats`) are outside the checkout and untouched. Nothing is deleted. The database is **not** restored automatically, because startup schema changes are additive and a restore discards newer data. The script prints the restore command for an owner decision.

**Expected interruption:** one process restart. That is systemd `RestartSec=5` plus about 2–10 s start-up (measured 1.7–2.5 s on a fresh local PostgreSQL), so roughly 10–20 s of 502/503. Plan a quiet moment.

**Code rollback after a successful release:** run the same script with `ATS_SHA=5272780e054246e2c789e8cd1ecfe9ec267116f8`. It repeats the backup, builds outside the live tree, and switches back. Database restore stays a separate owner decision using the printed command and the run's DSN file.

## Exact commands (from this Mac, after permission)

```
git branch release/20261004 <TARGET_SHA>        # local branch, nothing pushed
git bundle create /tmp/arabtec-release.bundle release/20261004
git bundle verify /tmp/arabtec-release.bundle
scp /tmp/arabtec-release.bundle deploy/on-prem/09-safe-release.sh ats@10.20.0.9:~/arabtec-release/
ssh ats@10.20.0.9 'ATS_SHA=<TARGET_SHA> ATS_BUNDLE=~/arabtec-release/arabtec-release.bundle bash ~/arabtec-release/09-safe-release.sh'
```

Post-release read-only smoke from this Mac (no login, no data written):

- `GET http://10.20.0.9:4001/api/health` and `/api/health/ready` → 200, DB up.
- `ssh ats@10.20.0.9 'cat /opt/arabtec-ats/DEPLOYED_SHA; git -C /opt/arabtec-ats rev-parse HEAD'` → both equal TARGET_SHA.
- `GET /` serves the new sign-in page and stylesheets carrying cache token `20261004c`.
- Unauthenticated `GET /api/interviews`, `/api/assessments/meta`, `/api/candidates` → 401 (routes alive, auth enforced).

**Authenticated live checks must be done by the owner** in a browser with a real account: sign-in, interviews calendar, one assessment open/save, an RBAC spot check as a restricted user, and reports. Claude does not enter production passwords, and no demo users, candidates or assessments are seeded into production.

## Outstanding permission (blocking)

Claude Code's automatic permission review refused production access after the first read-only SSH baseline:

- **Refused:** `ssh ats@10.20.0.9 '…read service environment variable names and /api/health…'`. Reason: "Production Reads".
- **Refused:** `curl http://10.20.0.9:4001/api/health*`. Reason: "Production Reads".

To proceed, the owner adds allow rules in Claude Code settings, or approves each prompt:

- `Bash(scp * ats@10.20.0.9:~/arabtec-release/*)`: copy the bundle and script, home directory only.
- `Bash(ssh ats@10.20.0.9:*)`: run the release script and the read-only smoke.
- `Bash(curl *http://10.20.0.9:4001/*)`: health and readiness checks.

No credential, network or approval-control changes are requested beyond these. Docker on this Mac is only a disposable local PostgreSQL for testing (`arabtec-pg-scratch-test-20261004`); it is not a server dependency.
