"""Arabtec private AI gateway — the only authenticated door to the AI runtime.

WHAT IT IS FOR. Docling and Ollama both speak unauthenticated HTTP and are
built for loopback; the Ollama adapter in the ATS enforces that with a
local-host assertion, which is a real privacy guarantee about candidates' CVs.
Reaching them across the internet would mean weakening exactly that check. So
they stay on 127.0.0.1 and this process is the single door that faces the ATS.

WHAT IT DELIBERATELY IS NOT. Not a proxy. There is no endpoint that takes a
URL, a host, a model name or a prompt from the caller. The ATS can ask for one
thing — parse this CV — and the model, the prompt and the schema are decided
here, by the pinned deployment.

NO DOCUMENT CONTENT IS LOGGED, EVER. Log lines carry a request id, a status and
a duration. The one thing a CV parser must never do is write the CV to a log
that ships to an aggregator.
"""

from __future__ import annotations

import base64
import hmac
import json
import logging
import os
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests

GATEWAY_VERSION = "arabtec-ai-gateway/1.0.0"
PROMPT_VERSION = "resume-extract-prompt/1.0.0"
SCHEMA_VERSION = "resume-extract/1.0.0"
PARSER_VERSION = "docling-sidecar/1.0.0"

TOKEN = os.environ["AI_GATEWAY_TOKEN"]
PORT = int(os.environ.get("GATEWAY_PORT", "8080"))
DOCLING = f"http://127.0.0.1:{os.environ.get('DOCLING_PORT', '8089')}"
OLLAMA = f"http://{os.environ.get('OLLAMA_HOST', '127.0.0.1:11434')}"
MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:7b-instruct")

# Below this, native text is a scan with stray glyphs rather than a CV, and the
# OCR rescue is worth its cost. Above it, OCR would re-read glyphs that are
# already exact and LOSE fidelity.
MIN_CHARS_PER_PAGE = 120

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("gateway")

SYSTEM_PROMPT = "\n".join([
    "You extract structured data from a candidate CV. You are a reader, not an author.",
    "",
    "RULES",
    "1. Return ONLY a JSON object matching the provided schema. No prose, no markdown fence.",
    "2. Copy values from the CV. Never infer, complete, translate, or correct them.",
    "3. If the CV does not state a value, omit the field or use null. Never guess.",
    "4. Preserve the original script. Arabic names stay in Arabic.",
    "5. Copy phone numbers and emails exactly as written, including their digits.",
    '6. List every field you were unsure about by name in "uncertainFields".',
    "",
    "Inventing a plausible value is the worst possible outcome. Omission is correct.",
])


def authorised(header: str | None) -> bool:
    """Constant-time compare: a token check that leaks timing is not a check."""
    if not header or not header.startswith("Bearer "):
        return False
    return hmac.compare_digest(header[7:], TOKEN)


def model_digest() -> str | None:
    try:
        r = requests.post(f"{OLLAMA}/api/show", json={"model": MODEL}, timeout=10)
        if r.ok:
            return (r.json().get("details") or {}).get("digest") or r.json().get("digest")
    except requests.RequestException:
        pass
    # Provenance must never be why a parse fails. Missing is recorded as missing.
    return None


def convert(content: bytes, filename: str, mime: str, ocr: bool) -> dict:
    r = requests.post(
        f"{DOCLING}/v1/convert",
        json={
            "filename": filename,
            "mimeType": mime,
            "contentBase64": base64.b64encode(content).decode(),
            "forceOcr": ocr,
        },
        timeout=240,
    )
    r.raise_for_status()
    return r.json()


