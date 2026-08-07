# Docling as the Document Intelligence Layer — Engineering Assessment

**Status:** assessment only. No code modified, nothing implemented, nothing committed.
**Question:** should IBM Docling replace the current text-extraction approach, and if so, where does it attach?
**Excluded by instruction:** Anthropic, DeepSeek, and any hosted provider. Not evaluated below.

---

## 0. Evidence basis and its limits

Architecture claims below are traced to files in this repository. Docling claims come
from my knowledge of the project as of May 2026 and are marked:

- **[verified-in-repo]** — checked against this codebase
- **[docling-stable]** — long-standing, structural properties of the project
- **[MEASURE]** — must be validated on your own corpus before it can be relied on

I have not run Docling against your CVs. Any number marked **[MEASURE]** is an
order-of-magnitude expectation, not a benchmark. Treat the distinction as load-bearing.

---

## 1. The headline finding

**Your target diagram is already this system's architecture.** Not approximately — stage
for stage:

| Your target stage | Existing component | State |
| --- | --- | --- |
| Upload CV | `POST /cv-intake` (multipart) | **Exists**, tested |
| Document Intelligence Layer | `DocumentParser` port — [capabilities.ts:39-48](backend/src/modules/shared/kernel/ai/capabilities.ts:39) | **Port exists, no real adapter** |
| Structured Markdown / JSON | `ParsedDocument` — [capabilities.ts:31-37](backend/src/modules/shared/kernel/ai/capabilities.ts:31) | **Exists but flat text only** — needs 2 optional fields |
| Local LLM Resume Extraction | `ResumeExtractor` port — [capabilities.ts:95-99](backend/src/modules/shared/kernel/ai/capabilities.ts:95) | **Port exists, no adapter** |
| Validation | `toProposedFields` + `Candidate` invariants + human review | **Exists**, tested |
| ATS Candidate JSON | `CandidateProposal` → `Candidate` | **Exists**, tested |

The gap between where you are and the target is **two adapters and one additive contract
change**. There is no missing layer, no missing pipeline, and no restructuring required.
That is the most important thing in this document, because it means the Docling decision
is a *component choice inside an existing seam*, not an architectural change — and it can
be reversed by deleting one file.

The requirement that the DI layer "later feed any local model (Qwen, Granite, Llama)
without changing ATS business logic" is **already satisfied by construction**:
`ResumeExtractor.extract(ParsedDocument)` names no model, and the guard at
[architecture.test.ts:265](backend/src/modules/architecture.test.ts:265) fails the build if
a port ever does.

---

## 2. The one hard constraint

**Docling is Python. This is a Node 22 monolith.** [docling-stable] / [verified-in-repo]

- Runtime: `node:22.11.0-slim`, `CMD ["node", "src/server.js"]` — [Dockerfile](Dockerfile)
- Zero `child_process` / `spawn` / `execFile` anywhere in `backend/src` — **verified by grep**
- Two `.py` files in the repo, both UAT scripts under `docs/uat/`, neither in the runtime

There are three ways to cross that boundary, and the choice determines everything else:

| Option | Verdict |
| --- | --- |
| **(a) Embed Python in the app image**, spawn a CLI per document | **Reject.** Puts a second runtime, a package manager and ~1 GB of model weights inside the app container; makes `npm ci && npm start` insufficient; introduces subprocess lifecycle management into a codebase that has none |
| **(b) `docling-serve` as a separate service** over HTTP | **Adopt.** Node stays pure. Deployment is already multi-service (app + Postgres); a third service is a deployment change, not an architecture change. Scales and restarts independently |
| **(c) Port Docling to JS** | Not viable. No equivalent exists; the layout and table models are the product |

Everything below assumes **(b)**.

---

## 3. The ten questions

### 1. Can Docling replace our current PDF/DOCX text extraction?

**Yes, and the bar is low.** [verified-in-repo]

- In the **new stack**, PDF and DOCX extraction does not exist at all.
  `PlainTextDocumentParser` accepts only `text/*` and `application/(json|xml)` and abstains
  permanently on everything else — [plain-text-parser.ts:17](backend/src/infrastructure/ai/plain-text-parser.ts:17). Its own header says PDF/DOCX
  "belongs in the AI phase".
- In the **legacy stack**, DOCX goes through `mammoth.extractRawText`
  ([extractor.js:151](backend/src/lib/cv/extractor.js:151)) — which discards every table,
  heading level and list structure by definition. PDF goes through hand-rolled pdfjs
  fragment assembly.

