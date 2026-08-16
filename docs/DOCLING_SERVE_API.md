# Docling Serve — verified live contract

**Source of truth:** the running deployment's own `/openapi.json` plus one executed conversion.
Nothing in this document is remembered, inferred from other versions, or copied from the
discovery note. Anything not yet executed is labelled **schema-only**.

**Verified against:** `https://<pod-id>-5001.proxy.runpod.net` · 2026-08-14
**Reported by `GET /version`:**

```json
{"docling-serve":"1.12.0","docling-jobkit":"1.10.1","docling":"2.72.0",
 "docling-core":"2.63.0","docling-ibm-models":"3.11.0","docling-parse":"4.7.3",
 "python":"cpython-312 (3.12.12)","plaform":"Linux-6.8.0-134-generic-x86_64-with-glibc2.34"}
```

`GET /openapi.json` → HTTP 200, 140 879 bytes, `info: {"title":"Docling Serve","version":"1.12.0"}`.

> Note: the local pilot sidecar runs Docling **2.55.1**; this image runs Docling **2.72.0**. A
> parser-version difference is itself a behaviour risk and must be covered by the Step 2 corpus.

---

## 1. Authentication

Declared security scheme — the **only** one in the document:

```json
"securitySchemes": { "APIKeyAuth": { "type": "apiKey", "in": "header", "name": "X-Api-Key" } }
```

- Header name: **`X-Api-Key`** (not `Authorization: Bearer`).
- Global `security`: **absent**. Applied per-operation.
- `GET /health`, `GET /version`, `GET /openapi-3.0.json` declare **no** security.
- Every `/v1/**` operation declares `security: [{"APIKeyAuth": []}]`.

**Enforcement — 2026-08-14: NOT enforced. 2026-08-16: ENFORCED (re-verified).**
On 14 Aug `POST /v1/convert/file` returned HTTP 200 with a full conversion and **no
`X-Api-Key` header at all**. The key was subsequently configured and rotated; on 16 Aug the same
request returns **401**, and a request carrying the key returns 200. The §11/§12 observations
below were taken during the unauthenticated window; §14 onward were taken authenticated.

---

## 2. Endpoints (complete, from the live document)

| Method | Path | Security | Purpose |
|---|---|---|---|
| GET | `/health` | none | liveness — returns `{"status":"ok"}` |
| GET | `/version` | none | component versions (§ header above) |
| GET | `/openapi-3.0.json` | none | OpenAPI 3.0 rendering |
| POST | `/v1/convert/file` | APIKeyAuth | **synchronous** conversion, multipart upload |
| POST | `/v1/convert/file/async` | APIKeyAuth | asynchronous conversion, multipart upload |
| POST | `/v1/convert/source` | APIKeyAuth | synchronous conversion from a source (URL/base64) |
| POST | `/v1/convert/source/async` | APIKeyAuth | asynchronous from a source |
| GET | `/v1/status/poll/{task_id}` | APIKeyAuth | task status; optional `?wait=` query |
| GET | `/v1/result/{task_id}` | APIKeyAuth | task result |
| GET | `/v1/clear/converters` | APIKeyAuth | drop cached converters |
| GET | `/v1/clear/results` | APIKeyAuth | drop stored results |
| POST | `/v1/chunk/{hierarchical,hybrid}/{file,source}[/async]` | APIKeyAuth | chunking — **not used by the ATS** |

There is **no `/v1/health`** and no `POST` health. Health is `GET /health`.

---

## 3. `POST /v1/convert/file` — request schema

Content type: **`multipart/form-data` only** (schema
`Body_process_file_v1_convert_file_post`). There is no JSON body variant on this endpoint.

Required: **`files`** — `array` of `string/binary`. Repeat the field to send several.

All other fields are optional form fields with these **live defaults**:

