# Outlook CV Ingestion API

`POST /api/ingest/cv` — the single controlled entry point for Outlook CV
ingestion.

Implemented in the **legacy JS backend** (`backend/src/routes/ingest.js`), which
is what production runs. It reuses the existing multipart upload middleware, the
existing durable blob store, the existing CV parsing pipeline and the existing
`candidate_intake` review queue. It is not a parallel pipeline and it creates no
candidates.

The undeployed TypeScript API is untouched by this work.

---

## Why it is shaped this way

The Outlook/Graph scanner retries on timeout, re-runs after a crash, and its
scan windows overlap at the edges — so the **same attachment arrives more than
once**. Without a durable identity for "this attachment", each retry would
re-parse the CV and stage a second review item, and a reviewer would approve the
same person twice. Every design decision below follows from that.

---

## Contract

### Authentication

Bearer token, the existing ATS mechanism. The caller needs **`candidate.add`** —
the same permission a recruiter needs to upload a CV by hand. No new auth
mechanism, no service-account bypass.

### Request

`multipart/form-data`. The file part must be named **`file`**.

| Field | Required | Notes |
|---|---|---|
| `file` | ✅ | The CV. **PDF, DOC or DOCX only.** 64 bytes – 20 MB. |
| `messageId` | ✅ | Graph message id. Half the idempotency key. |
| `attachmentId` | ✅ | Attachment id within that message. The other half. |
| `source` | ✅ | `outlook` (or `microsoft_365` — synonyms, see below). |
| `filename` | ✅ | Original attachment filename. |
| `senderEmail` | ✅ | Validated against the project's existing email convention. |
| `receivedAt` | ✅ | Must be parseable; stored normalised to ISO-8601 UTC. |
| `subject` | — | Email subject. |
| `senderName` | — | Sender display name when Graph reported one. |

**The client cannot supply a file hash.** A `contentHash`, `fileHash` or
`sha256` field is ignored if sent. The server hashes the bytes it actually
received — a hash the server did not compute is a claim, not a checksum, and
this value decides what counts as the same document.

### Request example

```bash
curl -X POST https://<host>/api/ingest/cv \
  -H "Authorization: Bearer $ATS_TOKEN" \
  -F "file=@Ahmed_Mohamed_CV.pdf;type=application/pdf" \
  -F "messageId=AAMkAGE4MmY2Y2UxLTFjMTgt..." \
  -F "attachmentId=AAMkAGE4MmY2Y2UxLTFjMTgt...BEgAQALYxElaAm31C" \
  -F "source=outlook" \
  -F "filename=Ahmed_Mohamed_CV.pdf" \
  -F "senderEmail=ahmed.mohamed@example.com" \
  -F "senderName=Ahmed Mohamed" \
  -F "subject=Application for Civil Engineer" \
  -F "receivedAt=2026-09-01T07:42:00Z"
```

### Response codes

Branch on **`code`**, never on the prose. The codes are the contract; the
sentences are not.

| HTTP | `code` | Meaning |
|---|---|---|
| 201 | `accepted` | New attachment. Ingested and queued for parsing. |
| 200 | `duplicate` | Already ingested. Nothing re-parsed, nothing created. |
| 400 | `provenance-missing` | A required field is absent; `missing` lists which. |
| 400 | `unsupported-file-type` | Not PDF/DOC/DOCX. Nothing stored. |
| 400 | `sender-email-invalid` | `senderEmail` is malformed. |
| 400 | `received-at-invalid` | `receivedAt` is not parseable. |
| 400 | `source-unknown` | Unrecognised source label. |
| 400 | `file-missing` / `file-too-small` | No file part / under 64 bytes. |
| 401 / 403 | — | Not authenticated / lacks `candidate.add`. |
| 413 | `file-too-large` | Over the 20 MB cap. |
| 500 | `storage-failure` / `storage-unavailable` | The file or receipt could not be written. |

### New attachment — `201`

```json
{
  "ingestionId": 42,
  "status": "RECEIVED",
  "code": "accepted",
  "queued": true,
  "source": "outlook",
  "messageId": "AAMkAGE4MmY2Y2UxLTFjMTgt...",
  "attachmentId": "AAMkAGE4MmY2Y2UxLTFjMTgt...BEgAQALYxElaAm31C",
  "filename": "Ahmed_Mohamed_CV.pdf",
  "contentHash": "9f2c...<sha256 hex>",
  "intakeId": null,
  "receivedAt": "2026-09-01T07:42:00.000Z",
  "parseAttempts": 0,
  "priorHashMatches": [],
  "statusUrl": "/api/ingest/cv/42",
  "message": "Ingested and queued for parsing. No candidate was created."
}
```

