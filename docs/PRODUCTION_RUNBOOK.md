# Arabtec ATS — production runbook

Current deployable architecture: **Node/Express + PostgreSQL + the local Docling sidecar**.
The RunPod Docling Serve transport is in the repository and **disabled**. Do not enable it until
it passes the full matrix (see `FINAL_PRODUCTION_READINESS_REPORT.md` §RunPod migration pending).

---

## 1. What runs where

| Component | What it is | Notes |
|---|---|---|
| ATS API + UI | `node src/server.js` | Express serves the API and the SPA |
| Database | PostgreSQL | production; SQLite is development only |
| Document parsing | Docling sidecar, loopback | `deploy/docling-sidecar`, `127.0.0.1:8089` |
| OCR | Tesseract inside the sidecar | `eng` + `ara`, both verified |
| AI extraction | none by default | deterministic rules answer alone |

The sidecar has **no transport security of its own**. It must stay on loopback or a private
network, with `DOCLING_BEARER_TOKEN` set the moment it is reachable any other way.

---

## 2. Environment

Required in production — the app **refuses to boot** without them:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | `postgres://…` |
| `JWT_SECRET` | 32+ chars; a shorter value warns |

Parsing:

| Variable | Production value | Notes |
|---|---|---|
| `DOCLING_BACKEND` | `sidecar` (default) | `serve` is not production-ready |
| `DOCLING_BASE_URL` | `http://127.0.0.1:8089` | unset ⇒ local pdfjs parser, scans abstain explicitly |
| `DOCLING_BEARER_TOKEN` | set if not loopback | never in git, never in the frontend |
| `DOCLING_TIMEOUT_MS` | `120000` | |
| `SIDECAR_OCR_LANGS` | `eng,ara` | sidecar-side |
| `SIDECAR_OCR_SCALE` | `4.0` | **do not lower** — 2.0 is 144 dpi and scans come back empty |

Data protection:

| Variable | Default | Notes |
|---|---|---|
| `RETENTION_ENFORCEMENT` | unset (manual) | `true` erases lapsed candidates on a schedule |
| `RETENTION_DRY_RUN` | unset | `true` reports what it would erase, touches nothing |
| `RETENTION_SWEEP_HOURS` | `24` | |
| `OLLAMA_ALLOW_REMOTE` | unset | required before any non-local Ollama; leave unset |

Operational: `TRUST_PROXY=1` behind one proxy · `CORS_ORIGINS` · `SEED_DEMO_DATA=false` ·
`SENTRY_DSN` optional · `UPLOAD_DIR` on persistent storage.

---

## 3. Start, stop, verify

```bash
# Docling sidecar (loopback only, keeps the host awake while it runs)
./scripts/start-local-docling.sh
./scripts/stop-local-docling.sh

# ATS
npm --prefix backend ci --include=dev && npm --prefix backend run build
npm --prefix backend start
```

Verify after every deploy:

```bash
curl -s localhost:4000/api/health          # liveness — {ok, db}
curl -s localhost:4000/api/health/db       # strict DB check — 503 when down
curl -s localhost:4000/api/health/parsing  # which parser is wired + retention mode
```

`/api/health/parsing` must report `"layoutParser":"docling-sidecar"`. If it reports
`local-pdfjs-mammoth`, the sidecar is unreachable and **scanned CVs will be refused** — an
explicit refusal, never a wrong candidate, but recruiters will notice.

---

## 4. Backup and restore

Documented in `docs/BACKUP_AND_RESTORE.md`. Daily `pg_dump --format=custom`.

**Rehearse the restore — a backup that has never been restored is a hope.**

```bash
DATABASE_URL='postgres://…' ./scripts/pg-backup-restore-rehearsal.sh
```

It dumps, restores into a throwaway database, compares row counts table by table, checks the
constraints came back, and fails loudly on any mismatch. Needs the PostgreSQL **client**
binaries (`pg_dump`, `pg_restore`, `psql`, `createdb`, `dropdb`) — run it on the database host or
in CI. Record the date, dump size and server version each time.

Uploaded CVs live in the `file_blob` table, so a database dump captures them too.

---

## 5. Retention

Off by default. To enable:

```bash
RETENTION_DRY_RUN=true RETENTION_ENFORCEMENT=true   # watch it first
RETENTION_ENFORCEMENT=true                          # then enforce
```

Erasure clears personal fields and deletes CV binaries but keeps the row as
`candidate_state='erased'`, so audit trail, counts and foreign keys stay intact. Every automatic
erasure writes `candidate.data_erased` with `actor_role='system'` and `reason=retention_policy`.
Review `GET /api/candidates/privacy/retention` before switching enforcement on.

---

## 6. Common failures

| Symptom | Cause | Action |
|---|---|---|
| `/api/health/parsing` says `local-pdfjs-mammoth` | sidecar down | restart it; scans are refused meanwhile |
| Scanned CVs return "no reviewable field" | OCR scale, or sidecar without Tesseract | check `SIDECAR_OCR_SCALE=4.0` and `/v1/health` `ocrLanguages` |
| 503 with `Retry-After` on every API call | boot not finished | wait; check the boot log for `Initialisation failed` |
| 403 `PASSWORD_CHANGE_REQUIRED` | bootstrap admin has not rotated | rotate via `POST /api/auth/change-password` |
| Uploads rejected at 413 | over 20 MB | expected; the message states the real limit |
| Everything 401 after a restart | `JWT_SECRET` changed | sessions are signed with it; a new value invalidates all |

---

## 7. Rollback

Configuration only. No database migration, no candidate-data migration.

1. `DOCLING_BACKEND=sidecar` (default) — the RunPod transport is never reached.
2. Unset `DOCLING_BASE_URL` — local parser; born-digital keeps working, scans abstain explicitly.
3. Application rollback: redeploy the previous commit. The schema is additive
   (`addColumnIfMissing`), so an older build runs against a newer database.
4. Database rollback: restore the most recent dump (§4) — the only step that loses data, so it
   is the last resort.

---

## 8. Monitoring

- `/api/health` — liveness, always 200 once HTTP is up.
- `/api/health/db` — 503 when the database is unreachable. **Alert on this.**
- `/api/health/parsing` — alert if `layoutParser` is not `docling-sidecar`.
- `/api/health/watcher` — CV inbox watcher, when enabled.
- Structured JSON request logs: status, duration, requestId, userId. **No CV text, no secrets.**
- Sentry when `SENTRY_DSN` is set; a clean no-op when it is not.
