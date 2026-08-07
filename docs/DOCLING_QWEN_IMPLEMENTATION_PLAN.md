# Implementation Plan — Docling + Qwen/Ollama

**Target (fixed):** Upload → IBM Docling → Local LLM (Qwen via Ollama) → Resume Extraction → Validation → Candidate JSON → ATS
**Scope:** file-level actions only. No architecture changes. Nothing implemented yet.

---

## 1. Inventory

### 1.1 Which legacy parsing components become obsolete

| File | Responsibility | Superseded by | Obsolete |
| --- | --- | --- | --- |
| [lib/cv/extractor.js](backend/src/lib/cv/extractor.js) | bytes → text, PDF line assembly | Docling | **Yes** |
| [lib/cv/section-detector.js](backend/src/lib/cv/section-detector.js) | heading → canonical section | Docling markdown headings | **Yes** — except `foldArabic`, see §1.3 |
| [lib/cv/entity-parser.js](backend/src/lib/cv/entity-parser.js) | per-field regex detection | Qwen `ResumeExtractor` | **Yes** |
| [lib/cv/confidence-engine.js](backend/src/lib/cv/confidence-engine.js) | method × validation scoring | `ProposedField.confidence` | **Yes** |
| [lib/cv/validator.js](backend/src/lib/cv/validator.js) | plausibility checks | `Candidate` invariants + review | **Yes** |
| [lib/cv/dictionaries.js](backend/src/lib/cv/dictionaries.js) | term lists | Qwen; optionally `SkillNormalizer` | **Yes** |
| [lib/cv/index.js](backend/src/lib/cv/index.js) | orchestration | `runResumeParse` | **Yes** |
| [lib/cv/ai-parser.js](backend/src/lib/cv/ai-parser.js) | **Anthropic hosted** | — removed outright | **Yes — delete now** |
| [lib/cv-parser.js](backend/src/lib/cv-parser.js) | facade | — | **Yes** |
| [lib/cv-mapper.js](backend/src/lib/cv-mapper.js) | entities → candidate columns | `toProposedFields` | **Yes** |
| [lib/cv-watcher.js](backend/src/lib/cv-watcher.js) | folder watcher + **DeepSeek hosted** | — removed outright | **Yes — delete now** |

`PlainTextDocumentParser` is **not** obsolete — it stays as the zero-dependency floor so the
suite runs with no sidecar.

### 1.2 Which files should be deleted

**Wave 1 — hosted AI removal. Safe now; changes no parsing behaviour.**

| Action | File | Note |
| --- | --- | --- |
| Delete | `backend/src/lib/cv/ai-parser.js` | Anthropic. Already dead — `@anthropic-ai/sdk` not installed |
| Delete | `backend/src/lib/cv-watcher.js` | DeepSeek |
| Edit | [server.js:14, :237-238](backend/src/server.js:14) | Drop `startWatcher`/`getWatcherStatus` import + call |
| Edit | `backend/src/routes/*` | Remove `/api/health/watcher` route |
| Edit | [lib/cv-parser.js:20, :37-56](backend/src/lib/cv-parser.js:20) | Drop `claudeParse`, `aiExtract`, `isAiEnabled`, `aiGateStatus` |
| Edit | [lib/cv/index.js:18, :121](backend/src/lib/cv/index.js:18) | Drop AI imports/re-exports |
| Edit | [feature-flags.js:39-40](backend/src/lib/feature-flags.js:39) | Remove `feature.ai_parsing`, `feature.ai_scoring` |
| Edit | [lib/config.js:49-51](backend/src/lib/config.js:49) | Remove hosted-key warnings |
| Edit | `backend/.env`, `backend/.env.example` | Remove `DEEPSEEK_*`, `ANTHROPIC_*`, `CV_AI_PARSING_ENABLED` |
| Migration | `system_setting` | Delete the two `feature.ai_*` rows |

> **Action required outside this repo:** `DEEPSEEK_API_KEY` is live in `backend/.env`
> (35 chars). Deleting the line does not revoke it. **Revoke the key at the provider** —
> it has been on disk and in shell environments.

**Wave 2 — legacy parser removal. Only after §3 cutover and a green benchmark.**

Delete `backend/src/lib/cv/` (7 remaining files), `cv-parser.js`, `cv-mapper.js`;
rewrite the two call sites at [candidates.js:222-225](backend/src/routes/candidates.js:222)
and [candidates.js:564-566](backend/src/routes/candidates.js:564).

**Do not delete Wave 2 before Wave 1 ships and the cutover is proven.** `POST /candidates/parse-cv`
is live production.

### 1.3 Which files remain unchanged

