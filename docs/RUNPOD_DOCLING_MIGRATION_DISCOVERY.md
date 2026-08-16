# RunPod Docling Serve migration — discovery

**Status: DISCOVERY ONLY.** No code was changed, nothing was installed, nothing was deployed or
exposed. Everything below was read from the repository at `readiness/final-gate` (`d21238a`).

---

## 1. Current architecture

```
POST /api/candidates/parse-cv                       routes/candidates.js
  └─ getParser()                                    lib/parsing/registry.js
       └─ pipelineParserProvider                    lib/parsing/pipeline-provider.js   ← JS↔TS bridge
            └─ composeAI(process.env)               dist/api/composition-root.js       ← the ONE wiring point
                 └─ DocumentUnderstandingPipeline   infrastructure/ai/document/…       ← implements DocumentParser
                      ├─ routing / quality gate / reconciliation
                      ├─ layoutParser  = DoclingDocumentParser                          ← MAPPING BOUNDARY
                      │      └─ DoclingSidecarClient  ──HTTP──▶  local sidecar :8089
                      ├─ fallbackParser = LocalDocumentParser  (pdfjs + mammoth)
                      ├─ textParser     = PlainTextDocumentParser
                      └─ ocrEngine      = HttpOcrEngine (optional, currently unset)
            └─ resume-parse-handler.buildProposedFields    ← evidence located + deterministic validation
  └─ createIntake(...)                              lib/intake-store.js  → candidate_intake (PENDING)

POST /api/candidates/intakes/:id/review
  └─ reviewIntake(...)   one transaction: candidate + proposal + application + intake
```

Two comments in the source state the intended seam, and they are accurate:

- `sidecar-client.ts`: *"THIS FILE IS THE ONLY PLACE THAT KNOWS DOCLING EXISTS."*
- `docling-document-parser.ts`: *"The mapping boundary. Everything Docling-shaped stops here."*

**This is why the migration is small.** Replacing the sidecar with RunPod Docling Serve is a
transport swap beneath an existing, tested mapping layer — not a change to the pipeline, the
evidence model, the proposal, the intake, or the database.

---

## 2. Current parser contract

### 2.1 Entry point
`backend/src/lib/parsing/pipeline-provider.js` → `parseDocument(filePath)` and
`pipelineParserProvider` (registered in `lib/parsing/composition.js`, default provider
`document-pipeline`, overridable by `CV_PARSER_PROVIDER`). It reads the file into a
`Uint8Array` and calls `documentParser.parse({ documentId, filename, mimeType, bytes })`.
Results are memoised on `path:size:mtimeMs` (LRU), so `parseEntities` + `parseDocument` in the
same request cost one conversion.

### 2.2 Adapter
`backend/src/infrastructure/ai/docling/docling-document-parser.ts` — `DoclingDocumentParser
implements DocumentParser`. `modelId = 'docling-sidecar'`, `version =
docling-adapter/1.0.0+<DOCLING_PIPELINE_VERSION|unpinned>`.

### 2.3 Sidecar HTTP endpoints
Both are **POST**, both JSON, both behind the same optional bearer guard:

| Endpoint | Purpose |
|---|---|
| `POST /v1/health` | readiness |
| `POST /v1/convert` | conversion (also aliased at `POST /convert`) |

### 2.4 Request payload
```json
{ "filename": "cv.pdf", "mimeType": "application/pdf", "contentBase64": "<base64>" }
```
Base64-in-JSON, not multipart — chosen so the contract is one JSON shape and trivially
stubbable. Client-side ceiling `maxBytes = 25 MB`, enforced **before** the request is spent.

### 2.5 Response format
```jsonc
{
  "status": "ok" | "unsupported" | "encrypted" | "corrupt" | "empty",
  "markdown": "…", "text": "…",
  "pages": ["…"] | null,          // always null on 2.55.1 — see §2.10
  "blocks": [ … ] | undefined,    // optional; absent on the current build
  "pageCount": 2,
  "detectedLanguages": ["en"] | null,
  "ocrApplied": true,
  "ocrEngine": "tesseract",
  "reason": "…",                  // only when status != ok; never contains document text
  "doclingVersion": "2.55.1",
  "pipelineVersion": "unpinned"
}
```
The client validates the envelope: a non-object body, an unknown `status`, or `status:"ok"`
without a string `text` is a **protocol** fault (retryable), not a document fault.

