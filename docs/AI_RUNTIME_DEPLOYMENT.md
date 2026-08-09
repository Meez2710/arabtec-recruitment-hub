# Private AI runtime — staging deployment (RunPod Secure Cloud)

Reproducible artifacts for the CV-parsing runtime. **Nothing here has been
deployed.** Deployment needs owner-provided RunPod access and an approved
region; the inputs still required are listed at the end.

## Shape

```
ATS (Render, Node)                 RunPod Secure Cloud pod
────────────────────               ──────────────────────────────────────
POST /v1/resume/parse  ──HTTPS──▶  :8080  gateway.py   (authenticated)
   Authorization: Bearer <token>            │
                                            ├─▶ 127.0.0.1:8089  Docling sidecar
                                            └─▶ 127.0.0.1:11434 Ollama / Qwen
```

Only `:8080` is published. Docling and Ollama bind to loopback and are
unauthenticated **by design** — the only process that can reach them lives in
the same container. Port `11434` is never `EXPOSE`d, never published, and never
reachable from outside the pod. The browser reaches neither: the ATS holds the
token server-side and exposes no endpoint that takes a caller-supplied host,
path, model or prompt.

## Why one container rather than three services

Docling and Ollama both speak unauthenticated HTTP and are designed for
loopback. Splitting them across network boundaries would mean either exposing
them or building mutual TLS between them. Co-locating them behind one
authenticated gateway keeps both on `127.0.0.1` and leaves exactly one door,
which is the door that can be defended.

## Persistent paths

The RunPod volume mounts at `/workspace`. Weights are **not** baked into the
image — a 5 GB layer would make every deploy a re-download.

| Path | Holds | First boot |
| --- | --- | --- |
| `/workspace/models/ollama` | Qwen weights (`OLLAMA_MODELS`) | `ollama pull`, ~5 GB |
| `/workspace/models/docling` | Docling layout/OCR models (`DOCLING_ARTIFACTS_PATH`) | downloaded on first convert |
| `/workspace/models/hf` | HuggingFace cache (`HF_HOME`) | populated as needed |

No CV is written to `/workspace`. Documents exist only in memory and in a
per-request temp directory that is removed on every exit path.

## Environment variables

Set on the RunPod template. **Values are the owner's; none are recorded here or
in the repository.**

### Pod (gateway side)

| Variable | Required | Purpose |
| --- | --- | --- |
| `AI_GATEWAY_TOKEN` | **yes** | Shared bearer token. The gateway refuses to start without it. |
| `OLLAMA_MODEL` | no | Default `qwen2.5:7b-instruct`. |
| `OLLAMA_HOST` | no | Default `127.0.0.1:11434`. **Do not override** — this is what keeps the model off the network. |
| `OLLAMA_MODELS` | no | Default `/workspace/models/ollama`. |
| `DOCLING_ARTIFACTS_PATH` | no | Default `/workspace/models/docling`. |
| `GATEWAY_PORT` | no | Default `8080`. |
| `DOCLING_PORT` | no | Default `8089`, loopback only. |

### ATS (Render side)

| Variable | Required | Purpose |
| --- | --- | --- |
| `AI_ENABLED` | **yes** | `false` by default. `true` switches the feature on. |
| `AI_GATEWAY_URL` | **yes** | `https://<pod-id>-8080.proxy.runpod.net` |
| `AI_GATEWAY_TOKEN` | **yes** | Must match the pod's token exactly. |
| `AI_TIMEOUT_MS` | no | Default `180000`. |
| `AI_MAX_CONCURRENCY` | no | Default `2`. A GPU serves one at a time; queueing in the database is cheaper than queueing in the model. |
| `AI_MAX_ATTEMPTS` | no | Default `2` — one automatic retry. |
| `AI_BREAKER_THRESHOLD` | no | Default `3` consecutive environment failures. |
| `AI_BREAKER_COOLDOWN_MS` | no | Default `60000`. |
| `AI_MAX_UPLOAD_BYTES` | no | Default `15728640` (15 MB). |
| `AI_MAX_PAGES` | no | Default `30`. |

There is no hosted-provider variable, and no fallback provider, deliberately.

## Build

```bash
docker build -t arabtec-ai-gateway:staging deploy/ai-gateway
```

The image pins the base by digest and asserts the Ollama version after install,
because the upstream installer follows `latest` by design. `requirements.txt`
uses `--require-hashes`.

**The build fails until the requirement hashes are generated.** That is
intended: an unpinned dependency in an image that processes candidates' CVs is
not an acceptable default. Generate them on the build host:

```bash
pip-compile --generate-hashes --output-file=deploy/ai-gateway/requirements.txt deploy/ai-gateway/requirements.in
```

To refresh the pinned base digest deliberately:

```bash
docker buildx imagetools inspect python:3.11-slim-bookworm --format '{{json .Manifest.Digest}}'
```

## Stage 2 smoke test

Run from a machine that can reach the pod, with `AI_GATEWAY_URL` and
`AI_GATEWAY_TOKEN` exported. It checks readiness, version reporting, that the
model runtime is **not** exposed, and one real parse.

```bash
bash deploy/ai-gateway/smoke-test.sh
```

## Owner inputs still required

1. RunPod account access and an **approved region** (data-residency decision —
   Gulf CVs may carry residency expectations this project has not been told).
2. A GPU tier decision (a 7B model at Q4 needs ~8 GB VRAM; 16 GB gives headroom).
3. The generated `AI_GATEWAY_TOKEN`, set on both sides.
4. Confirmation that the persistent volume is provisioned and sized (≥ 20 GB).
5. Sign-off to run `pip-compile` and commit the resulting hashes.
6. Confirmation of the retention rule for uploaded CVs on the ATS side — the
   current behaviour reuses the existing `file_blob` policy unchanged.