"Replace" is the wrong verb though. Correct framing: **Docling becomes the preferred
adapter; a pure-JS adapter remains the fallback floor.** See §5 on portability for why
that is not optional.

### 2. Can it improve multi-column CV reading order?

**Yes — and this is the strongest single technical argument in the assessment,** because
the current algorithm has a demonstrable failure mode, not a vague weakness.

`itemsToLines` groups PDF text fragments into lines by baseline Y coordinate
([extractor.js:67-102](backend/src/lib/cv/extractor.js:67)):

```js
for (const L of lines) { if (Math.abs(L.y - y) <= LINE_EPS) { bucket = L; break; } }
```

**In a two-column CV, the left column and the right column sit at the same Y.** They land
in the same bucket, get sorted left-to-right, and are emitted as one line. A skills sidebar
interleaves with employment history, one line at a time. The section detector and every
downstream regex then operate on text that never existed in the document.

Two-column templates are the dominant modern CV format. Docling's layout model produces
reading order from detected regions rather than from geometry alone [docling-stable], which
is precisely the class of problem the Y-bucketing approach cannot solve with any amount of
tuning.

**[MEASURE]** — quantify this before adopting: run the existing corpus, count CVs where a
skills token appears inside an employment line.

### 3. Can it improve OCR quality for scanned CVs?

**Yes, trivially — there is no OCR in this system today.** Any OCR is an improvement from
zero. A scanned CV currently produces empty text, indistinguishable from a corrupt file.

Docling integrates OCR engines (EasyOCR, Tesseract, RapidOCR) and applies layout analysis
around the OCR pass rather than OCR'ing a flat page [docling-stable] — which matters more
than raw character accuracy for multi-column scans.

**The open question is Arabic.** Both EasyOCR and Tesseract support Arabic script, but
quality on scanned, sometimes photocopied, mixed Arabic/English construction CVs is
genuinely uncertain and I will not estimate it. **[MEASURE]** — this is the single most
important measurement before OCR is enabled in production.

### 4. Can it preserve tables, sections and layout better than our current parser?

**Yes.** Docling's table structure model (TableFormer) reconstructs cell topology
[docling-stable]; the current pipeline has no table concept whatsoever.

Relevance is higher than it first appears for this specific market: MENA construction CVs
routinely put skills matrices, project lists, and language proficiency in tables. Today
those flatten into token soup, which is a plausible contributor to the section detector's
misfires.

### 5. Can it output Markdown or JSON suitable for a local LLM?

**Yes — that is its output contract** [docling-stable]: a structured document model
exportable to Markdown and JSON.

This matters for extraction quality. A local 7B-class model given structured markdown with
real headings performs materially better than the same model given a flattened blob,
because section boundaries stop being something the model has to infer. This is the
mechanism by which the DI layer improves extraction without the extractor changing.

**Architectural note:** the output type crossing the port must be **provider-neutral**.
`ParsedDocument` may gain `markdown?: string` and a generic structure field. It may **not**
gain a `DoclingDocument` type — that would name a provider in a port, and
[architecture.test.ts:265](backend/src/modules/architecture.test.ts:265) fails the build for
exactly that. The adapter maps Docling's model to the neutral shape; that mapping is the
adapter's whole job.

### 6. What additional dependencies would it introduce?

**As a sidecar: zero npm dependencies.** [verified-in-repo — `backend/package.json` unchanged]

Inside the sidecar image: Python 3.9+, PyTorch (CPU build), transformers, docling +
docling-core + docling-ibm-models, an OCR engine, and model weights. Realistically a
**1.5–2.5 GB container image** [MEASURE].

That is the honest cost, and it is a *deployment* cost, not a codebase cost. The
distinction is what keeps it reversible.

### 7. Does it fit our portability requirements?

**Partially — and this is where an unqualified "adopt" would be wrong.**

Your portability constraint is real and has already forced two decisions in this
repository: `pg_trgm` was dropped from the search migration because PGlite cannot load it,
and D-09 required a hand-written `DOMMatrix` polyfill
([extractor.js:26-54](backend/src/lib/cv/extractor.js:26)) after a platform-specific native
binding failed to load and made total library failure look like an empty CV.

A hard Docling dependency would mean `npm ci && npm start` no longer produces a working
system, and the test suite would need a Python service to run. **Both are unacceptable.**