### 2.6 Authentication
Optional bearer. Server side: `require_token()` reads `DOCLING_BEARER_TOKEN`; empty means an
open service; otherwise `secrets.compare_digest` against `Authorization: Bearer …`, 401 with a
deliberately vague reason. Client side: header added only when `bearerToken` is set. Verified in
the pilot: 401 without a token, 401 with a wrong token, 200 with the right one.

### 2.7 OCR parameters (all server-side, none in the wire contract)

| Variable | Default | Meaning |
|---|---|---|
| `SIDECAR_OCR_SCALE` | `4.0` | rasterisation scale (~288 dpi). **The single knob that decides whether scanned CVs work at all** — Docling's 1.0 is 72 dpi, at which Tesseract skips the page |
| `SIDECAR_OCR_LANGS` | `eng,ara` | Tesseract language packs |
| `SIDECAR_MIN_NATIVE_CHARS` | `30` | native-text threshold below which a PDF is retried with forced OCR |
| `SIDECAR_OCR_ENGINE` | `tesseract` | reported in health |
| `DOCLING_ARTIFACTS_PATH` | — | offline model artifacts |

Engine: `TesseractCliOcrOptions` (the CLI binary, **not** the `tesserocr` binding),
`do_ocr = mode != "native"`, `do_table_structure = True`,
`force_full_page_ocr = (mode == "forced")`. Converters are cached per mode so models load once.

### 2.8 Arabic/English OCR configuration
`lang=["eng","ara"]` from `SIDECAR_OCR_LANGS`. Health reports the packs actually installed by
shelling out to `tesseract --list-langs` (measured, not assumed):
`["ara","eng","osd","snum"]`. Verified working: fixture D (image-only Arabic PDF) passes.

### 2.9 Evidence / provenance mapping
`toStructure()` in the adapter, two paths:

- **Blocks present** — each sidecar block maps to a neutral `RawBlock` with `page`, `kind`
  (via `BLOCK_KINDS`), `text`, `method` (`block.ocr ? 'ocr' : 'native'`), `level`, `bbox`
  (fractional, origin top-left), `table`, `confidence`.
- **Blocks absent** (the current build) — structure is derived from the markdown **inside the
  adapter**, deliberately: only this layer knows whether OCR ran, and that flag is the
  difference between "decoded" and "recognised" for every block. `blocksFromMarkdown(markdown,
  1, method)` — note the hardcoded page `1`.

`buildStructuredDocument` then assigns block ids (`b1`, `b2`, …), section ids (`s1`, …) and
reading order. `resume-parse-handler.refOf()` turns a located evidence hit into
`evidenceRef = { page, blockId, section }`, which is what the Candidate Review screen renders
and what `cv_intake_test`/`ats_e2e_test` assert against real block ids.

`DocumentProvenance` carries `parser`, `parserVersion`, `ocrEngine?`, `convertedAt`,
`pipelineVersion?`. The pipeline records `usedParser`, not the requested parser, so a fallback
can never be reported as Docling.

### 2.10 pageCount handling
Sidecar: `pageCount = _page_count(document)` from `document.num_pages()`. Adapter:
`result.pageCount ?? pages.length`, and `pages` falls back to `[text]` when the sidecar returns
no split.

**Known open defect (B4 in the readiness report):** `_pages_of()` returns `[]` on Docling
2.55.1 — `export_to_text()` takes no `page_no` — so the adapter always takes the
markdown-derived path and stamps **page 1 on every block**. Text is complete; the page number in
an evidence citation is wrong beyond page 1.

### 2.11 Error handling
`SidecarError { retryable, kind: 'unavailable'|'timeout'|'server'|'protocol'|'too-large' }`.
The adapter converts every failure into an `AIAbstention` and — this is the load-bearing part —
sets `permanent`:

