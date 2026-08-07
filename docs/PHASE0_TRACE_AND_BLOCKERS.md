# Phase 0 — Repository Trace, Environment Verification, and Blockers

**Task:** implement the Docling → Ollama/Qwen migration through all non-destructive phases.
**Outcome:** Phase 0 complete. **Execution halted at Phase 1** on two hardware blockers and
one annotation blocker. No code modified. No legacy code deleted.

---

## A. SECURITY — resolved and reported

**Verified, without reading or printing the value:**

| Check | Result |
| --- | --- |
| `backend/.env` tracked by git? | **No** — ignored at [.gitignore:9](.gitignore:9); `git ls-files` returns 0 |
| Real secret present? | **Yes** — `DEEPSEEK_API_KEY`, 35 chars, `sk-` prefix (DeepSeek platform format) |
| Value ever committed? | **No** — searched every commit reachable from all refs (`git rev-list --all`). **History is clean; no rewrite required** |
| Which commits mention the *name*? | `906b639`, `3b0a0db` — `.env.example` placeholder (empty) and source references only |

**Notable:** commit `906b639` already documented *"`backend/.env` contains a real
`DEEPSEEK_API_KEY`"* and recommended rotation. **That recommendation was never actioned.**

### Required action — do not wait for the migration

1. **Revoke the key in the DeepSeek/SiliconFlow dashboard.** It has been on disk and in
   shell environments. Deleting the line does not revoke it. *(Provider-side action — I
   cannot and should not perform it.)*
2. No git-history remediation needed.
3. Removing the line from `backend/.env` is safe now — the only consumer is
   `cv-watcher.js`, gated off by `feature.folder_watcher` = `disabled`
   ([feature-flags.js:36](backend/src/lib/feature-flags.js:36), [server.js:237](backend/src/server.js:237)).
   Deferred to the deletion plan per the no-destructive-change instruction.

---

## B. Production trace (verified)

### B.1 Exact production entry point

```
frontend/public/app.jsx:4168   "Parse CV" button
  └─ app.jsx:4157              api.uploadTo('/candidates/parse-cv', cvFile)
      └─ routes/candidates.js:216   router.post('/parse-cv', requirePermission('candidate.add'), multipart, …)
          ├─ :222  await parseCV(filePath)              ← alias for parseHeuristic
          ├─ :223  await parseEntitiesFromFile(filePath)
          ├─ :224  toCandidatePayload(entities)          ← lib/cv-mapper.js
          ├─ :225  toParseMetadata(entities)
          ├─ :240  Candidates.create({...})              ← direct SQL model
          ├─ :259  dbRun('UPDATE candidate SET resume_path…')
          ├─ :263  Candidates.setParseMeta(…)
          ├─ :264  CandidateDocuments.add(…)
          ├─ :269  CandidateActivity.add(…)
          └─ :274  writeAudit(…)
```

Second call site: `parseAndFill` at [candidates.js:562-566](backend/src/routes/candidates.js:562) —
same parser, invoked on resume upload/attach.

### B.2 Current dependency-injection registration

**There is none on the production path.** [candidates.js:12](backend/src/routes/candidates.js:12)
is a module-level static import:

```js
import { parseHeuristic as parseCV, parseEntitiesFromFile } from '../lib/cv-parser.js';
```

No composition root, no container, no injection point. **This is the single most important
Phase 0 finding for implementation:** cutover (Phase 6) is specified as "switch through the
existing composition root," but the live endpoint has no composition root to switch. The
composition root that exists ([api/composition-root.ts](backend/src/api/composition-root.ts))
belongs to the TypeScript stack, which is **not running** — `package.json` `main` is
`src/server.js`, and nothing starts [api/main.ts:37](backend/src/api/main.ts:37).

Cutover therefore requires either (a) starting the TS API and routing `/candidates/parse-cv`
to it, or (b) introducing an injection seam into the legacy route. That is a real scope item
absent from the prior plan.

### B.3 Current DocumentParser implementation

| Stack | Implementation |
| --- | --- |
| Production (legacy) | [lib/cv/extractor.js](backend/src/lib/cv/extractor.js) — pdfjs + mammoth. Not a port implementation |
| TS stack | [plain-text-parser.ts](backend/src/infrastructure/ai/plain-text-parser.ts) — `text/*` only; abstains permanently on PDF/DOCX |

### B.4 Current ResumeExtractor implementation

