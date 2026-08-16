# Arabtec ATS — Final Production Readiness Report

**Branch:** `readiness/final-gate` · **Date:** 2026-08-16
**Deployable architecture:** Node/Express + PostgreSQL + **local Docling sidecar**.
The RunPod Docling Serve transport is implemented, tested against stubs, and **disabled**.

Nothing was pushed, merged or deployed. No real CV or PII was used at any point.

---

## 0. Reading this report

| Section | Question it answers |
|---|---|
| §1 Application-ready | Is the software itself finished and proven? |
| §2 Current deployable architecture | What would we actually ship today? |
| §3 RunPod migration pending | What is built but deliberately switched off? |
| §4 Infrastructure blockers | What needs a machine, an account or money? |
| §5 True production blockers | What actually stops go-live? |
| §6 Smallest remaining work | The shortest path to deploying |

Blocker types: **CODE** · **INFRASTRUCTURE** · **SECURITY** · **OPERATIONAL** · **FUTURE**.

---

## 1. APPLICATION-READY — verified

**1.1 PostgreSQL is now genuinely verified.** Previously ⊘ SKIPPED and reported as a blocker.
`embedded-postgres` was installed as a dev dependency and the full required gate ran against a
**real PostgreSQL engine**:

| Suite | Result |
|---|---|
| PostgreSQL transactions | **48/48** |
| application-number race | 13/13 |
| shared sequence | 22/22 |
| BL-04 reopen concurrency | 15/15 |
| reconciliation | 44/44 |
| headcount race | 31/31 |
| join race | 45/45 |
| **Total** | **218 assertions, 0 failures** |

**1.2 Whole-application coverage.** Full runner **34/34**. End-to-end **48/48** — hiring request
→ approval → assignment → intake → parsing → OCR → review → duplicate → candidate → application
→ interview → feedback → offer → audit, with the database inspected at every step and a
whole-database integrity sweep (no orphans, no duplicates, no empty candidates, no
half-converted intakes, seat accounting correct).

**1.3 Retention is now enforced, not just reported.** `src/lib/retention.js` erases candidates
whose window has lapsed, on a schedule. **Off by default** — erasure is irreversible and nobody
should discover it running because they deployed. `RETENTION_DRY_RUN=true` reports what it would
erase and touches nothing. Erasure clears personal fields and CV binaries but keeps the row as
`candidate_state='erased'`, so audit trail, counts and foreign keys survive. 8/8 tests, and the
negative assertions are the point: off unless opted in, dry run touches nothing, in-window
candidates untouched, no personal data in the sweep log.

**1.4 Security.** Verified this pass:

- `JWT_SECRET` required in production, boot **fails** without it; sessions revocable; password
  change revokes every other session; cookie `httpOnly`/`sameSite=lax`/`secure` in prod.
- 12-char password policy, all four character classes, deny-list, no name/email reuse; forced
  first-login rotation covering every route by default; lockout after 5 attempts.
- HSTS + `upgrade-insecure-requests` + frameguard + `noSniff` in production; `TRUST_PROXY=1` so
  `req.ip` cannot be spoofed; CORS denies cross-origin in production unless allowlisted; JSON
  body capped at 1 MB.
- Uploads: 20 MB cap, extension allowlist (`.pdf .doc .docx .png .jpg .jpeg .txt`), stored under
  a generated UUID name — **the caller's filename never touches disk**, so no traversal and no
  leak into logs.
- Error handler returns a generic message plus a request id; no stack, no internals.
- Structured JSON request logs carry status, duration, requestId, userId — **no CV text, no
  secrets**.
- No secrets committed: `git ls-files` clean, 15 `sync:false` placeholders in `render.yaml`,
  `.env.*` git-ignored, key files `-rw-------`.
- Audit integrity: append-only writer, every row names an actor, and the E2E asserts an entry for
  every stage including `application.created` from the CV-review path.
- **A failed conversion never creates a candidate** — the parser abstains, no intake is raised,
  and the E2E asserts it.

**1.5 Fixed this pass.**

| | Type |
|---|---|
| `assertLocalHost` restored — was a commented-out no-op, so any `OLLAMA_BASE_URL` silently sent CV text off-machine. Now enforces local/private with an explicit `OLLAMA_ALLOW_REMOTE=true` opt-in. | SECURITY |
| Process-global `NODE_TLS_REJECT_UNAUTHORIZED='0'` removed from `cv/ai-parser.js` and `reasoner.js` — while set, **every** outbound TLS connection skipped certificate verification. | SECURITY |
| Upload rejection said "max 15MB" while the cap was 20 MB. Now derived from the constant. | CODE |
| `/api/health/parsing` added — reports which parser is wired and the retention mode. Nothing surfaced Docling health before. | OPERATIONAL |
| Retention enforcement (§1.3). | OPERATIONAL |
| `screeningCounts`, `application.created` audit, sidecar `pageCount` — fixed earlier in this branch. | CODE |

