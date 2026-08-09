#!/usr/bin/env python3
"""Materialise every OCR asset RapidOCR needs, then hash what actually landed.

WHY NOT A URL LIST. The first attempt pinned modelscope URLs transcribed from
Run 1's console output. One 404'd, and picking the right subset by hand is
guesswork that goes stale whenever the pinned RapidOCR changes which weights it
wants. RapidOCR already knows its own URLs; the reliable move is to let it
fetch once under supervision and record the bytes that resulted.

  --record   warm the cache, print `<relpath>  <sha256>` for every file
  --verify   warm the cache, then require an exact match against the lock

Either way the download happens at BUILD time. Runtime gets a populated,
checksum-verified directory and needs no network.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
import zlib


def tiny_scanned_pdf(path: str) -> None:
    """A 1-page image-only PDF: no text layer, so conversion must invoke OCR
    and therefore must pull the OCR weights."""
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (1000, 1400), "white")
    ImageDraw.Draw(img).text((80, 80), "OCR WARMUP 12345", fill="black")
    img.save(path, "PDF", resolution=150.0)


def warm(cache_dir: str) -> None:
    os.makedirs(cache_dir, exist_ok=True)
    # Point every model cache RapidOCR / Docling might consult at our directory
    # BEFORE importing them — these are read at import time.
    os.environ.setdefault("MODELSCOPE_CACHE", cache_dir)
    os.environ.setdefault("RAPIDOCR_MODEL_DIR", cache_dir)
    os.environ.setdefault("HF_HOME", os.path.join(cache_dir, "hf"))
    # torch's inductor tries to JIT-compile and needs g++, which the slim base
    # deliberately lacks — shipping a C++ toolchain in an image that parses
    # untrusted documents is a worse trade than losing the compile speedup.
    os.environ.setdefault("TORCHINDUCTOR_DISABLE", "1")
    os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")

    import tempfile
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    opts = PdfPipelineOptions()
    opts.do_ocr = True
    opts.do_table_structure = True
    conv = DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)})

    with tempfile.TemporaryDirectory() as tmp:
        pdf = os.path.join(tmp, "warm.pdf")
        tiny_scanned_pdf(pdf)
        conv.convert(pdf)
    print(f"warmed OCR cache at {cache_dir}", file=sys.stderr)


def digest_tree(root: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for dirpath, _, names in os.walk(root):
        for n in sorted(names):
            p = os.path.join(dirpath, n)
            rel = os.path.relpath(p, root)
            # Volatile cache bookkeeping is not an asset. A timestamped xet
            # log made the recorded lock unreproducible on the very next run,
            # which would have turned the integrity check into a coin flip.
            if rel.endswith((".lock", ".tmp", ".incomplete", ".log")):
                continue
            parts = rel.split(os.sep)
            if "logs" in parts or ".locks" in parts:
                continue
            if os.path.basename(rel) in ("CACHEDIR.TAG", ".agent_harnesses.json"):
                continue
            h = hashlib.sha256()
            try:
                with open(p, "rb") as fh:
                    for chunk in iter(lambda: fh.read(1 << 20), b""):
                        h.update(chunk)
            except OSError:
                continue
            out[rel] = h.hexdigest()
    return out


def read_lock(path: str) -> dict[str, str]:
    got: dict[str, str] = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            if len(parts) >= 2:
                got[parts[0]] = parts[1]
    return got


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["record", "verify"], required=True)
    ap.add_argument("--dir", required=True)
    ap.add_argument("--lock", default="ocr-assets.lock")
    args = ap.parse_args()

    warm(args.dir)
    actual = digest_tree(args.dir)
    if not actual:
        print("::error::warm produced no files — OCR did not download anything",
              file=sys.stderr)
        return 1

    if args.mode == "record":
        print("# BEGIN-OCR-ASSETS")
        for rel, h in sorted(actual.items()):
            print(f"{rel}  {h}")
        print("# END-OCR-ASSETS")
        print(f"recorded {len(actual)} assets", file=sys.stderr)
        return 0

    expected = read_lock(args.lock)
    if not expected:
        print("::error::lock has no recorded assets", file=sys.stderr)
        return 1
    missing = sorted(set(expected) - set(actual))
    changed = sorted(k for k in set(expected) & set(actual) if expected[k] != actual[k])
    if missing or changed:
        for k in missing:
            print(f"::error::missing OCR asset: {k}", file=sys.stderr)
        for k in changed:
            print(f"::error::checksum mismatch: {k}", file=sys.stderr)
        return 1
    print(f"verified {len(expected)} OCR assets", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
