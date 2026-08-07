# Document-Processing Integration Assessment

**Status:** evaluation only — nothing implemented, nothing committed.
**Subject:** whether 17 document-processing capabilities from a separate CV-parsing
project should be adopted, and if so, where they belong.
**Constraint:** the ATS parser is not to be rewritten or replaced.

---

## 0. Method and its limits

This assessment compares the *named capabilities* against the ATS parsing
architecture as it actually exists in this repository. I have read:

| What | Where |
| --- | --- |
| Capability ports | `backend/src/modules/shared/kernel/ai/capabilities.ts` |
| Outcome / provenance contracts | `backend/src/modules/shared/kernel/ai/contracts.ts` |
| Parse pipeline wiring | `backend/src/infrastructure/ai/resume-parse-handler.ts` |
| The only real parser today | `backend/src/infrastructure/ai/plain-text-parser.ts` |
| Task execution | `backend/src/infrastructure/ai/task-worker.ts`, `schema/ai.ts` |
| Legacy production parser | `backend/src/lib/cv/*` |

**I have not seen the other project's source.** Every judgement below is about the
capability as described, not about that team's implementation of it. Two things
would change the numbers materially and are worth supplying before Phase B is
approved: their dependency list, and their measured accuracy delta on real
scanned CVs. If you share the repository I can turn this into a genuine diff.

---

## 1. The headline answer

> *"Should these become a preprocessing layer before our existing parser?"*

**No — not as one layer, and not "before".** Two of the seventeen belong in front
of nothing; five are not parser features at all. Forcing them into a single
pre-parser stage would be the one change that actually damages the architecture.

Here is why the framing matters. `runResumeParse` fetches the document bytes
once and hands them to a `DocumentParser`. A literal preprocessing layer *before*
that would:

1. **Create a second reader of document bytes.** Storage access is currently one
   call in one place. Two readers means two failure modes, two abstention
   vocabularies, and a blob fetched twice per parse.
2. **Put a rejection decision outside the abstention model.** This is the
   expensive mistake. "Rejected in preprocessing" would not be an `AIOutcome`,
   so it would not inherit `permanent` vs `temporary` — and that distinction is
   the entire reason a CV is not silently discarded when a GPU is offline
   (`contracts.ts:79-95`). A preprocessing layer that returns its own result type
   re-implements retry, backoff, and terminal-state semantics badly.
3. **Bypass provenance.** A proposal must be reproducible from
   `GenerationProvenance` (`resume-parse-handler.ts:49-57`). A preprocessing step
   that alters the text a model sees, without recording that it did, silently
   breaks reproducibility for every proposal generated after it ships.

**The correct shape: `DocumentParser` composes.** The port already accepts raw
bytes and returns `AIOutcome<ParsedDocument>`. A preprocessing decorator *is* a
`DocumentParser` — it wraps the format-specific parsers, may abstain with the
existing semantics, and reports its own `version`. The composition root remains
the only file that knows the arrangement.

```
                    ┌─────────────────── DocumentParser (the port) ──────────────────┐
runResumeParse ───► │  PreprocessingParser                                           │
                    │    ├─ classify (pre-scan: text-bearing? image-only? encrypted?)│
                    │    ├─ delegate ─► PdfTextParser | DocxParser | PlainTextParser │
                    │    ├─ [Phase B] rasterize ─► quality gate ─► OCR ─► text       │
                    │    └─ normalize (+ index map) ─► ParsedDocument + diagnostics  │
                    └────────────────────────────────────────────────────────────────┘
                                              │
                              unchanged ──────▼──────
                          ResumeExtractor ─► toProposedFields ─► Proposal / IntakeItem
```

Nothing above the port changes. No domain change. No API change. No new
messaging. `AITaskWorker` already runs the capability **outside** the transaction,
so a 20-second OCR holds no row lock.

---

## 2. Where the seventeen actually land

They are not one thing. They are four.

