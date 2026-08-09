#!/usr/bin/env bash
# Bring up the private AI runtime, loopback-first, then the authenticated door.
#
# ORDER MATTERS. The gateway must not report ready before the model is loaded,
# or the ATS will mark the first uploads as failed while the pod is still
# warming — and a failed parse looks to a recruiter like a broken feature, not
# a cold start.
set -euo pipefail

: "${AI_GATEWAY_TOKEN:?AI_GATEWAY_TOKEN must be set — the gateway refuses to start unauthenticated}"
: "${OLLAMA_MODEL:=qwen2.5:7b-instruct}"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# 1. Model runtime, bound to loopback by OLLAMA_HOST (set in the image).
log "starting ollama on ${OLLAMA_HOST}"
ollama serve &
OLLAMA_PID=$!

for i in $(seq 1 60); do
  if curl -fsS "http://${OLLAMA_HOST}/api/tags" >/dev/null 2>&1; then break; fi
  if [ "$i" = 60 ]; then log "ollama did not become ready"; exit 1; fi
  sleep 2
done

# 2. Weights live on the persistent volume. Present after the first boot, so
#    this is a no-op on every restart rather than a re-download.
if ! ollama list | grep -q "${OLLAMA_MODEL%%:*}"; then
  log "pulling ${OLLAMA_MODEL} into ${OLLAMA_MODELS} (first boot only)"
  ollama pull "${OLLAMA_MODEL}"
fi

# 3. Docling sidecar, also loopback only.
log "starting docling sidecar on 127.0.0.1:${DOCLING_PORT}"
python docling_sidecar.py &
DOCLING_PID=$!

for i in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:${DOCLING_PORT}/health" >/dev/null 2>&1; then break; fi
  if [ "$i" = 90 ]; then log "docling sidecar did not become ready"; exit 1; fi
  sleep 2
done

# 4. OPTIONAL one-shot Stage 2 benchmark, gated on STAGE2_RUN_ON_BOOT.
#
# WHY THIS EXISTS. RunPod exposes no container-exec primitive: the only ways
# into a running pod are SSH, the web terminal, or a port you publish. SSH and
# extra ports are forbidden for this runtime and the web terminal will not
# start, so Run 2 has no shell to run in. Rather than weaken the network
# posture, the benchmark becomes a boot mode.
#
# It publishes NO port, touches NO real data, and is inert unless the variable
# is explicitly "true" — absent or any other value preserves the previous
# behaviour exactly.
if [ "${STAGE2_RUN_ON_BOOT:-}" = "true" ]; then
  log "STAGE2_RUN_ON_BOOT=true — running the one-shot synthetic benchmark"
  BENCH_OUT=/workspace/bench/run2
  CORPUS=/workspace/bench/corpus
  mkdir -p "$BENCH_OUT" "$CORPUS"

  # Synthetic fixtures only. generate_fixtures.py fabricates every name, email
  # and employer from fixed word lists with a fixed seed; it reads no input.
  if python3 /srv/generate_fixtures.py --out "$CORPUS" \
       --fonts "${OCR_ASSETS_DIR:-/opt/ocr-assets}/fonts" >>"$BENCH_OUT/boot.log" 2>&1; then
    log "corpus generated"
  else
    log "corpus generation FAILED — see $BENCH_OUT/boot.log"
  fi

  set +e
  python3 /srv/stage2_benchmark.py --corpus "$CORPUS" --out "$BENCH_OUT" \
    --expect-no-egress >>"$BENCH_OUT/boot.log" 2>&1
  echo "$?" > "$BENCH_OUT/EXIT_CODE"
  set -e
  log "benchmark finished rc=$(cat "$BENCH_OUT/EXIT_CODE") — results in $BENCH_OUT"

  # The gateway still starts afterwards: the pod must stay healthy on 8080 so
  # the results can be collected and the runtime inspected. The benchmark's
  # exit code is preserved on disk rather than in the container's exit status.
fi

# Any child dying must take the pod down. A gateway still answering /health
# while the model is gone is worse than an outage: it looks healthy and fails
# every request.
trap 'kill -TERM "$OLLAMA_PID" "$DOCLING_PID" 2>/dev/null || true' TERM INT

log "starting authenticated gateway on 0.0.0.0:${GATEWAY_PORT}"
exec python gateway.py