| Field | Type | Default | Notes |
|---|---|---|---|
| `target_type` | enum `TargetName` | `inbody` | `inbody` \| `zip` |
| `from_formats` | array of `InputFormat` | `["docx","pptx","html","image","pdf",…]` | see §5 |
| `to_formats` | array of `OutputFormat` | `["md"]` | see §5 |
| `image_export_mode` | enum `ImageRefMode` | `embedded` | `placeholder` \| `embedded` \| `referenced` |
| `do_ocr` | boolean | **`true`** | OCR is ON by default |
| `force_ocr` | boolean | `false` | |
| `ocr_engine` | enum `ocr_engines_enum` | **`easyocr`** | `auto`,`easyocr`,`ocrmac`,`rapidocr`,`tesserocr`,`tesseract` |
| `ocr_lang` | array of string \| null | `null` | *"each OCR engine has different values for the language names"* |
| `pdf_backend` | enum `PdfBackend` | `dlparse_v4` | `pypdfium2`,`dlparse_v1`,`dlparse_v2`,`dlparse_v4` |
| `table_mode` | enum `TableFormerMode` | `accurate` | `fast` \| `accurate` |
| `table_cell_matching` | boolean | `true` | |
| `pipeline` | enum `ProcessingPipeline` | `standard` | `legacy`,`standard`,`vlm`,`asr` |
| `page_range` | `[int,int]` | `[1, 9223372036854775807]` | 1-based, inclusive |
| `document_timeout` | number | **`604800.0`** (7 days) | per-document ceiling |
| `abort_on_error` | boolean | `false` | |
| `do_table_structure` | boolean | `true` | |
| `include_images` | boolean | **`true`** | see §12 — inflates responses |
| `images_scale` | number | **`2.0`** | the local sidecar uses **4.0** |
| `md_page_break_placeholder` | string | `""` | |
| `do_code_enrichment`, `do_formula_enrichment`, `do_picture_classification`, `do_chart_extraction`, `do_picture_description` | boolean | `false` | |
| `picture_description_area_threshold` | number | `0.05` | |
| `picture_description_local` / `_api` | string | `null` | |
| `vlm_pipeline_model` / `_local` / `_api` | — | `null` | |

**Schema-only, not yet executed:** `/v1/convert/source` accepts sources rather than an upload;
its schema was not extracted because the ATS will use `/v1/convert/file`. If a base64 body is
ever wanted, that endpoint must be documented separately before use.

---

## 4. Response schema — `ConvertDocumentResponse`

Required: `document`, `status`, `processing_time`.

```jsonc
{
  "document": {                     // ExportDocumentResponse — required: filename
    "filename":        "string",
    "md_content":      "string | null",
    "json_content":    "DoclingDocument | null",
    "html_content":    "string | null",
    "text_content":    "string | null",
    "doctags_content": "string | null"
  },
  "status": "pending|started|failure|success|partial_success|skipped",   // ConversionStatus
  "errors": [ { "component_type": "document_backend|model|doc_assembler|user_input|pipeline",
                "module_name": "string", "error_message": "string" } ],  // default []
  "processing_time": 2.189,
  "timings": {}                     // default {}
}
```

A field is populated only if its format was requested in `to_formats`. In the executed call
(`to_formats=md,json`), `text_content` came back **null**.

**There is no `ocrApplied`, no `ocr_used`, and no equivalent field anywhere in the response
schema.** Whether OCR ran is not reported. See §9.

---

## 5. Formats

`InputFormat`: `docx, pptx, html, image, pdf, asciidoc, md, csv, xlsx, xml_uspto, xml_jats,
mets_gbs, json_docling, audio, vtt`

`OutputFormat`: `md, json, yaml, html, html_split_page, text, doctags`

---

## 6. Async, polling, result

- `POST /v1/convert/file/async` → **`TaskStatusResponse`** — required `task_id`, `task_type`
  (`convert`|`chunk`), `task_status` (string); optional `task_position` (int|null),
  `task_meta` (`{num_docs, num_processed, num_succeeded, num_failed}`).
- `GET /v1/status/poll/{task_id}` — path param `task_id` (required), **query param `wait`**
  (optional) → `TaskStatusResponse`.
- `GET /v1/result/{task_id}` — path param `task_id` (required). The live document declares
  **no response schema** for 200 on this operation.

**Schema-only — the async path was not executed.** The one conversion in §11 used the
synchronous endpoint.

