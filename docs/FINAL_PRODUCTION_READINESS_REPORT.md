# Arabtec ATS — Final Production Readiness Report

**Branch:** `readiness/final-gate` · **Date:** 2026-08-16
**Scope:** RunPod Docling Serve migration + production gates.
Nothing was pushed, merged, or deployed. No real CV or PII was used at any point.

**Decision on scope:** Arabic OCR fails on the RunPod image. You directed that we proceed
English-only for now, so Arabic is recorded below as an accepted limitation with its blast
radius stated, not as a solved problem.

Blocker types used throughout: **CODE** · **INFRASTRUCTURE** · **SECURITY** · **OPERATIONAL** · **FUTURE**.

---

## A. VERIFIED

**A1 — Docling Serve contract, from the running image.** `docling-serve 1.12.0`, `docling
2.72.0`. Auth `X-Api-Key` (verified enforced: unauthenticated → **401**). `POST
/v1/convert/file`, multipart. Full request/response schema in `DOCLING_SERVE_API.md`, taken
from the live `/openapi.json`, not from memory.

**A2 — English OCR on RunPod.** `image-only-en.pdf`, tesseract/`eng`, scale 4.0: 200/success,
9 691 ms, 321 chars, **5/5** ground truth — byte-identical character count to the local sidecar.

**A3 — Two-page provenance on RunPod.** `multipage-scan-en.pdf`: page-2-only markers **3/3**,
`json_content.pages` = `["1","2"]`, distinct `prov[].page_no` = `[1,2]`, **8/8** texts carrying
a bbox. Page count derivable as `len(pages)`.

**A4 — Engine matrix.** All five engines installed and functional for English (tesseract 5/5,
easyocr 5/5, auto 5/5, rapidocr 5/5, tesserocr 4/5). **tesseract** selected — same engine as the
sidecar, so quality is reproduced rather than approximated.

**A5 — `images_scale`.** 2.0 and 4.0 recover identical text (321 chars, 5/5); 2.43 s vs 2.92 s
server-side. 4.0 retained to match the validated sidecar configuration.

**A6 — Transport swap, tested.** `DoclingTransport` extracted; `DoclingServeClient` added;
`DoclingDocumentParser` takes an injected transport. **The 20 pre-existing adapter tests pass
untouched**, plus **20 new** — 40/40. Bounding-box conversion (BOTTOMLEFT points → top-left
fractions) is asserted against a **real captured response**, not an invented shape.

**A7 — Backend selection and rollback.** Verified in all four configurations:

| environment | selected parser |
|---|---|
| `DOCLING_BASE_URL` only | `docling-sidecar` (safe default) |
| `DOCLING_BACKEND=sidecar` | `docling-sidecar` |
| `DOCLING_BACKEND=serve` | `docling-serve` |
| no `DOCLING_BASE_URL` | `local-pdfjs-mammoth` |

**A8 — Contract preserved.** Full ATS end-to-end **48/48** on the sidecar backend after all
changes — request → approval → assignment → intake → parsing → OCR → review → duplicate →
candidate → application → interview → feedback → offer → audit, with the whole-database
integrity sweep clean. Full runner **33/33**.

**A9 — `ocrApplied` strategy (Phase 6).** Docling Serve reports nothing about OCR — verified: no
key anywhere in the returned `DoclingDocument` matches `/ocr|confid|recogni|source|method|engine/`.
Rather than pay for two remote conversions, the **existing local parser** answers "does this
document already have a text layer?" from bytes we hold, and the single remote call is made with
the right OCR setting. The flag is therefore **measured, not configured**. When the probe cannot
tell, `ocrApplied` is left **unset** rather than defaulted to `false` — a silent `false` would
make a scanned CV indistinguishable from a digital one.

---

## B. FIXED

**B1 — AI egress guard restored (SECURITY).** `assertLocalHost` had its body commented out
("Disabled the local-only restriction to allow external hosted Ollama"), so any value of
`OLLAMA_BASE_URL` would silently send CV text off the machine. It now enforces loopback / RFC1918
/ `.local` / single-label container names, and permits a hosted endpoint **only** with an
explicit `OLLAMA_ALLOW_REMOTE=true`. The capability is preserved; the decision is now visible.
Its test — one of the 83 known vitest failures — now passes.

**B2 — Process-global TLS kill switch removed (SECURITY).** `src/lib/cv/ai-parser.js` and
`reasoner.js` set `NODE_TLS_REJECT_UNAUTHORIZED='0'` for `runpod.net` hosts. That is
process-wide: while set, **every** outbound TLS connection in the app skipped certificate
verification. Removed from both.

**B3 — Page attribution (CODE).** The sidecar path stamps page 1 on every block (defect B4 in
the previous report). The Serve transport maps `texts[].prov[].page_no` and real bounding boxes
into the existing `RawBlock` shape, so evidence cites the page it actually came from. Covered by
tests for page 1, page 2, bbox conversion and multi-page evidence.

**B4 — Provenance names the engine.** `structure.provenance.parser` now reports `docling-serve`
or `docling-sidecar` rather than a single hardcoded name, so a candidate's evidence can be traced
to the engine that produced it.

