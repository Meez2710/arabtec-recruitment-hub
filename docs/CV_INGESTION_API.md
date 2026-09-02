# Inbound CV Ingestion API

`POST /api/ingest/cv` — the entry point an external mailbox connector uses to
submit one CV attachment to the ATS.

Implemented in the **legacy JS backend** (`backend/src/routes/ingest.js`), which
is what production runs. It reuses the existing upload storage, the existing CV
parsing pipeline and the existing `candidate_intake` review queue. It is not a
parallel pipeline and it creates no candidates.

---

## Why this exists

The Microsoft 365 orchestrator scans `career@arabtecegy.com` daily and forwards
CV attachments. It retries on timeout, re-runs after a crash, and its scan
windows overlap at the edges — so the **same attachment arrives more than once**.
Without a durable identity for "this attachment", each retry would re-parse the
CV and stage a second review item, and a reviewer would approve the same person
twice.

That is the whole design constraint. Everything below follows from it.

---

## Authentication

Bearer token, same as every other ATS route. The caller needs the
**`candidate.add`** permission — the same permission a recruiter needs to upload
a CV by hand. No new role, no service-account bypass.

```
Authorization: Bearer <token>
```

## Request

`multipart/form-data`. The file part must be named **`file`**.

| Field | Required | Notes |
|---|---|---|
| `file` | ✅ | The CV. **PDF, DOC or DOCX only.** Max 20 MB. |
| `source` | ✅ | Must be `microsoft_365`. |
| `messageId` | ✅ | Mailbox message id. Half the idempotency key. |
| `attachmentId` | ✅ | Attachment id within that message. The other half. |
| `filename` | ✅ | Original attachment filename. |
| `senderEmail` | — | Candidate's address. |
| `senderName` | — | Candidate's display name, when the mailbox reported one. |
| `subject` | — | Email subject. |
| `receivedAt` | — | ISO-8601. A malformed value is **rejected**, not silently stored. |

A `contentHash` or `fileHash` field, if sent, is **ignored**. The server hashes
the bytes it actually received. A hash the server did not compute is a claim,
not a checksum, and this value decides what counts as the same document.

## Responses

Branch on **`code`**, never on the prose. The codes are the contract; the
sentences are not.

| HTTP | `code` | Meaning |
|---|---|---|
| 201 | `accepted` | Ingested and staged as a PENDING intake. `intakeId` is set. |
| 201 | `no-fields` | Ingested; the document produced nothing reviewable. Still a success — the receipt is durable and re-sending reads to the same nothing. |
| 200 | `duplicate` | This `(source, messageId, attachmentId)` was already ingested. `duplicateOf` names the original receipt. **No candidate was created.** |
| 400 | `provenance-missing` | A required field is absent. `missing` lists which. |
| 400 | `unsupported-file-type` | Not a PDF/DOC/DOCX. Nothing is stored. |
| 400 | `source-unknown` | `source` is not a recognised connector. |
| 400 | `received-at-invalid` | `receivedAt` is not ISO-8601. |
| 400 | `file-missing` | No file part in the request. |
| 401 / 403 | — | Not authenticated / lacks `candidate.add`. |
| 413 | — | Over the 20 MB cap. |
| 502 | `parse-failed` | Parsing failed downstream. Receipt saved as `FAILED`, `retryable: true`. |
| 500 | `storage-failure` / `storage-unavailable` | The file or its receipt could not be written. |

Every non-rejection response is a **receipt**:

```json
{
  "ingestionId": 42,
  "status": "PARSED",
  "source": "microsoft_365",
  "messageId": "<message-id>",
  "attachmentId": "<attachment-id>",
  "filename": "Ahmed_Mohamed_CV.pdf",
  "contentHash": "<sha256 hex>",
  "intakeId": 17,
  "receivedAt": "2026-09-01T07:42:00.000Z",
  "code": "accepted",
  "intakeStatus": "PENDING",
  "fieldCount": 9,
  "priorHashMatches": [],
  "message": "Ingested and staged for review. No candidate was created."
}
```

**The response never carries document text** — no parsed values, no preview, no
raw text. A connector needs to know what happened to the file, not what the file
said. This is the main reason ingestion is a separate route from
`POST /api/candidates/parse-cv`, which deliberately *does* return all of that to
a human at a browser.

## `GET /api/ingest/cv/:id`

