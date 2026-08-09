"""Docling sidecar — loopback-only document conversion with a real OCR gate.

Speaks the contract in docs/DOCLING_SIDECAR_API.md, which is versioned
independently of Docling itself so a Docling upgrade that changes its internal
document model does not change this wire format.

BINDS TO 127.0.0.1 AND NOTHING ELSE. It is unauthenticated by design: the only
thing that can reach it is the gateway in the same container. If this ever
needs to listen on 0.0.0.0, that is a design change, not a configuration one.

THE OCR GATE
------------
Stage 2 Run 1 decided "was OCR needed?" by measuring the length of markdown
produced AFTER conversion. That text already contains OCR output, so the check
could never distinguish a native text layer from an OCR rescue. It duly
reported `ocr_needed: false` for a rasterised image-only PDF.

The correct shape, implemented here:

  1. NATIVE PASS with do_ocr=False. Whatever comes back is, by construction,
     the document's own text layer.
  2. PER-PAGE QUALITY GATE on that native text. Page-level, not document-level:
     a 10-page CV with one scanned page is the case a document-level average
     hides.
  3. OCR PASS only if at least one page fails, and its output is used only for
     the pages that failed. Pages with good native text keep it — re-reading
     exact glyphs through OCR loses fidelity.
  4. PROVENANCE per page in the response, so a downstream accuracy result can
     be split by how the text was obtained.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("DOCLING_PORT", "8089"))
ARTIFACTS = os.environ.get("DOCLING_ARTIFACTS_PATH", "/workspace/models/docling")
OCR_ASSETS = os.environ.get("OCR_ASSETS_DIR", "/opt/ocr-assets")

# --- quality gate thresholds -------------------------------------------------
# A page below MIN_CHARS is either blank or a scan. 120 was inherited from the
# gateway's old document-level heuristic and is retained so the two agree.
MIN_CHARS_PER_PAGE = int(os.environ.get("OCR_GATE_MIN_CHARS", "120"))
# Native text extracted from a scan is characteristically punctuation and
# stray glyphs. Real prose is mostly letters.
MIN_ALPHA_RATIO = float(os.environ.get("OCR_GATE_MIN_ALPHA_RATIO", "0.55"))
# U+FFFD means the text layer exists but its encoding is broken — common in
# Arabic PDFs with a bad ToUnicode map. OCR is the better source there.
MAX_REPLACEMENT_RATIO = float(os.environ.get("OCR_GATE_MAX_REPLACEMENT_RATIO", "0.02"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("docling")

_converters: dict[bool, object] = {}

_WORDLIKE = re.compile(r"[^\W\d_]", re.UNICODE)


def assets_present() -> tuple[bool, int]:
    """Readiness depends on this. Missing assets must fail closed, not silently
    fall through to a runtime download — that is the whole point of Run 1's
    finding."""
    manifest = os.path.join(OCR_ASSETS, "MANIFEST")
    if not os.path.isfile(manifest):
        return False, 0
    count = 0
    try:
        with open(manifest, encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("asset="):
                    rel = line.split("=", 1)[1].strip()
                    if not os.path.isfile(os.path.join(OCR_ASSETS, rel)):
                        return False, count
                    count += 1
    except OSError:
        return False, count
    return count > 0, count


def _build(do_ocr: bool):
    """Docling is imported lazily so an import failure surfaces on /health
    rather than preventing the process from starting at all."""
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    opts = PdfPipelineOptions(artifacts_path=ARTIFACTS)
    opts.do_ocr = do_ocr
    opts.do_table_structure = True

    if do_ocr:
        # Engine selection is deliberately defensive: the pinned Docling's
        # default is RapidOCR, but the option class name has moved between
        # releases. compat_check.py asserts at build time that at least one of
        # these exists; here we take whichever does.
        try:
            from docling.datamodel.pipeline_options import RapidOcrOptions
            opts.ocr_options = RapidOcrOptions(force_full_page_ocr=True)
        except (ImportError, AttributeError):
            try:
                from docling.datamodel.pipeline_options import TesseractCliOcrOptions
                # Arabic alongside English: Gulf CVs routinely mix scripts and
                # an English-only OCR silently drops half a scanned page.
                opts.ocr_options = TesseractCliOcrOptions(
                    lang=["eng", "ara"], force_full_page_ocr=True)
            except (ImportError, AttributeError):
                log.warning("no explicit OCR engine options available; using defaults")

    return DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)}
    )


def converter(do_ocr: bool):
    if do_ocr not in _converters:
        _converters[do_ocr] = _build(do_ocr)
    return _converters[do_ocr]


def page_texts(doc) -> list[str]:
    """Per-page text, defensively.

    Docling's page model has changed shape across releases. We try the
    documented accessor, then a couple of known fallbacks, and finally give up
    to a single pseudo-page rather than raising — a provenance feature must not
    be able to fail a conversion.
    """
    pages = getattr(doc, "pages", None)
    out: list[str] = []
    if isinstance(pages, dict) and pages:
        for _, p in sorted(pages.items(), key=lambda kv: kv[0]):
            txt = ""
            for attr in ("export_to_text", "text"):
                v = getattr(p, attr, None)
                if callable(v):
                    try:
                        txt = v() or ""
                        break
                    except Exception:  # noqa: BLE001
                        continue
                elif isinstance(v, str):
                    txt = v
                    break
            out.append(txt)
        if any(out):
            return out
    # Fallback: whole-document text as one page. Recorded as such by the caller.
    try:
        return [doc.export_to_text() or ""]
    except Exception:  # noqa: BLE001
        return [""]


def ocr_metadata(doc) -> dict:
    """Whatever Docling itself says about OCR, when it says anything.

    Preferred over our heuristic when present; recorded alongside it when both
    exist so a disagreement is visible rather than silently resolved.
    """
    meta: dict = {}
    for attr in ("num_ocr_cells", "ocr_cell_count"):
        v = getattr(doc, attr, None)
        if isinstance(v, int):
            meta[attr] = v
    pages = getattr(doc, "pages", None)
    if isinstance(pages, dict) and pages:
        flags = []
        for idx, p in sorted(pages.items(), key=lambda kv: kv[0]):
            f = None
            for attr in ("is_ocr", "ocr", "has_ocr"):
                v = getattr(p, attr, None)
                if isinstance(v, bool):
                    f = v
                    break
            flags.append(f)
        if any(f is not None for f in flags):
            meta["perPageOcrFlags"] = flags
    return meta


def assess_page(text: str) -> dict:
    """The gate. Returns the verdict and the numbers behind it, because a gate
    whose reasoning is not recorded cannot be debugged from a benchmark run."""
    t = text or ""
    n = len(t.strip())
    letters = len(_WORDLIKE.findall(t))
    repl = t.count("�")
    alpha_ratio = (letters / n) if n else 0.0
    repl_ratio = (repl / n) if n else 0.0

    reasons = []
    if n < MIN_CHARS_PER_PAGE:
        reasons.append(f"chars<{MIN_CHARS_PER_PAGE}")
    if n and alpha_ratio < MIN_ALPHA_RATIO:
        reasons.append(f"alphaRatio<{MIN_ALPHA_RATIO}")
    if repl_ratio > MAX_REPLACEMENT_RATIO:
        reasons.append(f"replacementRatio>{MAX_REPLACEMENT_RATIO}")

    return {
        "chars": n,
        "alphaRatio": round(alpha_ratio, 4),
        "replacementRatio": round(repl_ratio, 4),
        "nativeOk": not reasons,
        "failedChecks": reasons,
    }


def convert_with_gate(path: str, force_ocr: bool | None = None) -> dict:
    """Native pass, per-page gate, targeted OCR rescue, explicit provenance."""
    t0 = time.time()

    # ---- 1. native pass, OCR explicitly disabled ----
    native_doc = converter(False).convert(path).document
    native_pages = page_texts(native_doc)
    t_native = time.time() - t0

    assessments = [assess_page(p) for p in native_pages]
    failing = [i for i, a in enumerate(assessments) if not a["nativeOk"]]

    if force_ocr is True:
        failing = list(range(len(native_pages)))
    elif force_ocr is False:
        failing = []

    final_pages = list(native_pages)
    provenance = ["native"] * len(native_pages)
    ocr_meta: dict = {}
    t_ocr = 0.0
    ocr_error = None

    # ---- 2. OCR rescue, only for pages that failed ----
    if failing:
        t1 = time.time()
        try:
            ocr_doc = converter(True).convert(path).document
            ocr_pages = page_texts(ocr_doc)
            ocr_meta = ocr_metadata(ocr_doc)
            for i in failing:
                if i >= len(ocr_pages):
                    provenance[i] = "ocr-no-improvement"
                    continue
                # When the caller forced OCR they have overridden the gate, so
                # OCR output is authoritative and the length comparison below
                # must not veto it. Only the *automatic* rescue path keeps the
                # better of the two — there, a shorter OCR result means the
                # rescue found less than the native layer already had.
                if force_ocr is True:
                    if ocr_pages[i].strip():
                        final_pages[i] = ocr_pages[i]
                        provenance[i] = "ocr"
                    else:
                        provenance[i] = "ocr-no-improvement"
                elif len(ocr_pages[i].strip()) > len(final_pages[i].strip()):
                    final_pages[i] = ocr_pages[i]
                    provenance[i] = "ocr"
                else:
                    provenance[i] = "ocr-no-improvement"
            markdown = ocr_doc.export_to_markdown()
        except Exception as exc:  # noqa: BLE001 - never re-raised onto the CV path
            ocr_error = type(exc).__name__
            log.error("ocr rescue failed: %s", ocr_error)
            for i in failing:
                provenance[i] = "ocr-failed"
            markdown = native_doc.export_to_markdown()
        t_ocr = time.time() - t1
    else:
        markdown = native_doc.export_to_markdown()

    text = "\n\n".join(p for p in final_pages if p)

    return {
        "status": "ok",
        "markdown": markdown,
        "text": text,
        "pages": final_pages,
        "pageCount": len(final_pages),
        # Kept for wire compatibility: true when ANY page was OCR'd.
        "ocrApplied": any(p == "ocr" for p in provenance),
        "detectedLanguages": [],
        # --- new, additive: the provenance Run 1 could not produce ---
        "pageProvenance": provenance,
        "nativePageCount": sum(1 for p in provenance if p == "native"),
        "ocrPageCount": sum(1 for p in provenance if p == "ocr"),
        "ocrRescueInvoked": bool(failing),
        "ocrError": ocr_error,
        "pageAssessments": assessments,
        "doclingOcrMetadata": ocr_meta,
        "gate": {
            "minCharsPerPage": MIN_CHARS_PER_PAGE,
            "minAlphaRatio": MIN_ALPHA_RATIO,
            "maxReplacementRatio": MAX_REPLACEMENT_RATIO,
        },
        "timings": {
            "nativeConvertS": round(t_native, 3),
            "ocrConvertS": round(t_ocr, 3),
            "totalConvertS": round(time.time() - t0, 3),
        },
    }


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

        ocr_ok, ocr_count = assets_present()
        models_ok = os.path.isdir(ARTIFACTS)
        # Readiness is the conjunction. A runtime that is "up" but would reach
        # modelscope.cn on the first scanned CV is not ready.
        ready = ok and models_ok and ocr_ok
        self._send(200 if ready else 503, {
            "ok": ready,
            "doclingVersion": version,
            "modelsPresent": models_ok,
            "ocrAssetsPresent": ocr_ok,
            "ocrAssetCount": ocr_count,
            "ocrAssetsDir": OCR_ASSETS,
            "ocrEngine": os.environ.get("OCR_ENGINE", "rapidocr"),
            "reason": None if ready else (
                "docling import failed" if not ok else
                "docling artifacts missing" if not models_ok else
                "OCR assets missing or incomplete — refusing to serve, a parse "
                "would download at runtime"),
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
        force = req.get("forceOcr")
        force = None if force is None else bool(force)

        # Randomised temp path, removed on every exit path. The bytes are a
        # person's CV; nothing may survive the request.
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / f"doc{suffix}"
            path.write_bytes(content)
            try:
                payload = convert_with_gate(str(path), force_ocr=force)
            except Exception as exc:  # noqa: BLE001 - classified below, never re-raised
                name = type(exc).__name__.lower()
                status = ("encrypted" if "encrypt" in name or "password" in name
                          else "unsupported" if "format" in name or "conversion" in name
                          else "corrupt")
                log.info("convert rejected status=%s", status)
                return self._send(200, {"status": status,
                                        "reason": f"Document rejected ({status})."})

            if not (payload["markdown"] or payload["text"]).strip():
                return self._send(200, {"status": "empty",
                                        "reason": "The document produced no text."})

            # Provenance counts only — never page text.
            log.info("convert ok pages=%d native=%d ocr=%d rescue=%s",
                     payload["pageCount"], payload["nativePageCount"],
                     payload["ocrPageCount"], payload["ocrRescueInvoked"])
            self._send(200, payload)


if __name__ == "__main__":
    log.info("docling sidecar listening on 127.0.0.1:%d", PORT)
    # Loopback only. Never 0.0.0.0.
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