| Category | Capabilities | Touches the ATS how? |
| --- | --- | --- |
| **A. Inside the parser adapter** — a swap of one injected implementation | pre-scan, blur, skew, darkness, near-blank, rasterization, OCR prep, multilingual normalization, thresholds | Composition root only |
| **B. Additive contract fields** — optional, so absence is legal | quality score, diagnostics, index mapping, parser confidence | `ParsedDocument`, intake-item read model |
| **C. Pure infrastructure** — no product surface | structured logging, health metrics | Existing `/health`, existing logger |
| **D. Test and measurement** — no production code path | synthetic framework, benchmarking | Test tree only |

Category D is the one to build **first**, which is the least obvious conclusion
in this document. See §4.

---

## 3. Capability-by-capability assessment

Complexity and performance are relative to this codebase, not absolute.
Performance is measured per document at parse time — all of it runs in the AI
worker, off the request path, outside any transaction.

| # | Capability | Business value | Technical complexity | Performance impact | ATS impact | Priority | Recommendation |
|---|---|---|---|---|---|---|---|
| 1 | **CV quality scoring** | Medium — one number a recruiter can act on ("re-scan this"). Worthless before the detectors that feed it | **Low** — a weighted sum of §3 items 2–6 | Nil (arithmetic) | Additive field on intake item. Must never gate a transition | **Medium** | **Integrate later** |
| 2 | **Image pre-scan** | **High** — decides whether OCR is needed at all. Today an image-only PDF yields empty text indistinguishable from a corrupt file | **Low** — count text items per page; pdfjs already loaded (`lib/cv/extractor.js:117-127`) | ~5 ms/doc | Turns a mystery failure into a stated reason | **High** | **Integrate now** |
| 3 | **Blur detection** | Medium — prevents confident garbage from OCR on a phone photo | Medium — variance-of-Laplacian over a rasterized page | 30–80 ms/page *on top of* rasterization | Advisory only | **Medium** | **Integrate later** (bundle with OCR) |
| 4 | **Skew detection** | Medium — but **deskewing** is worth several accuracy points to OCR; detection alone is worth little | Medium — projection profile or Hough | 40–120 ms/page | Advisory + corrective | **Medium** | **Integrate later** — implement as *deskew*, not a report |
| 5 | **Darkness detection** | Low–Medium — photocopied and faxed CVs are common in this market | **Low** — histogram mean and contrast | <10 ms/page *if it shares the raster pass* | Advisory only | **Low** | **Integrate later** (same pass as 3 and 6) |
| 6 | **Near-blank detection** | Medium — catches cover sheets, fax separators, "page 1 of 1 uploaded by mistake" | **Low** — ink coverage ratio | <10 ms/page | Advisory; may abstain **permanently** | **Medium** | **Integrate later** for images. The *text* equivalent already exists (`plain-text-parser.ts:44-49`) and should be extended to PDF now |
| 7 | **Automatic rasterization** | **Enabling only** — no value alone; unlocks 3–6 and OCR | **High** — this is the native-dependency risk (see §6) | **200–600 ms/page, 20–80 MB peak/page at 300 DPI.** The dominant cost in the whole list | None if bounded; severe if unbounded | **High but conditional** | **Integrate later**, gated on the OCR decision. Never ship standalone |
| 8 | **OCR preparation** | **High** — scanned CVs are a large share of this market's inbound. Today they are a total loss | High — binarize, denoise, DPI-normalize, deskew | Dominated by #7 plus 1–3 s/page for the engine | Largest single capability unlock | **High** | **Integrate later** — as a package with an actual OCR engine |
| 9 | **Multilingual normalization** | **High** and under-served — see §3.1 | **Low** — pure string functions; a correct version already exists at `lib/cv/section-detector.js:9-26` | <5 ms/doc | Improves parsing **and** the search feature already shipped | **High** | **Integrate now** |
| 10 | **Index mapping (normalized ↔ original)** | **High** — cheap now, expensive to retrofit. See §3.2 | Low–Medium *if built with #9*; a rewrite if built after | Nil | Makes `evidence` on a proposed field citable to an exact offset | **High** | **Integrate now** — inseparable from #9 |
| 11 | **Document diagnostics** | **High** — makes a parse failure explainable to a recruiter and debuggable **without possessing the CV** (PII-safe) | Low — a struct populated by stages that already run | Nil | Additive optional field; surfaces on the intake-item read model | **High** | **Integrate now** |
| 12 | **Parser confidence scoring** | **High** — drives review triage. Today one flat number is halved for `uncertainFields` (`resume-parse-handler.ts:79-96`); the legacy engine's method × validation decomposition is strictly better | Low — port `lib/cv/confidence-engine.js:8-42` as a pure function | Nil | **See §3.3 — one part of the legacy engine must not be ported** | **High** | **Integrate now** (partially) |
| 13 | **Structured parser logging** | **High** — per-stage timing and outcome is how you find out *which* stage regressed | **Low** — `correlationId`, `lastError`, `abstainReason` already exist (`schema/ai.ts:49-53`) | Nil | Operational only | **High** | **Integrate now** |
| 14 | **Configurable thresholds** | Medium — needed the moment a detector exists; meaningless before | Low — injected adapter config | Nil | **Must bump `DocumentParser.version`** — see §5 | **Medium** | **Integrate later** (with the detectors) |
| 15 | **Synthetic testing framework** | **High** — and it is a *precondition*, not a companion. You cannot honestly set a blur threshold without labelled ground truth, and you cannot use real CVs as fixtures | Medium — generate documents in-process with known expected output | Test-time only | Zero production surface | **High** | **Integrate now — first** |
| 16 | **Parser benchmarking** | Medium — field-level precision/recall against ground truth, tracked over time. Latency alone is the less useful half | Low **once #15 exists**; impossible before | Test-time only | Zero production surface | **Medium** | **Integrate later** |
| 17 | **Parser health metrics** | Medium — abstention rate by reason, permanent:temporary ratio, OCR fallback rate, proposal acceptance rate | Low — extend the existing endpoint, do not add a metrics system | Nil | `/health` already reports `aiBacklog` (`server.ts:84-89`) | **Medium** | **Integrate later** |

