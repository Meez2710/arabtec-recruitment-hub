# Backup & Restore

Covers the PostgreSQL database and uploaded files. Prepared for the VPS/Coolify
target. **Not yet active** — there is no automated backup on the current Render free
tier (a launch blocker, R-01/PG-01).

> Commands below use environment variable NAMES. Never paste real credentials into
> shell history, tickets, or commits. Prefer `PGPASSWORD` via the host secret store,
> or a `~/.pgpass` file with `600` permissions.

## 1. What must be backed up

| Data | Where | Notes |
|------|-------|-------|
| Relational data | PostgreSQL (`DATABASE_URL`) | Candidates, requests, offers, users, audit log. |
| Uploaded files | `file_blob` table (in Postgres) + `UPLOAD_DIR` cache | Files live **in the DB today** (FS-01/PG-02), so a DB backup currently captures them too — but it bloats the DB. See §5. |

## 2. Daily logical backup (pg_dump)

```bash
# Run on the VPS (or a small backup box). Uses DATABASE_URL from the environment.
TS=$(date +%F_%H%M)
pg_dump "$DATABASE_URL" --format=custom --no-owner --file "/var/backups/arabtec/arabtec_${TS}.dump"
```

Custom format (`-Fc`) is compressed and restorable selectively with `pg_restore`.

## 3. Schedule (cron) + retention

```cron
# /etc/cron.d/arabtec-backup  — daily 02:30, keep 14 days, then weekly for 8 weeks
30 2 * * *  deploy  /usr/local/bin/arabtec-backup.sh >> /var/log/arabtec-backup.log 2>&1
```

`arabtec-backup.sh` should: dump → verify exit code → copy off-box (object storage /
second server) → prune older than retention. **Off-box copy is essential** — a backup
on the same disk dies with the disk.

## 4. Restore (and the test you must actually run)

```bash
# Into a FRESH, empty database (never blind-restore over prod).
createdb arabtec_restore
pg_restore --clean --if-exists --no-owner --dbname "postgres://USER:PASS@HOST:5432/arabtec_restore" \
  /var/backups/arabtec/arabtec_YYYY-MM-DD_HHMM.dump
```

**Do this once before launch and quarterly after:** restore the latest dump into a
throwaway DB, boot the app against it (`DATABASE_URL` → the restore DB), log in, open a
candidate. A backup you have never restored is a guess, not a backup.

## 5. Recommended: move files out of the database (FS-01/PG-02)

Storing 15 MB blobs in Postgres bloats every backup and pushes toward the free-tier
1 GB limit. Target design:

- Store files on object storage (S3 / DigitalOcean Spaces / Hetzner Storage Box) or a
  mounted VPS volume via `UPLOAD_DIR`; keep only metadata + a storage key in Postgres.
- Back up the object store separately (versioning / lifecycle rules).
- This makes DB dumps small and fast. Implementation is a Stage 2 change (touches
  `src/lib/upload.js`); not done in Stage 1 (reversible-only rule).

## 6. Managed-backup alternative

If you choose **paid Render Postgres** or a **managed Postgres** (e.g. Hetzner + a
managed provider), enable the provider's automated daily backups / point-in-time
recovery instead of (or in addition to) the cron dump. Still run one manual test
restore.

## 7. Required to activate

- The production database must exist on the paid/VPS target (blocked: R-01/PG-01).
- A backup destination (object storage bucket or second host) + its credentials.
- Decision: managed backups vs. self-run `pg_dump` cron.