Everything below is untouched. Ports and domain are unchanged by construction.

- **All domain files** — `modules/*/domain/**` (hiring, interview, offer, talent, matching)
- **All application services** — including [candidate-service.ts](backend/src/modules/talent/application/candidate-service.ts), [intake-service.ts](backend/src/modules/talent/application/intake-service.ts), [proposal-service.ts](backend/src/modules/talent/application/proposal-service.ts)
- **All repositories, UoW, mappers, migrations**
- **The whole outbox/event stack**
- **[resume-parse-handler.ts](backend/src/infrastructure/ai/resume-parse-handler.ts)** — calls the ports only; new adapters drop in behind it with **zero edits**
- **[task-worker.ts](backend/src/infrastructure/ai/task-worker.ts)**, [task-dispatcher.ts](backend/src/infrastructure/ai/task-dispatcher.ts)
- **[plain-text-parser.ts](backend/src/infrastructure/ai/plain-text-parser.ts)** — retained as the floor
- **All controllers, routes, read models** in `api/`

**One exception, carried forward from legacy:** `foldArabic` +
Arabic-Indic digit folding ([section-detector.js:9-26](backend/src/lib/cv/section-detector.js:9)).
Neither Docling nor an LLM does this reliably, and `dedupPhone`
([mappers.ts:33-39](backend/src/modules/talent/infrastructure/mappers.ts:33)) silently returns
`null` for Arabic-Indic numerals today. **Port it, don't delete it** — see §3 Step 2.

### 1.4 Which adapters must be created

Four new files, all in `backend/src/infrastructure/ai/`:

| File | Implements | Talks to |
| --- | --- | --- |
| `docling-document-parser.ts` | `DocumentParser` | `docling-serve` over HTTP |
| `ollama-resume-extractor.ts` | `ResumeExtractor` | Ollama `/api/generate` |
| `ollama-client.ts` | — (thin transport) | Ollama; shared, no domain knowledge |
| `text-normalizer.ts` | — (pure functions) | nothing; Arabic/Latin folding |

Nothing else is created. No new layer, no new service class, no new pipeline.

### 1.5 Which interfaces already satisfy the target architecture

All of them. **No port changes required.**

| Target stage | Interface | File | Change |
| --- | --- | --- | --- |
| Document Intelligence | `DocumentParser` | [capabilities.ts:39-48](backend/src/modules/shared/kernel/ai/capabilities.ts:39) | none |
| Structured output | `ParsedDocument` | [capabilities.ts:31-37](backend/src/modules/shared/kernel/ai/capabilities.ts:31) | **+2 optional fields** |
| LLM extraction | `ResumeExtractor` | [capabilities.ts:95-99](backend/src/modules/shared/kernel/ai/capabilities.ts:95) | none |
| Abstention/retry | `AIOutcome` | [contracts.ts:96-103](backend/src/modules/shared/kernel/ai/contracts.ts:96) | none |
| Async submission | `AITaskDispatcher` | [contracts.ts:147-152](backend/src/modules/shared/kernel/ai/contracts.ts:147) | none |
| Wiring | `AICapabilities` | [capabilities.ts:227-235](backend/src/modules/shared/kernel/ai/capabilities.ts:227) | none |
| Validation | `Candidate` invariants + `CandidateProposal` | `modules/talent/domain/` | none |
| Reproducibility | `GenerationProvenance` | [resume-parse-handler.ts:49-57](backend/src/infrastructure/ai/resume-parse-handler.ts:49) | **+2 optional fields** |

Model swap (Qwen → Granite → Llama) = new `ResumeExtractor` adapter + one composition-root
line. Guaranteed by the guard at [architecture.test.ts:265](backend/src/modules/architecture.test.ts:265),
which fails the build if any port names a provider.

### 1.6 Which existing tests remain valid

**All 39 vitest suites remain valid and must stay green.**

[parsing.test.ts](backend/src/api/parsing.test.ts) and [intake.test.ts](backend/src/api/intake.test.ts)
already inject **stub** capabilities into `compose()`. They exercise the pipeline, not a
provider — so real adapters change nothing for them. That is the design working.

[architecture.test.ts](backend/src/modules/architecture.test.ts) stays valid and gets
**stricter** (§4).

**Legacy:** none of the 22 `.mjs` suites touch the parser — verified by grep. Deleting
`lib/cv/` breaks no test. That also means **the benchmark is the only safety net for Wave 2.**

### 1.7 Which new integration tests are required