**Mitigation, which the architecture already supports for free:**

- The adapter is **optional**, exactly as AI already is — `compose()` treats absent
  capabilities as a first-class configuration, not a degraded one
  ([composition-root.ts:167-172](backend/src/api/composition-root.ts:167))
- A pure-JS PDF/DOCX adapter remains the fallback floor
- Tests inject stubs — already the established pattern in
  [parsing.test.ts](backend/src/api/parsing.test.ts) and [intake.test.ts](backend/src/api/intake.test.ts)
- Sidecar unreachable ⇒ **temporary** abstention ⇒ task retries with backoff. The CV is
  never lost. This semantic already exists ([contracts.ts:79-95](backend/src/modules/shared/kernel/ai/contracts.ts:79))

With those, portability is preserved. Without them, adopting Docling breaks it.

### 8. Does it work fully offline?

**Yes, conditionally.** [docling-stable]

Models are fetched from HuggingFace on first use unless pre-downloaded. Offline operation
requires baking weights into the image at build time and pointing the artifacts path at
them.

**Concrete risk:** if this step is skipped, the first parse in a locked-down or air-gapped
deployment reaches out to the internet and fails — at runtime, in production, on a path
that looks like a parser bug. Make the model pre-fetch a build step, and assert it at
container start.

### 9. Is it suitable for Linux deployment?

**Yes — it is the primary target,** with official container images [docling-stable]. This
fits the Stage 2 VPS + Coolify plan in [DEPLOYMENT.md](docs/DEPLOYMENT.md) cleanly: Coolify
already orchestrates app + Postgres; docling-serve is a third resource with its own health
check.

**One thing to check before committing:** CPU architecture. If the VPS is ARM (Hetzner ARM
is cheap and commonly chosen), confirm an arm64 image exists for the pinned Docling version
and OCR engine, or budget for building one. **[MEASURE]**

### 10. Does it conflict with existing ATS architecture decisions?

**No conflicts. Three constraints it must respect:**

| Decision | Status |
| --- | --- |
| ADR-0001 pure domain | **Compatible** — adapter lives in `infrastructure/ai/`, invisible to the domain |
| AI is advisory ([contracts.ts:9-14](backend/src/modules/shared/kernel/ai/contracts.ts:9)) | **Compatible** — parsing produces proposals; a human still accepts every field |
| Async via outbox | **Compatible** — `AITaskWorker` already runs capabilities *outside* the transaction, so a 20 s parse holds no row lock |
| Ports name no provider ([architecture.test.ts:265](backend/src/modules/architecture.test.ts:265)) | **Constraint** — new `ParsedDocument` fields must be neutral; no Docling type crosses the port |
| Aggregates/repositories stay AI-free ([architecture.test.ts:283](backend/src/modules/architecture.test.ts:283)) | **Constraint** — structure data reaches the read model, never an aggregate |
| Portability | **Constraint** — see §7. Optional adapter + JS fallback + stub tests |

---

## 4. Recommendation

# PARTIAL ADOPT

**Adopt** Docling as the Document Intelligence layer, deployed as a **sidecar service**,
behind the **existing** `DocumentParser` port.

**Reject** in-process embedding, Python in the app image, and any arrangement that makes
Docling required for the system to boot or the tests to run.

Why "partial" rather than "adopt": an unconditional adoption breaks the portability
constraint that has already shaped two prior decisions in this repository. Docling as the
*preferred* adapter with a JS floor gets essentially all of the benefit and keeps
`npm ci && npm start` working. That is not hedging — it is the same optionality the AI
layer was built with, applied consistently.

---

## 5. Integration strategy

**Cleanest integration point: `DocumentParser`.** [capabilities.ts:39-48](backend/src/modules/shared/kernel/ai/capabilities.ts:39)

