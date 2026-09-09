#!/usr/bin/env bash
# Arabtec ATS — redeploy the already-installed on-prem service to a newer commit.
#
# 01–05 are first-install steps and are NOT re-run here: the service account,
# database, secrets and systemd units already exist. This is the routine path
# for "main moved, put it on the server":
#
#     fetch + build (04-app.sh)  →  restart  →  verify (06-verify.sh)
#
# The database is backed up first. Nothing here drops or migrates data; the app
# creates and upgrades its own schema at startup, additively.
#
#   sudo bash 08-redeploy.sh              # deploy origin/main
#   sudo ATS_REF=v1.2.3 bash 08-redeploy.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT=/opt/arabtec-ats
REF="${ATS_REF:-main}"

PREVIOUS_SHA="$(cat "$APP_ROOT/DEPLOYED_SHA" 2>/dev/null || echo unknown)"
echo "==> currently deployed: $PREVIOUS_SHA"

# A backup before every deploy, not just the nightly one. The restart is the
# only moment the schema can change, so this is the snapshot worth having.
if [ -x "$HERE/backup.sh" ]; then
  echo "==> pre-deploy backup"
  bash "$HERE/backup.sh"
fi

echo "==> fetch + build $REF"
ATS_REF="$REF" bash "$HERE/04-app.sh"

echo "==> restart"
systemctl restart arabtec-ats

# The service binds its port immediately and initialises behind a readiness
# gate, so "active" is not "serving". Wait for readiness, not for systemd.
PORT="$(grep -oP '^PORT=\K.*' /etc/arabtec-ats/ats.env 2>/dev/null || echo 4001)"
echo "==> waiting for readiness on :$PORT"
ready=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health/ready" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 2
done
if [ "$ready" != 1 ]; then
  echo "REFUSING to report success: the service never became ready." >&2
  echo "  journalctl -u arabtec-ats -n 80 --no-pager" >&2
  echo "  roll back with: sudo ATS_REF=$PREVIOUS_SHA bash $HERE/08-redeploy.sh" >&2
  exit 1
fi

echo "==> verify"
bash "$HERE/06-verify.sh"

echo
echo "Deployed $(cat "$APP_ROOT/DEPLOYED_SHA" 2>/dev/null) (was $PREVIOUS_SHA)."
echo "Roll back with: sudo ATS_REF=$PREVIOUS_SHA bash $HERE/08-redeploy.sh"
