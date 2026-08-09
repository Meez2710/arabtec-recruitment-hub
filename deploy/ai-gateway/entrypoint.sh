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

# Any child dying must take the pod down. A gateway still answering /health
# while the model is gone is worse than an outage: it looks healthy and fails
# every request.
trap 'kill -TERM "$OLLAMA_PID" "$DOCLING_PID" 2>/dev/null || true' TERM INT

log "starting authenticated gateway on 0.0.0.0:${GATEWAY_PORT}"
exec python gateway.py
