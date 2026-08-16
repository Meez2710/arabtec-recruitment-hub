# Arabtec ATS — Pilot v1

**This is a pilot build for stakeholder demonstration and UAT. It is not production.**

It runs entirely on local infrastructure so evaluation can start while the
production server is still being provisioned. Nothing here is hardened for
internet exposure, and no production data should be loaded into it.

---

## 1. What this pilot contains

- The production-readiness baseline (auth, RBAC, audit, requests, candidates,
  applications, interviews, offers, dashboards).
- The audited Arabtec UI: black sidebar, green primary actions, Arabtec red
  reserved for structure and destructive/critical states.
- The real pre-candidate **Candidate Intake Review** workflow — a CV upload
  creates a PENDING intake and never a candidate; a candidate and its
  application are created only after a complete human review.
- The Request Detail **Edit** correction (edit issues `PUT /requests/:id`
  instead of creating a duplicate request).
- The candidates route-precedence fix that made `GET /candidates/intakes`
  reachable.
- The document pipeline with the **local Docling sidecar** and the existing
  Arabic/English OCR path.
- **Talent Pool → Hiring Request linking** (new in this build).

### 1.1 How the pilot differs from the full system

**The pilot is not a cut-down product.** It is the same application, the same
recruitment logic, the same permissions and the same audit trail as the full
system — running in a smaller, disposable environment. What the pilot lacks is
**infrastructure and one document-processing component**, not features.

Identical in both: every screen and workflow, the requisition → approval →
intake → review → candidate → application → interview → offer chain, the
role-based permissions, the duplicate rules, the evidence-gated CV review, and
the audit history.

Different, and all of it environmental:

| | Pilot | Full system |
| --- | --- | --- |
| Purpose | Demonstration and UAT | Live hiring |
| Hosting | One local machine (or a free tier) | Provisioned Linux server |
| Database | Local SQLite or a disposable PostgreSQL | Managed PostgreSQL |
| Data | Synthetic only | Real candidate records |
| Transport | Plain HTTP on localhost | HTTPS, real domain, reverse proxy |
| Scanned / image-only CVs | **Not supported** — no Docling sidecar, so the local pdfjs/mammoth parser is used | Supported via the Docling sidecar and Arabic/English OCR |
| AI extraction | Deterministic rules only | Optionally a private local model |
| Email | Off — nothing is ever sent | SMTP configured |
| Error tracking | Off | Sentry |
| Backup / restore | None; treat the database as disposable | Scheduled, with a tested restore |
| Accounts | Demo users, one shared password | Real accounts; no demo users seeded |
| Database concurrency gates | Not run (need `PG_TEST_URL`) | Required before release |
| Performance | Single process, tiny dataset | Sized instance |

The practical consequence for anyone evaluating the pilot: **judge the workflow,
the recruitment logic and the usability — those are real and final.** Do not
judge speed, and do not conclude that scanned-CV parsing is broken; it is simply
not deployed here (§5). The steps to close each gap are in §8.

---

## 2. Required environment variables

Set these before starting. **Never commit real values and never echo them to a
shared terminal or log.**