| # | Test | File |
| --- | --- | --- |
| T1 | Docling adapter: HTTP response → `ParsedDocument` with `markdown` | `docling-document-parser.test.ts` |
| T2 | Docling unreachable → **temporary** abstention (CV never lost) | same |
| T3 | Docling rejects file (corrupt/unsupported) → **permanent** abstention | same |
| T4 | Ollama adapter: model JSON → `ExtractedResume`; malformed → permanent abstain | `ollama-resume-extractor.test.ts` |
| T5 | Ollama unreachable → temporary abstention | same |
| T6 | Extractor **prefers `markdown`**, falls back to `text` | same |
| T7 | End-to-end intake with both adapters stubbed at HTTP level | extend `intake.test.ts` |
| T8 | **Offline/no-capability**: system fully functional, task abstains, nothing degrades | extend `parsing.test.ts` |
| T9 | Arabic folding + Arabic-Indic digits → `dedupPhone` resolves | `text-normalizer.test.ts` |
| T10 | Guard: no `docling`/`ollama`/`qwen` token in `modules/**` | extend `architecture.test.ts` |

All stub HTTP. **No test may require Docling, Ollama, or Python to run.**

### 1.8 Does any current component duplicate Docling functionality

| Responsibility | Docling | Current | Verdict |
| --- | --- | --- | --- |
| bytes → text | yes | `cv/extractor.js` | **Duplicate** → Docling |
| Reading order / multi-column | yes | `cv/extractor.js` `itemsToLines` | **Duplicate** → Docling |
| Section detection | yes (markdown headings) | `cv/section-detector.js` | **Duplicate** → Docling |
| Tables | yes | none | Docling adds |
| OCR | yes | none | Docling adds |
| Field extraction | **no** | `cv/entity-parser.js` | Not Docling's job → **Qwen** |
| Confidence | **no** | `cv/confidence-engine.js` | → `ProposedField.confidence` |
| Validation | **no** | `cv/validator.js` | → domain |
| Value normalization | **no** | `cv/normalizer.js` | **Not duplicated** — partially retained (§1.3) |

Docling and `ResumeExtractor` do not overlap: Docling produces **structure**, Qwen produces
**fields**. The boundary is `ParsedDocument`.

---

## 2. Benchmark gate (runs before any replacement)

### Corpus — verified present

| Source | PDF | DOCX |
| --- | --- | --- |
| `~/Downloads/CVs & Resumes` | 678 | 26 |
| `~/Downloads/cvs for arabtec` (11 role folders) | 27 | 1 |
| `backend/data/uploads` (gitignored, 0 tracked) | 106 | — |

Sample **n = 80**: 60 random from `CVs & Resumes`, 20 from `cvs for arabtec` — the role
folders (`Quantity Surveyor`, `HSE Manager`, …) are **free ground truth** for
`currentPosition`/`role_applied`. Stratify to include Arabic, English, and mixed.

### PII handling — non-negotiable

- Corpus stays **outside the repository**; harness reads by absolute path
- Results store **metrics only** — never CV text, never names
- Output dir gitignored; `backend/data/` is already ignored ([.gitignore:14](.gitignore:14))
- No CV content in logs — the existing rule at [extractor.js:133](backend/src/lib/cv/extractor.js:133)

### Harness

`backend/src/infrastructure/tools/parser-bench/` — alongside the existing `tools/reconcile`,
run via `tsx`, **not** part of the test suite.

| Metric | Method | Gate |
| --- | --- | --- |
| Field accuracy | P/R/F1 over 8 fields vs. labelled truth | Docling+Qwen ≥ current |
| Reading order | column-bleed rate: skills token inside an employment line | Docling ≤ current |
| Table preservation | tables detected / tables present | report only (current = 0) |
| OCR quality | field recall on the image-only subset | report only (current = 0) |
| Processing time | wall-clock p50/p95 per doc | record; informs batch sizing |
| Memory | peak RSS of the sidecar | must fit target VPS |

**Ground-truth labelling is the real cost: ~80 CVs × ~3 min ≈ 4 hours of human time.**
The role folders cut this for position; the rest must be labelled by hand. Budget it
explicitly — a benchmark without truth labels measures nothing.

**Gate:** replace a capability only where Docling/Qwen is **equal or better**. Record the
numbers in `docs/`. If reading order does not improve, the primary technical case fails and
Wave 2 does not proceed.

---

## 3. Implementation steps

### Step 1 — Wave 1 deletions (no dependency on the benchmark)

Execute §1.2 Wave 1. Suite stays green; parsing behaviour unchanged. Revoke the DeepSeek key.

### Step 2 — `text-normalizer.ts`

