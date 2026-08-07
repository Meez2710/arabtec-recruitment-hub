# Docling sidecar — UNVERIFIED.
#
# This image has NOT been built or run. Docker is not installed on the machine
# where it was authored, so every version below is a written intention, not a
# tested fact. Treat the first successful build as the point at which these
# pins become real, and re-pin from that build's lockfile.
#
# DESIGN CONSTRAINTS THIS FILE ENCODES
#   1. Models are baked in at BUILD time. A runtime download would break the
#      offline guarantee at the worst possible moment — the first parse in a
#      network-restricted production environment.
#   2. Runs as a non-root user.
#   3. Binds to the container network only; the compose file does not publish
#      the port to the host.
#   4. No telemetry, no outbound calls at runtime.

FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    # Docling reads model weights from here. Set before the download step so the
    # baked artifacts are the ones served at runtime.
    DOCLING_ARTIFACTS_PATH=/opt/docling-models \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

# Tesseract is the OCR engine; the Arabic pack is required for this deployment
# and is the single most uncertain quality input in the whole migration.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tesseract-ocr tesseract-ocr-ara tesseract-ocr-eng \
      libgl1 libglib2.0-0 curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Fetch model weights at BUILD time. If this step is removed, the container will
# reach the network on first use and the offline guarantee is void.
RUN mkdir -p "$DOCLING_ARTIFACTS_PATH" \
    && HF_HUB_OFFLINE=0 docling-tools models download --output-dir "$DOCLING_ARTIFACTS_PATH"

COPY app.py ./

RUN useradd --create-home --uid 10001 sidecar \
    && chown -R sidecar:sidecar /app "$DOCLING_ARTIFACTS_PATH"
USER sidecar

EXPOSE 8089

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD curl -fsS -X POST http://127.0.0.1:8089/v1/health || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8089", "--workers", "1"]