### 2.1 ATS server (`backend/`)

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | **yes** | `file:./pilot.db` (SQLite) or `postgres://…` |
| `JWT_SECRET` | **yes** | Session signing. 32+ random chars: `openssl rand -hex 32` |
| `PORT` | yes for this pilot | `4173` — the documented pilot port |
| `SEED_DEMO_DATA` | seeding only | `true` to create the demo users in §3.5 |
| `SEED_ADMIN_PASSWORD` | seeding only | Bootstrap admin password; rotated at first sign-in |
| `DOCLING_BASE_URL` | no | **Set = sidecar mode.** Unset = local pdfjs/mammoth parser |
| `DOCLING_BEARER_TOKEN` | only if the sidecar sets one | Must be **identical** to the sidecar's value |
| `DOCLING_TIMEOUT_MS` | no | Defaults to 120000 |
| `DOCLING_PIPELINE_VERSION` | no | Recorded in extraction provenance |
| `OCR_BASE_URL` | no | Separate HTTP OCR service. Unset = pages needing OCR are marked degraded, never silently empty |
| `OCR_ENGINE`, `OCR_PATH`, `OCR_TIMEOUT_MS` | no | Only meaningful with `OCR_BASE_URL` |
| `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | no | Unset = deterministic rules only, a complete and valid configuration |
| `PG_NO_SSL` | PostgreSQL on localhost | `true` for a same-box PostgreSQL |

### 2.2 Docling sidecar (`deploy/docling-sidecar/`)

| Variable | Required | Purpose |
| --- | --- | --- |
| `DOCLING_BEARER_TOKEN` | see below | Unset = **open service, loopback only**. Set = `Authorization: Bearer` enforced with a constant-time compare |
| `SIDECAR_OCR_LANGS` | no | Defaults to `eng,ara` — the Arabic/English OCR path |
| `SIDECAR_OCR_ENGINE` | no | Defaults to `tesseract` |
| `SIDECAR_OCR_SCALE` | no | OCR rasterisation scale |
| `SIDECAR_MAX_BYTES` | no | Upload ceiling, default 25 MB |
| `SIDECAR_TIMEOUT_S` | no | Conversion timeout, default 120 s |
| `SIDECAR_MIN_NATIVE_CHARS` | no | Below this a page is treated as needing OCR |
| `SIDECAR_PIPELINE_VERSION` | no | Reported back as provenance |
| `DOCLING_ARTIFACTS_PATH` | no | Pre-downloaded model artifacts |

**On the token.** It is optional *only* because this pilot binds the sidecar to
loopback. Leaving it unset makes the sidecar an unauthenticated service, so the
moment it is reachable through a tunnel, a container network or any non-loopback
interface, `DOCLING_BEARER_TOKEN` **must** be set — to the *same* value on both
processes, or every conversion returns 401.

---

## 3. Local startup

Three processes, in this order. All three run on the same machine.

### 3.1 Database

The pilot runs on either engine. **PostgreSQL** is closer to production:

```bash
createdb arabtec_pilot
export DATABASE_URL="postgres://localhost:5432/arabtec_pilot"
export PG_NO_SSL=true
```

**SQLite** needs no server and is the fastest way to demo:

```bash
export DATABASE_URL="file:./pilot.db"
```

Seed once (creates roles, permissions, demo org data and demo users):

```bash
cd backend && SEED_DEMO_DATA=true SEED_ADMIN_PASSWORD='Admin@12345' npm run seed
```

### 3.2 Docling sidecar

**Prerequisites — check these first, the sidecar cannot start without one:**

- a container runtime (Docker, Podman or Colima), **or**
- Python **3.10+** to run it natively. `requirements.txt` pins
  `torch==2.9.1+cpu`, which publishes no wheels for Python 3.9 or older.

```bash
cd deploy/docling-sidecar
docker build -t arabtec-docling-sidecar .
docker run --rm -p 8089:8089 \
  -e DOCLING_BEARER_TOKEN="$DOCLING_BEARER_TOKEN" \
  arabtec-docling-sidecar
