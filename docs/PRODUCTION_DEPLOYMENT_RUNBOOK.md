# Arabtec ATS — production deployment runbook

**Audience:** the IT administrator performing the deployment. No knowledge of the project's
development history is assumed.

**Target:** Ubuntu 22.04/24.04 LTS · Node.js 22 · PostgreSQL 16 · Apache 2.4 (HTTPS) ·
Docling sidecar on loopback · systemd supervision.

**Architecture being deployed**

```
Internet ── HTTPS :443 ── Apache ──► 127.0.0.1:4000  arabtec-ats.service   (Node/Express)
                                              │
                                              ├──► 127.0.0.1:5432  PostgreSQL
                                              └──► 127.0.0.1:8089  arabtec-docling.service
                                                                    (Docling + Tesseract eng/ara)
```

Only Apache is exposed. The application, the database and the sidecar all bind to loopback.

---

## 0. Before you start

| You need | Why |
|---|---|
| A host with **4 GB RAM, 2 vCPU, 20 GB disk** | the sidecar peaks at ~760 MB and PostgreSQL needs headroom |
| A DNS record pointing at the host | for the certificate |
| sudo | package installation and systemd |
| The release tarball or repository checkout | the application |

The sidecar can share the application host (recommended for this size) or run on its own box. If
it is on its own box it is **no longer on loopback**, and §5.9 becomes mandatory.

---

## 1. System packages

```bash
sudo apt update
sudo apt install -y curl git build-essential \
  postgresql postgresql-contrib \
  apache2 \
  python3-venv python3-pip \
  tesseract-ocr tesseract-ocr-eng tesseract-ocr-ara \
  ghostscript
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

**Verify the OCR language data is present before going further.** This is the single most common
deployment failure — without it, scanned CVs come back empty:

```bash
tesseract --list-langs      # MUST list both  ara  and  eng
```

---

## 2. Service account and directories

```bash
sudo useradd --system --home /opt/arabtec --shell /usr/sbin/nologin arabtec
sudo mkdir -p /opt/arabtec /var/lib/arabtec/uploads /var/log/arabtec /etc/arabtec
sudo chown -R arabtec:arabtec /opt/arabtec /var/lib/arabtec /var/log/arabtec
sudo chmod 750 /etc/arabtec
```

---

## 3. PostgreSQL

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE arabtec LOGIN PASSWORD 'REPLACE_WITH_A_STRONG_PASSWORD';
CREATE DATABASE arabtec OWNER arabtec;
SQL
```

Keep PostgreSQL on loopback (`listen_addresses = 'localhost'` in `postgresql.conf`, the default).
The schema is created by the application on first boot — there is no separate migration step, and
schema changes are additive (`addColumnIfMissing`), so an older build can run against a newer
database.

---

## 4. Application

```bash
sudo -u arabtec git clone <REPO_URL> /opt/arabtec/app
cd /opt/arabtec/app/backend
sudo -u arabtec npm ci --include=dev     # --include=dev is REQUIRED: the build compiles TypeScript
sudo -u arabtec npm run build            # produces dist/ — the app will not start without it
```

`--include=dev` is not optional. `NODE_ENV=production` would otherwise prune TypeScript and the
document pipeline cannot be compiled; the application then fails at boot with
*"The document pipeline is not built."*

### 4.1 Configuration

```bash
sudo cp /opt/arabtec/app/deploy/production.env.example /etc/arabtec/ats.env
sudo chown root:arabtec /etc/arabtec/ats.env
sudo chmod 640 /etc/arabtec/ats.env
sudo nano /etc/arabtec/ats.env
```

Fill in every `SUPPLY` value. At minimum:

```ini
DATABASE_URL=postgres://arabtec:PASSWORD@127.0.0.1:5432/arabtec?sslmode=disable
JWT_SECRET=<openssl rand -hex 32>
CORS_ORIGINS=https://ats.your-domain.example
NODE_ENV=production
TRUST_PROXY=1
SEED_DEMO_DATA=false
DOCLING_BACKEND=sidecar
DOCLING_BASE_URL=http://127.0.0.1:8089
UPLOAD_DIR=/var/lib/arabtec/uploads
```

