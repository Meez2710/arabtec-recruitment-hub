#!/usr/bin/env python3
"""Stage 2 Run 2 — the benchmark that actually closes the gates.

Run 1 answered "is the GPU fast enough" (yes) and left four gates open. This
run closes them, or reports precisely which one did not close and why.

WHAT THIS IS NOT. It is not a parser accuracy benchmark. Every document is
synthetic, so field matches here measure plumbing, not extraction quality
against real CVs. ACCEPTANCE_CRITERIA §7 remains unevaluated and needs human
labels. Nothing this script prints may be quoted as parser acceptance.

Usage (inside the pod, after provisioning):
    python3 stage2_benchmark.py \
        --corpus /workspace/bench/corpus \
        --out    /workspace/bench/run2 \
        [--expect-no-egress]
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from resource_probe import ResourceSampler, snapshot  # noqa: E402

DOCLING = os.environ.get("DOCLING_URL", "http://127.0.0.1:8089")
OLLAMA = f"http://{os.environ.get('OLLAMA_HOST', '127.0.0.1:11434')}"
MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:7b")

SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "email": {"type": "string"},
        "phone": {"type": "string"},
        "current_title": {"type": "string"},
    },
    "required": ["name", "email", "phone", "current_title"],
    "additionalProperties": False,
}
PROMPT = ("Extract the candidate details from the document text below. "
          "Return ONLY JSON with keys name, email, phone, current_title.\n\n---\n{}\n---")

# §6 measurement 5 budget. A document exceeding this is an unexpected timeout.
E2E_TIMEOUT_S = float(os.environ.get("BENCH_E2E_TIMEOUT_S", "180"))


def p95(xs: list[float]) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    # Nearest-rank. With n=20 this is the 19th value: honest about the sample
    # size rather than interpolating a precision we do not have.
    k = max(0, min(len(s) - 1, int(round(0.95 * len(s) + 0.5)) - 1))
    return round(s[k], 3)


def post(url: str, payload: dict, timeout: float) -> dict:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def valid(o) -> bool:
    return (isinstance(o, dict)
            and set(o.keys()) == set(SCHEMA["required"])
            and all(isinstance(o[k], str) for k in SCHEMA["required"]))


def readiness() -> dict:
    """Gate 0. If assets are not prewarmed the whole run is invalid, because a
    runtime download would contaminate every latency number after it."""
    try:
        with urllib.request.urlopen(f"{DOCLING}/health", timeout=20) as r:
            h = json.load(r)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    h["ok"] = bool(h.get("ocrAssetsPresent")) and bool(h.get("modelsPresent"))
    return h


def egress_blocked() -> dict:
    """Record whether the runtime can reach the internet.

    Checked by attempting the exact host Run 1 was observed downloading from.
    A refusal here is the evidence for §6 measurement 9.

    REACHABLE IS RECORDED, NOT HIDDEN. RunPod Pods expose no outbound firewall
    control, so on that platform this probe is expected to report REACHABLE and
    §6 #9 cannot be satisfied there. That is a fact about the platform, not a
    result to soften: `allBlocked` stays false and the offline guarantee stays
    unproven. See `no_downloads_during_run` for the weaker property that CAN be
    demonstrated with the network up.
    """
    probes = [("modelscope.cn", 443), ("huggingface.co", 443), ("pypi.org", 443)]
    results = {}
    for host, port in probes:
        try:
            s = socket.create_connection((host, port), timeout=6)
            s.close()
            results[host] = "REACHABLE"
        except Exception as exc:  # noqa: BLE001
            results[host] = f"blocked ({type(exc).__name__})"
    return {"probes": results,
            "allBlocked": all(v != "REACHABLE" for v in results.values())}


# Trees that a runtime download would have to land in. Everything the pipeline
# reads at inference time is supposed to be baked or prewarmed into one of them.
def _asset_trees() -> dict:
    return {
        "ocrAssets": os.environ.get("OCR_ASSETS_DIR", "/opt/ocr-assets"),
        "hfCache": os.environ.get("HF_HOME", "/workspace/models/hf"),
        "ollamaModels": os.environ.get("OLLAMA_MODELS", "/workspace/models/ollama"),
        "doclingArtifacts": os.environ.get("DOCLING_ARTIFACTS_PATH", "") or "",
    }


def _inventory(root: str) -> dict:
    """path -> (size, mtime_ns) for every file under root. Cheap; no hashing.

    Size AND mtime together are what catch a download: a replaced file changes
    at least one, and a newly fetched file appears as a new key.
    """
    out: dict = {}
    if not root or not os.path.isdir(root):
        return out
    for dirpath, _dirnames, filenames in os.walk(root):
        for fn in filenames:
            p = os.path.join(dirpath, fn)
            try:
                st = os.stat(p)
            except OSError:
                continue
            out[os.path.relpath(p, root)] = (st.st_size, st.st_mtime_ns)
    return out


def snapshot_assets() -> dict:
    return {name: _inventory(root) for name, root in _asset_trees().items()}


def no_downloads_during_run(before: dict, after: dict) -> dict:
    """Did the run fetch anything into an asset tree?

    THE PROPERTY THIS PROVES, AND THE ONE IT DOES NOT. It proves the pipeline
    read only what was already on disk when the run started — no weights
    appeared, none were replaced. It does NOT prove the runtime cannot reach the
    internet; a process that downloads to a tmpfs and deletes it would pass
    this and fail the real offline requirement.

    So this is the evidence available when egress cannot be blocked. It is
    strictly weaker than §6 #9 and never substitutes for it.
    """
    added: dict = {}
    modified: dict = {}
    for name in before:
        b, a = before[name], after.get(name, {})
        new = sorted(k for k in a if k not in b)
        chg = sorted(k for k in a if k in b and a[k] != b[k])
        if new:
            added[name] = new[:50]
        if chg:
            modified[name] = chg[:50]
    clean = not added and not modified
    return {
        "added": added,
        "modified": modified,
        "offlineEnvSet": {
            "HF_HUB_OFFLINE": os.environ.get("HF_HUB_OFFLINE"),
            "TRANSFORMERS_OFFLINE": os.environ.get("TRANSFORMERS_OFFLINE"),
        },
        "pass": clean,
    }


def convert(path: str) -> dict:
    import base64
    with open(path, "rb") as f:
        b = base64.b64encode(f.read()).decode()
    return post(f"{DOCLING}/v1/convert",
                {"contentBase64": b, "filename": os.path.basename(path)},
                timeout=E2E_TIMEOUT_S)


def extract(text: str) -> tuple[dict | None, dict]:
    t0 = time.time()
    d = post(f"{OLLAMA}/api/generate",
             {"model": MODEL, "prompt": PROMPT.format(text[:6000]), "stream": False,
              "format": SCHEMA, "options": {"temperature": 0, "num_predict": 256}},
             timeout=E2E_TIMEOUT_S)
    try:
        obj = json.loads(d.get("response", ""))
    except Exception:  # noqa: BLE001
        obj = None
    ec, ed = d.get("eval_count") or 0, d.get("eval_duration") or 0
    return obj, {"extractS": round(time.time() - t0, 3),
                 "tokS": round(ec / (ed / 1e9), 2) if ed else None}


def decide_verdict(gates: dict, egress_not_controllable: bool) -> tuple:
    """Three outcomes, not two.

    "Every gate that could run passed, but one could not be tested" is neither
    acceptance nor failure. Collapsing it into acceptance is how an unproven
    offline guarantee gets quoted later as a proven one; collapsing it into
    failure discards a run that told us everything else we asked.

    THE INVARIANT: a reachable network can never produce ACCEPTED. `ACCEPTED`
    requires egressBlocked to have actually passed, which requires the assertion
    to have been made and the probes to have refused.

    @returns (verdict, waiver_or_None)
    """
    offline_proven = gates.get("egressBlocked", {}).get("pass") is True
    others_passed = all(
        g.get("pass") for name, g in gates.items()
        if name != "egressBlocked" and g.get("pass") is not None)

    if offline_proven and others_passed:
        return "ACCEPTED", None

    if others_passed and egress_not_controllable:
        return "ACCEPTED_SYNTHETIC_STAGING_WAIVER", {
            "scope": "synthetic staging only",
            "unproven": ["ACCEPTANCE_CRITERIA §6 #9 — egress blocked"],
            "compensating": ("noDownloadsDuringRun passed: no asset tree gained or "
                             "lost a file during the run, so the pipeline ran on "
                             "prewarmed, checksum-verified assets."),
            "productionBlocker": ("No-egress must be PROVEN on a platform that can "
                                  "block outbound before any real candidate data is "
                                  "processed. This waiver does not carry to production."),
        }

    return "FAILED", None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--expect-no-egress", action="store_true")
    # RunPod Pods expose no outbound firewall control, so §6 #9 cannot be
    # satisfied there. This flag says "I know egress is up; run every other gate
    # and record the offline requirement as UNPROVEN" — it does not weaken any
    # gate and it never turns a reachable network into a pass.
    ap.add_argument("--egress-not-controllable", action="store_true",
                    help="platform cannot block egress; record §6 #9 as unproven")
    args = ap.parse_args()
    if args.expect_no_egress and args.egress_not_controllable:
        print("--expect-no-egress and --egress-not-controllable are contradictory",
              file=sys.stderr)
        return 2

    os.makedirs(args.out, exist_ok=True)
    manifest = json.load(open(os.path.join(args.corpus, "manifest.json"), encoding="utf-8"))
    docs = manifest["documents"]

    report: dict = {
        "runtime": snapshot(),
        "readiness": readiness(),
        "egress": egress_blocked(),
        "corpus": {"count": len(docs), "seed": manifest.get("seed"),
                   "cohortCounts": manifest.get("cohortCounts")},
        "documents": [],
        "syntheticOnly": True,
        "parserAccuracyClaimed": False,
    }

    if not report["readiness"].get("ok"):
        report["fatal"] = ("OCR assets not prewarmed — refusing to benchmark. "
                           "Latencies measured against a runtime download are not "
                           "the latencies of the system under test.")
        json.dump(report, open(os.path.join(args.out, "run2.json"), "w", encoding="utf-8"),
                  indent=2, ensure_ascii=False)
        print(report["fatal"], file=sys.stderr)
        return 2

    if len(docs) < 20:
        report["fatal"] = f"corpus has {len(docs)} documents; 20 required"
        print(report["fatal"], file=sys.stderr)
        return 2

    # Taken AFTER readiness and BEFORE the first document, so anything that
    # appears in an asset tree is attributable to the run itself.
    assets_before = snapshot_assets()

    timeouts, ocr_wrong = 0, []

    for i, d in enumerate(docs, 1):
        path = os.path.join(args.corpus, d["file"])
        rec = {"docId": d["docId"], "kind": d["kind"], "cohorts": d["cohorts"],
               "order": i, "expectOcrRescue": d["expectOcrRescue"]}
        try:
            with ResourceSampler() as rs:
                conv = convert(path)
                text = conv.get("markdown") or conv.get("text") or ""
                obj, ex = extract(text)
            res = rs.result()
            timings = conv.get("timings") or {}
            rec.update({
                "status": conv.get("status"),
                "convertS": timings.get("totalConvertS"),
                "nativeConvertS": timings.get("nativeConvertS"),
                "ocrConvertS": timings.get("ocrConvertS"),
                "extractS": ex["extractS"],
                "tokS": ex["tokS"],
                "totalS": round((timings.get("totalConvertS") or 0) + ex["extractS"], 3),
                "jsonValid": valid(obj),
                "ocrRescueInvoked": bool(conv.get("ocrRescueInvoked")),
                "pageProvenance": conv.get("pageProvenance"),
                "resources": res,
            })
            if obj:
                rec["fieldMatch"] = {
                    k: (str(obj.get(k, "")).strip() == str(v).strip())
                    for k, v in d["expect"].items()
                }
            # THE OCR ROUTING ASSERTION — the thing Run 1 could not make.
            if rec["ocrRescueInvoked"] != d["expectOcrRescue"]:
                rec["ocrDecisionCorrect"] = False
                ocr_wrong.append(d["docId"])
            else:
                rec["ocrDecisionCorrect"] = True
            if (rec["totalS"] or 0) > E2E_TIMEOUT_S:
                timeouts += 1
                rec["timedOut"] = True
        except Exception as exc:  # noqa: BLE001
            timeouts += 1
            rec.update({"error": f"{type(exc).__name__}: {str(exc)[:200]}", "timedOut": True})
        report["documents"].append(rec)
        print(f"[{i}/{len(docs)}] {d['docId']:18} "
              f"conv={rec.get('convertS')}s total={rec.get('totalS')}s "
              f"ocr={rec.get('ocrRescueInvoked')} ok={rec.get('ocrDecisionCorrect')}")

    ok = [r for r in report["documents"] if not r.get("error")]
    digital = [r for r in ok if r["kind"].startswith("digital")]
    scanned = [r for r in ok if r["kind"] == "scanned"]

    def col(rs, key):
        return [r[key] for r in rs if isinstance(r.get(key), (int, float))]

    first10 = col(ok[:10], "totalS")
    last10 = col(ok[10:20], "totalS")
    peak_rss = max((r["resources"]["peakProcessTreeRssBytes"] or 0
                    for r in ok if r.get("resources")), default=0)
    limit = report["runtime"].get("memoryLimitBytes")

    report["gates"] = {
        "assetsPrewarmed": {
            "pass": bool(report["readiness"].get("ok")),
            "assetCount": report["readiness"].get("ocrAssetCount")},
        "digitalConvertP95S": {
            "value": p95(col(digital, "convertS")), "budget": 10.0, "n": len(digital),
            "pass": (p95(col(digital, "convertS")) or 1e9) <= 10.0},
        "scannedOcrConvertP95S": {
            "value": p95(col(scanned, "convertS")), "budget": 60.0, "n": len(scanned),
            "pass": (p95(col(scanned, "convertS")) or 1e9) <= 60.0},
        "endToEndP95S": {
            "value": p95(col(ok, "totalS")), "budget": E2E_TIMEOUT_S, "n": len(ok),
            "pass": (p95(col(ok, "totalS")) or 1e9) <= E2E_TIMEOUT_S},
        "peakContainerRss": {
            "peakBytes": peak_rss or None,
            "limitBytes": limit,
            "pctOfLimit": round(100.0 * peak_rss / limit, 2) if (peak_rss and limit) else None,
            "budgetPct": 70.0,
            "pass": bool(peak_rss and limit and (100.0 * peak_rss / limit) <= 70.0)},
        "stability20Doc": {
            "first10P95S": p95(first10), "last10P95S": p95(last10), "ratioBudget": 1.25,
            "ratio": (round(p95(last10) / p95(first10), 3)
                      if p95(first10) and p95(last10) else None),
            "pass": bool(p95(first10) and p95(last10)
                         and p95(last10) <= 1.25 * p95(first10))},
        "zeroUnexpectedTimeouts": {"timeouts": timeouts, "pass": timeouts == 0},
        "egressBlocked": {
            "probes": report["egress"]["probes"],
            "pass": (report["egress"]["allBlocked"] if args.expect_no_egress else None),
            "asserted": args.expect_no_egress,
            "platformCannotBlock": args.egress_not_controllable,
            "note": ("RunPod Pods expose no outbound firewall control; §6 #9 is "
                     "UNPROVEN on this platform and remains a production blocker."
                     if args.egress_not_controllable else None)},
        # Weaker than egressBlocked and never a substitute for it. Reported as a
        # gate because when egress cannot be blocked it is the only evidence
        # available that the pipeline ran on prewarmed assets alone.
        "noDownloadsDuringRun": no_downloads_during_run(assets_before, snapshot_assets()),
        "ocrDecisionsCorrect": {
            "wrong": ocr_wrong, "n": len(ok),
            "pass": not ocr_wrong},
    }
    report["allGatesPassed"] = all(
        g.get("pass") for g in report["gates"].values() if g.get("pass") is not None)

    verdict, waiver = decide_verdict(report["gates"], args.egress_not_controllable)
    report["verdict"] = verdict
    if waiver:
        report["waiver"] = waiver

    with open(os.path.join(args.out, "run2.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    print("\n===== GATES =====")
    for name, g in report["gates"].items():
        verdict = {True: "PASS", False: "FAIL", None: "n/a "}[g.get("pass")]
        print(f"  {verdict}  {name}")
    print(f"\nallGatesPassed={report['allGatesPassed']}")
    print(f"verdict={report['verdict']}")
    if report.get("waiver"):
        print("  WAIVER: synthetic staging only — offline guarantee UNPROVEN.")
        print("  " + report["waiver"]["productionBlocker"])
    print("NOTE: runtime/infrastructure only. No parser field-accuracy claim.")
    # A waiver exits 0 so the boot mode records a usable result, but the verdict
    # in run2.json is what must be quoted — never the exit code alone.
    return 0 if report["verdict"].startswith("ACCEPTED") else 1


if __name__ == "__main__":
    sys.exit(main())