---

## C. OPEN DEFECTS

**C1 — Arabic OCR does not work on RunPod (CODE/INFRASTRUCTURE).** Every engine, every language
code, zero Arabic glyphs. Root cause proven: `ocr_lang=ara` on an *English* scan returns 0 chars
where `eng` returns 321 — Tesseract cannot initialise with `ara`, i.e. the Arabic traineddata is
absent from the image. Control: the same fixture through the local sidecar recovers **107 Arabic
glyphs**. Re-verified after your rebuild — numbers byte-identical to before, and `/version`
unchanged, so the running container was not replaced.

**C2 — The pre-existing "Arabic" fixture contains no Arabic (CODE).** `image-only-ar.pdf` is a
wholly Latin CV; only the *name* is Arabic. Every prior claim that Arabic OCR was verified,
including in `FINAL_READINESS_REPORT.md` §A3, rested on it and was unsupported.
`scan-ar-true.pdf` was generated for this gate and is the real fixture.

**C3 — 82 failing tests in the parallel TypeScript API layer (CODE, non-shipping).** Down from
83 (B1 fixed one). All one cause: the service uses the real permission catalogue
(`candidate.add`) while the fixtures grant invented names (`candidate.create`). **Production does
not start this layer** — `render.yaml` runs `node src/server.js`.

**C4 — Mixed PDFs (FUTURE).** A PDF with a healthy native text layer is not additionally OCR'd,
so text living only inside an embedded image is absent. Unchanged by this work.

---

## D. PRODUCTION BLOCKERS

| # | Blocker | Type | Smallest next action |
|---|---|---|---|
| D1 | **RunPod endpoint is down.** `/health`, `/version` and `/openapi.json` all return 404 with an empty body — the proxy has no listener on 5001. Phase 3 matrix and Phase 12 live E2E could not run. | INFRASTRUCTURE | Confirm the pod is running and bound to 5001; re-check the pod ID in the URL |
| D2 | **Arabic OCR absent from the image.** Accepted for now per your direction, but blocking for any Arabic-language CV. | INFRASTRUCTURE | `apt-get install -y tesseract-ocr-ara` in the **final** image stage, push under a new immutable tag, **recreate** the pod |
| D3 | **PostgreSQL still unverified.** No PG binaries, no docker, no `embedded-postgres`, no `PG_TEST_URL` on this machine; the suite explicitly refuses PGlite. `pg_tx_test` remains ⊘ SKIPPED — not a pass. | INFRASTRUCTURE | Provide `PG_TEST_URL` to a disposable PostgreSQL, then `npm run test:pg:required` |
| D4 | **No automated database backup; no restore rehearsal.** `docs/BACKUP_AND_RESTORE.md` states it plainly. | OPERATIONAL | Schedule the documented `pg_dump -Fc`; rehearse one restore |
| D5 | **Retention is reported, not enforced.** `/privacy/retention` lists overdue candidates; nothing runs on a schedule. | OPERATIONAL | Add a scheduled job, or an owned monthly manual step |
| D6 | **Docling host capacity.** ~1 document / 5.8 s, 759 MB peak; Render free tier is 512 MB. | INFRASTRUCTURE | Size the Docling host (4 GB Linux) or keep RunPod with a queue |
| D7 | **RunPod data-protection position.** Candidate CVs would leave the company to a third-party GPU host. | OPERATIONAL | DPA review and a documented decision before any real CV is sent |

**No CODE blocker remains.** Every item above is infrastructure or operational.

---

## E. ACCEPTABLE PRODUCTION LIMITATIONS

1. **Arabic CVs are not readable by the RunPod backend** (C1). Accepted by explicit direction.
   Consequence to state to users: an Arabic scanned CV produces "no reviewable field could be
   read" — an honest refusal, never a wrong candidate. The **sidecar backend still reads Arabic**,
   so `DOCLING_BACKEND=sidecar` remains the option for Arabic intake.
2. **Mixed PDFs** (C4) — rare in practice; the reviewer sees the parser and OCR flag on screen.
3. **`ocrApplied` unset when the local probe is inconclusive** — reported as "not asserted"
   rather than guessed.
4. **Docling Serve `/health` reports no version** — recorded as `unknown` rather than invented.
5. **`images_scale` evidence is one document** — 4.0 retained as the conservative default.

---

## F. FUTURE ENHANCEMENTS

1. Resolve or delete the parallel TypeScript API layer (C3).
2. Mixed-document OCR (C4).
3. Delete the legacy parser chain entirely — defused, but still in the tree.
4. Async Docling Serve endpoints (`/v1/convert/file/async` + poll) for large documents.
5. Backfill page attribution on the sidecar path, or retire the sidecar once Serve carries Arabic.
6. A graded Arabic/English OCR accuracy corpus.

---

## G. TEST RESULTS