`sslmode=disable` is correct **only** when PostgreSQL is on this same host over loopback. For a
remote database use `sslmode=require`.

### 4.2 systemd unit — `/etc/systemd/system/arabtec-ats.service`

```ini
[Unit]
Description=Arabtec ATS (Node/Express)
After=network-online.target postgresql.service arabtec-docling.service
Wants=postgresql.service arabtec-docling.service

[Service]
Type=simple
User=arabtec
Group=arabtec
WorkingDirectory=/opt/arabtec/app/backend
EnvironmentFile=/etc/arabtec/ats.env
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
StandardOutput=append:/var/log/arabtec/ats.log
StandardError=append:/var/log/arabtec/ats.log

# Hardening — the app needs only its own directories.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/arabtec /var/log/arabtec

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now arabtec-ats
sudo systemctl status arabtec-ats
```

**First boot prints the bootstrap administrator password ONCE** (unless you set
`SEED_ADMIN_PASSWORD`). Capture it from `/var/log/arabtec/ats.log`, log in, and rotate it
immediately — the account is blocked from every route until you do.

---

## 5. Docling sidecar

### 5.1 Requirements

| | |
|---|---|
| CPU | 2 vCPU minimum. OCR is CPU-bound; this sets throughput |
| RAM | **1.5 GB minimum, 2 GB recommended.** Measured peak 759 MB under 6 concurrent conversions |
| Disk | ~2 GB for the Python venv and Docling models |
| Port | **8089**, bound to **127.0.0.1 only** |
| OCR | `tesseract-ocr` plus **`tesseract-ocr-eng` and `tesseract-ocr-ara`** |

### 5.2 Install

```bash
cd /opt/arabtec/app/deploy/docling-sidecar
sudo -u arabtec python3 -m venv .venv
sudo -u arabtec .venv/bin/pip install --upgrade pip
sudo -u arabtec .venv/bin/pip install -r requirements.txt
```

The first conversion downloads Docling's layout models. To pre-fetch them (recommended, so the
first real upload is not slow), run one conversion after starting the service (§5.6).

### 5.3 Configuration — `/etc/arabtec/docling.env`

```ini
SIDECAR_OCR_LANGS=eng,ara
SIDECAR_OCR_SCALE=4.0
SIDECAR_MIN_NATIVE_CHARS=30
SIDECAR_MAX_BYTES=26214400
SIDECAR_TIMEOUT_S=120
SIDECAR_PIPELINE_VERSION=arabtec-docling-2.55.1
# Only when the sidecar is NOT on loopback — see §5.9
# DOCLING_BEARER_TOKEN=
```

**`SIDECAR_OCR_SCALE=4.0` is not a tuning preference.** It is the rasterisation scale (~288 dpi).
Docling's own default of 1.0 is 72 dpi, at which Tesseract reports *"Too few characters. Skipping
this page"* and every scanned CV comes back empty — indistinguishable from a document with no
text. Do not lower it.

```bash
sudo chown root:arabtec /etc/arabtec/docling.env
sudo chmod 640 /etc/arabtec/docling.env
```

### 5.4 systemd unit — `/etc/systemd/system/arabtec-docling.service`

```ini
[Unit]
Description=Arabtec Docling sidecar (document parsing + OCR)
After=network-online.target

[Service]
Type=simple
User=arabtec
Group=arabtec
WorkingDirectory=/opt/arabtec/app/deploy/docling-sidecar
EnvironmentFile=/etc/arabtec/docling.env
ExecStart=/opt/arabtec/app/deploy/docling-sidecar/.venv/bin/uvicorn app:app \
          --host 127.0.0.1 --port 8089 --workers 1
Restart=always
RestartSec=5
StandardOutput=append:/var/log/arabtec/docling.log
StandardError=append:/var/log/arabtec/docling.log

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/log/arabtec

[Install]
WantedBy=multi-user.target
```

