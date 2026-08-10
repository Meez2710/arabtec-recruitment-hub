# Stage 2 Run 2 — plan and exact commands

**Infrastructure/runtime acceptance only.** Nothing in this plan can produce a
parser field-accuracy result. The corpus is synthetic, so field matches measure
plumbing. ACCEPTANCE_CRITERIA §7 still requires human labels that do not exist
(see §9 of that document).

RunPod pod `arabtec-ai-stage2-l4` stays **stopped** until this plan is executed
deliberately.

EUR-IS-1 is approved for **synthetic Stage 2 testing only** and is **not**
approved for real candidate data (2026-08-10, owner — see
STAGE2_BENCHMARK_RECORD §5a). Run 2's corpus is fabricated with a fixed seed and
reads no input, which is what makes it runnable under that scope.

Reuse the existing 50 GB EUR-IS-1 network volume and the existing pod. Do not
create another volume and do not rebuild for another region.

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

### Egress: what is actually possible on RunPod

**RunPod Pods expose no outbound-network firewall control.** An earlier revision
of this plan said to "block egress" before running; that instruction was wrong
and there is no setting to look for. Asserting `--expect-no-egress` on RunPod
therefore guarantees a failure that says nothing about the runtime — the network
is up because the platform cannot take it down.

So the run selects its posture explicitly:

| Mode | Flag | Use where |
| --- | --- | --- |
| `not-controllable` (default) | `--egress-not-controllable` | RunPod. Runs every other gate and records §6 #9 as **UNPROVEN** |
| `expect-blocked` | `--expect-no-egress` | Any platform that *can* cut outbound. Asserts §6 #9 |

Set via `STAGE2_EGRESS_MODE` when using the boot mode; the default is the RunPod
reality, so nothing needs to be set on the existing pod.

**A reachable network is never recorded as a pass.** `egressBlocked.pass` stays
`null`/`false` and §6 #9 stays open.

### What replaces it, and what that is worth

`noDownloadsDuringRun` inventories every asset tree (OCR assets, HF cache,
Ollama models, Docling artifacts) before the first document and again after the
last, and passes only if **nothing was added and nothing was modified**. That
demonstrates the pipeline ran on prewarmed, checksum-verified assets alone.

It is **strictly weaker** than blocking egress and never substitutes for it: a
process that downloaded to a tmpfs and deleted it would pass this and still
violate the offline requirement. It is the best evidence obtainable on a
platform that cannot cut the network.

### Running it

```bash
python3 deploy/ai-gateway/stage2_benchmark.py --corpus /workspace/bench/corpus --out /workspace/bench/run2 --egress-not-controllable
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
- `egressBlocked.pass: null` means the offline guarantee was **not** tested. It
  is not a pass, and on RunPod it never will be.

### The three verdicts

`run2.json` carries a `verdict`, and it is what must be quoted — not the exit
code, which is 0 for both acceptance and a waiver so the boot mode records a
usable result.

| `verdict` | Meaning |
| --- | --- |
| `ACCEPTED` | Every gate passed **including** a proven blocked egress |
| `ACCEPTED_SYNTHETIC_STAGING_WAIVER` | Every other gate passed; §6 #9 unproven because the platform cannot block outbound. Scope: **synthetic staging only**. Does not carry to production |
| `FAILED` | At least one substantive gate failed |

A waiver is not an acceptance with a footnote. **No-egress must be proven on a
platform that can block outbound before any real candidate data is processed**,
and that remains an open production blocker regardless of how Run 2 lands.

## After Run 2

Stop the pod. Do not terminate it and do not delete the network volume — the
Qwen weights and OCR assets on it are what make a re-run cheap.
