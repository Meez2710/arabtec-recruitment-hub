# AI-assisted candidate intake — staging MVP

One vertical slice: a recruiter uploads a CV, the local model proposes
structured fields, a human reviews and confirms, and the ordinary candidate
service creates the record. Nothing else.

## The rule the whole feature is built around

**The AI proposes. A human decides. Nothing else changes state.**

Not on success, not on high confidence, not ever does a parse create a
candidate, move an application, stamp a stage or touch a requisition. The
output is a draft; `Confirm & Save` is a named human act that calls
`lib/candidate-service.js` — the same path the manual form uses, with the same
validation, duplicate detection, override gate, activity and audit trail.

## Flow

```
upload  →  magic-byte validation  →  queued ai_task  →  gateway call
        →  document quality check  →  OCR rescue if native text is thin
        →  local model extraction  →  strict schema validation
        →  ai_parse_draft (pending)  →  human review  →  Confirm & Save
```

Statuses: `queued → running → succeeded | failed | cancelled`. Retry re-runs
the **same** row; it never creates a second task, so it cannot duplicate a
draft or a candidate.

## Configuration

`AI_ENABLED` is **false** by default. With it unset the routes answer
`AI_DISABLED`, the UI button does not appear, and the ATS behaves exactly as it
did before this feature existed. Full variable list:
[AI_RUNTIME_DEPLOYMENT.md](AI_RUNTIME_DEPLOYMENT.md).

There is no hosted-provider option and no fallback provider, deliberately: a
fallback that "keeps working" is how CVs end up processed by a system nobody
chose, and it hides an outage instead of reporting one.

## Security

| Control | Where |
| --- | --- |
| Only the Node backend calls the gateway | `lib/ai/gateway-client.js` is the single outbound call; the token is server-side only |
| No proxy surface | No endpoint accepts a caller-supplied URL, host, model or prompt |
| Ollama/Docling never exposed | Loopback inside the pod; `11434` never published — asserted first by the smoke test |
| Type by content, not extension | Magic bytes must agree with the extension; DOCX additionally needs the OOXML `word/` marker |
| Nothing stored before validation | `multipartMemory` parses to memory; a rejected upload leaves no row and no file |
| Randomised temp files, guaranteed cleanup | `withTempFile` removes the directory on the throw path too |
| Owner-only draft access | A pending draft is unreviewed personal data; not widened to managers |
| No CV content in logs, audit or errors | Errors are stable codes + fixed sentences; audit records the filename and ids only |
| Original CV retained under existing policy | `file_blob`, same as every other upload — no second store, no new retention rule |

## Provenance

Every task records `model_id`, `model_digest`, `prompt_version`,
`schema_version`, `parser_version` and `gateway_version`. A mutable model tag
can point at different weights after an upgrade, so the digest is what actually
identifies what read the CV. The review screen shows this collapsed — an
auditor needs it, a recruiter does not.

## Tests

`backend/ai_intake_test.mjs` — 88 assertions, **no GPU, no network, no model**.
The gateway is replaced by a deterministic local server that can be told to
succeed, stall, return malformed JSON, reject a document, abstain or vanish.
That is the only way CI can assert what happens when the model misbehaves,
which is the failure class that matters most and the one a real model will not
reproduce on demand.

Covers: valid CV → draft; explicit confirmation; edited values winning over
proposed; double-confirm refused; no workflow state touched; five invalid/
oversized file classes; malformed model JSON rejected not repaired; encrypted
and unreadable documents; abstention; timeout; cancellation mid-run; retry
without duplication; idempotent re-upload; unauthorised access; no browser path
to the gateway; no CV content in audit; AI disabled; gateway gone.

Registered in `run_tests.mjs`, so it runs in the ordinary CI gate.

## Deliberately not built

Bulk upload, automatic candidate creation, AI-driven stage changes, matching or
ranking, embeddings, and any use of the parsed skills/employment/education
beyond storing them with the draft for reference. The staging release saves
only the seven reviewed fields.

## Not deployed

The RunPod artifacts are pinned and reproducible but nothing has been deployed.
Outstanding owner inputs are listed at the end of
[AI_RUNTIME_DEPLOYMENT.md](AI_RUNTIME_DEPLOYMENT.md).