def extract(body: str) -> dict:
    r = requests.post(
        f"{OLLAMA}/api/generate",
        json={
            "model": MODEL,
            "system": SYSTEM_PROMPT,
            "prompt": body,
            "format": "json",
            "stream": False,
            "options": {"temperature": 0, "num_predict": 1536},
        },
        timeout=300,
    )
    r.raise_for_status()
    return r.json()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # noqa: A003 - stdlib hook
        """Silence the default access log: it prints the request line, and a
        request line is one refactor away from carrying a filename."""

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
        if not authorised(self.headers.get("Authorization")):
            return self._send(401, {"error": "unauthorised"})
        docling_ok = ollama_ok = False
        try:
            docling_ok = requests.get(f"{DOCLING}/health", timeout=5).ok
        except requests.RequestException:
            pass
        try:
            ollama_ok = requests.get(f"{OLLAMA}/api/tags", timeout=5).ok
        except requests.RequestException:
            pass
        self._send(200 if (docling_ok and ollama_ok) else 503, {
            "ok": docling_ok and ollama_ok,
            "ready": docling_ok and ollama_ok,
            "gatewayVersion": GATEWAY_VERSION,
            "components": {"docling": docling_ok, "ollama": ollama_ok},
            "provenance": {
                "modelId": MODEL,
                "modelDigest": model_digest(),
                "promptVersion": PROMPT_VERSION,
                "schemaVersion": SCHEMA_VERSION,
                "parserVersion": PARSER_VERSION,
            },
        })

    def do_POST(self) -> None:  # noqa: N802 - stdlib hook
        rid = uuid.uuid4().hex[:12]
        started = time.time()
        if self.path != "/v1/resume/parse":
            return self._send(404, {"error": "not found"})
        if not authorised(self.headers.get("Authorization")):
            log.warning("rid=%s unauthorised", rid)
            return self._send(401, {"error": "unauthorised"})

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 40 * 1024 * 1024:
            return self._send(413, {"error": "payload too large"})

        try:
            req = json.loads(self.rfile.read(length))
            content = base64.b64decode(req["contentBase64"], validate=True)
        except (ValueError, KeyError):
            return self._send(400, {"error": "malformed request"})

        filename = str(req.get("filename") or "cv")
        mime = str(req.get("mimeType") or "application/octet-stream")
        max_pages = int(req.get("maxPages") or 30)

        provenance = {
            "modelId": MODEL,
            "modelDigest": model_digest(),
            "promptVersion": PROMPT_VERSION,
            "schemaVersion": SCHEMA_VERSION,
            "parserVersion": PARSER_VERSION,
        }

        try:
            doc = convert(content, filename, mime, ocr=False)
        except requests.RequestException:
            log.error("rid=%s docling unavailable", rid)
            return self._send(502, {"error": "document service unavailable"})

        if doc.get("status") != "ok":
            log.info("rid=%s rejected status=%s", rid, doc.get("status"))
            return self._send(200, {
                "gatewayVersion": GATEWAY_VERSION, "provenance": provenance,
                "document": {"status": doc.get("status")},
            })

        pages = int(doc.get("pageCount") or 0)
        if pages > max_pages:
            return self._send(200, {
                "gatewayVersion": GATEWAY_VERSION, "provenance": provenance,
                "document": {"status": "too_many_pages", "pageCount": pages},
            })

        text = doc.get("markdown") or doc.get("text") or ""
        ocr_applied = False
        # OCR RESCUE — only when native text is too thin to be a CV.
        if pages and len(text) / pages < MIN_CHARS_PER_PAGE:
            log.info("rid=%s native text thin (%d chars / %d pages) — ocr rescue",
                     rid, len(text), pages)
            try:
                doc = convert(content, filename, mime, ocr=True)
                text = doc.get("markdown") or doc.get("text") or ""
                ocr_applied = True
            except requests.RequestException:
                log.error("rid=%s ocr rescue failed", rid)

        document = {
            "status": "ok",
            "pageCount": int(doc.get("pageCount") or pages),
            "charCount": len(text),
            "ocrApplied": ocr_applied or bool(doc.get("ocrApplied")),
            "detectedLanguage": (doc.get("detectedLanguages") or [None])[0],
        }

        if not text.strip():
            return self._send(200, {
                "gatewayVersion": GATEWAY_VERSION, "provenance": provenance,
                "document": {**document, "charCount": 0},
            })

        try:
            gen = extract(text)
        except requests.RequestException:
            log.error("rid=%s model unavailable", rid)
            return self._send(502, {"error": "model service unavailable"})

        raw = gen.get("response") or ""
        try:
            start, end = raw.index("{"), raw.rindex("}")
            content_json = json.loads(raw[start:end + 1])
        except (ValueError, json.JSONDecodeError):
            # Abstain rather than repair. The ATS validates again regardless.
            log.info("rid=%s model returned unparseable json", rid)
            return self._send(200, {
                "gatewayVersion": GATEWAY_VERSION, "provenance": provenance,
                "document": document,
                "extraction": {"abstained": True, "permanent": False,
                               "reason": "model did not return parseable JSON"},
            })

        log.info("rid=%s ok pages=%s chars=%s ocr=%s ms=%d",
                 rid, document["pageCount"], document["charCount"],
                 document["ocrApplied"], int((time.time() - started) * 1000))

        self._send(200, {
            "gatewayVersion": GATEWAY_VERSION,
            "provenance": provenance,
            "document": document,
            "extraction": {"content": content_json, "confidence": 0.7, "evidence": {}},
        })


if __name__ == "__main__":
    log.info("%s listening on 0.0.0.0:%d (model=%s)", GATEWAY_VERSION, PORT, MODEL)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