```

The sidecar listens on **8089** and exposes `POST /v1/health` and
`POST /v1/convert`. Both are POST — a `GET /v1/health` returns 405 and is not
a sign the service is down.

Set `DOCLING_BEARER_TOKEN` here **and** on the ATS server, to the same value,
or leave it unset on both. A mismatch fails every conversion with 401.

**If no runtime is available**, leave `DOCLING_BASE_URL` unset on the ATS
server. The pilot still runs on the local pdfjs/mammoth parser: born-digital
PDF, DOCX and plain text still parse, and scanned/image-only input — already
listed as open in §5 — remains unavailable. Report the missing runtime rather
than substituting another parser.

### 3.3 ATS server

```bash
cd backend
npm ci
npm run build                # compiles the TypeScript domain into dist/
export DOCLING_BASE_URL="http://localhost:8089"
export DOCLING_TIMEOUT_MS=120000
export JWT_SECRET="$(openssl rand -hex 32)"
export PORT=4173
npm run start:sqlite         # or `npm start` when DATABASE_URL is PostgreSQL
```

`npm run build` is **required**: the proposal aggregate is TypeScript and is
loaded from `dist/` at runtime. A missing build is a deployment defect, not a
reason to bypass review.

### 3.4 Local URL

```
http://localhost:4173
```

### 3.5 Pilot sign-in

Demo users are created only when `SEED_DEMO_DATA=true`:

| Role | Email | Password |
| --- | --- | --- |
| HR Manager | `hr.manager@arabtec.com` | `Arabtec@123` |
| HR Director | `hr.director@arabtec.com` | `Arabtec@123` |
| Recruitment Manager | `rec.manager@arabtec.com` | `Arabtec@123` |
| Recruiter | `recruiter@arabtec.com` | `Arabtec@123` |
| Hiring Manager | `hiring.manager@arabtec.com` | `Arabtec@123` |
| Viewer | `viewer@arabtec.com` | `Arabtec@123` |

The bootstrap administrator (`admin@arabtec.com`) is created with
`SEED_ADMIN_PASSWORD` and is flagged `must_change_password`. **Every**
authenticated route answers `403 PASSWORD_CHANGE_REQUIRED` until that password
is rotated at first sign-in. This is deliberate; do not disable it.

These are demonstration credentials for a local pilot database. They must never
be seeded on an internet-reachable host.

---

## 4. Parsing configuration

There is **no backend-selector flag**. `composeAI()` in
`backend/src/api/composition-root.ts` branches on one variable:

```
DOCLING_BASE_URL set    → DoclingDocumentParser (the sidecar)
DOCLING_BASE_URL unset  → LocalDocumentParser  (pdfjs/mammoth)
```

`DOCLING_BEARER_TOKEN`, `DOCLING_TIMEOUT_MS` and `DOCLING_PIPELINE_VERSION` are
read only when a base URL is present. Full list in §2.

> **Naming correction.** Earlier planning documents referred to a
> `DOCLING_BACKEND=sidecar` switch. **No such variable exists anywhere in this
> codebase** — nothing reads it, and setting it has no effect whatsoever. Use
> `DOCLING_BASE_URL` as above. Any document still saying `DOCLING_BACKEND`
> is wrong and should be corrected at the source.

RunPod is **not** used by this pilot. Leave `OLLAMA_BASE_URL` unset unless a
private local Ollama is running; unset means deterministic rule-based
extraction only, which is a complete and valid configuration.

Never commit a real `.env`, `DOCLING_BEARER_TOKEN`, or `JWT_SECRET`.

---

## 5. Parsing limitations — read before UAT

Do not present the parser as complete. Current honest status:

| Input | Status |
| --- | --- |
| Born-digital PDF | Working |
| DOCX | Working |
| Mixed Arabic/English with a native text layer | Working |
| Image-only / scanned PDF | **Open** |
| Image-only Arabic | **Open** |
| PNG / JPEG OCR | **Open** |

When a document yields no evidence-supported field, the upload raises **no
intake and no empty proposal**. Candidate Review reports it as
*"No reviewable field could be read from this document"* and names the
scanned/image-only case. That is the designed behaviour, not a failure to fix
by loosening the evidence gate.

---

## 6. Talent Pool → Hiring Request linking

A link **is an application**. The Talent Pool "Request" column calls the
existing `POST /applications` with `{ candidateId, requestId }` under the
existing `candidate.link` permission. No new relationship, table, or model was
introduced.

Behaviour inherited from the backend, not reimplemented in the UI:

- Requests that are `closed`, `cancelled`, `rejected` or `filled` are refused
  and are therefore not offered in the dropdown.
- One application per candidate per request. An already-linked candidate shows
  the request as a link to its detail page and is offered no second link.
- Without `candidate.link` the control is not rendered at all.
- A failed link shows the backend's own message and leaves the row unchanged.

**Suggestions** are a local heuristic over data the API already returned: token
overlap between the candidate's current position and the request title, with
location as a tie-breaker. When nothing scores, the plain available list is
shown. There is no recommendation service, no embeddings, no model call.

---

## 7. Pilot limitations

- **Pilot only.** Demonstration and UAT. Not production.
- **Local infrastructure only.** Single machine, local database, local sidecar.
- **RunPod disabled.** No remote GPU inference is configured or required.
- **Production Linux server pending.** Not yet provisioned.
- **Backup and restore pending.** No backup schedule, no tested restore. Treat
  the pilot database as disposable.
- **HTTPS / deployment pending.** Runs over plain HTTP on localhost. No TLS, no
  reverse proxy, no domain, no production CORS origin.
- **UAT still required.** No formal UAT has been signed off against this build.
- **Scanned/image-only OCR still open** (section 5).
- **Docling sidecar pins are unverified.** `deploy/docling-sidecar/requirements.txt`
  carries intended, not resolved, versions. Regenerate with `pip freeze` after
  the first successful build before relying on reproducible extraction.
- **PostgreSQL concurrency gates are not run here.** They need `PG_TEST_URL`
  (`npm run test:pg:required`) and are a production gate, not a pilot one.

### Deferred

Nothing from the Request Linking scope was deferred — the existing backend
supported it through `POST /applications`, so it was implemented rather than
postponed. The only additive backend change was a compact `links` summary on
the candidate list payload so the Talent Pool can show *which* request a
candidate is on without opening each profile.

---

## 8. When the production server is available

1. Provision the Linux host, PostgreSQL instance and TLS certificate.
2. Set real secrets outside git: `JWT_SECRET`, `DATABASE_URL`,
   `DOCLING_BEARER_TOKEN`. Rotate anything ever used locally.
3. Set `NODE_ENV=production`, `TRUST_PROXY=1` and the real `CORS_ORIGINS`.
4. Seed **without** `SEED_DEMO_DATA`, then rotate the bootstrap admin password
   immediately.
5. Run the PostgreSQL gates: `npm run test:pg:required`.
6. Rebuild the sidecar from resolved, pinned requirements.
7. Establish backup and a **tested** restore before any real candidate data.
8. Close the scanned/image-only OCR gap, or state the limitation in UAT scope.
9. Run formal UAT against the production host.