---

## 7. OCR parameters (verified from the live schema; behaviour NOT yet tested)

| Parameter | Live default | Delta vs the current sidecar |
|---|---|---|
| `do_ocr` | `true` | Sidecar probes natively **first** (`do_ocr=false` equivalent) and only then forces OCR. Preserving that here means explicitly sending `do_ocr=false` on the first pass |
| `force_ocr` | `false` | Sidecar's `force_full_page_ocr` for images and for the retry |
| `ocr_engine` | **`easyocr`** | Sidecar uses **Tesseract CLI**. `tesseract` and `tesserocr` are both offered here, but which engines are actually installed in this image is **unverified** |
| `ocr_lang` | `null` | Sidecar sends `["eng","ara"]` (Tesseract codes). EasyOCR uses different codes (e.g. `en`,`ar`). The schema says so explicitly. **Which codes this image accepts is unverified** |
| `images_scale` | **`2.0`** | Sidecar uses **4.0** (~288 dpi). 2.0 is ~144 dpi. This is the single knob that decided whether scanned CVs worked at all locally |
| `page_range` | `[1, …]` | no sidecar equivalent |
| `document_timeout` | `604800.0` | sidecar `SIDECAR_TIMEOUT_S=120` |
| `abort_on_error` | `false` | partial results are returned rather than refused |

`images_scale` **is** the real parameter name on this image — confirmed from the live schema,
not assumed.

---

## 8. Page and provenance data — VERIFIED

`json_content` is a full **`DoclingDocument`** (`schema_name: "DoclingDocument"`,
`version: "1.9.0"`) with:

- **`pages`** — an object keyed by page number, each `{size: {width, height}, image: {...}|null,
  page_no}`. The executed conversion returned keys `"1"` and `"2"` for a two-page PDF.
- **`texts[]`** — each item carries `label` (e.g. `section_header`, `text`) and
  **`prov[]`**, whose items are required to have `page_no` (int), `bbox`, `charspan`.
- `bbox` is `{l, t, r, b, coord_origin}` in **page points**, and the executed call returned
  `coord_origin: "BOTTOMLEFT"`.
- `origin` carries `{mimetype, binary_hash, filename, uri}`.
- Also present: `groups`, `tables`, `pictures`, `key_value_items`, `form_items`, `body`,
  `furniture`.

Observed on the two-page probe:

```
label=section_header  page=1  charspan=[0,83]   bbox=(72.0, 710.052, 320.92, 653.102)  BOTTOMLEFT
label=text            page=2  charspan=[0,45]   bbox=(72.0, 710.052, 270.408, 675.102) BOTTOMLEFT
```

**This is strictly more than the current sidecar provides.** The sidecar returns no `blocks`
and no page split, which is why the adapter derives structure from markdown and stamps page 1
on every block (open defect B4). `prov[].page_no` here is real per-page attribution, and the
bboxes are real geometry.

Two conversions are needed before this can feed the existing `RawBlock` shape:
`bbox` points → fractions of `pages[n].size`, and `BOTTOMLEFT` origin → the top-left origin the
`LayoutBox` contract specifies.

---

## 9. What is NOT available

- **No `ocrApplied` / OCR-used flag** in `ConvertDocumentResponse` or in `DoclingDocument`.
  Whether any given text item came from pixels is not reported at the document level. Whether
  it can be inferred from `DoclingDocument` internals is an open question for Step 3 and is
  **not** answered by this document.
- **No `pageCount` scalar** — derive from `len(json_content.pages)`.
- **No `detectedLanguages`** field.
- **No document-level status vocabulary matching the ATS contract.** `ConversionStatus` is
  `pending|started|failure|success|partial_success|skipped`; the ATS parser contract needs
  `ok|unsupported|encrypted|corrupt|empty`, and that classification would have to be derived
  from `status` plus `errors[].component_type` / `error_message`.

---

## 10. HTTP status codes and errors

| Code | Meaning (from the live document) |
|---|---|
| 200 | `ConvertDocumentResponse` or `PresignedUrlConvertDocumentResponse` (anyOf) |
| 422 | `HTTPValidationError` — `{"detail": [ValidationError, …]}` |