---

## 2. CURRENT DEPLOYABLE ARCHITECTURE

```
Browser ─ HTTPS ─ Express (Node)  ──  PostgreSQL
                      │
                      └── Docling sidecar on 127.0.0.1:8089  (Tesseract eng + ara)
```

- `DOCLING_BACKEND=sidecar` — the default, and the only backend that has passed a live matrix.
- **Arabic OCR works on this path** (107 glyphs recovered from the genuine Arabic fixture).
- Document classes verified live: born-digital PDF, DOCX, scanned English PDF, PNG, scanned
  Arabic, two-page scan, mixed Arabic/English, prompt-injection CV.
- Fallback: if the sidecar is unreachable the local pdfjs/mammoth parser takes over — born-digital
  keeps working, scans abstain **explicitly** rather than silently returning nothing.
- Measured: ~1 document / 5.8 s, 759 MB peak under 6-way load. Concurrency beyond ~20
  simultaneous uploads trips the 120 s client timeout.

---

## 3. RUNPOD MIGRATION — PENDING, DISABLED

Built and unit-tested; **not enabled and not verified end to end.**

- `DoclingTransport` interface; `DoclingServeClient`; parser takes an injected transport;
  `DOCLING_BACKEND=serve` selects it. 40/40 adapter tests (the 20 pre-existing ones untouched).
- Contract verified from the running image's own `/openapi.json` while it was up
  (`docling-serve 1.12.0`, `docling 2.72.0`, `X-Api-Key` enforced).
- English OCR, two-page provenance and `images_scale` were verified live before the endpoint went
  away. **Arabic OCR failed** — no `ara` traineddata in the image.
- Currently unreachable: `/health`, `/version` and `/openapi.json` all 404. RunPod credits
  exhausted.

**Not verified, and not claimed:** the full 11-fixture matrix, the live end-to-end on the Serve
backend, and Arabic on any RunPod image.

Before it may be enabled: `tesseract-ocr-ara` in the final image stage → matrix 11/11 →
E2E 48/48 with `DOCLING_BACKEND=serve` → a data-protection decision about sending CVs to a
third-party GPU host.

---

## 4. INFRASTRUCTURE BLOCKERS

| # | Item | Type | Smallest action |
|---|---|---|---|
| I1 | **Backup not scheduled; restore never rehearsed.** The procedure exists; nothing runs it. | OPERATIONAL | Schedule the daily `pg_dump -Fc`, then run `./scripts/pg-backup-restore-rehearsal.sh` on the DB host — it dumps, restores to a throwaway DB, compares row counts and constraints, and fails loudly. **Cannot run here: `embedded-postgres` ships only the server, no `pg_dump`/`pg_restore` client binaries.** |
| I2 | **Docling sidecar host.** Needs ~2 GB and stays on loopback. Render's 512 MB tier cannot host it. | INFRASTRUCTURE | Provision the 4 GB Linux host, or keep it beside the app on a VPS |
| I3 | **TLS terminates at the platform.** HSTS and `upgrade-insecure-requests` are set; the certificate itself is the platform's. | INFRASTRUCTURE | Confirm the certificate and that HTTP redirects to HTTPS |
| I4 | **Retention window not signed off.** Default 24 months. | OPERATIONAL | Legal confirms, then `RETENTION_ENFORCEMENT=true` (dry run first) |
| I5 | **RunPod endpoint down / credits exhausted.** | INFRASTRUCTURE | Only blocks §3; does not block deployment |

---

## 5. TRUE PRODUCTION BLOCKERS

Things that genuinely stop go-live on the sidecar architecture:

1. **I1 — no rehearsed restore.** The only item here that could cost data. A backup nobody has
   restored is not a backup. **OPERATIONAL.**
2. **I2 — the Docling host.** Without it there is no OCR; scanned CVs are refused (honestly, but
   refused). **INFRASTRUCTURE.**

**That is the complete list. No CODE blocker and no SECURITY blocker remains.**

Everything else — I3, I4, I5, and §7 below — is either a confirmation step or does not block.

---