### 3.1 Why multilingual normalization is rated High

This is the item most likely to be under-valued, because "we mostly get English
CVs" is true and irrelevant. The failures are silent:

- **Arabic-Indic digits.** `٠١٢٣٤٥٦٧٨٩` are not `0-9`. A phone number written
  `٠١٠٠١٢٣٤٥٦٧` matches no phone regex, so `phone` is never proposed — and
  `dedupPhone` (`talent/infrastructure/mappers.ts:33-39`) strips non-digits and
  returns `null`, so **duplicate detection silently stops working** for those
  candidates.
- **Letter variants.** `أحمد` and `احمد` are the same person and different
  strings. The search feature shipped last week indexes
  `to_tsvector('simple', search_text)` — `'simple'` applies no Arabic folding
  whatsoever, so those two spellings never match each other.
- **Bidi contamination.** PDF text extraction of mixed Arabic/English routinely
  emits embedded RLM/LRM marks and visually-reordered runs. These survive into
  `search_text` as invisible characters that break exact matching.

The repository already contains a correct fold (`foldArabic`, tatweel and
diacritic stripping) — but it is scoped to *section-heading detection only* and
never touches extracted values or the search blob. Promoting it to a shared
normalizer is low-cost, high-yield, and improves a feature that already exists.

### 3.2 Why index mapping is rated High despite sounding like plumbing

The moment you normalize, offsets into the normalized text no longer point at the
original. `ProposedField.evidence` is currently a free-text hint
(`"employment: Orascom"`). With an index map it can become an exact span, which
is what lets a review screen highlight the sentence a value came from — the
single most effective thing you can do to make human review fast and honest.

Retrofitting this later means re-plumbing every normalization step. Building it
alongside #9 is nearly free. This is the one item where "integrate later" has a
real, compounding cost.

### 3.3 The part of the legacy confidence engine that must NOT be ported

`lib/cv/confidence-engine.js` contains two separable things:

- **`fieldConfidence` / `summarise`** (lines 8–72) — deterministic, explainable,
  decomposes into method × validation. **Port this.** It is strictly better than
  the current flat-confidence-halved approach and it is pure.