Only 200 and 422 are declared for the convert operations. Nothing else (401/403/404/413/500) is
declared for them. Document-level failures are expected **inside** a 200 response via
`status: "failure"` / `"partial_success"` and a populated `errors[]`, not via an HTTP code.

---

## 11. The one executed conversion

Input: a hand-built **two-page, 1 043-byte PDF** with neutral synthetic text and no personal
data (`"ARABTEC PARSER CONTRACT TEST"`, `"Page two of two. Second page marker: ZULU-77."`).
No CV and no PII were uploaded.

Request: `POST /v1/convert/file`, multipart, `files=@contract-probe.pdf`, `to_formats=md`,
`to_formats=json`, `do_ocr=false`, **no `X-Api-Key`**.

Result:

```
http=200  time=4.93 s (client)  bytes=91 516
status="success"  errors=[]  processing_time=2.189  timings={}
document.filename="contract-probe.pdf"
md_content=present   json_content=present   text_content=null (not requested)
json_content.pages = {"1": {...}, "2": {...}}
texts[0].prov[0].page_no = 1 ; texts[1].prov[0].page_no = 2
```

`md_content`:

```
## ARABTEC PARSER CONTRACT TEST Page one of two. Synthetic document. No personal data.

Page two of two. Second page marker: ZULU-77.
```

Response shape matched the OpenAPI exactly.

---

## 12. Operational observations from that single call

1. **Authentication is not enforced.** A secured operation returned a full conversion with no
   API key. Until a key is configured on the container, this endpoint is a public document
   converter — unacceptable for candidate CVs.
2. **`include_images=true` and `image_export_mode=embedded` are the defaults**, and they
   embedded a base64 PNG of each page at 144 dpi. A 1 KB PDF produced a **91 KB** response. For
   ATS use, send `include_images=false` (and `image_export_mode=placeholder`) or responses will
   be dominated by page rasters the ATS never looks at.
3. `timings` came back empty `{}` despite being in the schema.
4. `processing_time` 2.19 s server-side vs 4.93 s wall clock — roughly 2.7 s of network and
   queueing on a trivial document.
5. `document_timeout` defaults to **7 days**. A hung document will not fail fast unless this is
   set explicitly.

---

## 13. Cross-check against the current ATS parser contract

| ATS contract needs | Docling Serve 1.12.0 | Verdict |
|---|---|---|
| text | `md_content` / `text_content` | ✅ |
| markdown | `md_content` | ✅ |
| page count | `len(json_content.pages)` | ✅ derived |
| per-page text/blocks | `texts[].prov[].page_no` | ✅ **better than today** |
| bounding boxes | `prov[].bbox` (points, BOTTOMLEFT) | ✅ needs conversion |
| `ocrApplied` | — | ❌ **not reported** — Step 3 decision |
| `status` ∈ ok/unsupported/encrypted/corrupt/empty | `success/partial_success/failure/skipped` + `errors[]` | ⚠ must be derived |
| permanent vs temporary classification | HTTP 200/422 + `errors[].component_type` | ⚠ must be derived |
| Arabic OCR | `ocr_lang` exists; engine and codes unverified | ⚠ **Step 2** |
| OCR resolution control | `images_scale` (default 2.0 vs our 4.0) | ✅ present, must be set |
| bearer auth | `X-Api-Key`, currently unenforced | ⚠ config change |

---

## 14. OCR gate — executed results (2026-08-16)

Synthetic fixtures only. No CV or PII was sent. Engine matrix run against
`image-only-en.pdf`; Arabic against a newly generated genuine Arabic-script fixture (see §15).

### Test 4 — engine availability (all five respond; measured, not inferred)

`image-only-en.pdf`, `force_ocr=true`, `images_scale=4.0`, `include_images=false`:

| engine | http | status | time | chars | ground truth |
|---|---|---|---|---|---|
| `auto` | 200 | success | 15 197 ms | 313 | 5/5 |
| `easyocr` | 200 | success | 8 747 ms | 320 | 5/5 |
| `tesseract` | 200 | success | 12 307 ms | 321 | 5/5 |
| `tesserocr` | 200 | success | 7 222 ms | 253 | **4/5** |
| `rapidocr` | 200 | success | 14 965 ms | 313 | 5/5 |