`--workers 1` is deliberate: the Docling converter is a cached in-process object, and a second
worker doubles memory for no throughput gain (OCR is CPU-bound and already releases the GIL).

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now arabtec-docling
```

### 5.5 Bind address — verify it

```bash
sudo ss -lntp | grep 8089
# MUST show 127.0.0.1:8089 — never 0.0.0.0:8089
```

The sidecar has **no transport security of its own**. Loopback is the control.

### 5.6 Health check

```bash
curl -s -X POST http://127.0.0.1:8089/v1/health -H 'content-type: application/json' -d '{}'
```

Expected:

```json
{"ok":true,"doclingVersion":"2.55.1","modelsPresent":true,"ocrEngine":"tesseract",
 "ocrExecutablePresent":true,"ocrLanguages":["ara","eng","osd","snum"]}
```

`ocrLanguages` is **measured** — the endpoint shells out to the real `tesseract`. If `ara` or
`eng` is missing, fix §1 before going live.

### 5.7 Restart and failure behaviour

- `Restart=always`, 5 s backoff — systemd restarts it on crash or OOM.
- If the sidecar is down, the application **falls back to its in-process pdfjs/mammoth parser**:
  born-digital PDFs and DOCX keep working, and scanned CVs are **refused explicitly**. Users see
  "no reviewable field could be read", never a wrong candidate.
- The fallback is recorded in provenance, so a Docling outage is visible rather than silent.

### 5.8 Logs

`/var/log/arabtec/docling.log` — status codes, durations, request ids, and Docling's own INFO
lines (tesseract invocations, temp-file paths). **No document text is ever logged.** Add to
logrotate as in §8.

### 5.9 If the sidecar is NOT on loopback

Only if it runs on a separate host:

1. Generate a token: `openssl rand -hex 32`.
2. Set `DOCLING_BEARER_TOKEN` in **both** `/etc/arabtec/docling.env` and `/etc/arabtec/ats.env`.
3. Restrict the port with a firewall to the application host only.
4. Put TLS in front of it. The sidecar speaks plain HTTP.

Verify: an unauthenticated request must return **401**.

---

## 6. Apache — HTTPS and reverse proxy

```bash
sudo a2enmod proxy proxy_http headers ssl rewrite
sudo apt install -y certbot python3-certbot-apache
sudo certbot --apache -d ats.your-domain.example
```

`/etc/apache2/sites-available/arabtec-ats.conf`:

```apache
<VirtualHost *:80>
    ServerName ats.your-domain.example
    Redirect permanent / https://ats.your-domain.example/
</VirtualHost>

<VirtualHost *:443>
    ServerName ats.your-domain.example

    SSLEngine on
    SSLCertificateFile    /etc/letsencrypt/live/ats.your-domain.example/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/ats.your-domain.example/privkey.pem
    SSLProtocol -all +TLSv1.2 +TLSv1.3

    ProxyPreserveHost On
    ProxyPass        / http://127.0.0.1:4000/
    ProxyPassReverse / http://127.0.0.1:4000/

    # The app sets HSTS, CSP, frameguard and noSniff itself. Do not duplicate
    # them here — two sources for one header is how they end up contradicting.

    # CV uploads are capped at 20 MB by the application; allow a little headroom.
    LimitRequestBody 26214400

    ErrorLog  /var/log/arabtec/apache-error.log
    CustomLog /var/log/arabtec/apache-access.log combined
</VirtualHost>
```

```bash
sudo a2ensite arabtec-ats && sudo systemctl reload apache2
```

`TRUST_PROXY=1` in `ats.env` must match **exactly one** proxy hop. If you later add a CDN, raise
it — otherwise `req.ip` is the CDN's and the per-IP rate limiter protects nobody.

---

## 7. Post-deployment verification

Run all of these before handing over:

```bash
# 1. Liveness
curl -s https://ats.your-domain.example/api/health
# {"ok":true,"service":"arabtec-recruitment-hub","db":"up"}

