#!/usr/bin/env bash
# Run a backend maintenance script against the LIVE production configuration.
#
#   sudo bash /opt/arabtec-ats/deploy/on-prem/ats-run.sh prisma/reset-transactional-data.mjs --dry-run
#   sudo ARABTEC_RESET_CONFIRM=RESET bash .../ats-run.sh prisma/reset-transactional-data.mjs
#   sudo ARABTEC_MANAGER_PASSWORD='...' bash .../ats-run.sh prisma/migrate-arabtec-data.mjs
#
# WHY THIS EXISTS. DATABASE_URL, UPLOAD_DIR and CV_INBOX live only in the
# root-owned /etc/arabtec-ats/ats.env. systemd's EnvironmentFile= injects them
# into the SERVICE, not into an interactive shell, and the deployment creates no
# backend/.env. So running these scripts directly — as the runbook used to say —
# left DATABASE_URL unset, and src/lib/db.js silently fell back to its local
# SQLite default. The command then reported success against an empty scratch
# database while production sat untouched: the most dangerous kind of green tick.
#
# This loads the real environment, runs as the application user, and refuses if
# either is missing.
set -euo pipefail

ENV_FILE=${ATS_ENV_FILE:-/etc/arabtec-ats/ats.env}
APP_DIR=${ATS_APP_ROOT:-/opt/arabtec-ats}/backend
APP_USER=${ATS_APP_USER:-arabtec-ats}

[ $# -ge 1 ] || { echo "usage: ats-run.sh <script-path-relative-to-backend> [args...]" >&2; exit 2; }
[ -r "$ENV_FILE" ] || { echo "cannot read $ENV_FILE — run this with sudo" >&2; exit 1; }
[ -d "$APP_DIR" ]  || { echo "no backend at $APP_DIR — set ATS_APP_ROOT" >&2; exit 1; }

set -a; . "$ENV_FILE"; set +a

: "${DATABASE_URL:?DATABASE_URL is not set in $ENV_FILE}"
case "$DATABASE_URL" in
  postgres://*|postgresql://*) ;;
  *) echo "REFUSING: DATABASE_URL in $ENV_FILE is not a postgres:// URL ($DATABASE_URL)." >&2
     echo "On this host production is PostgreSQL; a file: URL means the wrong database." >&2
     exit 1;;
esac

echo "==> $(basename "$1") against ${DATABASE_URL%%\?*} as $APP_USER"
SCRIPT=$1; shift
# Pass through the confirmation variables explicitly — sudo -u drops the rest.
exec sudo -u "$APP_USER" env \
  DATABASE_URL="$DATABASE_URL" \
  UPLOAD_DIR="${UPLOAD_DIR:-}" \
  CV_INBOX="${CV_INBOX:-}" \
  NODE_ENV="${NODE_ENV:-production}" \
  BCRYPT_ROUNDS="${BCRYPT_ROUNDS:-10}" \
  ARABTEC_RESET_CONFIRM="${ARABTEC_RESET_CONFIRM:-}" \
  ARABTEC_MANAGER_PASSWORD="${ARABTEC_MANAGER_PASSWORD:-}" \
  node --experimental-sqlite "$APP_DIR/$SCRIPT" "$@"