### Test 1 — English scan — **PASS**

`tesseract`, `ocr_lang=["eng"]`, `do_ocr=true`, `force_ocr=false`, scale 4.0 → 200/success,
9 691 ms, 321 chars, **5/5** ground truth. Output matches the local sidecar's byte count exactly.

### Test 2 — Arabic scan — **FAIL, every engine, every code**

`scan-ar-true.pdf`, `force_ocr=true`, scale 4.0. Arabic glyphs counted by Unicode range:

| engine | codes tried | result |
|---|---|---|
| `tesseract` | `ara`, `ara+eng`, `ar` | 0 / 192 / 0 chars — **0 Arabic glyphs** |
| `easyocr` | `ar`, `ar+en`, `ara` | **HTTP 404** `"Task result not found. Please wait for a completion status."` |
| `tesserocr` | `ara`, `ara+eng`, `ar` | 404 / 99 chars / 404 — **0 Arabic glyphs** |
| `rapidocr` | `ar`, `ar+en`, `ara` | 200, 127 chars — **0 Arabic glyphs** |
| `auto` | `ar`, `ar+en`, `ara` | 200, 127 chars — **0 Arabic glyphs** |

**Root cause, confirmed:** `ocr_lang=["ara"]` on the *English* scan returns **0 chars** where
`["eng"]` returns 321. Tesseract cannot initialise with `ara`, i.e. **the Arabic traineddata is
not installed in this image**. The 404s from easyocr/tesserocr are crashed tasks surfacing
through the sync endpoint.

**Control — the fixture is valid.** The same file through the local sidecar (Tesseract with the
`ara` pack): 6 109 ms, `ocrApplied=true`, **107 Arabic glyphs**, recovering
`مصر · القاهرة · مهندس إنشائي أول في شركة أرابتك للإنشاءات · المؤهل الدراسي ·
بكالوريوس الهندسة المدنية جامعة القاهرة`. The failure is the RunPod image, not the document.

### Test 3 — two-page scan — **PASS**

`multipage-scan-en.pdf`, `force_ocr=true`, scale 4.0 → 200/success, 11 658 ms, 344 chars.
- page-2-only ground truth (`Cairo University`, `Primavera`, `PMP`): **3/3**
- `json_content.pages` keys: `["1","2"]`
- distinct `texts[].prov[].page_no`: `[1, 2]`
- texts carrying a bbox: **8/8**

Page count derivable as `len(pages)`. This is strictly better than the sidecar, which reports
no page split and stamps every block page 1.

### Test 5 — `images_scale` 2.0 vs 4.0

| scale | wall | server | chars | ground truth |
|---|---|---|---|---|
| 2.0 | 6 846 ms | 2.43 s | 321 | 5/5 |
| 4.0 | 7 146 ms | 2.92 s | 321 | 5/5 |

**Identical output.** Unlike the local sidecar — where 1.0 produced nothing and 4.0 was the fix —
this image reads the same scan correctly at 2.0. Evidence is one document, so 4.0 remains the
safe default at ~17 % more server time.

### Test 6 — OCR provenance — **NOT RELIABLE**

Keys anywhere in the returned `DoclingDocument` matching `/ocr|confid|recogni|source|method|engine/i`: **none**.
Text items expose `self_ref, parent, children, content_layer, meta, label, prov, orig, text,
formatting, hyperlink, level`; `prov[]` items expose only `page_no, bbox, charspan`.
`origin` is `{mimetype, binary_hash, filename, uri}`. **Nothing reports whether OCR ran.**

### Test 6b — a reliable *behavioural* substitute

| document | request | chars |
|---|---|---|
| born-digital `digital-en.pdf` | `do_ocr=false` | **450** |
| born-digital `digital-en.pdf` | `do_ocr=true` | 450 |
| born-digital `digital-en.pdf` | `force_ocr=true`, scale 4.0 | 469 |
| **scanned** `image-only-en.pdf` | `do_ocr=false` | **0**, `status=success`, `errors=[]` |