| Condition | `permanent` | Consequence |
|---|---|---|
| `status` ∈ {unsupported, encrypted, corrupt, empty} | **true** | terminal; the bytes will never yield text |
| `ok` with blank text | **true** | terminal |
| oversized (client-side, no request spent) | **true** | terminal |
| 4xx | **true** (`retryable=false`) | terminal; same bytes meet the same refusal |
| 5xx, timeout, unreachable, malformed body | **false** | temporary; the CV is delayed, not discarded |
| unexpected adapter throw | **false** | a defect here must not discard a CV |

There is **no silent fallback inside the adapter** — it returns content only on success.

### 2.12 Timeout handling
`AbortController` with `timeoutMs` (default `120_000`, `DOCLING_TIMEOUT_MS`). `AbortError` /
`TimeoutError` → `SidecarError('timeout', retryable: true)`. Server-side `SIDECAR_TIMEOUT_S`
defaults to 120 s.

### 2.13 Retry behaviour
**The client never retries.** Retry is expressed as `retryable`/`permanent` and handled above:
`DocumentUnderstandingPipeline` performs exactly one observable fallback to
`LocalDocumentParser` on a **temporary** abstention, and records the parser that actually ran.
The sidecar itself performs one bounded internal retry (native → forced OCR) for PDFs under
`SIDECAR_MIN_NATIVE_CHARS`.

### 2.14 Temporary file handling
**None on the Node side** — bytes go over the wire, a document comes back. The sidecar owns
temp files: `tempfile.TemporaryDirectory(prefix="docling-")`, filename
`<request_id><suffix>` where the caller's filename is **never used on disk** (no path traversal,
no leak into logs), plus a belt-and-braces `unlink(missing_ok=True)`.

### 2.15 Health checks
`POST /v1/health` →
`{ok, doclingVersion, modelsPresent, ocrEngine, ocrExecutablePresent, ocrLanguages}`.
`DoclingSidecarClient.health()` normalises the first four. **`DoclingDocumentParser.health()`
has no caller** — no Node route surfaces sidecar health today. The Node app's own
`/api/health`, `/api/health/db`, `/api/health/watcher` say nothing about Docling.

### 2.16 Environment variables

| Variable | Where | Default | In `.env.example`? |
|---|---|---|---|
| `DOCLING_BASE_URL` | Node | unset → local parser selected | yes |
| `DOCLING_BEARER_TOKEN` | Node + sidecar | unset → no header / open service | **no — gap** |
| `DOCLING_TIMEOUT_MS` | Node | 120000 | yes |
| `DOCLING_PIPELINE_VERSION` | Node | `unpinned` | yes |
| `CV_PARSER_PROVIDER` | Node | `document-pipeline` | — |
| `OCR_BASE_URL` / `OCR_ENGINE` / `OCR_PATH` / `OCR_TIMEOUT_MS` | Node | unset / `http-ocr` / `/ocr` / 60000 | yes (must stay unset — OCR happens inside Docling) |
| `SIDECAR_MAX_BYTES` | sidecar | 26214400 | n/a |
| `SIDECAR_TIMEOUT_S` | sidecar | 120 | n/a |
| `SIDECAR_MIN_NATIVE_CHARS` | sidecar | 30 | n/a |
| `SIDECAR_OCR_SCALE` | sidecar | 4.0 | n/a |
| `SIDECAR_OCR_LANGS` | sidecar | `eng,ara` | n/a |
| `SIDECAR_OCR_ENGINE` | sidecar | `tesseract` | n/a |
| `SIDECAR_PIPELINE_VERSION` | sidecar | `unpinned` | n/a |
| `DOCLING_ARTIFACTS_PATH` | sidecar | unset | n/a |

### 2.17 Tests that validate the parser contract

| Test | What it pins |
|---|---|
| `src/infrastructure/ai/docling/docling-document-parser.test.ts` | **20 tests, stubbed HTTP.** Success mapping (markdown, provenance+latency, pinned version, no invented markdown, OCR confidence 0.8, single-page fallback); permanent abstention (4 rejection statuses, blank text, oversized without spending a request, no 4xx retry); temporary abstention (unreachable, timeout, 5xx); "no silent fallback". **This is the contract suite a new transport must keep green.** |
| `src/infrastructure/ai/document-smoke/` | 23 tests — routing, quality gate, reconciliation, structure |
| `parser_seam_test.mjs` | 13 — one registered provider, no direct parser import in routes, unknown provider fails loudly, evidence-bearing fields, nothing persistable that isn't in the document |
| `cv_proposal_test.mjs` | 16 — proposal lifecycle |
| `cv_intake_test.mjs` | 35 — intake → review → candidate, evidence refs against real block ids |
| `intake_route_http_test.mjs` | 9 — HTTP route precedence |
| `ats_e2e_test.mjs` | 48 — whole pipeline; stage `[ocr]` asserts `parser=docling-sidecar` **and** `ocrApplied=true` |
| `run_docling_matrix.mjs` | 9 document classes against a live endpoint (A–I, incl. Arabic and a genuine 2-page scan) |
| `live_parser_test.mjs` | opt-in live-service suite (`LIVE_TESTS=1`) |

