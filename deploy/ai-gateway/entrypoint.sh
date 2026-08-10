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

# 4. The authenticated gateway, STARTED BEFORE THE BENCHMARK.
#
# ORDERING BUG THIS FIXES. The benchmark used to run here, synchronously, and
# the gateway started only after it finished. Three consequences, all bad:
#
#   * Port 8080 stayed CLOSED for the entire run. A 22-document benchmark takes
#     far longer than a boot, so the pod looked dead exactly when someone would
#     be checking on it.
#   * The container HEALTHCHECK probes 8080. With nothing listening it fails,
#     the container is marked unhealthy within minutes, and a platform that
#     restarts unhealthy containers restarts the benchmark — which never
#     finishes, forever.
#   * There was no way to watch progress: /health was the only window and it
#     was shut.
#
# So the gateway comes up first and keeps serving THROUGHOUT the benchmark. It
# is backgrounded rather than exec'd, and the script waits on it at the end.
log "starting authenticated gateway on 0.0.0.0:${GATEWAY_PORT}"
python gateway.py &
GATEWAY_PID=$!

# Waits for a LISTENING SOCKET, not for readiness. /health answers 503 until
# both components respond, and curl -f treats that as failure — but a 503 still
# proves the port is open, which is all this loop needs to know before handing
# the benchmark a working gateway.
for i in $(seq 1 60); do
  # curl already prints 000 on a failed connection, so `|| echo 000` would
  # CONCATENATE and produce "000000" — which is != "000" and breaks the loop
  # immediately, handing the benchmark a gateway that is not listening. Take
  # curl's output alone and let a non-zero exit fall through to the retry.
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${GATEWAY_PORT}/health" 2>/dev/null) || true
  [ -n "$code" ] && [ "$code" != "000" ] && break
  if [ "$i" = 60 ]; then log "gateway did not open ${GATEWAY_PORT}"; exit 1; fi
  sleep 1
done
log "gateway is listening on ${GATEWAY_PORT} (health=${code})"

# Any child dying must take the pod down. A gateway still answering /health
# while the model is gone is worse than an outage: it looks healthy and fails
# every request.
trap 'kill -TERM "$OLLAMA_PID" "$DOCLING_PID" "$GATEWAY_PID" 2>/dev/null || true' TERM INT

# 5. OPTIONAL one-shot Stage 2 benchmark, gated on STAGE2_RUN_ON_BOOT.
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

  # EGRESS MODE. RunPod Pods expose no outbound firewall control, so asserting
  # --expect-no-egress there guarantees a FAIL that says nothing: the network is
  # up because the platform cannot take it down. STAGE2_EGRESS_MODE selects the
  # honest posture per platform and defaults to the RunPod reality.
  #
  #   not-controllable (default) — run every other gate, record §6 #9 UNPROVEN
  #   expect-blocked             — assert it; use only where egress CAN be cut
  case "${STAGE2_EGRESS_MODE:-not-controllable}" in
    expect-blocked)   EGRESS_FLAG=--expect-no-egress ;;
    not-controllable) EGRESS_FLAG=--egress-not-controllable ;;
    *) log "unknown STAGE2_EGRESS_MODE — defaulting to not-controllable"
       EGRESS_FLAG=--egress-not-controllable ;;
  esac

  set +e
  python3 /srv/stage2_benchmark.py --corpus "$CORPUS" --out "$BENCH_OUT" \
    "$EGRESS_FLAG" >>"$BENCH_OUT/boot.log" 2>&1
  echo "$?" > "$BENCH_OUT/EXIT_CODE"
  set -e
  log "benchmark finished rc=$(cat "$BENCH_OUT/EXIT_CODE") — results in $BENCH_OUT"
  log "verdict: $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("verdict","(none)"))' "$BENCH_OUT/run2.json" 2>/dev/null || echo '(run2.json unreadable)')"

  # The benchmark's exit code is preserved on disk rather than in the
  # container's exit status: the pod must stay up on 8080 so the results can be
  # collected and the runtime inspected.
fi

# Hand the foreground to the gateway. It has been serving since step 4; this is
# what keeps the container alive and propagates its exit.
log "gateway serving; container will stay up for result collection"
wait "$GATEWAY_PID"
