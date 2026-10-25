#!/usr/bin/env bash
# Isolated tests for 10-verify-approval.sh against a mock GitHub API
# (Packet 2, 25 Oct 2026). No network, no token, no server touched.
#   bash deploy/on-prem/test-verify-approval.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'kill $MOCK 2>/dev/null; rm -rf "$TMP"' EXIT
SHA="$(git -C "$ROOT" rev-parse HEAD)"
PROC="$(git -C "$ROOT" show "$SHA:deploy/on-prem/08-redeploy.sh" | sha256sum | cut -d' ' -f1)"
VER="$(git -C "$ROOT" show "$SHA:deploy/on-prem/10-verify-approval.sh" | sha256sum | cut -d' ' -f1)"
echo "dummy-token" > "$TMP/token"; chmod 600 "$TMP/token"
PORT=$((20000 + RANDOM % 20000))
# The mock reads its scenario from a file so each case can change it.
cat > "$TMP/mock.py" <<PY
import json, os, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from datetime import datetime, timezone, timedelta
SHA="$SHA"; PROC="$PROC"; VER="$VER"
def scenario(): return json.load(open("$TMP/scenario.json"))
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        s = scenario(); p = self.path
        if s.get("down"): self.send_response(500); self.end_headers(); return
        age_h = s.get("age_h", 1); created = (datetime.now(timezone.utc) - timedelta(hours=age_h)).strftime("%Y-%m-%dT%H:%M:%SZ")
        payload = {"sha": s.get("payload_sha", SHA), "environment": s.get("payload_env", "onprem-10.20.0.9"),
                   "procedure_sha256": s.get("proc", PROC), "verifier_sha256": VER, "run_id": 77, "requested_by": "Meez2710"}
        body = None
        if p.startswith("/repos/") and "/deployments?" in p:
            body = [] if s.get("no_deployment") else [{"id": s.get("dep_id", 501), "sha": SHA, "environment": "onprem-10.20.0.9", "created_at": created, "payload": payload}]
        elif p.endswith("/actions/runs/77"):
            body = {"id": 77, "head_sha": s.get("run_sha", SHA)}
        elif p.endswith("/actions/runs/77/approvals"):
            body = [{"state": s.get("state", "approved"), "user": {"login": s.get("reviewer", "Meez2710")}, "environments": [{"name": s.get("approved_env", "onprem-10.20.0.9")}]}]
        if body is None: self.send_response(404); self.end_headers(); return
        out = json.dumps(body).encode(); self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)
HTTPServer(("127.0.0.1", $PORT), H).serve_forever()
PY
echo '{}' > "$TMP/scenario.json"
python3 "$TMP/mock.py" & MOCK=$!
for _ in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.1; done
pass=0; fail=0
run() { # name, expected exit, scenario json, [extra env]
  local name="$1" want="$2" sc="$3"; shift 3
  echo "$sc" > "$TMP/scenario.json"
  env GITHUB_API="http://127.0.0.1:$PORT" APP_ROOT="$ROOT" RELEASE_TOKEN_FILE="$TMP/token" CONSUMED_FILE="$TMP/consumed" "$@" \
    bash "$HERE/10-verify-approval.sh" "$SHA" > "$TMP/out" 2>&1; local got=$?
  if [ "$got" = "$want" ]; then pass=$((pass+1)); echo "  ✅ $name"; else fail=$((fail+1)); echo "  ❌ $name (exit $got, wanted $want): $(tail -1 "$TMP/out")"; fi
}
run 'approved release passes' 0 '{}'
run 'no deployment for the SHA is refused' 1 '{"no_deployment":true}'
run 'approval by someone else is refused' 1 '{"reviewer":"emanelashkar1-gif"}'
run 'a rejected review is refused' 1 '{"state":"rejected"}'
run 'approval for another environment is refused' 1 '{"approved_env":"onprem-test"}'
run 'an approval older than 24 h is refused' 1 '{"age_h":25}'
run 'a run approved for a different commit is refused' 1 '{"run_sha":"0000000000000000000000000000000000000000"}'
run 'a changed deploy procedure is refused (hash mismatch)' 1 '{"proc":"deadbeef"}'
run 'a payload naming another environment is refused' 1 '{"payload_env":"staging"}'
run 'GitHub down leaves no approval (refused)' 1 '{"down":true}'
rm -f "$TMP/token"; run 'missing token is refused' 1 '{}'; echo dummy > "$TMP/token"
echo '{}' > "$TMP/scenario.json"
env GITHUB_API="http://127.0.0.1:$PORT" APP_ROOT="$ROOT" RELEASE_TOKEN_FILE="$TMP/token" CONSUMED_FILE="$TMP/consumed" bash "$HERE/10-verify-approval.sh" --consume "$SHA" >/dev/null 2>&1 && grep -q "^501 " "$TMP/consumed" && { pass=$((pass+1)); echo "  ✅ --consume records the deployment id"; } || { fail=$((fail+1)); echo "  ❌ --consume did not record"; }
run 'a consumed approval cannot be released twice' 1 '{}'
run 'a fresh deployment id after re-approval passes again' 0 '{"dep_id":502}'
env GITHUB_API="http://127.0.0.1:$PORT" APP_ROOT="$ROOT" RELEASE_TOKEN_FILE="$TMP/token" bash "$HERE/10-verify-approval.sh" "not-a-sha" >/dev/null 2>&1; [ $? = 1 ] && { pass=$((pass+1)); echo "  ✅ a branch name instead of a SHA is refused"; } || { fail=$((fail+1)); echo "  ❌ branch name accepted"; }
echo; echo "=== VERIFY-APPROVAL: $pass passed, $fail failed ==="; [ "$fail" = 0 ]