A scanned page with `do_ocr=false` returns zero characters and still reports success. That is
exactly the native-probe semantics the sidecar relies on, so `ocrApplied` can be **measured**
rather than configured — at the cost of one extra request (5.6 s on a scan that yields nothing).

## 15. Fixture correction

`image-only-ar.pdf` / `.png` — the fixture the matrix has been calling "image-only **Arabic** PDF"
— **contains no Arabic script at all.** Visual inspection and OCR both show a wholly Latin CV
("Ahmed Samir", "Cairo, Egypt", "Arabtec Construction"). Only the *name* is Arabic. Every prior
claim that Arabic OCR was verified — including in `FINAL_READINESS_REPORT.md` §A3 fixture D —
rests on that file and is therefore **unsupported**.

`scan-ar-true.pdf` / `.png` was generated for this gate: synthetic, 300 dpi, right-aligned,
rendered through Pillow with libraqm so the script is properly joined and bidi-ordered. Verified
legible by eye and read successfully by the local sidecar (107 Arabic glyphs). It should replace
`image-only-ar.*` as fixture D in the matrix.

---

## 16. Production configuration (what the adapter sends)

Selected by `DOCLING_BACKEND=serve`. Implemented in
`backend/src/infrastructure/ai/docling/docling-serve-client.ts`.

```
POST /v1/convert/file            multipart/form-data
X-Api-Key: <DOCLING_SERVE_API_KEY>          # server-side only, never in the frontend

files=@<document>
to_formats=md
to_formats=json                  # REQUIRED — the only source of page provenance
ocr_engine=tesseract             # DOCLING_OCR_ENGINE
ocr_lang=eng                     # DOCLING_OCR_LANGS (add ara when installed)
do_ocr=true
force_ocr=<decided per document> # see below
images_scale=4                   # DOCLING_IMAGES_SCALE; image default is 2.0
include_images=false             # image default true → 91 KB of rasters for a 1 KB PDF
document_timeout=<timeoutMs/1000># image default is 7 days
```

**`force_ocr` and `ocrApplied`.** Docling Serve reports nothing about whether OCR ran, so the
flag is established before the call: images are OCR'd by definition; anything else is asked of
the ATS's own local parser ("how many characters of native text does this already have?"), and
`force_ocr` follows the answer against `minNativeChars` (30, matching the sidecar). One remote
call per document. When the probe cannot answer, `ocrApplied` is left **unset** — never a silent
`false`.

**Status mapping** (`classifyStatus`) — this decides DELAYED vs TERMINAL for a CV:

| Docling Serve | ATS status | permanent? |
|---|---|---|
| `failure`/`skipped` + `password`/`encrypt` in `errors[]` | `encrypted` | yes |
| `failure`/`skipped` + `unsupported`/`format` | `unsupported` | yes |
| `failure`/`skipped`, otherwise | `corrupt` | yes |
| `success`/`partial_success` with empty text | `empty` | yes |
| `success`/`partial_success` with text | `ok` | — |
| HTTP 5xx / 401 / 403 / 404 / 429 / timeout / unreachable | thrown `SidecarError` | **no** — retryable |
| body with no `status` | thrown, `protocol` | no — retryable |

**Geometry.** `prov[].bbox` is absolute points with `coord_origin: BOTTOMLEFT`; the adapter
contract is fractions of the page with a top-left origin. The conversion is
`y = (pageHeight − t) / pageHeight`, and reading it as `t / pageHeight` would place every
citation on the wrong half of the page. Asserted in `docling-serve-client.test.ts` against a real
captured response.

**Page count** is `len(json_content.pages)`.

### Known limitations of this backend

- **Arabic OCR is unavailable** — the image has no `ara` traineddata (§14 Test 2). Arabic CVs
  return an explicit refusal, never a wrong candidate. The sidecar backend still reads Arabic.
- `/health` reports no Docling version; provenance records `unknown` rather than inventing one.
- Async endpoints are documented but unused; all conversions are synchronous.
