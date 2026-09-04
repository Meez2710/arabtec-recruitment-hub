#!/usr/bin/env bash
# Run the production user-credential handover on ats@10.20.0.9.
#
# It sources the app's env file (as root — that file is 600 root:root), then runs
# the handover script as the arabtec-ats service account so the confidential
# output in /var/lib/arabtec-ats/handover/ is owned by that account, chmod 600.
#
#   sudo bash deploy/on-prem/run-handover.sh audit        # read-only reconciliation
#   sudo bash deploy/on-prem/run-handover.sh rotate-dry   # generate+verify, NO writes
#   sudo bash deploy/on-prem/run-handover.sh rotate       # LIVE: unique temp passwords
#   sudo bash deploy/on-prem/run-handover.sh verify       # re-verify every credential
#
# Env overrides: ATS_ENV_FILE, ATS_APP_DIR, ATS_USER, ATS_PUBLIC_URL
set -euo pipefail

ENVFILE="${ATS_ENV_FILE:-/etc/arabtec-ats/ats.env}"
APPDIR="${ATS_APP_DIR:-/opt/arabtec-ats/backend}"
RUNAS="${ATS_USER:-arabtec-ats}"
HDIR=/var/lib/arabtec-ats/handover

[ "$(id -u)" = 0 ] || { echo "Run with sudo (needs to read $ENVFILE)."; exit 1; }
[ -r "$ENVFILE" ] || { echo "Cannot read $ENVFILE"; exit 1; }
[ -d "$APPDIR" ]  || { echo "No app dir at $APPDIR (set ATS_APP_DIR)"; exit 1; }

# shellcheck disable=SC1090
set -a; . "$ENVFILE"; set +a
: "${DATABASE_URL:?DATABASE_URL is not set by $ENVFILE}"

case "${DATABASE_URL}" in
  postgres://*|postgresql://*) : ;;
  *) echo "REFUSING: DATABASE_URL in $ENVFILE is not a postgres URL."; exit 1 ;;
esac

case "${1:-}" in
  audit)      SCRIPT="$APPDIR/prisma/handover-01-audit.mjs";  shift; ARGS=() ;;
  rotate-dry) SCRIPT="$APPDIR/prisma/handover-02-rotate.mjs"; shift; ARGS=(--dry-run "$@") ;;
  rotate)     SCRIPT="$APPDIR/prisma/handover-02-rotate.mjs"; shift; ARGS=("$@") ;;
  verify)     SCRIPT="$APPDIR/prisma/handover-03-verify.mjs"; shift; ARGS=("$@") ;;
  *) echo "usage: sudo bash $0 <audit|rotate-dry|rotate|verify> [extra args]"; exit 2 ;;
esac
[ -f "$SCRIPT" ] || { echo "Not found: $SCRIPT — is the repo checked out / up to date at $APPDIR?"; exit 1; }

install -d -o "$RUNAS" -g "$RUNAS" -m 700 "$HDIR"

echo "==> $(basename "$SCRIPT") ${ARGS[*]:-}  (as $RUNAS)"
exec sudo -u "$RUNAS" env \
  DATABASE_URL="$DATABASE_URL" \
  BCRYPT_ROUNDS="${BCRYPT_ROUNDS:-10}" \
  NODE_ENV="${NODE_ENV:-production}" \
  SEED_ADMIN_EMAIL="${SEED_ADMIN_EMAIL:-admin@arabtec.com}" \
  HANDOVER_DIR="$HDIR" \
  ATS_PUBLIC_URL="${ATS_PUBLIC_URL:-http://10.20.0.9:4001}" \
  node "$SCRIPT" "${ARGS[@]}"
