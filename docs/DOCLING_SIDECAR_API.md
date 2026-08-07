# Docling Sidecar API — v1

**Status:** contract defined and implemented on both sides. **Never executed** — Docker is
not installed on the authoring machine, so the Python service is unverified. The Node client
and its 20 contract tests run today against stubbed HTTP.

The contract is versioned **independently of Docling**. A Docling upgrade that changes its
internal document model must not change what this service returns; absorbing that difference
is the sidecar's job.

Client: [sidecar-client.ts](backend/src/infrastructure/ai/docling/sidecar-client.ts) ·
Service: [app.py](deploy/docling-sidecar/app.py)

---

## Transport

- Base URL: `http://docling:8089` on the internal compose network. **Never published to the
  host**, never routable off the machine.
- JSON over POST. Base64 payload rather than multipart: one contract, trivially stubbable,
  and the size ceiling bounds the encoding cost.
- No authentication — the network boundary is the control. If the sidecar ever becomes
  reachable beyond the compose network, that assumption is void.

---

## `POST /v1/health`

```json
{ "ok": true, "doclingVersion": "2.55.1", "modelsPresent": true, "ocrEngine": "tesseract" }
```

`modelsPresent` is the **offline canary**. If it is false, weights were not baked into the
image and the first conversion will attempt a download — which fails in a network-restricted
deployment. Treat false as not-ready.

## `POST /v1/convert`

**Request**

```json
{ "filename": "cv.pdf", "mimeType": "application/pdf", "contentBase64": "JVBERi0…" }
```

`filename` is used only to pick a temp-file suffix. It is **never** written to disk as given
and never logged.

**Response**

| Field | Type | Notes |
| --- | --- | --- |
| `status` | `ok` \| `unsupported` \| `encrypted` \| `corrupt` \| `empty` | required |
| `text` | string | required when `ok` |
| `markdown` | string | structured output; may be absent |
| `pages` | string[] | per-page text |
| `pageCount` | number | |
| `detectedLanguages` | string[] | |
| `ocrApplied` | boolean | lowers adapter confidence when true |
| `reason` | string | required when not `ok`. **Never contains document text** |
| `doclingVersion`, `pipelineVersion` | string | recorded in proposal provenance |

---

## Failure classification — the load-bearing part

`permanent` decides whether a CV is **delayed** or the task is **terminal**, so the mapping
is explicit rather than inferred:

| Condition | HTTP | Adapter outcome |
| --- | --- | --- |
| `status: ok` | 200 | proposal |
| `unsupported` / `encrypted` / `corrupt` / `empty` | 200 | **permanent** abstention |
| Oversized (client-side check) | — | **permanent**, no request spent |
| 4xx | 4xx | **permanent** — same bytes, same refusal |
| 5xx | 5xx | **temporary** |
| Timeout | — | **temporary** |
| Connection refused / DNS / reset | — | **temporary** |
| Unparseable body, unknown status, `ok` without text | 200 | **temporary** — a protocol mismatch is a deployment fault, not a verdict on the CV |

A document-level refusal returns **200 with a status**, not a 5xx. A 5xx is retryable, and
retrying a genuinely broken file forever would fill the queue.

There is **no fallback to another parser.** A Docling outage surfaces as a retryable
abstention, visibly.

---

## Limits and resources

| Limit | Value | Where enforced |
| --- | --- | --- |
| Max document | 25 MB | client (before the request) and service |
| Convert timeout | 120 s | client `AbortController`; service env |
| Workers | 1 | uvicorn — concurrency is memory, and memory is the constraint |
| Temp files | private dir, removed in `finally` | service |

**Logging:** JSON lines carrying `requestId`, `status`, byte count and duration. No document
text, no candidate names, no caller-supplied filenames. This matches the rule already
established in the legacy extractor.

---

## Before this contract can be trusted

1. Build the image; confirm `docling-tools models download` succeeds and `modelsPresent` is
   true.
2. Verify the Docling API calls in `app.py` (`export_to_markdown`, `export_to_text`, page
   enumeration, OCR flag) against the pinned version — these are **written from documented
   behaviour, not from a running import**.
3. Re-pin `requirements.txt` from the first successful build's `pip freeze`.
4. Confirm each of the five statuses with a real fixture: a normal PDF, a DOCX, a
   password-protected PDF, a truncated PDF, and a zero-page PDF.
5. Confirm conversion succeeds with outbound network access blocked.