| Suite | Result |
|---|---|
| Full ATS runner (`npm test`) | **33 suites, 33 passed, 0 failed** |
| Full ATS E2E (`ats_e2e_test.mjs`, sidecar backend) | **48/48** |
| Docling adapter — sidecar (pre-existing, untouched) | **20/20** |
| Docling adapter — Serve transport (new) | **20/20** |
| Intake / Proposal / Parser seam / HTTP route | 35/35 · 16/16 · 13/13 · 9/9 |
| Document smoke | 23/23 |
| Ollama (incl. the restored egress guard) | **25/25** (was 24/25) |
| Typecheck · Build | PASS · PASS |
| Vitest domain | 740 passed, **82 failed** (was 83), 9 skipped — all C3 |
| RunPod Phase 3 matrix | **NOT RUN — endpoint 404 (D1)** |
| RunPod Phase 12 live E2E | **NOT RUN — endpoint 404 (D1)** |
| `pg_tx_test` | **⊘ SKIPPED — not a pass (D3)** |

**Measured performance** (RunPod, while reachable): born-digital 2.5–3.2 s · scanned English
6.8–12.3 s · two-page scan 11.7 s · Arabic n/a. Local sidecar: ~1 doc / 5.8 s, 759 MB peak under
6-way load, 8 cores. Concurrency beyond ~20 simultaneous uploads trips the 120 s client timeout.
No new stress test was run; the previous measurements stand.

---

## H. ROLLBACK PLAN

Configuration only. No database migration, no candidate-data migration, no permanent RunPod
dependency.

1. `DOCLING_BACKEND=sidecar` (or unset) → local sidecar. Default already.
2. Unset `DOCLING_BASE_URL` → `LocalDocumentParser`. Born-digital keeps working; scans abstain
   **explicitly**.
3. `deploy/docling-sidecar/` stays in the tree and runnable throughout.
4. Pin the RunPod image by digest so a rollback target exists on that side too.

Intakes and proposals created under either transport are identical rows; only
`structure.provenance.parser` differs — which is the point.

---

## I. DEPLOYMENT CHECKLIST

- [ ] Pod running, bound to 5001, URL confirmed (D1)
- [ ] `tesseract --list-langs` shows `ara` (D2)
- [ ] Phase 3 matrix 11/11 against RunPod
- [ ] Phase 12 E2E 48/48 with `DOCLING_BACKEND=serve`
- [ ] `PG_TEST_URL` set; `npm run test:pg:required` passes (D3)
- [ ] Backup scheduled; one restore rehearsed (D4)
- [ ] Retention job scheduled or owned (D5)
- [ ] `DOCLING_SERVE_API_KEY` set server-side only; never in frontend or git
- [ ] `OLLAMA_ALLOW_REMOTE` left unset unless a DPA decision says otherwise
- [ ] DPA position recorded for sending CVs to RunPod (D7)
- [ ] Docling host sized (D6)

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DOCLING_BACKEND` | `sidecar` | `sidecar` \| `serve` |
| `DOCLING_BASE_URL` | unset → local parser | endpoint for either backend |
| `DOCLING_SERVE_API_KEY` | unset | `X-Api-Key` for Docling Serve |
| `DOCLING_BEARER_TOKEN` | unset | bearer for the sidecar |
| `DOCLING_TIMEOUT_MS` | 120000 | also sent as `document_timeout` |
| `DOCLING_OCR_ENGINE` | `tesseract` | Serve only |
| `DOCLING_OCR_LANGS` | `eng` | comma-separated; add `ara` when installed |
| `DOCLING_IMAGES_SCALE` | `4` | Serve only |
| `DOCLING_PIPELINE_VERSION` | `unpinned` | recorded on every proposal |
| `OLLAMA_ALLOW_REMOTE` | unset | required for a non-local Ollama |

---

## J. FINAL GO / NO-GO

# NOT PRODUCTION READY

**The code is ready. The infrastructure is not.** No code blocker remains: the transport swap is
implemented, tested (40/40 adapter, 33/33 runner, 48/48 E2E), rollback is one variable, and two
real security defects are fixed.

Blockers in priority order, each with its smallest next action:

1. **D1 — RunPod endpoint 404 (INFRASTRUCTURE).** Nothing about the live backend can be
   confirmed while it is down. → Bring the pod up on 5001 and confirm the URL.
2. **D2 — Arabic OCR (INFRASTRUCTURE).** → Install `tesseract-ocr-ara` in the final image stage,
   new tag, recreate the pod. Accepted as deferred by your direction; blocking for Arabic CVs.
3. **D3 — PostgreSQL unverified (INFRASTRUCTURE).** Production is PostgreSQL; everything verified
   here ran on SQLite. → Provide `PG_TEST_URL`, run `npm run test:pg:required`.
4. **D7 — RunPod data-protection position (OPERATIONAL).** → Record the DPA decision before any
   real CV is sent.
5. **D4 — Backups (OPERATIONAL).** → Schedule `pg_dump`, rehearse one restore.
6. **D5 — Retention enforcement (OPERATIONAL).** → Schedule or assign it.
7. **D6 — Docling host capacity (INFRASTRUCTURE).** → Size the host.

With D1–D3 closed, the remaining items are operational decisions rather than engineering work,
and the system can go to a supervised production pilot on the **sidecar** backend — which reads
Arabic — while the Serve backend waits on D2.
