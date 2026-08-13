# Local Mac Docling pilot — operations

**This is a pilot, not production hosting.** The sidecar runs on one laptop, on
loopback, behind a token. It has no restart supervision, no redundancy, and no
backup. Treat it as a way to prove the parsing path with real OCR, and plan the
move to a Linux host.

## Start / stop

```bash
# Start (binds 127.0.0.1:8089, keeps the Mac awake while it runs)
./scripts/start-local-docling.sh

# Stop
./scripts/stop-local-docling.sh

# Health — the token comes from the local env file, never from a literal
set -a; . deploy/docling-sidecar/.env.local; set +a
curl -sS -X POST -H "Authorization: Bearer $DOCLING_BEARER_TOKEN" \
  http://127.0.0.1:8089/v1/health
```

Expected:

```json
{"ok":true,"doclingVersion":"2.55.1","modelsPresent":true,
 "ocrEngine":"tesseract","ocrExecutablePresent":true,
 "ocrLanguages":["ara","eng","osd","snum"]}
```

`ocrExecutablePresent` and `ocrLanguages` are **measured** — the endpoint shells
out to the real tesseract. It previously reported a static `"tesseract"` on
hosts with no tesseract at all, which is exactly the lie a readiness endpoint
must not tell.

## Logs

`logs/` — gitignored. Status codes, durations and request ids only; **no CV
content is ever logged**. Docling's own INFO lines include tesseract invocations
and temp-file paths, never document text.

## The Mac must stay awake and online

`start-local-docling.sh` wraps uvicorn in `caffeinate -dimsu`, so sleep is
inhibited **only while the service runs** — no global power setting is changed.
Still true:

- the Mac must stay powered on, lid open, and connected;
- the service dies if the Mac sleeps, reboots, or loses network;
- closing the terminal does not stop it (`nohup`), but logging out does.

## Rotating the bearer token

```bash
openssl rand -hex 32 > /tmp/new && \
  printf 'DOCLING_BEARER_TOKEN=%s\n' "$(cat /tmp/new)" > deploy/docling-sidecar/.env.local && \
  chmod 600 deploy/docling-sidecar/.env.local && rm -f /tmp/new
./scripts/stop-local-docling.sh && ./scripts/start-local-docling.sh
```

Then set the same value in the ATS backend's `DOCLING_BEARER_TOKEN` and restart
**only** the backend. The token lives in the environment on both sides — never
in Git, never in the frontend, never in a report.

## Pointing the ATS at a different Docling

Backend environment only:

```bash
# Local pilot, same machine
DOCLING_BASE_URL=http://127.0.0.1:8089
DOCLING_BEARER_TOKEN=<from deploy/docling-sidecar/.env.local>

# Back to RunPod (no auth support there)
DOCLING_BASE_URL=https://<pod-id>-8089.proxy.runpod.net

# No Docling at all — the local pdfjs/mammoth parser takes over, and
# scanned CVs correctly abstain rather than silently returning nothing
# unset DOCLING_BASE_URL
```

`OCR_BASE_URL` stays **unset**: OCR happens inside Docling via tesseract, and
setting it would wire a second, redundant OCR path.

Restart only the backend process after changing these.

## Known limits

- **Mixed-content PDFs.** Routing is native-probe first, then one OCR retry if
  the text layer yields under `SIDECAR_MIN_NATIVE_CHARS` (default 30). A PDF
  with a good text layer *and* scanned images returns the native text and does
  not OCR the images. Acceptable for CVs; revisit if it bites.
- **`ocrApplied` is decided by the route taken**, not read back from Docling —
  2.55.1 discards per-cell OCR provenance (`page.cells` is empty,
  `parsed_page` is None). The native probe makes the flag correct by
  construction.
- **OCR resolution** is `SIDECAR_OCR_SCALE` (default 4.0 ≈ 288 dpi). Docling's
  default of 1.0 is 72 dpi, at which tesseract answers "Too few characters.
  Skipping this page" and every scan comes back empty. Do not lower it.
