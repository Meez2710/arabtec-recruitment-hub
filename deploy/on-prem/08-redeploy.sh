#!/usr/bin/env bash
# Arabtec ATS — redeploy the running on-prem service to a newer commit.
#
# 01–05 are first-install steps and are NOT re-run: the account, database,
# secrets and systemd unit already exist. This is the routine path for "main
# moved, put it on the server":
#
#     backup → fetch + build → restart → verify readiness
#
# WRITTEN AGAINST THE HOST AS IT ACTUALLY IS (10.20.0.9, verified 9 Sep 2026),
# which differs from the layout 01–05 would have produced:
#
#   • the unit runs as `ats`, not a separate `arabtec-ats` service account, and
#     /opt/arabtec-ats is owned by `ats`. So the code update needs no sudo.
#   • `ats` has no passwordless sudo, so this script must not need any. The unit
#     has Restart=always and runs as us, so ending the process IS the restart.
#   • /etc/arabtec-ats/ats.env is root-only. DATABASE_URL is read from our own
#     running process instead — same value, no privilege needed, never echoed.
#
# Nothing here drops or migrates data; the app upgrades its own schema at
# startup, additively.
#
#   ATS_REF=<full sha> bash 08-redeploy.sh
#
# A release is an exact SHA that Moutaz Adly approved in GitHub (Packet 2,
# 25 Oct 2026; see RELEASE-GATE.md). Branch names and defaults are refused;
# 10-verify-approval.sh checks the approval record before anything changes,
# and a refusal leaves the running service exactly as it is.
set -euo pipefail

APP_ROOT=/opt/arabtec-ats
REF="${ATS_REF:-}"
[[ "$REF" =~ ^[0-9a-f]{40}$ ]] || { echo "REFUSING: ATS_REF must be the full 40-character SHA of a release approved in GitHub (environment onprem-10.20.0.9)." >&2; exit 1; }
UNIT=arabtec-ats
export PATH=/opt/node22/bin:$PATH

PREVIOUS_SHA="$(git -C "$APP_ROOT" rev-parse HEAD)"
echo "==> currently deployed: $PREVIOUS_SHA"

PID="$(systemctl show -p MainPID --value "$UNIT")"
PORT="$(tr '\0' '\n' < "/proc/$PID/environ" | sed -n 's/^PORT=//p')"
PORT="${PORT:-4001}"

echo "==> pre-deploy database backup"
TS="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$HOME/backups"
DSN="$(tr '\0' '\n' < "/proc/$PID/environ" | sed -n 's/^DATABASE_URL=//p')"
[ -n "$DSN" ] || { echo "REFUSING: could not read DATABASE_URL from the running service" >&2; exit 1; }
chmod 700 "$HOME/backups"
pg_dump --format=custom --no-owner --dbname="$DSN" --file="$HOME/backups/pre-deploy-$TS.dump"
chmod 600 "$HOME/backups/pre-deploy-$TS.dump"   # a dump is the whole candidate database (audit F6)
echo "    $HOME/backups/pre-deploy-$TS.dump"

echo "==> fetch $REF"
# The original clone used a single-branch refspec for a feature branch that was
# later deleted upstream, so every fetch failed with "couldn't find remote ref"
# and the host silently sat on a months-old commit. Assert the standard refspec
# rather than trusting it.
git -C "$APP_ROOT" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git -C "$APP_ROOT" fetch --prune origin

DIRTY="$(git -C "$APP_ROOT" status --porcelain --untracked-files=no)"
if [ -n "$DIRTY" ]; then
  echo "REFUSING: the deployed tree has local edits:" >&2
  echo "$DIRTY" >&2
  echo "Upstream them first — a checkout would silently discard them." >&2
  exit 1
fi

# The approval check needs the commit locally (fetched just above) and runs
# before anything is changed. No approval, no release.
echo "==> verify approval for $REF"
bash "$(dirname "$0")/10-verify-approval.sh" "$REF" || { echo "REFUSING: no valid GitHub approval for $REF — the running service is untouched." >&2; exit 1; }

git -C "$APP_ROOT" reset --hard "$REF"

echo "==> build"
cd "$APP_ROOT/backend"
# npm ci deletes node_modules before installing, so a failed install would
# otherwise leave the service with nothing to start from.
rm -rf node_modules.prev
[ -d node_modules ] && mv node_modules node_modules.prev
if npm ci --no-audit --no-fund && npm run build; then
  rm -rf node_modules.prev
else
  echo "build failed — restoring the previous node_modules" >&2
  rm -rf node_modules; [ -d node_modules.prev ] && mv node_modules.prev node_modules
  exit 1
fi
git -C "$APP_ROOT" rev-parse HEAD > "$APP_ROOT/DEPLOYED_SHA"

echo "==> restart"
kill "$PID" 2>/dev/null || true

# The service binds its port immediately and initialises behind a readiness
# gate, so "active" is not "serving". Wait for readiness, not for systemd.
echo "==> waiting for readiness on :$PORT"
ready=0
for _ in $(seq 1 90); do
  if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health/ready" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != 1 ]; then
  echo "REFUSING to report success: the service never became ready." >&2
  echo "  journalctl -u $UNIT -n 80 --no-pager" >&2
  echo "  roll back: ATS_REF=$PREVIOUS_SHA bash $0" >&2
  exit 1
fi

# One approval, one release: mark the deployment consumed only now that the
# new build is serving. A failed build above leaves it usable for a retry.
bash "$(dirname "$0")/10-verify-approval.sh" --consume "$REF" >/dev/null || true
echo "$(date -Is) RELEASE $REF (was $PREVIOUS_SHA) by ${SUDO_USER:-$USER} from ${SSH_CLIENT%% *}" >> "$HOME/releases.log"

echo
echo "Deployed $(cat "$APP_ROOT/DEPLOYED_SHA") (was $PREVIOUS_SHA)."
echo "Roll back: approve $PREVIOUS_SHA in GitHub (Actions → Release to on-prem), then ATS_REF=$PREVIOUS_SHA bash $0"
