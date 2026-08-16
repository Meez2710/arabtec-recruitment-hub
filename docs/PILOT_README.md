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

---

## 2. Local startup

Three processes, in this order. All three run on the same machine.

### 2.1 Database

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

### 2.2 Docling sidecar

```bash
cd deploy/docling-sidecar
docker build -t arabtec-docling-sidecar .
docker run --rm -p 8089:8089 \
  -e DOCLING_BEARER_TOKEN="$DOCLING_BEARER_TOKEN" \
  arabtec-docling-sidecar
```

The sidecar listens on **8089** and exposes `POST /v1/health` and
`POST /v1/convert`.

### 2.3 ATS server

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

### 2.4 Local URL

```
http://localhost:4173
```

### 2.5 Pilot sign-in

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

## 3. Parsing configuration

`DOCLING_BASE_URL` pointing at the local sidecar is what selects sidecar mode.

> **Naming note.** Earlier planning documents referred to a `DOCLING_BACKEND=sidecar`
> switch. No such variable exists in the code. The backend is chosen by
> `DOCLING_BASE_URL` (set = sidecar, unset = the local pdfjs/mammoth parser).
> Setting `DOCLING_BACKEND` has no effect.

RunPod is **not** used by this pilot. Leave `OLLAMA_BASE_URL` unset unless a
private local Ollama is running; unset means deterministic rule-based
extraction only, which is a complete and valid configuration.

Never commit a real `.env`, `DOCLING_BEARER_TOKEN`, or `JWT_SECRET`.

---

## 4. Parsing limitations — read before UAT

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

## 5. Talent Pool → Hiring Request linking

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

## 6. Pilot limitations

- **Pilot only.** Demonstration and UAT. Not production.
- **Local infrastructure only.** Single machine, local database, local sidecar.
- **RunPod disabled.** No remote GPU inference is configured or required.
- **Production Linux server pending.** Not yet provisioned.
- **Backup and restore pending.** No backup schedule, no tested restore. Treat
  the pilot database as disposable.
- **HTTPS / deployment pending.** Runs over plain HTTP on localhost. No TLS, no
  reverse proxy, no domain, no production CORS origin.
- **UAT still required.** No formal UAT has been signed off against this build.
- **Scanned/image-only OCR still open** (section 4).
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

## 7. When the production server is available

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