- **`deriveStatus` / `STATUS.DONE` / `DONE_MIN_CONFIDENCE = 0.75`** (lines 88–117)
  — **do not port this.** It is a business rule wearing a parser's clothing: it
  decides that a CV is "done" when a confidence number crosses 0.75. `contracts.ts:62-69`
  states the prohibition directly — *"a rule that fires at 0.61 and not at 0.59 is
  a business rule whose threshold lives in a model's calibration, which is
  untestable and unauditable."*

The equivalent decision in the new architecture is already correctly placed: a
human reviews per-field proposals, and `CvIntakeItem` status is set by that human
act. Porting `deriveStatus` would re-introduce exactly the coupling the Talent
context was built to remove.

---

## 4. Why the test framework comes first

Every image-quality capability (3, 4, 5, 6) is a **threshold over a continuous
measurement**. Shipping one without a labelled corpus means the threshold is a
guess, and a guessed threshold on a rejection path throws away real candidates'
CVs.

The corpus must be **synthetic**, for three independent reasons:

1. **PII.** Real CVs cannot become test fixtures. Under GDPR/PDPL a candidate's
   CV committed to a repository is a disclosure with no lawful basis and no
   deletion path.
2. **Portability.** The project must run anywhere — the constraint that already
   forced `pg_trgm` out of the search migration and forced a hand-written
   `DOMMatrix` polyfill (`lib/cv/extractor.js:26-54`). Binary fixture blobs work
   against that; in-process generation does not.
3. **Ground truth.** You can only measure extraction accuracy if you know the
   right answer. A generated CV knows its own name, phone, and employer.

Required corpus dimensions: clean digital PDF · DOCX · image-only PDF · scanned
at 150/200/300 DPI · skewed 1°/3°/7° · blurred (three levels) · under-exposed ·
near-blank · Arabic-only · mixed Arabic/English · Arabic-Indic digits ·
encrypted/password-protected · zero-page/corrupt.

This corpus also retro-fits value to the *existing* parser, independently of
whether any preprocessing ships.

---

## 5. Contract changes required

Minimal and strictly additive. Existing implementations stay valid because every
new field is optional.

**`ParsedDocument`** (`capabilities.ts:31-37`) — add:

- `qualityScore?: number` (0..1, advisory)
- `diagnostics?: DocumentDiagnostics` — page count, text-bearing page count,
  image-only pages, detected scripts, per-page metrics, whether OCR ran
- `indexMap?: IndexMap` — normalized↔original offset mapping
- `normalizationVersion?: string`

**`GenerationProvenance`** (`resume-parse-handler.ts:49-57`) — extend so a
proposal remains reproducible:

- `preprocessorVersion`, `ocrEngineId`, `thresholdProfileId`

**Non-negotiable rule on thresholds.** A threshold change is a behaviour change.
Any adjustment must bump `DocumentParser.version`, because that version is what
tells you which proposals were generated under the old calibration. Thresholds
are **adapter configuration injected at the composition root** — not
`PlatformConfig`, and never visible to the domain.

**What does not change:** `ResumeExtractor`, `toProposedFields`, `AITaskWorker`,
the outbox, the event bus, every domain aggregate, every controller, every route,
and the architecture guards.

---

## 6. Risks

| Risk | Severity | Note |
| --- | --- | --- |
| **Native dependencies** (`sharp`, `canvas`, `tesseract`) break portability | **High** | This exact class of bug already bit this project once — D-09, where `@napi-rs/canvas`'s platform-specific binding failed to load and made a total library failure look like an empty CV. Any Phase B dependency must be evaluated against that precedent, and must fail *loudly* |
| **Memory** — rasterizing a 300-page scanned PDF | **High** | Compounded by the known debt that multer buffers uploads in memory. Requires a hard page cap, a streaming raster, and a per-worker concurrency limit before OCR ships |
| **Silent discard** — a preprocessing rejection that loses a CV | **High** | Mitigated by rule: preprocessing may *abstain* or *annotate*, never delete. A permanent abstention still leaves the file, the batch item, and a stated reason |
| **Confidence creep** — a quality score starts gating something | Medium | Guard-testable: assert no domain or application module imports the diagnostics type |
| **Throughput collapse** on bulk intake | Medium | A 200-CV batch at 3 s/page OCR is hours. Needs `BATCH` priority to route to a separate worker pool — the priority field already exists (`schema/ai.ts:39`) |
| **PII in logs** | Medium | Rule already established in the codebase: *"Never log CV content"* (`lib/cv/extractor.js:133`). Diagnostics must carry metrics, never text |

