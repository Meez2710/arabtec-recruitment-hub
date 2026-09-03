# Arabtec ATS — on-prem migration runbook

Move the Recruitment Hub off Render onto the company server and **retire Render**.

- **Target host:** `ats@10.20.0.9` (Ubuntu 24.04, existing PostgreSQL 16, Apache).
  Shared with the Employee Workspace app — this package keeps the two isolated
  (own service account, own DB role, own port, hardened systemd unit).
- **Code deployed:** `origin/main` of
  `github.com/Meez2710/arabtec-recruitment-hub` — the same ref Render prod tracks.
- **App:** the legacy Node server (`backend/src/server.js`). `npm run build`
  compiles the TypeScript document pipeline to `dist/` before start, exactly as
  Render does.

## Status

**Not executed.** This host is on the corporate LAN and is not reachable from the
assistant's environment (no route to `10.20.0.9:22`), and the assistant has no
SSH tool and cannot accept a server password in chat. Every command below must be
run **from a machine on the Arabtec network** (an on-site laptop, or a bastion)
by someone with a sudo-capable login on the box.

The previous attempt (Aug 2026) stopped at the same wall: the deployment SSH key
was never added to the host, so nothing ran. It also targeted a now-superseded
feature branch. This package is rebuilt against current `main` and adds the two
things that were out of scope before — **migrating the live data off Render** and
**nightly backups** (Render free tier had none).

## Gate — settle these before step 1

1. **SSH access.** A login on `10.20.0.9` with `sudo`. Either add your public key
   to `~/.ssh/authorized_keys` there, or use the password the infra team holds.
2. **The HR CV folder.** Is it a CIFS/NFS share? Path and credentials?
   `CV_INBOX` points at it (read-only mount is fine). `00-inspect.sh` reports
   current mounts.
3. **Hostname + TLS.** The name staff will type, and whether there is a
   CA-issued cert or it should be internal-CA / self-signed. Drives `ServerName`,
   `CORS_ORIGINS`, the two `SSLCertificate*` paths.
4. **Anthropic key.** Reuse the Render key, or issue a separate one for on-prem?
5. **Outbound HTTPS.** Does the box reach `api.anthropic.com` and `github.com`?
   `00-inspect.sh` probes both. No egress → CV parsing / talent search / AI
   shortlist run but report "not configured", and `04-app.sh` can't `git clone`
   (copy a repo tarball instead).
6. **Port 4000.** Free, or held by Employee Workspace? Default here is **4001**;
   change `PORT` in `ats.env` and the vhost together if 4001 is taken too.
7. **Render data.** Is there real data on Render to keep? If the pilot never went
   live there, skip `03-import-from-render.sh` and let the app seed fresh.

## Order

| # | Step | What it does | Reversible |
|---|---|---|---|
| — | `00-inspect.sh` | Read-only survey. **Read the output before step 1.** | n/a |
| 1 | `01-provision.sh` | Service account, dirs, Node 22, PG client, backup dir | yes |
| 2 | `02-database.sh` | Separate role + DB on the existing PG 16; prints `DATABASE_URL` once | yes (refuses to clobber) |
| 3 | `03-import-from-render.sh` | `pg_dump` Render → restore on-prem. **Skip if no Render data to keep.** | yes (`MODE=refresh` re-runs) |
| 4 | fill `/etc/arabtec-ats/ats.env` and `scan.env` from the `*.template` files | secrets | yes |
| 5 | `04-app.sh` | Clone + checkout `origin/main`, `npm ci`, build; records the SHA | yes |
| 6 | `05-install-services.sh` | systemd units, 08:00 scan timer, 02:00 backup timer, Apache vhost | yes |
| 7 | `06-verify.sh` | Health, commit identity, storage, isolation, backups | read-only |
| 8 | burn-in 5–7 days, then `07-decommission-render.md` | final sync, DNS cutover, delete Render | — |
| — | `99-rollback.sh` | Stops on-prem. During burn-in, Render is the fallback. | — |

### Copy the package over

```bash
scp -r deploy/on-prem ats@10.20.0.9:~/arabtec-deploy
ssh ats@10.20.0.9
cd ~/arabtec-deploy && bash 00-inspect.sh | tee ~/arabtec-inspect.txt
```

## Decisions baked in, and why

**Port 4001, not 4000.** Employee Workspace may already hold 4000. `00-inspect.sh`
lists listeners.

**Apache is a reverse proxy only.** The Node app serves its own SPA from
`frontend/public`, so there is no second copy of the frontend to drift out of
sync with the deployed commit. `TRUST_PROXY=1` matches exactly one hop.

**The 08:00 scan is a systemd timer, not the app's watcher.**
`backend/src/lib/cv-watcher.js` polls on `setInterval(CV_WATCH_INTERVAL_MIN)`. An
interval cannot express "08:00 local" — it drifts across restarts and ignores
DST. The timer states the schedule declaratively, `Persistent=true` catches a run
missed while the box was down, and `systemctl list-timers` shows the next fire.
The in-process watcher is disabled (`CV_WATCH_INTERVAL_MIN=0`) so the folder is
never scanned twice. **No code change** — the deployed commit stays byte-exact.

**The scanner uses a dedicated service account.** `POST /api/candidates/inbox-scan`
requires `candidate.add`. Create a user holding that permission and nothing else;
its credentials go in `/etc/arabtec-ats/scan.env` (0600). Do not reuse a person's
login.

**Isolation.** Dedicated PostgreSQL role and database on the existing cluster;
`PUBLIC` revoked on both database and schema. The systemd unit runs under its own
account with `ProtectSystem=strict` and `ReadWritePaths` limited to the ATS data
and log directories — it cannot touch Employee Workspace's files.

**Persistent storage.** `UPLOAD_DIR=/var/lib/arabtec-ats/uploads` and
`CV_INBOX=/var/lib/arabtec-ats/cv_inbox`, outside `/opt`, so a redeploy never
touches CVs. Mode 750: CVs are personal data.

**Nightly backups are not optional.** Render's free DB had none and on-prem is
now the only copy. `backup.sh` (02:00 Africa/Cairo) dumps the DB and tars
`UPLOAD_DIR` to `/var/backups/arabtec-ats`, 14 dailies + 8 weeklies. Restore
recipe is in the header of `backup.sh` — test it once on a scratch DB before
deleting Render.

## Redeploying later

```bash
ssh ats@10.20.0.9 'cd ~/arabtec-deploy && bash 04-app.sh && bash 06-verify.sh && sudo systemctl restart arabtec-ats'
```

Pin an older build after a bad release: `ATS_REF=<sha> bash 04-app.sh`.

## Not in this package

Master data import (the 17 projects / 17 depts / 41 managers / 459 designations)
is a separate `backend/prisma/migrate-arabtec-data.mjs` run against
`DATABASE_URL` — do it only if you did **not** import the Render database, and
only after a dry run.
