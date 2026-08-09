# Stage 2 Run 2 — plan and exact commands

**Infrastructure/runtime acceptance only.** Nothing in this plan can produce a
parser field-accuracy result. The corpus is synthetic, so field matches measure
plumbing. ACCEPTANCE_CRITERIA §7 still requires human labels that do not exist
(see §9 of that document).

RunPod pod `arabtec-ai-stage2-l4` stays **stopped** until this plan is executed
deliberately. EUR-IS-1 remains **synthetic-only**.

---

## What Run 2 must prove

| Gate | Source | How Run 2 measures it |
| --- | --- | --- |
| OCR/model assets prewarmed | Run 1 finding | `/health` reports `ocrAssetsPresent` and the benchmark refuses to start without it |
| Digital convert p95 | §6 #3 | p95 over ≥12 digital documents, assets warm |
| Scanned OCR p95 | §6 #4 | p95 over ≥7 scanned documents |
| End-to-end p95 | §6 #5 | p95 over all 22 |
| Peak **container** RSS | §6 #6 | cgroup + process-tree RSS vs `memory.max` |
| 20-document stability | §6 #7 | p95(docs 11–20) ≤ 1.25 × p95(docs 1–10) |
| Zero unexpected timeouts | §6 #8 | any document over 180 s counts as one |
| Egress blocked | §6 #9 | TCP probes to modelscope.cn / huggingface.co / pypi.org must all refuse |
| Correct native-vs-OCR decisions | Run 1 finding | every document's `ocrRescueInvoked` must equal its manifest `expectOcrRescue` |

---

## Prerequisites, in order

These are **provisioning** steps. They need network egress and are deliberately
separate from the benchmark, which must run with egress blocked.

### 1. Generate the dependency lock

```bash
cd deploy/ai-gateway && ./lock.sh
```

Runs `pip-compile --generate-hashes` inside the pinned base image and overwrites
`requirements.txt`. Commit the result. The image build fails until this exists.

### 2. Record OCR asset checksums

```bash
cd deploy/ai-gateway && ./fetch-ocr-assets.sh --record /tmp/ocr-assets
```

Prints the real `sha256` for every asset. Paste them into `ocr-assets.lock`
replacing `__RECORD__`, commit, then verify:

```bash
cd deploy/ai-gateway && ./fetch-ocr-assets.sh /tmp/ocr-assets
```

### 3. Build the image

```bash
docker build -t arabtec/ai-gateway:stage2-run2 deploy/ai-gateway
```

The build runs `compat_check.py`. If it fails, **do not** promote
`DOCLING_PIN_STATUS`; the pinned Docling is not compatible and the pin must
change rather than the check.

### 4. Confirm the pins agree

```bash
cd deploy/ai-gateway && ./check-pins.sh
```

### 5. Generate the synthetic corpus

```bash
python3 deploy/ai-gateway/generate_fixtures.py \
  --out /workspace/bench/corpus \
  --fonts /opt/ocr-assets/fonts
```

The corpus is written to `/workspace` on the pod, never into `backend/data/`
— that path is gitignored because it holds the live database and real uploads,
and synthetic fixtures must not be mixed in with them.

22 documents, seed `20260809`, 14 of them Arabic / mixed / scanned. The script
exits non-zero if the corpus falls below 20 documents or 8 Arabic/mixed/scanned.

---

## The benchmark

Start the pod, then **block egress**, then run. Order matters: provisioning
needs the network, the measurement must not have it.

```bash
python3 deploy/ai-gateway/stage2_benchmark.py \
  --corpus /workspace/bench/corpus \
  --out /workspace/bench/run2 \
  --expect-no-egress
```

Exit 0 = every gate passed. Exit 1 = at least one did not; `run2.json` names
which. Exit 2 = the run was refused (assets not prewarmed, or corpus too small)
— a refusal, not a failure, and the numbers from it must not be quoted.

Writes `/workspace/bench/run2/run2.json`: per-document timings, per-page OCR
provenance, per-document resource peaks, and the gate verdicts.

---

## Reading the result honestly

- `allGatesPassed: true` means the **runtime** is acceptable. It says nothing
  about extraction quality.
- A failed `ocrDecisionsCorrect` is the most important single failure: it means
  the pipeline is routing documents to the wrong path, and every latency number
  in the run describes the wrong work.
- `peakContainerRss.pctOfLimit` is the number Run 1 could not produce. If it is
  absent, the pod is not running under a cgroup memory limit and §6 #6 is still
  unmeasured — do not record it as passed.
- `egressBlocked.pass: null` means `--expect-no-egress` was not passed, so the
  offline guarantee was **not** tested. It is not a pass.

## After Run 2

Stop the pod. Do not terminate it and do not delete the network volume — the
Qwen weights and OCR assets on it are what make a re-run cheap.