Port `foldArabic`/`foldLatin` from [section-detector.js:9-26](backend/src/lib/cv/section-detector.js:9);
add Arabic-Indic → ASCII digit folding and bidi-mark stripping. Pure, no I/O.
Wire into `dedupPhone` and `searchTextOf` ([mappers.ts](backend/src/modules/talent/infrastructure/mappers.ts)).
Independently valuable; unblocks T9.

### Step 3 — Contract fields (additive, provider-neutral)

`ParsedDocument` += `markdown?: string`, `structure?: DocumentStructure`
`GenerationProvenance` += `documentIntelligenceVersion?: string | null`, `documentIntelligenceModelId?: string | null`

Neutral names only. **No Docling type may cross the port** — [architecture.test.ts:265](backend/src/modules/architecture.test.ts:265)
fails the build otherwise. Optional ⇒ `PlainTextDocumentParser` stays valid.

### Step 4 — `docling-document-parser.ts`

`DocumentParser` over `docling-serve`. `version` = pinned Docling version + adapter revision.
Abstention mapping: connection/timeout/5xx ⇒ **temporary**; rejected/unsupported/corrupt ⇒
**permanent**. Base URL and timeout injected; **no default pointing at a hosted host**.

### Step 5 — `ollama-client.ts` + `ollama-resume-extractor.ts`

`ResumeExtractor` producing `ExtractedResume`. Prefers `markdown`, falls back to `text`.
Populates `uncertainFields` — the review UI depends on it
([resume-parse-handler.ts:79-96](backend/src/infrastructure/ai/resume-parse-handler.ts:79)).
Unparseable model output ⇒ permanent abstain; unreachable ⇒ temporary.
`version` = model tag + prompt version.

### Step 6 — Composition root

One edit to [composition-root.ts](backend/src/api/composition-root.ts): build `capabilities`
from env when configured. Absent ⇒ `ai: null`, unchanged behaviour. No other file changes.

### Step 7 — Deployment

Add `docling-serve` and `ollama` as Coolify resources beside app + Postgres. Pin versions.
**Bake model weights into images at build** (Docling artifacts, `ollama pull qwen…`) and
assert at container start — otherwise first parse reaches the internet and breaks the
offline requirement at runtime.

### Step 8 — Cutover (gated on §2)

Route `POST /candidates/parse-cv` and `parseAndFill`
([candidates.js:222, :564](backend/src/routes/candidates.js:222)) to the new stack. Then
Wave 2 deletions. **This step is what prevents a second pipeline** — until it lands,
`lib/cv/*` and the new stack coexist.

---

## 4. Test actions

| Action | File |
| --- | --- |
| New | `docling-document-parser.test.ts` (T1–T3) |
| New | `ollama-resume-extractor.test.ts` (T4–T6) |
| New | `text-normalizer.test.ts` (T9) |
| Extend | `intake.test.ts` (T7) |
| Extend | `parsing.test.ts` (T8) |
| Extend | `architecture.test.ts` (T10) |
| Unchanged | the other 34 suites |

Coverage ratchet (90/90/85/90) applies to new adapters.

---

## 4b. The JS–TS runtime bridge

The live endpoint is JavaScript (`node src/server.js`); the Docling and Ollama adapters are
TypeScript. This section states exactly how the second becomes consumable by the first.

**Status legend:** ✅ implemented and tested · ⏳ designed, unproven until Stage 2.

### What exists today

✅ The seam: `registry.js` / `composition.js` / `legacy-provider.js`, with `legacy` registered
and selected. Four call sites in [candidates.js](backend/src/routes/candidates.js) resolve
through `getParser()`. 9 tests.

✅ The adapters: `DoclingDocumentParser` and `OllamaResumeExtractor`, 45 tests against stubbed
HTTP. They implement `DocumentParser` and `ResumeExtractor`, **not** the JS `ParserProvider` —
they sit one level below it.

⏳ **Nothing bridges the two yet, deliberately.** Registering an unproven provider — even
unselected — invites it being switched on without evidence.

### The provider contract the bridge must satisfy

`ParserProvider` (JS) is two methods returning the shapes the endpoint already consumes:

| Method | Returns |
| --- | --- |
| `parseLegacy(filePath)` | `{ full_name, email, phone, years_experience, role_applied, raw_text, extraction_status }` |
| `parseEntities(filePath)` | `{ personal, employment, education, metadata }` |

A `DoclingQwenParserProvider` must read the file, run `DocumentParser` → `ResumeExtractor`,
and **map the result into these two shapes**. That mapping is the bridge's entire job, and it
is what keeps the HTTP response contract unchanged: the route, `cv-mapper.js`, `FIELD_MAP`
and the SQL writes are untouched, because they still receive exactly the objects they
receive today.