---

## 7. Roadmap

### Phase A — no new dependencies, no new layer *(recommended to approve)*

Everything here is pure TypeScript, portable, and independently valuable even if
Phase B is never approved.

1. **Synthetic corpus + generator** (#15) — first, because it validates the rest
2. **Structured stage logging** (#13) — extends existing correlation IDs
3. **`DocumentDiagnostics` contract + intake-item surface** (#11)
4. **Image pre-scan** (#2) — classify text-bearing vs image-only; abstain
   *permanently* with a stated reason on image-only, instead of empty text
5. **Multilingual normalization + index map** (#9, #10) — promote `foldArabic`,
   add Arabic-Indic digit folding and bidi-mark stripping; feed the same
   normalizer into `searchTextOf`
6. **Confidence decomposition** (#12, partial) — port method × validation;
   explicitly **not** `deriveStatus`
7. **Real PDF/DOCX `DocumentParser` adapters** — not on your list, but Phase A is
   the natural home: the ports exist and only `PlainTextDocumentParser` fills them

**Exit gate:** benchmark Phase A against the corpus. Publish the numbers. That
measurement is what makes the Phase B decision a decision rather than a guess.

### Phase B — rasterization and OCR *(a business decision, not a technical one)*

Gated on one question: **what fraction of real inbound CVs are image-only?**
Phase A's pre-scan answers it with data within weeks of shipping.

If the answer is under ~5%, Phase B is not worth the dependency risk — route
those files to manual entry, which the intake workflow already supports. If it is
20%+, it is the highest-value work remaining.

8. Rasterization (#7) with hard page/memory/time caps
9. Quality detectors (#3, #4, #5, #6) — **one raster pass, all four metrics**
10. OCR preparation + engine (#8), behind the same `DocumentParser` port so it can
    later move to its own process or service without a business-layer edit
11. Threshold profiles (#14), calibrated against the Phase A corpus
12. Composite quality score (#1)

### Phase C — measurement

13. Benchmark suite in CI (#16) — accuracy *and* latency, tracked over time
14. Health metrics (#17) — extend `/health`, do not add a metrics stack

---

## 8. Rules this integration must not break

1. Preprocessing lives **behind** `DocumentParser`, never before the pipeline.
2. Preprocessing may **abstain or annotate — never discard**.
3. Every quality number is **advisory**. No threshold gates a state transition.
4. No provider-specific type (OCR engine, image library) escapes the adapter.
5. The system works with **no preprocessing configured** — same rule AI already
   follows; absent is a first-class configuration, not a degraded one.
6. Every behaviour change bumps a **version** recorded in provenance.
7. **Never log CV content.**
8. Domain, Application, Infrastructure and API layers stay **frozen**. Phase A
   touches the AI adapter, the kernel contracts (additively), the composition
   root and the test tree. Nothing else.

---

## 9. Summary

| Recommendation | Capabilities |
| --- | --- |
| **Integrate now** (6) | image pre-scan · multilingual normalization · index mapping · document diagnostics · parser confidence scoring *(partial)* · structured logging · synthetic testing framework |
| **Integrate later** (10) | quality scoring · blur · skew · darkness · near-blank · rasterization · OCR preparation · configurable thresholds · benchmarking · health metrics |
| **Unnecessary** (0) | none — but `deriveStatus` from the legacy confidence engine must be **excluded** when porting #12, and rasterization (#7) is unnecessary *on its own*: it has no standalone value and must never ship without OCR |

Nothing here is unnecessary in principle. The distinction that matters is that
seven items are portable pure-TypeScript work with immediate value, and ten are
gated behind a native-dependency decision that should be made with data Phase A
will produce.

If Phase A is approved it should be recorded as an ADR (0012 is already owed for
the Phase 2.5 shared-kernel extraction, so this would be **0013**).