**None exists in either stack.** The production equivalent is regex detection in
[entity-parser.js](backend/src/lib/cv/entity-parser.js) (422 lines), which does not implement
the port.

### B.5 Component status

| Component | Status |
| --- | --- |
| `lib/cv/{extractor,section-detector,entity-parser,normalizer,validator,confidence-engine,dictionaries,index}.js` | **Active in production** |
| `lib/cv-parser.js`, `lib/cv-mapper.js` | **Active in production** |
| `lib/cv/ai-parser.js` (Anthropic) | **Dead** — `@anthropic-ai/sdk` absent from `package.json` and `node_modules`; `await import(…)` throws into a bare `catch` |
| `lib/cv-watcher.js` (DeepSeek) | **Inactive but functional** — reachable if `feature.folder_watcher` is enabled; key is live |
| `infrastructure/ai/*`, `modules/talent/*`, `api/*` | **Test-only** — never started in production |

### B.6–B.11 Files unchanged / interfaces satisfying target / duplication

Unchanged from the prior plan and re-verified; not repeated here. One correction:

**`ParsedDocument` optional fields are required (Phase 0 item 14): confirmed.** Without
`markdown?`, Docling's structure would be flattened into `text` at the adapter boundary and
the extraction stage would receive nothing better than today's output — defeating the
migration's purpose.

**Provenance (Phase 0 item 15): confirmed feasible.** `GenerationProvenance`
([resume-parse-handler.ts:49-57](backend/src/infrastructure/ai/resume-parse-handler.ts:49))
already carries `capability`, `modelId`, `promptVersionId`, `documentHash`, `parserVersion`,
`extractorVersion`, `generatedAt`. Adding model digest, quantization, and timing is additive
and stays in infrastructure — no domain boundary crossed.

### B.12 Test status

39 vitest suites; **none of the 22 legacy `.mjs` suites touch the parser** (verified by
grep). Missing coverage is as listed in the prior plan.

---

## C. Environment verification — measured, not assumed

| Requirement | Status | Evidence |
| --- | --- | --- |
| Docker (Docling sidecar) | **NOT INSTALLED** | `docker --version` → not found |
| Ollama | **INSTALLED + RUNNING** | v0.32.5, `127.0.0.1:11434` reachable |
| Local Qwen model | **`qwen3:8b` only** | 5.23 GB, digest `500a1f067a9f`. Not an *instruct*-tagged build; no smaller Qwen present |
| Python | 3.9.6 (system) | Docling not installed |
| Node | v24.15.0 | — |
| Dev hardware | **Apple M1, 8 cores, 8 GB RAM** | `sysctl` |
| Production host | **Render free tier** | [render.yaml](render.yaml) — `plan: free` ×3 (512 MB RAM) |
| Stage 2 host | **Not provisioned** | [DEPLOYMENT.md](docs/DEPLOYMENT.md) §B — "needs the server + decisions" |

### C.1 Measured Ollama throughput on this machine

Three runs against the running daemon, `temperature: 0`, thinking disabled:

| Run | Load | Eval tokens | Eval time | **Throughput** |
| --- | --- | --- | --- | --- |
| 1 (cold) | — | 6 | 39.4 s | **0.15 tok/s** |
| 2 (warm) | 0.4 s | 13 | 39.5 s | **0.33 tok/s** |
| 3 (warm) | 0.5 s | 13 | 73.4 s | **0.18 tok/s** |

`load_duration` of 0.4–0.5 s proves the model was **already resident** — this is not cold
start. It is memory thrashing: a 5.23 GB model on an 8 GB machine (≈65 MB free at
measurement) swaps on every token. Throughput also **degrades run over run** (39.5 s → 73.4 s
for identical work), indicating compounding pressure.

**Extrapolation.** A CV extraction emitting ~600 JSON tokens ≈ **30–55 minutes per CV**.
The 120-CV benchmark ≈ **60–110 hours** of pure inference, before Docling.

---

## D. Blockers

### BLOCKER 1 — No hardware capable of running the target pipeline *(hard)*

- **Dev machine:** 8 GB RAM. Measured 0.2–0.3 tok/s — three orders of magnitude below usable.
  Docling adds a PyTorch layout model + OCR on top of a model that already exceeds available
  memory.
- **Current production:** Render free tier, 512 MB. Cannot host Docling *or* Qwen.
- **Stage 2 target:** does not exist.

