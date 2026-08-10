# Stage 2 Benchmark Record — Run 1

**Infrastructure/runtime measurement only.** Nothing here is a parser
field-accuracy result, and no criterion in
[ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md) §7 has been evaluated — those
require human labels, which per §9 do not exist yet.

Run 1 was a **synthetic smoke benchmark** against a single RunPod pod. It
answers one question: is this hardware capable enough to be worth accepting.
It does not answer whether the pipeline extracts correctly.

---

## 1. Runtime inventory

| | Measured |
| --- | --- |
| GPU | NVIDIA L4 ×1 |
| VRAM | 23 034 MiB |
| Driver | 570.195.03 |
| CUDA | 12.8 (torch 2.8.0+cu128) |
| vCPU | 16 (AMD EPYC 7702 64-Core) |
| RAM | 62 GB (pod allocation) |
| Container disk | 40 GB |
| Region / cloud | EUR-IS-1, Secure Cloud |
| Ollama | 0.32.6 |
| Model | `qwen2.5:7b`, digest `845dbda0ea48`, **Q4_K_M**, 4 683 087 332 B |
| Docling | 2.118.1 (ad-hoc `pip install docling`, **not** the pinned image) |
| Persistent volume | 50 GB, mounted at `/workspace`, 4.4 G used by weights |

Host identifiers, proxy URLs and notebook tokens are deliberately excluded.

> **The Docling version above is not a pin.** It is whatever `pip install
> docling` resolved to on the day. The image pins live in
> [ai-gateway/requirements.in](../deploy/ai-gateway/requirements.in) and are
> gated on [compat_check.py](../deploy/ai-gateway/compat_check.py).

---

## 2. Measured latency and throughput

Strict four-field JSON schema (`name`, `email`, `phone`, `current_title`),
`temperature: 0`, one cold request then ten warm.

| | Value |
| --- | --- |
| Cold wall | 14.08 s (of which model load 12.75 s) |
| Warm wall, median | **1.92 s** |
| Throughput, median | **50.39 tok/s** |
| Throughput, range over 10 runs | 50.26 – 50.46 tok/s |
| Warm `load_duration` | 576 – 687 ms (model resident) |
| Schema validity | **10/10 valid** |
| Peak VRAM | 4 756 MiB |

Throughput varied by under 0.5% across ten consecutive runs, and warm
`load_duration` stayed under a second throughout. Neither is consistent with
the swapping signature that disqualified the 8 GB authoring machine in
[STAGE2_RUNTIME_REQUIREMENTS.md](STAGE2_RUNTIME_REQUIREMENTS.md) §1.

### Document pipeline, three synthetic documents

| Document | Convert | Extract | Total | JSON | Fields |
| --- | --- | --- | --- | --- | --- |
| English digital PDF | **79.06 s** | 1.91 s | 80.98 s | valid | name ✓ email ✓ title ✓ |
| Arabic native (HTML) | 0.01 s | 1.79 s | 1.80 s | valid | 23 Arabic chars, 0 replacement chars |
| Scanned image PDF | 0.80 s | 1.80 s | 2.60 s | valid | name ✓ email ✓ |

The 79 s figure is **first-conversion cost**, not steady state: it includes
Docling initialising and downloading RapidOCR PP-OCRv6 weights. The next two
conversions took 0.80 s and 0.01 s.

---

## 3. Gates passed

| # | Gate (§6) | Measured | |
| --- | --- | --- | --- |
| 1 | Model load ≤ 30 s | 12.75 s | ✅ |
| 2 | Sustained ≥ 40 tok/s (GPU) | 50.4 tok/s | ✅ |
| 4 | Scanned OCR convert ≤ 60 s p95 | 0.80 s | ✅ (n=1) |
| 5 | End-to-end ≤ 180 s p95 | 80.98 s worst | ✅ (n=3) |
| 8 | Timeout/failure rate 0 | 0 | ✅ |

Security and resilience, all verified in-run:

- Ollama bound to `127.0.0.1:11434`; **never** `0.0.0.0`
- 11434 absent from the pod's exposed-port set; only HTTP 8888 was reachable
- malformed JSON rejected by the validator (missing key, extra key, non-dict)
- a 1 s model timeout produced `TimeoutError`, not a hang or a crash
- **zero** document content in the runtime log (4 probe strings, 0 hits)
- temporary fixtures deleted and deletion verified

