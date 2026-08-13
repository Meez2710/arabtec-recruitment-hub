"""Docling sidecar — UNVERIFIED.

This service has NOT been run. Docker and Docling are unavailable on the machine
where it was authored, so the Docling API calls below are written against the
documented interface and must be validated on the first real build.

It implements the contract in docs/DOCLING_SIDECAR_API.md, which is versioned
independently of Docling: a Docling upgrade that changes its internal document
model must not change what this service returns.

PRIVACY RULES ENFORCED HERE
  * No document content is ever logged. Log lines carry an id, a status, a byte
    count and a duration — never text, never a filename from the caller.
  * Temporary files are written to a private directory and removed in a finally
    block, including on failure.
  * No outbound network call at runtime. Models are baked into the image.
"""

from __future__ import annotations

import logging
import os
import tempfile
import time
import uuid
from base64 import b64decode
from contextlib import suppress
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI
from pydantic import BaseModel, Field

API_VERSION = "v1"
MAX_BYTES = int(os.environ.get("SIDECAR_MAX_BYTES", 25 * 1024 * 1024))
CONVERT_TIMEOUT_S = int(os.environ.get("SIDECAR_TIMEOUT_S", 120))

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("docling-sidecar")

app = FastAPI(title="Docling sidecar", version=API_VERSION)

Status = Literal["ok", "unsupported", "encrypted", "corrupt", "empty"]

SUPPORTED_MIME_PREFIXES = (
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword",
    "image/",
    "text/",
)


class ConvertRequest(BaseModel):
    filename: str = Field(max_length=512)
    mimeType: str = Field(max_length=255)
    contentBase64: str


class ConvertResponse(BaseModel):
    status: Status
    markdown: str | None = None
    text: str | None = None
    pages: list[str] | None = None
    pageCount: int | None = None
    detectedLanguages: list[str] | None = None
    ocrApplied: bool | None = None
    reason: str | None = None
    doclingVersion: str | None = None
    pipelineVersion: str | None = None


def _docling_version() -> str:
    with suppress(Exception):
        from importlib.metadata import version

        return version("docling")
    return "unknown"


@app.post(f"/{API_VERSION}/health")
def health() -> dict[str, Any]:
    """Readiness. `modelsPresent` is the offline guarantee's canary."""
    artifacts = Path(os.environ.get("DOCLING_ARTIFACTS_PATH", "/opt/docling-models"))
    models_present = artifacts.is_dir() and any(artifacts.iterdir())
    return {
        "ok": models_present,
        "doclingVersion": _docling_version(),
        "modelsPresent": models_present,
        "ocrEngine": os.environ.get("SIDECAR_OCR_ENGINE", "tesseract"),
    }


@app.post(f"/{API_VERSION}/convert", response_model=ConvertResponse)
@app.post("/convert", response_model=ConvertResponse)
def convert(req: ConvertRequest) -> ConvertResponse:
    request_id = uuid.uuid4().hex[:12]
    started = time.monotonic()
    tmp_path: Path | None = None

    try:
        try:
            payload = b64decode(req.contentBase64, validate=True)
        except Exception:
            return _reject("corrupt", "The request body was not valid base64.")

        size = len(payload)
        if size == 0:
            return _reject("empty", "The document is empty.")
        if size > MAX_BYTES:
            return _reject("unsupported", f"The document exceeds {MAX_BYTES} bytes.")
        if not req.mimeType.startswith(SUPPORTED_MIME_PREFIXES):
            return _reject("unsupported", f"Unsupported media type: {req.mimeType}")

        # Private temp dir; the caller's filename is NEVER used on disk, so a
        # crafted name cannot traverse a path or leak into a log.
        with tempfile.TemporaryDirectory(prefix="docling-") as tmp_dir:
            suffix = Path(req.filename).suffix[:16] or ".bin"
            tmp_path = Path(tmp_dir) / f"{request_id}{suffix}"
            tmp_path.write_bytes(payload)

            result = _converter().convert(str(tmp_path))
            document = result.document

            markdown = document.export_to_markdown()
            text = document.export_to_text()
            if not (text or "").strip():
                return _reject("empty", "The document produced no text.")

            pages = _pages_of(document)
            return ConvertResponse(
                status="ok",
                markdown=markdown or None,
                text=text,
                pages=pages or None,
                pageCount=len(pages) if pages else 1,
                ocrApplied=_ocr_applied(result),
                doclingVersion=_docling_version(),
                pipelineVersion=os.environ.get("SIDECAR_PIPELINE_VERSION", "unpinned"),
            )

    except Exception as exc:  # noqa: BLE001 — classify, never crash the worker
        name = type(exc).__name__.lower()
        if "password" in name or "encrypt" in name:
            return _reject("encrypted", "The document is password-protected.")
        # Any other failure is reported as corrupt rather than as a 500: the
        # adapter treats 5xx as retryable, and retrying a broken file forever
        # would fill the queue.
        log.info(
            '{"level":"error","msg":"convert.failed","requestId":"%s","error":"%s"}',
            request_id,
            name,
        )
        return _reject("corrupt", "The document could not be converted.")

    finally:
        # Belt and braces: TemporaryDirectory already cleans up, but an early
        # return must not leave bytes on disk under any circumstance.
        if tmp_path is not None:
            with suppress(Exception):
                tmp_path.unlink(missing_ok=True)
        log.info(
            '{"level":"info","msg":"convert","requestId":"%s","ms":%d}',
            request_id,
            int((time.monotonic() - started) * 1000),
        )


