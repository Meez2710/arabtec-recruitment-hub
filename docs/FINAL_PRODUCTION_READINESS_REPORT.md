# Arabtec ATS — Final Production Readiness Report

**Branch:** `readiness/final-gate` · **Date:** 2026-08-16 · **Mode:** release baseline
**Deployable architecture:** Ubuntu · Node/Express · PostgreSQL · **local Docling sidecar** · Apache HTTPS

# APPLICATION-READY · NOT YET DEPLOYABLE

Nothing was pushed, merged or deployed. No real CV or PII was used at any point.

---

## Summary

| Category | State |
|---|---|
| **CODE COMPLETE** | ✅ Yes. No code blocker, no security blocker. |
| **INFRASTRUCTURE REQUIRED** | ⛔ 2 items — a host, and a rehearsed restore. |
| **SECURITY / LEGAL SIGN-OFF** | ⛔ 2 items — HTTPS confirmation, retention window. |
| **UAT REQUIRED** | ⛔ 14 scenarios, not yet run. |

Everything in the first row is finished and proven. Everything below it needs a machine, a
decision, or a person — none of it is engineering work.

---

## 1. CODE COMPLETE ✅

### 1.1 Test evidence (re-run at release)

| Suite | Result |
|---|---|
| Full ATS runner (`npm test`) | **34 suites, 34 passed, 0 failed** |
| Full ATS end-to-end, including real OCR | **48/48** |
| **PostgreSQL required gate, real engine** | **218 assertions, 0 failed** |
| Retention enforcement | **8/8** |
| Docling adapter — sidecar (pre-existing) | 20/20, untouched |
| Docling adapter — Serve transport | 20/20 |
| Intake · Proposal · Parser seam · HTTP route | 35/35 · 16/16 · 13/13 · 9/9 |
| Document smoke · Ollama | 23/23 · 25/25 |
| Typecheck · Build | PASS · PASS |
| Vitest domain | 740 passed, 82 failed, 9 skipped — all in the non-shipping TypeScript API layer |

PostgreSQL detail: transactions 48 · application-number race 13 · shared sequence 22 · reopen
concurrency 15 · reconciliation 44 · headcount race 31 · join race 45.

### 1.2 What the application does correctly

- The full pipeline — hiring request → approval → assignment → intake → parsing → OCR → review →
  duplicate check → candidate → application → interview → feedback → offer → audit — verified
  over real HTTP with the database inspected at every step.
- **No candidate is created without a complete human review.** A failed conversion abstains and
  raises no intake.
- Whole-database integrity: no orphans, no duplicate applications, no empty candidates, no
  half-converted intakes, seat accounting correct.
- Document classes proven live on the sidecar: born-digital PDF, DOCX, scanned English, PNG,
  **scanned Arabic**, two-page scan, mixed Arabic/English, prompt-injection CV.

### 1.3 Security — verified, not asserted

`JWT_SECRET` required in production and boot fails without it · sessions revocable, password
change revokes all others · cookies `httpOnly`/`sameSite=lax`/`secure` · 12-char password policy
with four character classes, deny-list and no name/email reuse · forced first-login rotation
covering every route by default · lockout after 5 failures · HSTS, `upgrade-insecure-requests`,
frameguard, `noSniff` · `TRUST_PROXY=1` so `req.ip` cannot be spoofed · CORS denies cross-origin
in production unless allowlisted · 1 MB JSON cap, 20 MB upload cap, extension allowlist, uploads
stored under a generated UUID so **the caller's filename never touches disk** · generic error
responses with a request id, no stack · structured JSON logs with **no CV text and no secrets** ·
append-only audit with an actor on every row · no secrets in git.

### 1.4 Fixed on this branch

| | Type |
|---|---|
| `assertLocalHost` restored — was a commented-out no-op, so any `OLLAMA_BASE_URL` silently sent CV text off-machine | SECURITY |
| Process-global `NODE_TLS_REJECT_UNAUTHORIZED='0'` removed — while set, every outbound TLS connection skipped verification | SECURITY |
| Retention enforced on a schedule, off by default, with a dry-run mode | OPERATIONAL |
| `/api/health/parsing` — nothing previously surfaced which document backend was wired | OPERATIONAL |
| Upload rejection said "max 15MB" while the cap was 20 MB | CODE |
| `screeningCounts` restored to the candidate list; `application.created` audited on the CV-review path; sidecar `pageCount` corrected; 14 stale admin fixtures repaired | CODE |

---

## 2. INFRASTRUCTURE REQUIRED ⛔

| # | Item | Action | Owner |
|---|---|---|---|
| **I1** | **Linux host for the application and sidecar.** 4 GB RAM, 2 vCPU, 20 GB disk. The sidecar peaks at 759 MB; Render's 512 MB tier cannot host it. | Provision, then follow `docs/PRODUCTION_DEPLOYMENT_RUNBOOK.md` §1–§6 | IT |
| **I2** | **Restore rehearsal never performed.** The backup procedure is written and scheduled by the runbook, but no dump has ever been restored. A backup that has never been restored is a hope. | Run `scripts/pg-backup-restore-rehearsal.sh` **on the production DB host** — runbook §9.4. It needs `pg_dump`/`pg_restore`, which do not exist on the development machines; that is precisely why this could not be closed during development. | IT |

**These two are the complete list of things that stop deployment.**

---

## 3. SECURITY / LEGAL SIGN-OFF ⛔

| # | Item | Action | Owner |
|---|---|---|---|
| **S1** | **HTTPS end to end.** The application sets HSTS and `upgrade-insecure-requests`; the certificate itself belongs to the platform. | Issue the certificate, confirm HTTP redirects to HTTPS, confirm the sidecar port is unreachable from outside — runbook §6, §7 | IT |
| **S2** | **Retention window not signed off.** Default 24 months, and erasure is irreversible. Enforcement stays off until someone owns the number. | Legal confirms `retention_months`, then enable with a dry run first — runbook §10 | Legal / HR |

