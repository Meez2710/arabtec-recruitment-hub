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
    """Prove the runtime cannot reach the internet.

    Checked by attempting the exact host Run 1 was observed downloading from.
    A refusal here is the evidence for §6 measurement 9.
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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--expect-no-egress", action="store_true")
    args = ap.parse_args()

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
            "asserted": args.expect_no_egress},
        "ocrDecisionsCorrect": {
            "wrong": ocr_wrong, "n": len(ok),
            "pass": not ocr_wrong},
    }
    report["allGatesPassed"] = all(
        g.get("pass") for g in report["gates"].values() if g.get("pass") is not None)

    with open(os.path.join(args.out, "run2.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    print("\n===== GATES =====")
    for name, g in report["gates"].items():
        verdict = {True: "PASS", False: "FAIL", None: "n/a "}[g.get("pass")]
        print(f"  {verdict}  {name}")
    print(f"\nallGatesPassed={report['allGatesPassed']}")
    print("NOTE: runtime/infrastructure only. No parser field-accuracy claim.")
    return 0 if report["allGatesPassed"] else 1


if __name__ == "__main__":
    sys.exit(main())