def _reject(status: Status, reason: str) -> ConvertResponse:
    """A document-level refusal. Never contains document content."""
    return ConvertResponse(
        status=status, reason=reason, doclingVersion=_docling_version()
    )


def _pages_of(document: Any) -> list[str]:
    with suppress(Exception):
        pages = getattr(document, "pages", None)
        if pages:
            return [document.export_to_text(page_no=n) for n in sorted(pages)]
    return []


def _ocr_languages() -> list[str]:
    """Tesseract language codes, matching the packs installed in the image.

    English and Arabic are both installed (tesseract-ocr-eng, tesseract-ocr-ara).
    Overridable so a deployment that adds a pack does not need a code change.
    """
    raw = os.environ.get("SIDECAR_OCR_LANGS", "eng,ara")
    return [code.strip() for code in raw.split(",") if code.strip()]


def _build_converter() -> Any:
    """Docling with OCR configured EXPLICITLY.

    A bare DocumentConverter() leaves the OCR engine at Docling's default, which
    is not the tesseract this image installs - so an image-only document came
    back with no text at all. Three things are set deliberately:

      do_ocr=True              OCR is available at all.
      TesseractCliOcrOptions   the CLI binary the Dockerfile installs, NOT the
                               tesserocr Python binding, which is not a
                               dependency of this service.
      force_full_page_ocr=False OCR runs ONLY on regions with no text layer. A
                               born-digital PDF keeps its exact native text and
                               never pays for a recognition pass; the previous
                               behaviour of the whole pipeline depended on this.
    """
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import (
        PdfPipelineOptions,
        TesseractCliOcrOptions,
    )
    from docling.document_converter import (
        DocumentConverter,
        ImageFormatOption,
        PdfFormatOption,
    )

    options = PdfPipelineOptions()
    options.do_ocr = True
    options.do_table_structure = True
    options.ocr_options = TesseractCliOcrOptions(
        lang=_ocr_languages(),
        # Native text wins wherever it exists. This is what keeps OCR
        # CONDITIONAL rather than universal.
        force_full_page_ocr=False,
    )

    artifacts = os.environ.get("DOCLING_ARTIFACTS_PATH")
    if artifacts:
        options.artifacts_path = artifacts

    # Images take the same pipeline: a PNG/JPEG resume is a page of pixels.
    return DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=options),
            InputFormat.IMAGE: ImageFormatOption(pipeline_options=options),
        }
    )


_CONVERTER: Any = None


def _converter() -> Any:
    """One converter for the process.

    Deliberately lazy: building it loads the layout, table and OCR models, and
    doing that at import time would make the health endpoint lie about
    readiness. Cached because rebuilding per request reloads every model.
    """
    global _CONVERTER  # noqa: PLW0603 - a process-wide cache is the point
    if _CONVERTER is None:
        _CONVERTER = _build_converter()
    return _CONVERTER


def _ocr_applied(result: Any) -> bool:
    """Did any text on this document actually come from OCR?

    Docling marks recognised cells `from_ocr`. The previous implementation read
    `result.ocr_applied`, which Docling does not define, so this always reported
    False - a digital PDF and a scanned one were indistinguishable downstream.
    """
    with suppress(Exception):
        for page in getattr(result, "pages", None) or []:
            for cell in getattr(page, "cells", None) or []:
                if getattr(cell, "from_ocr", False):
                    return True
    with suppress(Exception):
        for item, _level in result.document.iterate_items():
            for prov in getattr(item, "prov", []) or []:
                if getattr(prov, "from_ocr", False):
                    return True
    return False