### Duplicate — `200`

```json
{
  "status": "duplicate",
  "code": "duplicate",
  "messageId": "AAMkAGE4MmY2Y2UxLTFjMTgt...",
  "attachmentId": "AAMkAGE4MmY2Y2UxLTFjMTgt...BEgAQALYxElaAm31C",
  "ingestionId": 42,
  "duplicateOf": 42,
  "originalStatus": "PARSED",
  "intakeId": 17,
  "parseAttempts": 1,
  "message": "This attachment was already ingested. No candidate was created."
}
```

### Validation error — `400`

```json
{
  "status": "rejected",
  "code": "provenance-missing",
  "error": "Required provenance fields are missing.",
  "missing": ["attachmentId"]
}
```

### `GET /api/ingest/cv/:id`

Returns one receipt. Two jobs: polling an asynchronous parse to a terminal
status, and reconciling a request whose response the scanner never saw — a
timeout that actually succeeded — **without re-POSTing the file**.

```json
{
  "ingestionId": 42, "status": "PARSED", "intakeId": 17,
  "contentHash": "9f2c...", "parseAttempts": 1, "reason": null
}
```

`status` is one of `RECEIVED` (queued or in flight), `PARSED` (staged for
review), `NO_FIELDS` (read, nothing proposable), `FAILED` (retryable).

**No response on any route carries document text** — no parsed values, no
preview, no raw text. A scanner needs to know what happened to the file, not
what the file said. That is the main reason this is a separate route from
`POST /api/candidates/parse-cv`, which deliberately *does* return all of that to
a human at a browser.

---

## Duplicate behaviour

A duplicate **never**:

- creates another candidate
- creates another application
- triggers CV parsing again
- creates another ingestion record

The last three are enforced structurally, not by convention: the identity is
claimed *before* the parse is scheduled, so a duplicate returns from the route
before any parsing code is reachable. `parseAttempts` on the receipt is the
observable proof — it stays at `1` no matter how many times the scanner retries,
and the test suite asserts exactly that.

### Retry semantics by receipt status

| Status | Re-POSTing the same attachment |
|---|---|
| `RECEIVED` | `200 duplicate`. Another request holds the claim. |
| `PARSED` | `200 duplicate`. An intake is already awaiting review. |
| `NO_FIELDS` | `200 duplicate`. It would read to the same nothing. |
| `FAILED` | **Reprocessed in place**, reusing the same row. Never a second receipt. |

---

## Database constraint

```sql
CREATE UNIQUE INDEX ux_cv_ingestion_message_attachment
  ON cv_ingestion(message_id, attachment_id);
```

Uniqueness is the **database's** job. There is no check-then-insert anywhere in
this path: that pattern is not atomic, so two concurrent submissions of one
attachment would both pass the check and both write. Under the index, both reach
the `INSERT` and exactly one wins — the loser is told it is a duplicate.

**`source` is deliberately not in the key.** The same mailbox is called both
`outlook` and `microsoft_365` depending on who is describing it. If the label
were part of the identity, relabelling the scanner would silently re-ingest the
entire mailbox. Both labels are accepted, stored verbatim as provenance, and map
to the same identity.

**The content hash is not the key either.** It is stored and indexed but
deliberately not unique: one applicant legitimately mails the same PDF for two
different vacancies, and collapsing those would silently lose the second
application. Prior hash matches are reported in `priorHashMatches` as an advisory
signal — they never reject an ingestion.

### Schema

`cv_ingestion` — created and migrated by `ensureSchema()` on boot, the same
mechanism as every other table in this backend. No separate migration command.

Persisted: `message_id`, `attachment_id`, `sender_email`, `sender_name`,
`subject`, `received_at`, `source`, `content_hash` (SHA-256), `filename`,
`mime_type`, `size_bytes`, `stored_name` (blob reference), `status`,
`intake_id`, `reason`, `parse_attempts`, `parse_started_at`, `created_by`,
`created_at`, `updated_at`.

Upgrading a database that predates this change is handled automatically: the
earlier `ux_cv_ingestion_identity` index is dropped before the new one is built,
and `parse_attempts` / `parse_started_at` are added additively. Existing rows are
preserved.

---

## Asynchronous parsing

**The scanner never waits on a model call.** A CV parse is two Anthropic
round-trips and can take tens of seconds; a connector that blocks on that will
time out, retry, and pile up.

