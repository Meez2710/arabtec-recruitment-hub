#!/usr/bin/env python3
"""Assert the exact Docling API surface this runtime depends on.

WHY. `docling` moved 2.15 -> 2.55 -> 2.118 while this repo's three config files
each named a different one. Pipeline options and the page model are internal
APIs that have changed across those releases. Pinning a version because it
happened to be installed on a pod is not evidence it is compatible.

This runs during the image build. A failure here fails the build, which is the
intended behaviour: an incompatible Docling silently degrades to "no OCR" or
"no page provenance", and the benchmark would record a pass for a pipeline that
is not doing the work.

Exit 0 = the pin in versions.env may be treated as accepted.
"""

from __future__ import annotations

import inspect
import sys

FAILURES: list[str] = []
NOTES: list[str] = []


def need(cond: bool, msg: str) -> None:
    if not cond:
        FAILURES.append(msg)


def main() -> int:
    try:
        import docling
    except ImportError as exc:
        print(f"FATAL: docling not importable: {exc}", file=sys.stderr)
        return 2

    version = getattr(docling, "__version__", "unknown")
    print(f"docling version: {version}")

    # ---- pipeline options: the OCR switch and the local-artifacts path ----
    try:
        from docling.datamodel.pipeline_options import PdfPipelineOptions
    except ImportError as exc:
        FAILURES.append(f"PdfPipelineOptions not importable: {exc}")
        PdfPipelineOptions = None  # type: ignore[assignment]

    if PdfPipelineOptions is not None:
        try:
            opts = PdfPipelineOptions()
        except Exception as exc:  # noqa: BLE001
            FAILURES.append(f"PdfPipelineOptions() not constructible: {exc}")
            opts = None
        if opts is not None:
            need(hasattr(opts, "do_ocr"),
                 "PdfPipelineOptions.do_ocr missing — cannot disable OCR for the "
                 "native pass, so native/OCR provenance is unknowable")
            need(hasattr(opts, "do_table_structure"),
                 "PdfPipelineOptions.do_table_structure missing")
            fields = getattr(PdfPipelineOptions, "model_fields", {}) or {}
            need("artifacts_path" in fields or hasattr(opts, "artifacts_path"),
                 "PdfPipelineOptions.artifacts_path missing — cannot point Docling "
                 "at pre-provisioned local models, so runtime would download")

    # ---- OCR engine options actually available in this build ----
    engines = {}
    for name in ("RapidOcrOptions", "TesseractCliOcrOptions", "EasyOcrOptions"):
        try:
            mod = __import__("docling.datamodel.pipeline_options", fromlist=[name])
            engines[name] = getattr(mod, name)
        except (ImportError, AttributeError):
            engines[name] = None
    available = [k for k, v in engines.items() if v is not None]
    print(f"ocr engines available: {available}")
    need(bool(available), "no OCR engine options importable at all")

    # RapidOCR is the default in 2.118 and is what reached the network in Run 1.
    # If it is present we must be able to point it at local model files.
    rapid = engines.get("RapidOcrOptions")
    if rapid is not None:
        try:
            sig = set(getattr(rapid, "model_fields", {}) or {})
        except Exception:  # noqa: BLE001
            sig = set()
        local_keys = {"det_model_path", "rec_model_path", "cls_model_path"}
        if not (local_keys & sig):
            NOTES.append(
                "RapidOcrOptions exposes no det/rec/cls model path fields "
                f"(saw: {sorted(sig)[:12]}). Local-asset wiring must instead go "
                "through the engine's own env/config; verify fetch-ocr-assets.sh "
                "targets the path this build actually reads.")

    # ---- converter and format option plumbing ----
    try:
        from docling.document_converter import DocumentConverter, PdfFormatOption
        need(callable(DocumentConverter), "DocumentConverter not callable")
        params = inspect.signature(DocumentConverter).parameters
        need("format_options" in params,
             "DocumentConverter has no format_options parameter")
        need(callable(PdfFormatOption), "PdfFormatOption not callable")
    except ImportError as exc:
        FAILURES.append(f"document_converter imports failed: {exc}")

    try:
        from docling.datamodel.base_models import InputFormat
        need(hasattr(InputFormat, "PDF"), "InputFormat.PDF missing")
    except ImportError as exc:
        FAILURES.append(f"InputFormat not importable: {exc}")

    # ---- page-level model: required for per-page OCR provenance ----
    # We do not assert an exact shape here because it varies; we assert that a
    # converted document exposes SOMETHING page-indexed, and the sidecar probes
    # defensively at runtime. What must not happen is silent absence.
    try:
        from docling_core.types.doc import DoclingDocument
        has_pages = "pages" in (getattr(DoclingDocument, "model_fields", {}) or {})
        need(has_pages,
             "DoclingDocument has no `pages` field — per-page OCR provenance "
             "cannot be recorded and the OCR gate degrades to document level")
    except ImportError as exc:
        NOTES.append(f"docling_core.types.doc not importable ({exc}); "
                     "sidecar will fall back to document-level provenance")

    # ---- OCR engine runtime must actually import ----
    # rapidocr ships without an inference engine by default. Without this the
    # image builds, digital documents parse, and only scanned documents fail —
    # at runtime, in production, on the first CV that needs OCR.
    try:
        import onnxruntime
        print(f"onnxruntime: {onnxruntime.__version__} "
              f"providers={onnxruntime.get_available_providers()}")
    except ImportError as exc:
        FAILURES.append(f"onnxruntime not importable ({exc}) — RapidOCR selects "
                        "engine_name=onnxruntime and every OCR rescue will fail")

    # ---- report ----
    for n in NOTES:
        print(f"NOTE: {n}")
    if FAILURES:
        print(f"\nINCOMPATIBLE — {len(FAILURES)} problem(s) with docling {version}:",
              file=sys.stderr)
        for f in FAILURES:
            print(f"  - {f}", file=sys.stderr)
        print("\nDo NOT promote DOCLING_PIN_STATUS to accepted.", file=sys.stderr)
        return 1

    print(f"\nCOMPATIBLE — docling {version} satisfies the runtime's API surface.")
    print("versions.env DOCLING_PIN_STATUS may be set to: accepted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