---

## 4. UAT REQUIRED ⛔

14 scenarios in `docs/UAT_PLAN.md`, covering login and lockout, per-role permissions, hiring
request, approval, recruiter assignment, born-digital intake, scanned English, **scanned Arabic**,
unreadable file, review with accept/reject, duplicate, application → interview → feedback, offer,
and audit/reporting.

Four questions only the business can answer: Arabic OCR quality, field coverage, duplicate
strictness, and whether the approval chain matches the real delegation of authority.

---

## 5. RUNPOD MIGRATION — BUILT, DISABLED, NOT VERIFIED

Kept in the repository, switched off, and **not** part of this release.

- `DoclingTransport` + `DoclingServeClient` + `DOCLING_BACKEND=serve`. 40/40 adapter tests.
- Contract verified from the running image's `/openapi.json` (`docling-serve 1.12.0`,
  `docling 2.72.0`, `X-Api-Key` enforced). English OCR, two-page provenance and `images_scale`
  verified live before the endpoint became unavailable.
- **Arabic OCR failed** — no `ara` traineddata in the image. **Not verified:** the full
  11-fixture matrix, the live end-to-end, and Arabic on any RunPod image.

Before it may ever be enabled: `tesseract-ocr-ara` in the final image stage → matrix 11/11 →
end-to-end 48/48 with `DOCLING_BACKEND=serve` → a data-protection decision about sending CVs to a
third-party GPU host.

`DOCLING_BACKEND=sidecar` is the default in code and is fixed in `deploy/production.env.example`.

---

## 6. ACCEPTABLE PRODUCTION LIMITATIONS

1. **Mixed PDFs** — a healthy native text layer means embedded scanned images are not OCR'd.
2. **Evidence page numbers on the sidecar path always read "page 1."** Text is complete; only the
   label is wrong beyond page 1. The Serve transport fixes this if it is ever enabled.
3. **Throughput ~1 document / 5.8 s**; bulk uploads queue. Fine for recruiter-paced work.
4. **Arabic OCR accuracy is unmeasured** — recovery proven, quality is a UAT judgement (S2/UAT 8).
5. **RPO 24 hours, RTO ~30 minutes** — daily dumps. Improving RPO needs WAL archiving or managed
   PostgreSQL; a decision, not a defect.
6. **82 failing tests in the parallel TypeScript API layer** — permission-name drift in a stack
   production never starts (`npm start` → `node src/server.js`).

---

## 7. DEPENDENCY DECISION — `embedded-postgres`

**Test-only. Already correctly placed in `devDependencies`; no change required.**

- It is imported by exactly one file, `pg_tx_test.mjs`, and only when `PG_TEST_URL` is absent.
  No runtime path touches it.
- It stays rather than being removed: `pg_tx_test` refuses SQLite and PGlite by design — production
  is PostgreSQL, and a transaction-affinity suite that runs on anything else proves nothing.
  Without this package the gate reports SKIPPED, which it is careful to say is not a pass, and
  PostgreSQL went unverified across three readiness reports for exactly that reason.
- Cost: it downloads a PostgreSQL distribution on `npm ci --include=dev`, which adds CI time and
  disk. That is the price of a database gate that means something.
- **Production installs are unaffected** if you use `npm ci --omit=dev`. Note that the deployment
  runbook uses `npm ci --include=dev` because the TypeScript build needs `tsc`; a stricter
  two-stage build (`--include=dev` → `npm run build` → `npm prune --omit=dev`) would drop both
  `typescript` and `embedded-postgres` from the running image. That is an optimisation, not a
  requirement.

---

## 8. ROLLBACK

Configuration only. No database migration, no candidate-data migration, no RunPod dependency.

| Scenario | Action | Data loss |
|---|---|---|
| Bad release | check out the previous tag, `npm ci --include=dev && npm run build`, restart | none — the schema is additive |
| Sidecar misbehaving | `systemctl stop arabtec-docling` — the app falls back to the local parser; scans refused explicitly | none |
| Parsing suspect | unset `DOCLING_BASE_URL`, restart | none |
| Database corruption | restore from the daily dump | back to the last dump (RPO 24 h) |

---

## 9. RELEASE ARTEFACTS

| File | Purpose |
|---|---|
| `docs/PRODUCTION_DEPLOYMENT_RUNBOOK.md` | Ubuntu deployment, executable by an administrator with no project history |
| `deploy/production.env.example` | production configuration template; every value marked SUPPLY / FIXED / TUNE |
| `scripts/pg-backup-restore-rehearsal.sh` | dump → restore → compare → fail loudly on mismatch |
| `docs/UAT_PLAN.md` | 14 human-verification scenarios |
| `docs/PRODUCTION_RUNBOOK.md` | day-to-day operations |
| `docs/DOCLING_SERVE_API.md` | verified RunPod contract, for the deferred migration |

---

## 10. FINAL VERDICT

# APPLICATION-READY · NOT YET DEPLOYABLE

The software is finished. **No code blocker and no security blocker remains.**

Four external actions stand between this branch and production:

1. **I1 — provision the Linux host** (4 GB), then follow the deployment runbook.
2. **I2 — rehearse one restore** on the production database host. The only item that could cost
   data.
3. **S1 — confirm HTTPS** end to end and that the sidecar port is not externally reachable.
4. **S2 — legal signs off the retention window**, then enable enforcement after a dry run.

Then run UAT. None of the four is engineering work; all four are in the runbook with exact
commands.
