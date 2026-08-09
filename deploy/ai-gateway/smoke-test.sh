#!/usr/bin/env bash
# Stage 2 smoke test — run against a deployed pod before switching AI_ENABLED on.
#
# Proves four things, in order of how badly each would hurt if wrong:
#   1. the model runtime is NOT reachable from outside the pod
#   2. the gateway refuses an unauthenticated caller
#   3. it reports ready, with model/prompt/schema versions
#   4. it can actually parse a document end to end
#
# Reads no secret from the repo: both values come from the environment.
set -euo pipefail

: "${AI_GATEWAY_URL:?export AI_GATEWAY_URL first}"
: "${AI_GATEWAY_TOKEN:?export AI_GATEWAY_TOKEN first}"

BASE="${AI_GATEWAY_URL%/}"
pass=0; fail=0
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31m✗\033[0m %s %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

echo "── 1. the model runtime must not be exposed ──"
# Any answer at all on 11434 means Ollama is published. That is a stop-ship.
if curl -fsS --max-time 8 "${BASE%:*}:11434/api/tags" >/dev/null 2>&1; then
  bad "port 11434 answered — Ollama is PUBLICLY EXPOSED. Do not proceed."
else
  ok "port 11434 is not reachable"
fi

echo "── 2. authentication ──"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/health" || echo 000)
[ "$code" = "401" ] && ok "unauthenticated /health is refused (401)" \
                    || bad "unauthenticated /health returned" "$code (expected 401)"

echo "── 3. readiness and version reporting ──"
health=$(curl -fsS --max-time 20 -H "Authorization: Bearer $AI_GATEWAY_TOKEN" "$BASE/health" || echo '{}')
echo "$health" | grep -q '"ready":true'   && ok "gateway reports ready"          || bad "gateway not ready:" "$health"
echo "$health" | grep -q '"modelId"'      && ok "model id reported"              || bad "no modelId in /health"
echo "$health" | grep -q '"promptVersion"'&& ok "prompt version reported"        || bad "no promptVersion in /health"
echo "$health" | grep -q '"schemaVersion"'&& ok "schema version reported"        || bad "no schemaVersion in /health"
echo "$health" | grep -q '"gatewayVersion"' && ok "gateway version reported"     || bad "no gatewayVersion in /health"
echo "$health" | grep -q '"modelDigest":null' && printf '  \033[33m!\033[0m model digest is null — provenance will be incomplete\n' || true

echo "── 4. one real parse ──"
# A tiny synthetic CV. Contains no real person's data by construction.
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
python3 - "$tmp/cv.pdf" <<'PY'
import sys, zlib
text = b"BT /F1 11 Tf 40 750 Td (Test Candidate) Tj 0 -18 Td (test.candidate@example.com) Tj 0 -18 Td (+971 50 000 0000) Tj 0 -18 Td (Site Engineer, Example Contracting, 2019 to present) Tj ET"
stream = zlib.compress(text)
objs = [
 b"<</Type/Catalog/Pages 2 0 R>>",
 b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
 b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>",
 b"<</Length %d/Filter/FlateDecode>>stream\n" % len(stream) + stream + b"\nendstream",
 b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
]
out = bytearray(b"%PDF-1.4\n"); offs = []
for i, o in enumerate(objs, 1):
    offs.append(len(out)); out += b"%d 0 obj" % i + o + b"endobj\n"
xref = len(out)
out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
for o in offs: out += b"%010d 00000 n \n" % o
out += b"trailer<</Size %d/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
open(sys.argv[1], "wb").write(bytes(out))
PY

payload=$(python3 -c "import base64,json,sys;print(json.dumps({'filename':'cv.pdf','mimeType':'application/pdf','maxPages':30,'contentBase64':base64.b64encode(open(sys.argv[1],'rb').read()).decode()}))" "$tmp/cv.pdf")
resp=$(curl -fsS --max-time 300 -X POST "$BASE/v1/resume/parse" \
  -H "Authorization: Bearer $AI_GATEWAY_TOKEN" -H 'Content-Type: application/json' \
  -d "$payload" || echo '{}')

echo "$resp" | grep -q '"status": *"ok"' && ok "document converted" || bad "conversion failed:" "$(echo "$resp" | head -c 200)"
echo "$resp" | grep -q '"extraction"'    && ok "extraction returned" || bad "no extraction in response"
echo "$resp" | grep -q '"modelDigest"'   && ok "provenance travels with the result" || bad "no provenance in response"

echo
printf 'smoke test: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