Three of these assert the literal string `'docling-sidecar'` (`ats_e2e_test.mjs`,
`live_parser_test.mjs`, and the adapter suite via `modelId`). See §5.

---

## 3. Required RunPod API contract

> **⚠ This section is expectation, not verification.** I did not install or call Docling Serve,
> and its route prefix has moved between releases (`/v1alpha/…` → `/v1/…`), so field names below
> must be confirmed against the deployed image's own OpenAPI (`GET /docs`, `GET /openapi.json`)
> **before** any adapter code is written. Confirming it is step 1 of §7.

Expected surface of the official `docling-serve` container:

| Concern | Expected Docling Serve | Current sidecar |
|---|---|---|
| Convert (JSON) | `POST /v1/convert/source` — `{sources:[{kind:"file", base64_string, filename}], options:{…}}` | `POST /v1/convert` — `{filename, mimeType, contentBase64}` |
| Convert (multipart) | `POST /v1/convert/file` | — |
| Async | `POST /v1/convert/source/async` → task id; `GET /v1/status/poll/{id}`; `GET /v1/result/{id}` | — (synchronous only) |
| Health | `GET /health` | `POST /v1/health` |
| Auth | API key header (e.g. `X-Api-Key`), configured by env on the container | `Authorization: Bearer` |
| Result | `{document:{filename, md_content, text_content, json_content, html_content, doctags_content}, status, errors[], processing_time}` | flat `{status, markdown, text, pages, pageCount, ocrApplied, …}` |
| OCR control | per-request options: `do_ocr`, `force_ocr`, `ocr_engine`, `ocr_lang`, `image_export_mode`, `table_mode` | server-side env only |
| Status vocabulary | `success` / `partial_success` / `failure` + `errors[]` | 5-value enum `ok/unsupported/encrypted/corrupt/empty` |

**Four gaps the new client must close.** These are the whole job:

1. **`ocrApplied` does not exist in Docling Serve.** Our flag is correct *by construction*
   because the sidecar probes natively first and only then forces OCR. Docling Serve takes
   `do_ocr`/`force_ocr` as request options and does not report what it did. To preserve the
   flag the Node client must replicate the two-pass probe — call once with `do_ocr:false`, and
   if the text is under `MIN_NATIVE_CHARS` call again with `force_ocr:true` — which means **two
   network round trips and two GPU jobs for every scanned document**. This is the single
   largest behavioural risk in the migration.
2. **Status classification.** `success|failure` + `errors[]` must be mapped onto
   `ok|unsupported|encrypted|corrupt|empty`, because `permanent` vs `temporary` is what decides
   whether a CV is discarded or retried. Getting this wrong silently discards CVs. Expect to
   pattern-match on `errors[]` text — fragile, and it needs its own tests.
3. **`pageCount`.** Not obviously in the flat response; likely derivable from `json_content`
   (a full `DoclingDocument` has `pages`).
4. **Auth header shape** differs (`X-Api-Key` vs `Authorization: Bearer`).

**One opportunity worth taking while here.** Requesting `to_formats: ["json"]` returns the full
`DoclingDocument`, whose text items carry `prov[].page_no` and bounding boxes. That is exactly
the data the `blocks[]` branch of `toStructure()` already knows how to consume — so the RunPod
migration is also the natural moment to **fix open defect B4** (every block attributed to page 1)
and to get real bounding boxes into evidence. Optional, and it should be a separate commit.

---

## 4. Files involved

**Would be modified / added:**