```
upload → validate → hash → claim identity → 201 → (parse → intake) → settle receipt
                                             ↑ scanner returns here
```

**There is no job table and no in-memory queue.** The `cv_ingestion` row *is*
the work item: a receipt in `RECEIVED` is by definition a parse that has not
finished. That makes the queue durable for free — unlike the in-process `Map`
behind `/parse-cv-async`, which is documented as ephemeral and loses every
in-flight job on restart.

On boot, `recoverStranded()` re-drives receipts left in `RECEIVED` past a grace
window, so a crash mid-parse is recovered rather than lost. It is bounded by
`parse_attempts` so a document that reliably crashes the parser is not retried
forever, and it runs detached so it never delays the readiness gate.

---

## Integration with the existing ATS workflow

```
Outlook attachment
  → POST /api/ingest/cv
  → validate → SHA-256 → claim (messageId, attachmentId)
  → persist bytes to the existing file_blob store
  → existing parsing pipeline (lib/parsing/pipeline-provider.js)
  → existing createIntake() → candidate_intake, status PENDING
  → existing review/approval screen
  → candidate created ONLY by an approved intake review
```

The route stages an intake with `origin = 'mailbox.ingest'`, which is what
distinguishes a scanner ingestion from a recruiter's own upload downstream —
without a second intake model. Nothing here creates a candidate or an
application, and there is deliberately no flag to make it do so.

---

## How the Outlook scanner should call this endpoint

1. **Read the watermark.** `GET /api/ingest/scan-state` →
   `lastSuccessfulScanAt`. On the very first run this is
   `2026-09-01T00:00:00.000Z`, chosen so the first pass covers that day's
   applications rather than ~11k historical messages.
2. **List messages** received after that timestamp, and pick the ones that look
   like applications.
3. **For each attachment**, fetch the **raw bytes** from Graph and POST them.
   One request per attachment; an email with two CVs is two requests with the
   same `messageId` and different `attachmentId`.
4. **Classify the response** by `code`: `accepted` → submitted; `duplicate` →
   duplicate; `4xx` → rejected; `5xx`/timeout → failed, retry later.
5. **Retry freely.** Retries are safe by construction. A retry after a success
   returns `duplicate`, not a second candidate. Do not add client-side
   dedup — `(messageId, attachmentId)` already is it.
6. **Advance the watermark** only when nothing was left unprocessed:
   `PUT /api/ingest/scan-state` with `{ lastSuccessfulScanAt }`. It moves
   forward only; a backwards write returns `409 scan-state-regression` unless
   `force: true`. **Do not advance past attachments that failed for system
   reasons** — leave them inside the next window.
7. Optionally poll `statusUrl` if the run needs terminal parse outcomes; not
   required for correctness.

> **Note on fetching bytes.** The Microsoft 365 MCP connector's `read_resource`
> returns *extracted text*, not the raw attachment. This endpoint needs the real
> file. The scanner must therefore call Graph directly
> (`GET /messages/{id}/attachments/{attId}/$value`, or read `contentBytes`) with
> its own credentials. Do not reconstruct a document from extracted text — that
> fabricates the artefact of record and invalidates the content hash.

---

## Configuration

**No new environment variables.**

| Variable | Effect here |
|---|---|
| `DATABASE_URL` | Where `cv_ingestion` lives. Postgres in production. |
| `UPLOAD_DIR` | Best-effort disk cache only. The `file_blob` table is the source of truth, so ephemeral disks are safe. |
| `ANTHROPIC_API_KEY` | **Not required to ingest.** Without it files are still stored and provenance recorded; receipts settle `NO_FIELDS` with a reason. Set it to get real parses and PENDING intakes. |

---

## Tests

`backend/ingest_cv_test.mjs`, registered in `run_tests.mjs` (`npm test`).
**42 checks, 1 skipped** (the live-parse check, which needs an API key and skips
loudly — skipping is not a pass).

Covers all nine required scenarios — new CV, exact duplicate, concurrent
submission, same message with a different attachment, missing `messageId`,
missing `attachmentId`, invalid file, server-side SHA-256, and duplicates not
re-parsing — plus source-synonym identity, sender/date validation, size bounds,
provenance round-trip, durable blob retrieval, no-document-text-in-responses,
the async contract, restart recovery of a stranded receipt, scan-state
monotonicity, and — asserted throughout — that **no candidate and no application
is ever created by this route**.

Verified on both engines: SQLite via the suite, Postgres via PGlite for the DDL
translation, the unique index, cross-label deduplication and the retry
lifecycle. The pre-existing-database upgrade path is verified separately.
