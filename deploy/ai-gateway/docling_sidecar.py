"""Docling sidecar — loopback-only document conversion.

Speaks the contract in docs/DOCLING_SIDECAR_API.md, which is versioned
independently of Docling itself so a Docling upgrade that changes its internal
document model does not change this wire format.

BINDS TO 127.0.0.1 AND NOTHING ELSE. It is unauthenticated by design: the only
thing that can reach it is the gateway in the same container. If this ever
needs to listen on 0.0.0.0, that is a design change, not a configuration one.
"""

from __future__ import annotations

import base64
import json
import logging
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("DOCLING_PORT", "8089"))
ARTIFACTS = os.environ.get("DOCLING_ARTIFACTS_PATH", "/workspace/models/docling")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("docling")

_converter = None
_ocr_converter = None


def _build(force_ocr: bool):
    """Docling is imported lazily so an import failure surfaces on /health
    rather than preventing the process from starting at all."""
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, TesseractCliOcrOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    opts = PdfPipelineOptions(artifacts_path=ARTIFACTS)
    opts.do_ocr = force_ocr
    opts.do_table_structure = True
    if force_ocr:
        # Arabic alongside English: Gulf CVs routinely mix scripts and an
        # English-only OCR silently drops half a scanned page.
        opts.ocr_options = TesseractCliOcrOptions(lang=["eng", "ara"], force_full_page_ocr=True)
    return DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)}
    )


def converter(force_ocr: bool):
    global _converter, _ocr_converter
    if force_ocr:
        if _ocr_converter is None:
            _ocr_converter = _build(True)
        return _ocr_converter
    if _converter is None:
        _converter = _build(False)
    return _converter


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # noqa: A003 - stdlib hook
        """No access log: it would print filenames."""

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - stdlib hook
        if self.path != "/health":
            return self._send(404, {"error": "not found"})
        try:
            import docling  # noqa: F401
            ok, version = True, getattr(docling, "__version__", "unknown")
        except ImportError as exc:
            ok, version = False, str(exc)
        self._send(200 if ok else 503, {
            "ok": ok, "doclingVersion": version,
            "modelsPresent": os.path.isdir(ARTIFACTS), "ocrEngine": "tesseract",
        })

    def do_POST(self) -> None:  # noqa: N802 - stdlib hook
        if self.path != "/v1/convert":
            return self._send(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 40 * 1024 * 1024:
            return self._send(413, {"error": "payload too large"})
        try:
            req = json.loads(self.rfile.read(length))
            content = base64.b64decode(req["contentBase64"], validate=True)
        except (ValueError, KeyError):
            return self._send(400, {"error": "malformed request"})

        import tempfile
        from pathlib import Path

        suffix = Path(str(req.get("filename") or "cv")).suffix or ".pdf"
        # Randomised temp path, removed on every exit path. The bytes are a
        # person's CV; nothing may survive the request.
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / f"doc{suffix}"
            path.write_bytes(content)
            try:
                result = converter(bool(req.get("forceOcr"))).convert(str(path))
            except Exception as exc:  # noqa: BLE001 - classified below, never re-raised
                name = type(exc).__name__.lower()
                status = ("encrypted" if "encrypt" in name or "password" in name
                          else "unsupported" if "format" in name or "conversion" in name
                          else "corrupt")
                log.info("convert rejected status=%s", status)
                return self._send(200, {"status": status,
                                        "reason": f"Document rejected ({status})."})

            doc = result.document
            markdown = doc.export_to_markdown()
            text = doc.export_to_text()
            pages = [p.export_to_text() if hasattr(p, "export_to_text") else ""
                     for p in getattr(doc, "pages", {}).values()]
            page_count = len(pages) or getattr(doc, "num_pages", lambda: 1)()

            if not (markdown or text).strip():
                return self._send(200, {"status": "empty",
                                        "reason": "The document produced no text."})

            self._send(200, {
                "status": "ok",
                "markdown": markdown,
                "text": text,
                "pages": pages,
                "pageCount": page_count,
                "ocrApplied": bool(req.get("forceOcr")),
                "detectedLanguages": [],
            })


if __name__ == "__main__":
    log.info("docling sidecar listening on 127.0.0.1:%d", PORT)
    # Loopback only. Never 0.0.0.0.
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