# 2. Database — 503 if unreachable
curl -s https://ats.your-domain.example/api/health/db

# 3. Parsing — the one that catches a broken sidecar
curl -s https://ats.your-domain.example/api/health/parsing
```

Check 3 **must** report `"layoutParser":"docling-sidecar"`. If it says `local-pdfjs-mammoth`, the
sidecar is unreachable and scanned CVs will be refused.

```bash
# 4. HTTP redirects to HTTPS
curl -sI http://ats.your-domain.example | head -1        # 301

# 5. HSTS present
curl -sI https://ats.your-domain.example | grep -i strict-transport-security

# 6. Sidecar is not reachable from outside
curl -m 5 http://<PUBLIC_IP>:8089/v1/health              # must fail to connect
```

Then log in as the bootstrap administrator, rotate the password, and create the real user
accounts. Run `docs/UAT_PLAN.md`.

---

## 8. Logging

```bash
sudo tee /etc/logrotate.d/arabtec >/dev/null <<'EOF'
/var/log/arabtec/*.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    su arabtec arabtec
}
EOF
```

The application writes one structured JSON line per request: method, path, status, duration,
request id, user id. **No CV content and no secret values are ever logged.** Thirty days of
rotation is a starting point — align it with your own log-retention policy.

---

## 9. Backup and recovery

### 9.1 Daily backup

```bash
sudo mkdir -p /var/backups/arabtec && sudo chown postgres:postgres /var/backups/arabtec

sudo tee /etc/cron.daily/arabtec-backup >/dev/null <<'EOF'
#!/bin/sh
set -e
TS=$(date -u +%Y%m%dT%H%M%SZ)
su - postgres -c "pg_dump 'postgres://arabtec@127.0.0.1:5432/arabtec' \
  --format=custom --no-owner --file /var/backups/arabtec/arabtec_${TS}.dump"
find /var/backups/arabtec -name 'arabtec_*.dump' -mtime +30 -delete
EOF
sudo chmod 755 /etc/cron.daily/arabtec-backup
```

Custom format (`-Fc`) is compressed and selectively restorable with `pg_restore`.

**Uploaded CVs are stored in the `file_blob` table**, so a database dump captures them too. The
`UPLOAD_DIR` copy is a cache and does not need separate backup.

### 9.2 Backup retention

30 daily dumps on-host. **Copy them off-host** — a backup on the same disk as the database does
not survive the failure it exists for. Off-host copies must be encrypted at rest: a dump contains
every candidate's personal data.

### 9.3 Restore

```bash
sudo systemctl stop arabtec-ats
sudo -u postgres dropdb arabtec
sudo -u postgres createdb arabtec -O arabtec
sudo -u postgres pg_restore --dbname 'postgres://arabtec@127.0.0.1:5432/arabtec' \
     --no-owner --exit-on-error /var/backups/arabtec/arabtec_<TIMESTAMP>.dump
sudo systemctl start arabtec-ats
curl -s http://127.0.0.1:4000/api/health/db
```

`--exit-on-error` matters: a partial restore that "mostly worked" is exactly the failure this
must not hide.

### 9.4 ⚠ REHEARSE THE RESTORE — the one action that must run on the production DB host

**This has NOT been performed. Do not record the restore as verified until it has.**

```bash
DATABASE_URL='postgres://arabtec@127.0.0.1:5432/arabtec' \
  /opt/arabtec/app/scripts/pg-backup-restore-rehearsal.sh
```

It dumps, restores into a throwaway database it creates and drops itself, compares row counts
table by table, checks the primary/foreign/unique constraints came back, and fails loudly on any
mismatch. It never modifies the source database.

It requires the PostgreSQL **client** binaries (`pg_dump`, `pg_restore`, `psql`, `createdb`,
`dropdb`) — present on this host via `postgresql-contrib`, absent on the development machines,
which is why this step could not be completed during development.

Record the date, dump size and `SELECT version()` output in your change log after each rehearsal.
Repeat quarterly and after any PostgreSQL major upgrade.

### 9.5 RPO and RTO

| | Value | Basis |
|---|---|---|
| **RPO** | **24 hours** | daily dump; up to a day of intakes, reviews and interview feedback lost |
| **RTO** | **~30 minutes** | restore (§9.3) plus service restart, for a database of this size |

To improve RPO below 24 hours you need continuous archiving (WAL) or a managed PostgreSQL with
point-in-time recovery. That is a decision, not a defect — but the number should be stated to
the business rather than assumed.

---

## 10. Retention scheduling

Retention enforcement is **off by default**. Erasure is irreversible for the erased fields.

```bash
# 1. Review what is currently overdue (needs a candidate.privacy user).
curl -s -H "Authorization: Bearer <TOKEN>" \
  https://ats.your-domain.example/api/candidates/privacy/retention

# 2. Watch it first — reports what it would erase, touches nothing.
#    In /etc/arabtec/ats.env:
#      RETENTION_ENFORCEMENT=true
#      RETENTION_DRY_RUN=true
sudo systemctl restart arabtec-ats
grep retention /var/log/arabtec/ats.log

# 3. Enforce, once legal has confirmed the window.
#    Remove RETENTION_DRY_RUN, keep RETENTION_ENFORCEMENT=true.
sudo systemctl restart arabtec-ats
```

Erasure clears personal fields and deletes CV binaries but keeps the row as
`candidate_state='erased'`, so the audit trail, counts and foreign keys stay intact. Every
automatic erasure writes `candidate.data_erased` with `actor_role='system'`.

The window itself is `retention_months` in system settings (default 24). **It must be confirmed
by legal before enforcement is enabled.**

---

## 11. Secrets

| Secret | Lives in | Permissions |
|---|---|---|
| `JWT_SECRET`, `DATABASE_URL` | `/etc/arabtec/ats.env` | `640 root:arabtec` |
| `DOCLING_BEARER_TOKEN` (only if off-loopback) | both env files | `640 root:arabtec` |
| SMTP credentials | `/etc/arabtec/ats.env` | `640 root:arabtec` |
| TLS private key | `/etc/letsencrypt/live/…` | managed by certbot |

Rules: never in the repository, never in the frontend bundle, never in a log, never in a
screenshot or ticket. The application logs variable **names** and booleans, never values. To
rotate `JWT_SECRET`, change it and restart — every session is invalidated, which is intended.

---

## 12. Rollback

| Scenario | Action | Data loss |
|---|---|---|
| Bad application release | `git checkout <previous-tag> && npm ci --include=dev && npm run build && systemctl restart arabtec-ats` | none — the schema is additive |
| Sidecar misbehaving | `systemctl stop arabtec-docling` — the app falls back to the local parser; scans are refused explicitly | none |
| Parsing suspect | unset `DOCLING_BASE_URL`, restart | none |
| Database corruption | restore §9.3 | back to the last dump (RPO 24 h) |

`DOCLING_BACKEND=serve` selects the RunPod transport. It is implemented but **not
production-verified** — do not set it.

---

## 13. Routine operations

| Task | Frequency |
|---|---|
| Check `/api/health`, `/api/health/db`, `/api/health/parsing` | monitored continuously; alert on the last two |
| Verify a backup file was written | daily |
| Restore rehearsal (§9.4) | quarterly |
| Review the retention report | monthly |
| `apt upgrade` + `systemctl restart arabtec-ats arabtec-docling` | monthly |
| Certificate renewal | automatic via certbot; verify quarterly |

**Alert on:** `/api/health/db` returning 503 · `/api/health/parsing` reporting anything other than
`docling-sidecar` · either systemd unit entering a restart loop · the daily backup not appearing.