**Consequence:** the acceptance criteria require latency and memory measured "on the actual
target deployment hardware." There is no such hardware. Phases 1, 5, 6 and 7 cannot execute.

### BLOCKER 2 — Docker absent; the approved sidecar cannot be run *(hard, but resolvable)*

Phase 2 mandates a separate sidecar and forbids embedding Python in the Node process. Docker
is not installed. `pip install docling` into system Python 3.9.6 would (a) not be the
approved architecture, and (b) add a ~2–3 GB torch stack to a machine already thrashing.

### BLOCKER 3 — Ground truth requires human annotation I cannot perform *(hard)*

Phase 1 requires ≥120 CVs labelled across 14 field groups, cohort-stratified, with a
double-reviewed subset. Realistically **10–15 hours of skilled human work**. Every acceptance
threshold (email P/R ≥ 99%, name EM ≥ 97%, work-history F1 ≥ 90%) is defined against those
labels. **Without them there is no gate, and "passed the benchmark" cannot be claimed.**

I can build the schema, sampling, manifest, hashing and scoring harness. I cannot produce the
labels.

### BLOCKER 4 — Model pinning cannot be decided *(consequential)*

"Smallest suitable Qwen instruct model meeting criteria on target hardware" is undecidable
without Blockers 1 and 3 resolved. `qwen3:8b` is the only local model and is not an
instruct-tagged build.

---

## E. What is implementable now, with no blocker

Verified free of Docling, Docker, target hardware, and labels:

| # | Work | Blocked by |
| --- | --- | --- |
| 1 | `text-normalizer.ts` — Arabic/Eastern-Arabic digits, Unicode/whitespace folding, phone normalization; wired into `dedupPhone` + `searchTextOf`, with tests | nothing |
| 2 | `ParsedDocument` += `markdown?`, `structure?`; `GenerationProvenance` += provider/digest/quantization/timing — additive, provider-neutral | nothing |
| 3 | `docling-document-parser.ts` + contract/failure tests against a stubbed sidecar HTTP contract | nothing (integration test needs Docker) |
| 4 | `ollama-resume-extractor.ts` + schema-validation, malformed-output, timeout and abstention tests against stubbed HTTP | nothing (live inference needs RAM) |
| 5 | Composition-root wiring, provider selection by env | nothing |
| 6 | Benchmark harness: sampling with fixed seed, corpus manifest, hashing, cohort labels, scoring, cohort reporting | nothing (needs labels to *run*) |
| 7 | Annotation schema + acceptance-criteria document | nothing |
| 8 | Injection seam for `/candidates/parse-cv` (see §B.2) | nothing |

That is the entire implementation except: running Docling, running inference at usable speed,
the benchmark, cutover, and the observation gate.

---

## F. Options

| Option | Resolves | Cost |
| --- | --- | --- |
| **A. Provision the Stage 2 VPS now** (≥16 GB RAM, ≥8 vCPU; GPU optional) and run Docling + Ollama there | 1, 2, 4 | VPS spend; brings forward a planned step |
| **B. Install Docker locally** and run Docling only; defer inference | 2 (partial) | Free; does not fix 8 GB RAM |
| **C. Use a much smaller model** (e.g. a 1.5B-class instruct build ≈ 1 GB) for local iteration | Partially 1, 4 | Local dev viable; **cannot be the production pin** — quality unproven |
| **D. Annotate the corpus** (or a 40-CV pilot subset first) | 3 | 10–15 h human, or ~4 h for a pilot |
| **E. Build the unblocked subset (§E) now** | none — but delivers ~80% of the code | My time only |

**These are not exclusive.** E runs in parallel with everything.

---

## G. Recommendation

1. **Revoke the DeepSeek key today.** Independent of all of the above.
2. **Start §E immediately** — items 1, 2, 5, 7, 8 have no dependency on any blocker and are
   required by every possible resolution path.
3. **Decide Option A (provision the VPS).** It is the only path to the acceptance gate, it was
   already planned as Stage 2, and both Render free tier and the 8 GB M1 are permanently
   disqualified by measurement.
4. **Begin a 40-CV pilot annotation** (Option D, reduced) to validate the schema and produce
   an early quality signal before committing to the full 120.
5. **Do not** pin a model or claim any benchmark result until 1–4 land.

Nothing has been implemented, modified, or deleted. Awaiting a decision on Options A–E.
