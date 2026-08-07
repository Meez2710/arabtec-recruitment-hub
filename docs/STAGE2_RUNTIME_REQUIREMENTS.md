# Stage 2 Runtime Requirements

**Nothing here provisions or purchases anything.** It defines what a candidate machine must
be, and the smoke benchmark it must pass before it is accepted.

**A machine is accepted on measured results, never on its specification.** RAM capacity does
not prove inference speed — the measurement in §1 is why this document exists.

---

## 1. Measured evidence from the authoring machine

Apple M1, 8 cores, **8 GB RAM**, Ollama 0.32.5, `qwen3:8b` (5.23 GB, digest `500a1f067a9f`),
`temperature: 0`, thinking disabled:

| Run | `load_duration` | Output tokens | Eval time | Throughput |
| --- | --- | --- | --- | --- |
| 1 (cold) | — | 6 | 39.4 s | **0.15 tok/s** |
| 2 (warm) | 0.4 s | 13 | 39.5 s | **0.33 tok/s** |
| 3 (warm) | 0.5 s | 13 | 73.4 s | **0.18 tok/s** |

`load_duration` under half a second proves the model was **already resident**. This is not
cold start — it is swapping, on a machine where a 5.23 GB model leaves no headroom.
Throughput also **degraded run over run** for identical work.

At ~0.25 tok/s a ~600-token extraction takes **~40 minutes**. The 40-CV pilot would take
~27 hours; a 120-CV corpus, days.

**Conclusions:** 8 GB is disqualified. Render free tier (512 MB, three services —
[render.yaml](render.yaml)) cannot host either component. A useful host needs the model
resident *with room to spare*, which is a working-set question, not a capacity question.

---

## 2. Model candidates — estimates

Footprints are approximate download/resident sizes for common GGUF quantizations. **All
estimates.** Quality is unknown until measured against the acceptance criteria.

| Candidate | Quant | Approx. resident | Notes |
| --- | --- | --- | --- |
| Qwen 1.5B-class instruct | Q4_K_M | ~1.0–1.3 GB | Local iteration only. Unlikely to meet §7 thresholds; **not a production pin** |
| Qwen 3B-class instruct | Q4_K_M | ~2.0–2.5 GB | Plausible floor for structured extraction |
| Qwen 7–8B instruct | Q4_K_M | ~4.5–5.5 GB | **Expected production candidate** |
| Qwen 7–8B instruct | Q8_0 | ~8–9 GB | Only if Q4 fails accuracy and the host has room |
| Qwen 14B-class instruct | Q4_K_M | ~9–10 GB | Only if smaller models fail; needs a GPU for acceptable latency |

**Selection rule:** the **smallest** model that passes §7 of the acceptance criteria on the
accepted host. Bigger is not the goal; passing is.

`qwen3:8b` is what happens to be pulled locally. It is **not** an instruct-tagged build and
is **not** a pin — treat it as a starting point for evaluation only.

---

## 3. Runtime options

### CPU-only — viable, and the default assumption

Workable for batch CV parsing because extraction is off the request path (`AITaskWorker` runs
capabilities outside the transaction). Expect **single-digit tokens/second** on modern server
cores for a 7–8B Q4 model — enough for a ~600-token extraction in roughly 1–3 minutes.

Requires: AVX2 (AVX-512 better), high memory bandwidth (the actual bottleneck), and
`OLLAMA_NUM_PARALLEL=1`.

### GPU-assisted — viable, materially faster

A 7–8B Q4 model fits comfortably in **8 GB VRAM** and typically delivers an order of
magnitude more throughput than CPU. Worth it if bulk intake volume is high; unnecessary for
low single-digit CVs per hour.

Requires: NVIDIA with ≥8 GB VRAM (12 GB gives headroom for a larger model later), current
drivers, NVIDIA Container Toolkit.

**Docling is CPU-bound regardless** and does not need a GPU.

---

## 4. Minimum specification

