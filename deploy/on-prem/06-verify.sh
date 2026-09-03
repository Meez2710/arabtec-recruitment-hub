#!/usr/bin/env bash
# Arabtec ATS — post-deploy verification. Read-only. Non-zero exit = do not cut over.
set -uo pipefail
PORT=$(sudo grep -oP '^PORT=\K.*' /etc/arabtec-ats/ats.env 2>/dev/null || echo 4001)
URL="http://127.0.0.1:$PORT"; fail=0
ck(){ printf '%-44s' "$1"; shift; if "$@" >/dev/null 2>&1; then echo PASS; else echo FAIL; fail=1; fi; }

echo "=== services ==="
ck "arabtec-ats active"          systemctl is-active --quiet arabtec-ats
ck "cv-scan timer armed"         systemctl is-active --quiet arabtec-cv-scan.timer
ck "backup timer armed"          systemctl is-active --quiet arabtec-ats-backup.timer
ck "apache active"               systemctl is-active --quiet apache2

echo "=== deployed commit ==="
BUILT=$(cat /opt/arabtec-ats/DEPLOYED_SHA 2>/dev/null)
HEAD=$(sudo -u arabtec-ats git -C /opt/arabtec-ats rev-parse HEAD 2>/dev/null)
printf '%-44s' "running tree == the tree that was built"
[ -n "$BUILT" ] && [ "$BUILT" = "$HEAD" ] && echo "PASS ($HEAD)" || { echo "FAIL (built=$BUILT head=$HEAD)"; fail=1; }

echo "=== health ==="
ck "GET /api/health"             curl -fsS --max-time 10 "$URL/api/health"
ck "GET /api/health/db"          curl -fsS --max-time 10 "$URL/api/health/db"
echo -n "  watcher : "; curl -fsS --max-time 10 "$URL/api/health/watcher" 2>/dev/null || echo "(unreachable)"
echo; echo -n "  parsing : "; curl -fsS --max-time 25 "$URL/api/health/parsing" 2>/dev/null || echo "(unreachable)"
echo

echo "=== the SPA is really being served (not just a 200) ==="
# index.html is returned with HTTP 200 for ANY unknown path, so a status code
# proves nothing. Assert on content instead.
printf '%-44s' "design-system stylesheet is real"
curl -fsS --max-time 10 "$URL/arabtec-design-system.css" | grep -qi "design system" \
  && echo PASS || { echo "FAIL (got the SPA fallback, not the stylesheet)"; fail=1; }
printf '%-44s' "app.jsx is the real bundle"
curl -fsS --max-time 15 "$URL/app.jsx" | grep -q "function App" \
  && echo PASS || { echo "FAIL (fallback or wrong build)"; fail=1; }

echo; echo "=== storage is persistent and private ==="
ck "uploads dir"                 sudo test -d /var/lib/arabtec-ats/uploads
ck "cv inbox"                    sudo test -d /var/lib/arabtec-ats/cv_inbox
printf '%-44s' "uploads not world-readable"
[ "$(stat -c %a /var/lib/arabtec-ats/uploads)" -le 750 ] && echo PASS || { echo FAIL; fail=1; }

echo; echo "=== isolation ==="
printf '%-44s' "ATS role cannot CONNECT to other DBs"
sudo -u postgres psql -tAc "SELECT has_database_privilege('arabtec_ats','postgres','CONNECT')" | grep -q f \
  && echo PASS || echo "REVIEW"

echo; echo "=== backups ==="
printf '%-44s' "at least one backup archive exists"
sudo bash -c 'ls /var/backups/arabtec-ats/*.dump >/dev/null 2>&1' \
  && echo PASS || echo "PENDING (first run is 02:00 Africa/Cairo — or run backup.sh once by hand)"

echo; echo "=== next scheduled jobs ==="
systemctl list-timers arabtec-cv-scan.timer arabtec-ats-backup.timer --no-pager 2>/dev/null | sed -n '1,4p'

echo; [ $fail -eq 0 ] && echo "VERIFY OK" || { echo "VERIFY FAILED — do not cut over"; exit 1; }
