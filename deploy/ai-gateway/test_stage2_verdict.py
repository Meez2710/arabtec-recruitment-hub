"""Tests for the Run 2 verdict and the no-download proof.

These exist because of a specific failure mode: RunPod cannot block outbound
traffic, so the offline gate can never pass there. The tempting shortcuts are to
drop the gate, or to let "we could not test it" read as "it passed". Both would
put an unproven offline guarantee into a document that later gets quoted as
proof. The invariant asserted here is that a reachable network can NEVER produce
ACCEPTED, whatever flags were passed.

Run:  cd deploy/ai-gateway && python3 -m unittest test_stage2_verdict -v
"""

from __future__ import annotations

import importlib.util
import os
import tempfile
import time
import unittest

_spec = importlib.util.spec_from_file_location(
    "stage2_benchmark", os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                     "stage2_benchmark.py"))
bm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bm)


def gates(*, egress_pass, others_pass=True):
    """Minimal gate map: one substantive gate plus egress."""
    return {
        "digitalConvertP95S": {"pass": others_pass},
        "peakContainerRss": {"pass": others_pass},
        "noDownloadsDuringRun": {"pass": others_pass},
        "ocrDecisionsCorrect": {"pass": others_pass},
        "egressBlocked": {"pass": egress_pass},
    }


class TestVerdict(unittest.TestCase):
    def test_all_pass_with_proven_offline_is_accepted(self):
        v, w = bm.decide_verdict(gates(egress_pass=True), egress_not_controllable=False)
        self.assertEqual(v, "ACCEPTED")
        self.assertIsNone(w)

    def test_reachable_network_can_never_be_accepted(self):
        """The invariant. Egress observed REACHABLE, every other gate green,
        and the flag set — this must be a waiver, never ACCEPTED."""
        v, w = bm.decide_verdict(gates(egress_pass=False), egress_not_controllable=True)
        self.assertEqual(v, "ACCEPTED_SYNTHETIC_STAGING_WAIVER")
        self.assertIn("§6 #9", w["unproven"][0])

    def test_untested_egress_can_never_be_accepted(self):
        """pass=None means the assertion was never made. Also not acceptance."""
        v, _ = bm.decide_verdict(gates(egress_pass=None), egress_not_controllable=True)
        self.assertEqual(v, "ACCEPTED_SYNTHETIC_STAGING_WAIVER")

    def test_waiver_requires_every_other_gate_to_pass(self):
        """A waiver is not a way to pass a run that failed something else."""
        v, w = bm.decide_verdict(gates(egress_pass=False, others_pass=False),
                                 egress_not_controllable=True)
        self.assertEqual(v, "FAILED")
        self.assertIsNone(w)

    def test_without_the_flag_a_reachable_network_is_a_failure(self):
        """Not claiming the platform limitation means the run simply failed."""
        v, _ = bm.decide_verdict(gates(egress_pass=False), egress_not_controllable=False)
        self.assertEqual(v, "FAILED")

    def test_waiver_names_the_production_blocker(self):
        _, w = bm.decide_verdict(gates(egress_pass=False), egress_not_controllable=True)
        self.assertIn("production", w["productionBlocker"].lower())
        self.assertEqual(w["scope"], "synthetic staging only")


class TestNoDownloadProof(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        os.environ["OCR_ASSETS_DIR"] = self.dir
        # Isolate: the other trees must not resolve to real paths on the host.
        for var in ("HF_HOME", "OLLAMA_MODELS", "DOCLING_ARTIFACTS_PATH"):
            os.environ[var] = os.path.join(self.dir, "_absent_" + var)
        with open(os.path.join(self.dir, "weights.bin"), "wb") as f:
            f.write(b"pinned")

    def test_untouched_tree_passes(self):
        before = bm.snapshot_assets()
        self.assertTrue(bm.no_downloads_during_run(before, bm.snapshot_assets())["pass"])

    def test_a_downloaded_file_is_caught(self):
        before = bm.snapshot_assets()
        with open(os.path.join(self.dir, "fetched.onnx"), "wb") as f:
            f.write(b"new weights")
        r = bm.no_downloads_during_run(before, bm.snapshot_assets())
        self.assertFalse(r["pass"])
        self.assertIn("fetched.onnx", r["added"]["ocrAssets"])

    def test_a_replaced_file_is_caught(self):
        before = bm.snapshot_assets()
        time.sleep(0.01)
        with open(os.path.join(self.dir, "weights.bin"), "wb") as f:
            f.write(b"different content")
        r = bm.no_downloads_during_run(before, bm.snapshot_assets())
        self.assertFalse(r["pass"])
        self.assertIn("weights.bin", r["modified"]["ocrAssets"])

    def test_offline_env_is_reported(self):
        os.environ["HF_HUB_OFFLINE"] = "1"
        before = bm.snapshot_assets()
        r = bm.no_downloads_during_run(before, bm.snapshot_assets())
        self.assertEqual(r["offlineEnvSet"]["HF_HUB_OFFLINE"], "1")


if __name__ == "__main__":
    unittest.main()