| Resource | CPU-only | GPU-assisted | Reasoning |
| --- | --- | --- | --- |
| RAM | **32 GB** | 24 GB | Model ~6 GB + Docling/PyTorch ~4 GB + Postgres + app + page cache, with headroom. 16 GB is the absolute floor and leaves none |
| vCPU | 8 dedicated | 8 dedicated | Shared/burstable vCPU makes latency unpredictable and benchmarks meaningless |
| GPU | — | ≥ 8 GB VRAM | 12 GB preferred |
| Storage | **100 GB SSD** | 100 GB SSD | Docling image ~2–3 GB, model weights ~6 GB, Postgres, uploads, backups |
| OS | Ubuntu 22.04/24.04 LTS x86-64 | same | Widest wheel availability |
| Architecture | **x86-64 strongly preferred** | x86-64 | Verify arm64 images exist for the pinned Docling, torch and Tesseract before choosing ARM |
| Docker | Engine ≥ 24, Compose v2 | + NVIDIA Container Toolkit | |
| Network | Egress during provisioning only | same | Runtime parsing must work with egress blocked |

**Swap must be off or minimal.** Swapping is precisely what produced the 0.2 tok/s
measurement in §1; a host that swaps has failed regardless of its RAM figure.

---

## 5. Topology and provisioning

Topology is in [docker-compose.local-ai.yml](deploy/docker-compose.local-ai.yml) — **written,
never run**. Three services (`app`, `docling`, `ollama`) on an `internal: true` network.
Neither AI service publishes a port to the host.

**Concurrency: one document at a time initially.** `OLLAMA_NUM_PARALLEL=1`,
`OLLAMA_MAX_LOADED_MODELS=1`, Docling `--workers 1`. Raise only after measuring peak memory
under load. Bulk intake uses the existing `BATCH` priority
([schema/ai.ts:39](backend/src/infrastructure/db/schema/ai.ts:39)).

### Provisioning checklist

- [ ] Provision host; confirm **dedicated** vCPU, RAM, disk; swap off
- [ ] Install Docker Engine + Compose v2 (+ NVIDIA toolkit if GPU)
- [ ] Build the Docling image; confirm `docling-tools models download` succeeded
- [ ] Re-pin `requirements.txt` from the first successful build's `pip freeze`
- [ ] `POST /v1/health` → `modelsPresent: true`
- [ ] Verify the Docling API calls in `app.py` against the pinned version (§Before this
      contract can be trusted, [DOCLING_SIDECAR_API.md](docs/DOCLING_SIDECAR_API.md))
- [ ] Pull the candidate model into the `ollama-models` volume
- [ ] Record model name, **digest**, quantization, context size, Ollama version
- [ ] **Run the §6 smoke benchmark**
- [ ] **Re-run it with egress blocked** and confirm identical results
- [ ] Only then: accept the machine and pin the model

---

## 6. Smoke benchmark — the acceptance gate for hardware

Run before the machine is accepted and before any quality benchmark. Ten representative CVs
(mixed digital/scanned), sequential, model already resident.

| # | Measurement | Provisional go/no-go | Basis |
| --- | --- | --- | --- |
| 1 | Model load (cold → resident) | **≤ 30 s** | Beyond this, worker restarts dominate |
| 2 | Sustained generation | **≥ 8 tok/s** CPU · **≥ 40 tok/s** GPU | 8 tok/s ⇒ ~600-token extraction in ~75 s |
| 3 | Docling convert, 3-page digital PDF | **≤ 10 s** p95 | |
| 4 | Docling convert, 3-page scanned PDF (OCR) | **≤ 60 s** p95 | |
| 5 | End-to-end CV latency (convert + extract) | **≤ 180 s** p95 | Background work; the recruiter is not waiting |
| 6 | Peak RSS, both services under load | **≤ 70% of host RAM** | Headroom is what prevents §1 |
| 7 | Stability: 20 consecutive documents | **p95 of runs 11–20 ≤ 1.25 × runs 1–10** | Directly catches the degradation seen in §1 |
| 8 | Timeout/failure rate | **0** on valid documents | |
| 9 | Egress blocked | identical results | Proves the offline guarantee |

**All figures are estimates until measured.** They are provisional go/no-go values, not
acceptance criteria — they become binding when a specific machine is proposed and the numbers
are reviewed.

**Measurement 7 is the one that matters most.** A host that passes 1–6 and fails 7 is
swapping under sustained load, and will fail in production exactly when the batch is large.

Record with the results: exact hardware, OS and kernel, Docker version, Docling version and
pipeline config, Ollama version, model name + digest + quantization, context size, and
whether the run was CPU or GPU.