---

## 4. Gates NOT completed

| # | Gate | Status |
| --- | --- | --- |
| 3 | Digital convert ≤ 10 s p95 | **Inconclusive.** 79.06 s cold / 0.80 s warm, n=1. Needs p95 over ≥20 documents with assets prewarmed |
| 6 | Peak RSS ≤ 70% of host RAM | **Not measurable.** See below |
| 7 | Stability over 20 documents | **Not run.** 3 documents only |
| 9 | Egress blocked, identical results | **Not run**, and expected to fail today — see below |

### Why measurement 6 could not be computed

`free -m` and `nproc` inside the container report the **host**: 515 612 MiB and
128 vCPU, against a pod allocation of 62 GB and 16 vCPU. Every RAM number Run 1
produced is host-wide and cannot be compared to the pod limit. Run 2 reads
cgroup v2 (`memory.current`, `memory.max`) instead — see
[resource_probe.py](../deploy/ai-gateway/resource_probe.py).

### Why measurement 9 would have failed

Docling fetched RapidOCR PP-OCRv6 weights from `modelscope.cn` during the first
conversion. With egress blocked, that conversion fails. This is the offline
guarantee in ACCEPTANCE_CRITERIA §7 #13 breaking in the exact way the sidecar
Dockerfile comment predicted. Fixed by
[ocr-assets.lock](../deploy/ai-gateway/ocr-assets.lock) +
[fetch-ocr-assets.sh](../deploy/ai-gateway/fetch-ocr-assets.sh), with readiness
failing closed when assets are absent.

### A test that did not test what it claimed

Run 1's scanned-document check read `native_text_ok` from **post-conversion**
markdown, which already contains OCR output. It reported `ocr_needed: false`
for an image-only PDF — the flag was wrong, not the pipeline. OCR demonstrably
ran (weights downloaded, text recovered from a rasterised page), but native
versus OCR provenance was never actually discriminated. Corrected in
[docling_sidecar.py](../deploy/ai-gateway/docling_sidecar.py) with a per-page
gate and explicit provenance.

---

## 5. Hardware decision

**NVIDIA L4 is accepted as the Stage 2 target GPU.** It cleared the throughput
gate by 26% with no degradation across repeated runs, and held the 7B Q4_K_M
model in 4.8 GB of 22.5 GB VRAM — room for a larger model later without
changing hardware. L40/L40S are not recommended and are not under evaluation.

## 5a. Region scope

**2026-08-10 — the owner scoped EUR-IS-1 to synthetic Stage 2 testing only. It
is NOT approved for real candidate data.**

| | |
| --- | --- |
| Decision | EUR-IS-1 approved for **synthetic Stage 2 testing only** |
| Real candidate data | **Not approved** |
| Decided by | Owner |
| Date | 2026-08-10 |

An earlier revision of this section recorded the opposite. It was wrong and is
corrected here rather than deleted, because a compliance-adjacent record that
silently changes its mind is worse than one that shows the correction: anyone
who read the earlier claim needs to be able to find out it was superseded.

No real CV has been processed on this pod, and under this scope none may be.

**Consequences that follow from the scope, not from convenience:**

- Run 2's corpus stays synthetic — `generate_fixtures.py` fabricates every
  document from fixed word lists with a fixed seed and reads no input.
- The 50 GB EUR-IS-1 network volume is reused as-is. No new volume, no rebuild
  for another region.
- Any result from this pod is a **synthetic staging** result and may not be
  quoted as evidence about real candidate data.

---

## 6. Hardware result, scoped

**This is a hardware capability result.** It is not production readiness, not
parser acceptance, and not permission to switch `CV_PARSER_PROVIDER`.

---

## 6. What Run 2 must prove

Listed in [STAGE2_BENCHMARK_PLAN.md](STAGE2_BENCHMARK_PLAN.md). In short: assets
prewarmed, p95 over ≥20 synthetic documents including ≥8 Arabic/mixed/scanned,
peak **container** RSS against the pod limit, 20-document stability, zero
unexpected timeouts, egress blocked after provisioning, and correct
native-versus-OCR decisions on both an image-only and a digital PDF.
