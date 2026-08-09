"""Tests for the native-versus-OCR decision.

These exist because Stage 2 Run 1 shipped a check that could not fail: it read
post-OCR markdown and concluded no OCR was needed. The two cases that matter —
an image-only page must trigger rescue, a digital page must not — are asserted
here directly, with a stub converter so they run without Docling, a GPU or a
network.

Run:  python3 -m unittest deploy.ai-gateway.test_ocr_gate -v
  or: cd deploy/ai-gateway && python3 -m unittest test_ocr_gate -v
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import docling_sidecar as ds  # noqa: E402


DIGITAL_PAGE = (
    "Layla Hammad\nlayla.hammad@example.com\n+971 50 555 0142\n"
    "Senior Site Engineer\n"
    "Senior Site Engineer - Falcon Contracting LLC (2021-2026)\n"
    "Site Engineer - Delta Build Group (2017-2021)\n"
    "Cairo Institute of Technology - BSc Civil Engineering, 2016\n"
    "AutoCAD, Primavera P6, QA/QC, Concrete Testing\n"
)
# What a scanned page's *native* layer actually looks like: almost nothing.
SCANNED_NATIVE_PAGE = "  \n \f "
# A broken ToUnicode map: text present, encoding destroyed.
MOJIBAKE_PAGE = "�����������������������������������������������������������������������"
# Stray glyphs and punctuation, no words — the classic bad text layer.
GLYPH_SOUP_PAGE = "|| ||| .. ,, ;; :: || 1 2 3 || .. ,, || ;; :: || .. ,, ;; || 1 2 || .. ,,;;::||"


class FakeDoc:
    def __init__(self, pages, markdown="MD"):
        self._pages = {i: FakePage(t) for i, t in enumerate(pages)}
        self._md = markdown

    @property
    def pages(self):
        return self._pages

    def export_to_markdown(self):
        return self._md

    def export_to_text(self):
        return "\n".join(p.export_to_text() for p in self._pages.values())


class FakePage:
    def __init__(self, text):
        self._t = text

    def export_to_text(self):
        return self._t


class FakeResult:
    def __init__(self, doc):
        self.document = doc


class FakeConverter:
    """Records whether it was asked to run, so 'OCR was not invoked' is
    provable rather than inferred from output."""

    def __init__(self, pages, markdown="MD"):
        self.pages = pages
        self.markdown = markdown
        self.calls = 0

    def convert(self, path):
        self.calls += 1
        return FakeResult(FakeDoc(self.pages, self.markdown))


class GateHarness(unittest.TestCase):
    def install(self, native_pages, ocr_pages):
        self.native = FakeConverter(native_pages, "NATIVE_MD")
        self.ocr = FakeConverter(ocr_pages, "OCR_MD")
        ds._converters = {False: self.native, True: self.ocr}

    def tearDown(self):
        ds._converters = {}


class TestAssessPage(unittest.TestCase):
    def test_digital_page_passes(self):
        a = ds.assess_page(DIGITAL_PAGE)
        self.assertTrue(a["nativeOk"], a)
        self.assertEqual(a["failedChecks"], [])

    def test_empty_native_layer_fails_on_length(self):
        a = ds.assess_page(SCANNED_NATIVE_PAGE)
        self.assertFalse(a["nativeOk"])
        self.assertTrue(any("chars<" in r for r in a["failedChecks"]), a)

    def test_mojibake_fails_on_replacement_ratio(self):
        a = ds.assess_page(MOJIBAKE_PAGE)
        self.assertFalse(a["nativeOk"])
        self.assertTrue(any("replacementRatio" in r for r in a["failedChecks"]), a)

    def test_glyph_soup_fails_on_alpha_ratio(self):
        # Long enough to clear the length check, so alphaRatio is what must
        # catch it. This is the case a pure length heuristic misses.
        page = GLYPH_SOUP_PAGE * 3
        a = ds.assess_page(page)
        self.assertGreaterEqual(a["chars"], ds.MIN_CHARS_PER_PAGE)
        self.assertFalse(a["nativeOk"])
        self.assertTrue(any("alphaRatio" in r for r in a["failedChecks"]), a)


class TestConvertWithGate(GateHarness):
    def test_digital_pdf_must_not_invoke_ocr(self):
        self.install([DIGITAL_PAGE], ["SHOULD NOT BE USED"])
        r = ds.convert_with_gate("/tmp/fake.pdf")
        self.assertEqual(self.ocr.calls, 0, "OCR converter was built/called for a digital page")
        self.assertFalse(r["ocrRescueInvoked"])
        self.assertFalse(r["ocrApplied"])
        self.assertEqual(r["pageProvenance"], ["native"])
        self.assertEqual(r["nativePageCount"], 1)
        self.assertEqual(r["ocrPageCount"], 0)
        self.assertIn("Layla", r["text"])

    def test_image_only_pdf_must_report_ocr_rescue(self):
        self.install([SCANNED_NATIVE_PAGE], [DIGITAL_PAGE])
        r = ds.convert_with_gate("/tmp/fake.pdf")
        self.assertEqual(self.ocr.calls, 1)
        self.assertTrue(r["ocrRescueInvoked"])
        self.assertTrue(r["ocrApplied"])
        self.assertEqual(r["pageProvenance"], ["ocr"])
        self.assertEqual(r["ocrPageCount"], 1)
        self.assertEqual(r["nativePageCount"], 0)
        self.assertIn("Layla", r["text"])

    def test_mixed_document_rescues_only_the_failing_page(self):
        # The case the old document-level average could never catch: one bad
        # page inside an otherwise digital CV.
        self.install(
            native_pages=[DIGITAL_PAGE, SCANNED_NATIVE_PAGE, DIGITAL_PAGE],
            ocr_pages=["OCR-0", "Recovered scanned page with plenty of real words in it", "OCR-2"],
        )
        r = ds.convert_with_gate("/tmp/fake.pdf")
        self.assertEqual(r["pageProvenance"], ["native", "ocr", "native"])
        self.assertEqual(r["nativePageCount"], 2)
        self.assertEqual(r["ocrPageCount"], 1)
        # Pages that passed keep their native text; OCR must not overwrite them.
        self.assertIn("Layla", r["pages"][0])
        self.assertNotIn("OCR-0", r["pages"][0])
        self.assertNotIn("OCR-2", r["pages"][2])
        self.assertIn("Recovered", r["pages"][1])

    def test_ocr_failure_is_recorded_not_raised(self):
        class Boom:
            calls = 0

            def convert(self, path):
                Boom.calls += 1
                raise RuntimeError("ocr engine exploded")

        self.native = FakeConverter([SCANNED_NATIVE_PAGE], "NATIVE_MD")
        ds._converters = {False: self.native, True: Boom()}
        r = ds.convert_with_gate("/tmp/fake.pdf")
        # The message is now included so a bare exception class can never
        # again hide the real cause (a missing onnxruntime cost a full cycle).
        self.assertTrue(r["ocrError"].startswith("RuntimeError"), r["ocrError"])
        self.assertIn("exploded", r["ocrError"])
        self.assertEqual(r["pageProvenance"], ["ocr-failed"])
        self.assertFalse(r["ocrApplied"])

    def test_force_ocr_true_overrides_the_gate(self):
        self.install([DIGITAL_PAGE], ["FORCED with several genuine words present here"])
        r = ds.convert_with_gate("/tmp/fake.pdf", force_ocr=True)
        self.assertEqual(self.ocr.calls, 1)
        self.assertEqual(r["pageProvenance"], ["ocr"])

    def test_force_ocr_false_suppresses_rescue(self):
        self.install([SCANNED_NATIVE_PAGE], [DIGITAL_PAGE])
        r = ds.convert_with_gate("/tmp/fake.pdf", force_ocr=False)
        self.assertEqual(self.ocr.calls, 0)
        self.assertFalse(r["ocrRescueInvoked"])
        self.assertEqual(r["pageProvenance"], ["native"])

    def test_timings_split_native_and_ocr(self):
        self.install([SCANNED_NATIVE_PAGE], [DIGITAL_PAGE])
        r = ds.convert_with_gate("/tmp/fake.pdf")
        t = r["timings"]
        self.assertIn("nativeConvertS", t)
        self.assertIn("ocrConvertS", t)
        self.assertGreaterEqual(t["totalConvertS"], 0.0)


class TestReadiness(unittest.TestCase):
    def test_missing_assets_reports_not_present(self):
        old = ds.OCR_ASSETS
        try:
            ds.OCR_ASSETS = "/nonexistent-ocr-assets-path"
            ok, count = ds.assets_present()
            self.assertFalse(ok)
            self.assertEqual(count, 0)
        finally:
            ds.OCR_ASSETS = old

    def test_manifest_may_list_a_populated_directory(self):
        # The model cache is a directory, not a file. Requiring isfile here is
        # what crash-looped the pod.
        import tempfile
        old = ds.OCR_ASSETS
        try:
            with tempfile.TemporaryDirectory() as d:
                os.makedirs(os.path.join(d, "models", "hf"))
                open(os.path.join(d, "models", "hf", "w.bin"), "w").close()
                with open(os.path.join(d, "MANIFEST"), "w", encoding="utf-8") as f:
                    f.write("asset_count=1\nasset=models\n")
                ds.OCR_ASSETS = d
                ok, n = ds.assets_present()
                self.assertTrue(ok, "populated model directory rejected")
                self.assertEqual(n, 1)
        finally:
            ds.OCR_ASSETS = old

    def test_manifest_listing_an_empty_directory_is_not_ready(self):
        import tempfile
        old = ds.OCR_ASSETS
        try:
            with tempfile.TemporaryDirectory() as d:
                os.makedirs(os.path.join(d, "models"))
                with open(os.path.join(d, "MANIFEST"), "w", encoding="utf-8") as f:
                    f.write("asset_count=1\nasset=models\n")
                ds.OCR_ASSETS = d
                ok, _ = ds.assets_present()
                self.assertFalse(ok, "empty model directory accepted")
        finally:
            ds.OCR_ASSETS = old

    def test_manifest_listing_a_missing_file_is_not_ready(self):
        import tempfile
        old = ds.OCR_ASSETS
        try:
            with tempfile.TemporaryDirectory() as d:
                with open(os.path.join(d, "MANIFEST"), "w", encoding="utf-8") as f:
                    f.write("asset_count=1\nasset=models/absent.onnx\n")
                ds.OCR_ASSETS = d
                ok, _ = ds.assets_present()
                self.assertFalse(ok, "readiness passed with a manifested file absent")
        finally:
            ds.OCR_ASSETS = old


if __name__ == "__main__":
    unittest.main(verbosity=2)