```
POST /cv-intake ──► CvIntakeService ──► ai_task (QUEUED)          [all exists]
                                             │
                              AITaskWorker claims, runs OUTSIDE tx [exists]
                                             │
                          ┌──────────────────▼──────────────────┐
                          │      DocumentParser (the port)      │
                          │  ┌───────────────────────────────┐  │
                          │  │ DoclingDocumentParser   [NEW] │──┼──HTTP──► docling-serve
                          │  │   → markdown + structure      │  │          (sidecar)
                          │  ├───────────────────────────────┤  │
                          │  │ PdfDocumentParser (JS) [NEW]  │  │  ← fallback floor
                          │  │ PlainTextDocumentParser       │  │  ← exists
                          │  └───────────────────────────────┘  │
                          └──────────────────┬──────────────────┘
                                             │ ParsedDocument {text, markdown?, structure?}
                          ┌──────────────────▼──────────────────┐
                          │      ResumeExtractor (the port)     │
                          │   LocalLlmResumeExtractor    [NEW]  │──► Qwen / Granite / Llama
                          │   (prefers markdown, falls to text) │    (swap = new adapter only)
                          └──────────────────┬──────────────────┘
                                             │
       toProposedFields ► CandidateProposal ► human review ► Candidate    [all exists]
```

**Total change surface:**

| Change | Files |
| --- | --- |
| Docling adapter | 1 new file in `infrastructure/ai/` |
| JS PDF/DOCX fallback adapter | 1 new file in `infrastructure/ai/` |
| Local LLM extractor | 1 new file in `infrastructure/ai/` |
| `ParsedDocument` + 2 optional fields | 1 edit, additive |
| Composition-root wiring | 1 edit |
| Deployment: sidecar service | `Dockerfile` / Coolify config |

**No new layer. No second pipeline. No adapter that exists only to be replaced.** Every
new file is a permanent implementation of a port that already exists.

### On "avoid parallel parsing systems" — the real duplication is already here

Docling does not create a parallel pipeline. **One already exists**, and it is the largest
technical-debt item in this assessment:

- `backend/src/lib/cv/*` — legacy heuristic parser, **serving production today** via
  `POST /candidates/parse-cv` ([candidates.js:216](backend/src/routes/candidates.js:216))
- `backend/src/infrastructure/ai/*` + `modules/talent/*` — new stack, **not running**
  (`package.json` `main` is `src/server.js`; nothing starts `api/main.ts`)

Adding Docling to the new stack while the legacy parser serves production creates a *third*
path unless the cutover is planned in the same breath. **Sequence the cutover with the
adoption, or the debt compounds rather than resolves.** This is the point at which "avoid
technical debt" is actually won or lost — not in the Docling decision itself.

---

## 6. Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Second runtime to operate, patch, monitor | **High** | Sidecar isolation; pin the image tag; own health check. Accept it as a real ongoing cost — this is the main price of adoption |
| Third parsing path if legacy cutover isn't sequenced | **High** | Plan cutover alongside adoption (§5) |
| Model weights not pre-fetched ⇒ runtime network call | **High** | Bake into image at build; assert at container start |
| Throughput on bulk intake | **High** | `BATCH` priority already exists ([schema/ai.ts:39](backend/src/infrastructure/db/schema/ai.ts:39)); bounded worker concurrency; separate pool |
| Arabic OCR quality unmeasured | **Medium** | Measure before enabling OCR; keep it a separate gate from layout parsing |
| Sidecar is a SPOF for parsing | **Medium** | Already handled: temporary abstention → retry with backoff. CV never lost |
| Docling version churn (young, fast-moving) | **Medium** | Pin exact version; adapter isolates the blast radius to one file |
| Image size 1.5–2.5 GB on a small VPS | **Medium** | Check disk headroom and deploy times on the Coolify target |
| ARM image availability | **Low–Medium** | Verify before committing to ARM hardware |

---

## 7. Performance impact

All figures **[MEASURE]** — order of magnitude, to be validated on your corpus and hardware.

| Path | Current | With Docling |
| --- | --- | --- |
| Text-based PDF | ~50–200 ms (pdfjs) | ~1–3 s (layout model, CPU) |
| DOCX | ~50–150 ms (mammoth) | ~0.5–2 s |
| Scanned PDF | **impossible** (empty text) | ~5–30 s/page with OCR |

**10–20× slower per document, in exchange for output that is structurally correct.**

Three reasons this is acceptable here, and one reason it needs care:

- Parsing already runs in `AITaskWorker`, **off the request path** — the recruiter is not
  waiting on it
- It runs **outside the transaction** — no row lock is held
- Retry and abstention semantics already exist

**The care:** bulk intake. A 200-CV batch at 10 s/CV is ~35 minutes single-threaded; with
OCR it is hours. Bounded concurrency on a dedicated `BATCH` pool is a precondition, not a
follow-up.

---

## 8. Portability impact

**Net: preserved, conditionally.** Three invariants must hold:

1. `npm ci && npm start` still yields a working ATS (with JS parsing)
2. The full test suite runs with **no** Python and **no** sidecar
3. Docling absent ⇒ temporary abstention ⇒ retry, never data loss

If any one is dropped, the constraint that removed `pg_trgm` has been abandoned, and it
should be abandoned explicitly and on the record rather than by accident.

---

## 9. Long-term maintenance impact

**Increase — concentrated in operations, not in code.**

| Dimension | Assessment |
| --- | --- |
| Code | **Low.** One adapter file. Port isolates churn |
| Ops | **Meaningful.** A Python service to patch, monitor, upgrade; CVEs in torch/transformers |
| Upgrades | **Medium.** Model changes alter output ⇒ must bump `DocumentParser.version` so proposals stay reproducible ([resume-parse-handler.ts:49-57](backend/src/infrastructure/ai/resume-parse-handler.ts:49)) |
| Reversibility | **High.** Delete one file, drop one service. The port is the exit |
| Lock-in | **Low.** MIT licensed, self-hosted, no vendor. Swapping to another DI engine is one adapter |

Reversibility is the point. This decision is cheap to unwind, which is why it can be made
now on partial information — provided the port boundary is respected absolutely.

---

## 10. Migration roadmap

### Phase 0 — Baseline *(prerequisite; no Docling)*

Build the synthetic corpus from the preprocessing assessment (§4 of
[CV_PREPROCESSING_INTEGRATION.md](docs/CV_PREPROCESSING_INTEGRATION.md)) and measure the
current parser: field-level precision/recall, the multi-column failure rate from §3.2
above, and the image-only percentage of real inbound CVs.

**Without this you cannot demonstrate that Docling improved anything.** It is also what
decides whether OCR (Phase 4) is worth its cost.

### Phase 1 — Contract + JS floor *(no new runtime, valuable regardless)*

1. `ParsedDocument` gains `markdown?: string` and a neutral `structure?` field — additive,
   optional, existing implementations stay valid
2. `GenerationProvenance` gains `documentIntelligenceVersion`
3. Real **JS** PDF/DOCX `DocumentParser` adapters — the permanent fallback floor

**Gate:** contract review. This phase is independently useful even if Docling is rejected.

### Phase 2 — Docling sidecar *(off by default)*

4. `docling-serve` as a Coolify resource, pinned version, models baked in, own health check
5. `DoclingDocumentParser` adapter, mapping Docling's model → neutral `ParsedDocument`
6. Wired only when configured; absent ⇒ JS floor

**Gate:** Phase 0 benchmark re-run. Adopt only if reading-order accuracy improves
measurably.

### Phase 3 — Local LLM extraction

7. `LocalLlmResumeExtractor` against the `ResumeExtractor` port, consuming `markdown` when
   present. Model choice (Qwen / Granite / Llama) is an adapter-internal decision by
   construction

**Gate:** extraction accuracy vs the Phase 1 rule-based baseline.

### Phase 4 — OCR *(business decision, data-driven)*

8. Enable OCR in the sidecar **only if** Phase 0 shows a material image-only rate
9. Measure Arabic OCR quality separately before trusting it

### Phase 5 — Legacy cutover

10. Retire `lib/cv/*` and route `POST /candidates/parse-cv` to the new stack. **Without
    this the parallel pipeline is permanent.**

---

## 11. Summary

| | |
| --- | --- |
| **Recommendation** | **PARTIAL ADOPT** — sidecar service, behind the existing `DocumentParser` port, optional, with a pure-JS fallback floor |
| **Integration point** | `DocumentParser` — [capabilities.ts:39-48](backend/src/modules/shared/kernel/ai/capabilities.ts:39). One port, several adapters |
| **Contract change** | Two optional fields on `ParsedDocument`. Additive. Provider-neutral |
| **Biggest technical win** | Multi-column reading order — a demonstrable defect in `itemsToLines`, unfixable by tuning |
| **Biggest risk** | Not Docling — the *existing* legacy/new parallel pipeline. Sequence the cutover or the debt compounds |
| **Biggest unknown** | Arabic OCR quality on scanned CVs. **[MEASURE]** |
| **Reversibility** | Delete one adapter file, drop one service |

The architecture does not need to change to accommodate Docling. It was built with this
seam in it. The decision is which implementation fills it, and that decision should be made
on Phase 0 numbers rather than on this document.
