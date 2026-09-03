#!/usr/bin/env bash
# Daily HR CV folder scan, invoked by arabtec-cv-scan.timer at 08:00 Africa/Cairo.
#
# WHY A TIMER AND NOT THE APP'S OWN WATCHER. backend/src/lib/cv-watcher.js polls
# on setInterval(CV_WATCH_INTERVAL_MIN). An interval cannot express "08:00 local"
# — it drifts across restarts and ignores DST. A systemd timer states the
# schedule declaratively, survives reboots (Persistent=true catches a missed run)
# and is inspectable with `systemctl list-timers`. The watcher is disabled with
# CV_WATCH_INTERVAL_MIN=0 so the folder is never scanned twice.
#
# Requires /etc/arabtec-ats/scan.env (chmod 600, owner arabtec-ats) — see
# scan.env.template.
set -euo pipefail

: "${ATS_URL:?}" "${SCAN_EMAIL:?}" "${SCAN_PASSWORD:?}"
ts(){ date -u +%Y-%m-%dT%H:%M:%SZ; }   # portable ISO-8601 (BSD date has no -Is)

TOKEN=$(curl -fsS --max-time 20 -X POST "$ATS_URL/api/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$SCAN_EMAIL\",\"password\":\"$SCAN_PASSWORD\"}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).token;if(!t){process.exit(1)}process.stdout.write(t)})')

if [ -z "${TOKEN:-}" ]; then echo "$(ts) scan: LOGIN FAILED — no scan performed"; exit 1; fi

# -w captures the status separately so a refusal is reported in the server's own
# words rather than as a bare curl exit code. A non-2xx is a failure: the script
# exits non-zero and systemd records the unit as failed. It never logs a scan it
# did not perform.
BODY_FILE=$(mktemp); trap 'rm -f "$BODY_FILE"' EXIT
CODE=$(curl -sS --max-time 900 -o "$BODY_FILE" -w '%{http_code}' \
  -X POST "$ATS_URL/api/candidates/inbox-scan" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}')
RESP=$(cat "$BODY_FILE")

if [ "$CODE" -lt 200 ] || [ "$CODE" -ge 300 ]; then
  echo "$(ts) scan: FAILED http=$CODE $RESP"
  exit 1
fi
echo "$(ts) scan: ok http=$CODE $RESP"
