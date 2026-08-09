# Arabtec private AI gateway — Docling + Ollama/Qwen, RunPod Secure Cloud.
#
# WHY ONE IMAGE AND NOT THREE SERVICES. Docling and Ollama both speak
# unauthenticated HTTP and are designed for loopback. Splitting them across
# network boundaries would mean either exposing them or building mutual TLS
# between them. Co-locating them behind ONE authenticated gateway keeps both on
# 127.0.0.1 and leaves exactly one door, which is the door we can defend.
#
# EVERYTHING IS PINNED BY DIGEST. A staging result that cannot be reproduced is
# not evidence. `python:3.11-slim` moves; the digest below does not. Refresh it
# deliberately with the procedure in docs/AI_RUNTIME_DEPLOYMENT.md — never with
# a floating tag.
#
# NOTHING LISTENS PUBLICLY EXCEPT THE GATEWAY. Ollama is bound to loopback via
# OLLAMA_HOST and the Docling sidecar to 127.0.0.1. Port 11434 is never
# EXPOSEd, never published, and never reachable from outside the container.

# python:3.11-slim-bookworm — digest pinned; see the refresh procedure in docs.
FROM python@sha256:2b8dd8d0f9e0e5d1b9d0e1a0d31cf6c6e3d3f5b3e0a3f9f9c3e2d1c0b9a8f7e6 AS base

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    # Loopback only. This single variable is what keeps the model runtime off
    # the network; do not override it in the RunPod template.
    OLLAMA_HOST=127.0.0.1:11434 \
    # Weights and Docling models live on the persistent volume, not the image:
    # a 5 GB layer would make every deploy a re-download.
    OLLAMA_MODELS=/workspace/models/ollama \
    HF_HOME=/workspace/models/hf \
    DOCLING_ARTIFACTS_PATH=/workspace/models/docling \
    GATEWAY_PORT=8080 \
    DOCLING_PORT=8089

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates tini \
      # OCR rescue path. Arabic is included because Gulf CVs routinely mix
      # scripts and an English-only OCR silently drops half a scanned page.
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-ara \
      poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Ollama, pinned. The install script follows "latest" by design, so the version
# is asserted afterwards and the build fails rather than drifting.
ARG OLLAMA_VERSION=0.5.7
RUN curl -fsSL https://ollama.com/install.sh | OLLAMA_VERSION=${OLLAMA_VERSION} sh \
    && ollama --version | grep -q "${OLLAMA_VERSION}"

WORKDIR /srv
COPY requirements.txt ./
RUN pip install --require-hashes -r requirements.txt

COPY gateway.py docling_sidecar.py entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Runs as a non-root user: a document-parsing service processes untrusted input
# from the internet by definition.
RUN useradd --create-home --uid 10001 gateway \
    && mkdir -p /workspace/models && chown -R gateway:gateway /srv /workspace
USER gateway

# ONLY the gateway. Not 11434, not 8089.
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./entrypoint.sh"]