| File | Change |
|---|---|
| `backend/src/infrastructure/ai/docling/docling-serve-client.ts` | **NEW.** Speaks Docling Serve, returns the existing internal `SidecarDocument` shape |
| `backend/src/infrastructure/ai/docling/sidecar-client.ts` | extract a `DoclingTransport` interface (`convert`, `health`) that both clients satisfy; keep `SidecarError` shared |
| `backend/src/infrastructure/ai/docling/docling-document-parser.ts` | accept an injected transport instead of constructing `DoclingSidecarClient` directly. **No mapping logic changes** |
| `backend/src/infrastructure/ai/docling/index.ts` | export the new client |
| `backend/src/api/composition-root.ts` | choose the transport from env (one branch in `composeAI`) and set `description.layoutParser` accordingly |
| `backend/src/infrastructure/ai/docling/docling-serve-client.test.ts` | **NEW.** Mirrors the 20 existing adapter tests against the new wire shape |
| `backend/.env.example`, `docs/DOCLING_SIDECAR_API.md`, `docs/LOCAL_MAC_DOCLING_PILOT.md` | document the new variables; add the missing `DOCLING_BEARER_TOKEN` |
| `backend/run_docling_matrix.mjs` | auth header + base URL for the new endpoint |
| `backend/ats_e2e_test.mjs`, `backend/live_parser_test.mjs` | the literal `'docling-sidecar'` assertion (see §5) |

**Explicitly NOT modified** — and the migration is only worth doing if this holds:
`document-understanding-pipeline.ts`, `routing.ts`, `quality-gate.ts`, `reconcile.ts`,
`structure-builder.ts`, `resume-parse-handler.ts`, `pipeline-provider.js`, `composition.js`,
`registry.js`, `intake-store.js`, `proposal-store.js`, `models.js`, `schema.js`,
`routes/candidates.js`, `frontend/public/intake-review.jsx`, and every database table.

---

## 5. Minimum adapter change

Smallest change that works:

1. **Introduce a transport interface** in `sidecar-client.ts`:
   `interface DoclingTransport { convert(input): Promise<SidecarDocument>; health(): Promise<SidecarHealth>; }`
   `DoclingSidecarClient` already satisfies it.
2. **Add `DoclingServeClient`** implementing the same interface, translating Docling Serve's
   request/response/auth/status into the existing internal shape, including the two-pass OCR
   probe and the status classification from §3.