An abstention maps to `extraction_status: 'failed'` with `parse_status_reason` carrying the
reason — the status value the route already handles at
[candidates.js:232](backend/src/routes/candidates.js:232).

### Build output and module format ⏳

`tsconfig.json` currently emits nothing (`typecheck` is `tsc --noEmit`). Two options, to be
decided when the deployment is real:

| Option | Import path from JS | Trade-off |
| --- | --- | --- |
| **A. Compile to ESM** (`tsc --outDir dist`) | `../../dist/infrastructure/ai/...` | Adds a build step to the Docker image; plain `node` at runtime |
| **B. Run under `tsx`** | direct `.ts` import | No build step; a runtime dependency and a startup cost |

**Recommendation: A.** The project already targets `NodeNext` with extensionless-safe `.js`
specifiers, so the emitted ESM imports cleanly from `server.js` with no interop shim. Option
B puts a transpiler in the production path.

Either way the bridge module itself is **JavaScript** (`src/lib/parsing/docling-qwen-provider.js`),
importing compiled output. That keeps the seam free of build-tool assumptions.

### Startup registration ⏳

One added block in `composition.js` — the only file that may register a provider:

```js
// Sketch. Not implemented: registering before the gate would invite selection
// without evidence.
if (process.env.CV_PARSER_PROVIDER === 'docling-qwen') {
  const { doclingQwenProvider } = await import('./docling-qwen-provider.js');
  registerParser('docling-qwen', doclingQwenProvider(configFromEnv()));
}
```

Conditional on purpose: when the provider is not selected, its module is never loaded, so a
missing `dist/` cannot break a legacy deployment.

### Configuration ⏳

| Variable | Purpose | Default |
| --- | --- | --- |
| `CV_PARSER_PROVIDER` | Provider selection | `legacy` |
| `DOCLING_BASE_URL` | Sidecar | `http://127.0.0.1:8089` |
| `DOCLING_PIPELINE_VERSION` | Pinned tag, recorded in provenance | `unpinned` |
| `OLLAMA_BASE_URL` | Runtime | `http://127.0.0.1:11434` |
| `OLLAMA_MODEL` | **Required, no default** — an unpinned model makes proposals irreproducible | — |
| `OLLAMA_CONTEXT_SIZE` | Window | `8192` |

`assertLocalHost` rejects any non-loopback, non-private `OLLAMA_BASE_URL` at construction, so
a mistyped variable cannot ship CV text off the host. ✅ tested.

### Error behaviour ✅ (adapters) / ⏳ (bridge)

Both adapters already return `AIOutcome` with `permanent` set: temporary for unreachable,
timeout, 5xx and protocol faults; permanent for encrypted, corrupt, empty, unsupported,
oversized, 4xx and context overflow. There is **no fallback to the legacy parser** on any
path — an outage surfaces as a failed parse, visibly.

The bridge must preserve that: a temporary abstention becomes a failed parse the operator can
retry, **never** a silent call to `legacyParserProvider`.

### Deployment artifact ⏳

Image gains `dist/` (Option A). `docling` and `ollama` join as compose services on an
`internal: true` network — [docker-compose.local-ai.yml](deploy/docker-compose.local-ai.yml),
**written, never run**. `CV_PARSER_PROVIDER` stays `legacy` in that file until the gate passes.

### How the endpoint resolves the new provider ⏳

Unchanged from today. `getParser()` returns whichever provider `composition.js` selected;
`candidates.js` never learns which. Cutover is one environment variable, applied at one
place, after the benchmark passes — and reverting is the same variable.

### Still to be proven on Stage 2

1. `tsc --outDir dist` emits ESM that `server.js` imports without an interop shim
2. The compiled adapters run under plain `node`, not just `tsx`
3. `DoclingQwenParserProvider` reproduces both response shapes on real CVs
4. An abstention renders correctly in the existing UI's parse-status badge
5. The image builds with `dist/` and the sidecar reachable
6. End-to-end parse with outbound network blocked

---

## 5. Execution order

```
Step 1  Wave 1 deletions ─────────────► independent, do first
Step 2  text-normalizer ──────────────► independent
Step 3  contract fields ──────────────► blocks 4, 5
Step 4  docling adapter ──┐
Step 5  ollama adapter  ──┴───────────► blocks 6
Step 6  composition root ─────────────► blocks 7
Step 7  deployment ───────────────────► blocks benchmark
§2      BENCHMARK ════════ GATE ══════► blocks 8
Step 8  cutover + Wave 2 deletions
```

Steps 1–3 carry no Docling/Ollama dependency and can start immediately.
**Nothing is deleted from the live parsing path until the benchmark passes.**