## 6. ACCEPTABLE PRODUCTION LIMITATIONS

1. **Mixed PDFs** — a healthy native text layer means embedded scanned images are not OCR'd.
2. **Evidence page numbers on the sidecar path always read "page 1."** Text is complete; the page
   label is wrong beyond page 1. The Serve transport fixes this when it is enabled.
3. **Throughput** ~1 document / 5.8 s; bulk uploads queue. Fine for recruiter-paced work.
4. **Arabic OCR accuracy is unmeasured** — recovery is proven, quality is a UAT judgement.
5. **82 failing tests in the parallel TypeScript API layer** — permission-name drift in a stack
   `render.yaml` never starts (`npm start` → `node src/server.js`). Non-shipping.
6. **`embedded-postgres` is now a dev dependency** — it downloads a PostgreSQL distribution on
   install. Acceptable for a real DB gate; note it for CI time.

---

## 7. FUTURE ENHANCEMENTS

Resolve or delete the parallel TS API layer · mixed-document OCR · delete the legacy parser chain
(defused, still present) · async Docling Serve endpoints · backfill page attribution on the
sidecar path · a graded Arabic/English OCR accuracy corpus.

---

## 8. TEST RESULTS

| Suite | Result |
|---|---|
| Full ATS runner (`npm test`) | **34 suites, 34 passed, 0 failed** |
| Full ATS E2E (sidecar, incl. real OCR) | **48/48** |
| **PostgreSQL required gate (real engine)** | **218 assertions, 0 failed** |
| Retention enforcement (new) | **8/8** |
| Docling adapter — sidecar (pre-existing) | 20/20 untouched |
| Docling adapter — Serve transport | 20/20 |
| Intake · Proposal · Parser seam · HTTP route | 35/35 · 16/16 · 13/13 · 9/9 |
| Document smoke · Ollama | 23/23 · 25/25 |
| Typecheck · Build | PASS · PASS |
| Vitest domain | 740 passed, 82 failed (non-shipping TS API), 9 skipped |
| RunPod live matrix / live E2E | **NOT RUN — endpoint unavailable** |

---

## 9. ROLLBACK

Configuration only. No database migration, no candidate-data migration, no RunPod dependency.

1. `DOCLING_BACKEND=sidecar` (default) — the Serve transport is never reached.
2. Unset `DOCLING_BASE_URL` — local parser; scans abstain explicitly.
3. Application: redeploy the previous commit. The schema is additive (`addColumnIfMissing`), so
   an older build runs against a newer database.
4. Database: restore the most recent dump — last resort, the only lossy step.

---

## 10. DEPLOYMENT CHECKLIST

- [ ] `DATABASE_URL` (PostgreSQL) and `JWT_SECRET` (32+ chars) set
- [ ] `SEED_DEMO_DATA=false`; bootstrap admin password rotated at first login
- [ ] `TRUST_PROXY=1`; `CORS_ORIGINS` set; HTTPS confirmed end to end (I3)
- [ ] Docling sidecar running on loopback; `DOCLING_BACKEND=sidecar`
- [ ] `SIDECAR_OCR_LANGS=eng,ara`, `SIDECAR_OCR_SCALE=4.0`
- [ ] `/api/health`, `/api/health/db`, `/api/health/parsing` all green; alert on the last two
- [ ] `UPLOAD_DIR` on persistent storage
- [ ] Daily `pg_dump` scheduled **and one restore rehearsed** (I1)
- [ ] Retention window signed off; dry run reviewed before `RETENTION_ENFORCEMENT=true` (I4)
- [ ] `OLLAMA_ALLOW_REMOTE` unset
- [ ] `DOCLING_BACKEND=serve` **not** set
- [ ] UAT scenarios 1–14 signed off (`docs/UAT_PLAN.md`)

---

## 11. FINAL VERDICT

# APPLICATION-READY · NOT YET DEPLOYABLE

The software is finished and proven: 34/34 suites, 48/48 end-to-end, **218 PostgreSQL assertions
against a real engine**, two real security defects fixed, retention enforced, monitoring exposed.
**No code blocker and no security blocker remains.**

Two operational things stand between this and production, and neither is engineering work:

1. **Rehearse a restore** (I1) — the script is written; it needs a host with the PostgreSQL
   client binaries. Half a day, mostly waiting.
2. **Provision the Docling host** (I2) — 4 GB Linux, sidecar on loopback.

Then confirm HTTPS (I3), get the retention window signed off (I4), and run UAT.

**RunPod remains pending and disabled**, and nothing above depends on it.