3. **Inject the transport** into `DoclingDocumentParser` (constructor option, defaulting to
   today's sidecar client). The 20 mapping/abstention tests keep passing untouched, because the
   mapping boundary does not move.
4. **One branch in `composeAI`** selecting the transport from `DOCLING_BACKEND`
   (`sidecar` | `serve`, defaulting to `sidecar`).

**One naming decision needed.** `modelId` is the literal `'docling-sidecar'` and it is asserted
by name in three suites and written into `structure.provenance.parser`. Two options:
- keep `'docling-sidecar'` for both transports — zero test churn, but provenance stops
  distinguishing which engine actually ran, which is exactly the kind of blur this codebase has
  worked to remove; or
- report `'docling-serve'` — honest provenance, and three assertions to update.

**Recommendation: report `'docling-serve'`.** Provenance that cannot tell you which engine
produced a candidate's evidence is worth less than three one-line test edits.

---

## 6. Migration risks

| # | Risk | Severity | Note |
|---|---|---|---|
| R1 | **`ocrApplied` cannot be read back** — needs a two-pass probe | **High** | Doubles latency and GPU cost for scanned CVs. If skipped, a scanned CV becomes indistinguishable from a digital one in provenance and in the review UI. `ats_e2e_test` asserts this flag |
| R2 | **Status/`errors[]` → permanent-vs-temporary misclassification** | **High** | Classifying a temporary failure as permanent silently discards CVs. Needs dedicated tests before switchover |
| R3 | **Candidate PII leaves the machine** | **High** | RunPod is a third party. Needs TLS, API-key auth, a DPA review, and a decision that pilot CVs may go there. Never send documents by URL — inline bytes only |
| R4 | **OCR quality drift** | Medium | `SIDECAR_OCR_SCALE=4.0` is *the* knob that makes scanned CVs work; the equivalent in Docling Serve options must be found and set, or every scan silently returns empty again. This exact failure cost days already |
| R5 | **Arabic language pack absent from the official image** | Medium | Our health endpoint proves `ara` is installed locally; the RunPod image must be proven the same way before trusting Arabic OCR |
| R6 | **Latency / cold starts** | Medium | GPU pod cold start plus network. The 120 s sync timeout may not be enough; async + poll may be required, which is a larger client |
| R7 | **`pageCount` unavailable** | Low | Already wrong beyond page 1 today (B4); do not let it regress further |
| R8 | **Cost model changes** | Medium | Local sidecar is free; a GPU pod bills by the hour whether or not CVs arrive |
| R9 | **API version drift** | Medium | `/v1alpha` → `/v1` has already happened once. Pin the image digest and record it in `DOCLING_PIPELINE_VERSION` |
| R10 | **Availability becomes a network dependency** | Medium | The fallback to `LocalDocumentParser` still fires on a temporary abstention, but it cannot OCR — scanned CVs simply fail while RunPod is unreachable |

---

## 7. Rollback strategy

Rollback is **environment-only**, and that is a design goal, not an accident:

1. `DOCLING_BACKEND=sidecar` (or unset) and `DOCLING_BASE_URL=http://127.0.0.1:8089` → the
   local sidecar path returns, no redeploy of code required.
2. `DOCLING_BASE_URL` unset entirely → `LocalDocumentParser` takes over. Born-digital PDFs and
   DOCX keep working; scanned CVs abstain **explicitly** rather than silently returning nothing.
3. Keep `deploy/docling-sidecar/` in the tree and keep the local pilot runnable for the whole
   transition. Delete it only after the RunPod path has run a full document-class matrix and a
   full end-to-end.
4. Keep the RunPod image pinned by digest, so a rollback target exists on that side too.

Nothing in the database changes, so there is no data migration and nothing to reverse.
Intakes and proposals created under either transport are identical rows; only
`structure.provenance.parser` differs, which is the point.

---

## 8. Recommended migration sequence

1. **Confirm the real contract.** Start the official image once, read `GET /openapi.json`, and
   write the actual request/response/auth/status shapes into
   `docs/DOCLING_SERVE_API.md`. Do not write adapter code from remembered field names — §3 is
   expectation, not fact.
2. **Prove OCR on that image before integrating.** Push fixtures B, C, D and I straight at it
   with `curl`: image-only English, PNG, image-only **Arabic**, and the two-page scan. Find the
   option that corresponds to `images_scale`/`SIDECAR_OCR_SCALE` and confirm Arabic is
   installed. If any of these fail, stop — the migration has no value until they pass.
3. **Decide the `ocrApplied` strategy** (R1): two-pass probe, or accept losing the flag. This is
   a product decision about whether a reviewer is told the text was recognised rather than read.
   Recommendation: keep the probe.
4. **Extract the `DoclingTransport` interface** and inject it into `DoclingDocumentParser`.
   Pure refactor, no behaviour change; the existing 20 adapter tests must stay green untouched.
5. **Write `DoclingServeClient` + its test suite**, mirroring all 20 adapter cases against the
   new wire shape, with extra cases for the status/`errors[]` classification (R2).
6. **Wire `DOCLING_BACKEND` into `composeAI`**, defaulting to `sidecar`. Both paths live
   simultaneously; nothing switches yet.
7. **Run the document-class matrix against RunPod** (`run_docling_matrix.mjs`, 9/9 required,
   with correct `ocrApplied` per class).
8. **Run `ats_e2e_test.mjs` with `DOCLING_BACKEND=serve`** — 48/48, including the `[ocr]` stage.
9. **Compare against the local sidecar** on the same fixtures: recovered text, field count, and
   evidence refs should match. Any divergence is a finding, not a rounding error.
10. **Switch by environment variable**, sidecar left deployable and documented as the rollback.
11. **Only then** consider the `json_content` upgrade to fix per-page evidence attribution (B4)
    — separate commit, separate verification.
12. **Retire the local sidecar** after a full pilot cycle on RunPod, not before.

Steps 1–3 are discovery and decisions. Steps 4–6 are the only code, and they are confined to
four files plus two new ones.