Returns one receipt. Lets the orchestrator reconcile a request whose response it
never saw — a timeout that actually succeeded — **without re-POSTing the file**.

---

## Idempotency

The key is **`(source, messageId, attachmentId)`**, enforced by a unique index
(`ux_cv_ingestion_identity`) on the `cv_ingestion` table.

The identity is claimed **before the CV is parsed**, so a retry costs one
rejected `INSERT` rather than a second model call and a second review item.

Uniqueness is the **database's** job, not the application's. There is no
check-then-insert anywhere in this path: that pattern is not atomic, so two
concurrent submissions of one attachment would both pass the check and both
write. Under the index, both reach the `INSERT` and exactly one wins.

**The content hash is not the key.** It is recorded and indexed, but
deliberately *not* unique: one applicant legitimately mails the same PDF for two
different vacancies, and collapsing those would silently lose the second
application. Prior hash matches are reported in `priorHashMatches` as an
advisory signal for a reviewer — they never reject an ingestion.

### Retry semantics

| Receipt status | Re-POSTing the same attachment |
|---|---|
| `PARSED` | `200 duplicate`. An intake is already waiting for review. |
| `NO_FIELDS` | `200 duplicate`. It would read to the same nothing. |
| `FAILED` | **Reprocessed in place**, reusing the same row. Never a second receipt. |
| `RECEIVED` | `200 duplicate`. Another request holds the claim. |

---

## What this route will not do

- It **never creates or updates a candidate.** It stages a `candidate_intake`
  exactly as the manual upload path does. A person approving that intake is
  still the only thing in this system that creates a candidate, and there is no
  flag to change that.
- It never widens the accepted file types. An inbox is full of signatures,
  logos, scanned certificates and spreadsheets; each one that reached the parser
  would cost a model call and produce a junk review item.
- It never logs or returns CV contents. Operational logs carry identifiers and
  counts only.

---

## Scan state

The orchestrator's watermark lives in the ATS, not in the connector — a
connector is stateless between runs, and a watermark held only in its memory is
lost on every restart.

- `GET /api/ingest/scan-state?source=microsoft_365`
  → `{ source, lastSuccessfulScanAt, isFirstRun }`
- `PUT /api/ingest/scan-state`
  body `{ source, lastSuccessfulScanAt, force? }`

**First-run floor: `2026-09-01T00:00:00.000Z`.** There is no earlier watermark to
resume from, and the mailbox holds ~11k historical messages that were never
meant to be ingested. Starting at the beginning of the first operating day
bounds the first run to that day's applications instead of the entire history.

The watermark **moves forward only**. A backwards write is refused with `409
scan-state-regression`, because the ways it happens in practice — clock skew, a
partially failed run reporting its start time, a replayed request — all silently
widen the next window or look like success. Deliberate reprocessing is available
with `force: true`, and is safe precisely because ingestion is idempotent.

Per the operating spec, the orchestrator must **not** advance the watermark past
emails it could not process because of a system or API failure.

---

## Configuration

**No new environment variables.** The route reuses existing config:

| Variable | Effect on this route |
|---|---|
| `DATABASE_URL` | Where `cv_ingestion` lives. Postgres in production. |
| `UPLOAD_DIR` | Best-effort disk cache. The `file_blob` table is the source of truth, so an ephemeral disk is fine. |
| `ANTHROPIC_API_KEY` | **Not required to ingest.** Without it the CV reader is unwired: files are still stored, provenance is still recorded, and receipts settle as `NO_FIELDS` with a reason. Set it to get real parses and PENDING intakes. |

The `cv_ingestion` table and its indexes are created by `ensureSchema()` on
boot, which is how every other table in this backend is migrated. No separate
migration step to run.

---

## Tests

`backend/ingest_cv_test.mjs`, registered in `run_tests.mjs` (`npm test`).

33 checks covering valid PDF and DOCX, unsupported types, each missing
provenance field, unknown source, malformed `receivedAt`, first submission,
exact retry, concurrent submission (exactly one winner), server-side SHA-256,
client-hash rejection, persistence failure, the FAILED/retry lifecycle,
provenance round-trip, no-document-text-in-response, scan-state monotonicity,
and — asserted throughout — that **no candidate is ever created by this route**.

Most of the suite is reader-independent and runs green in CI with no
`ANTHROPIC_API_KEY`. The one check that genuinely needs a live parse skips
loudly; skipping is not a pass.
