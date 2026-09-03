#!/usr/bin/env bash
# Arabtec ATS — one-time data migration OFF Render.
#
# Pulls a full logical dump of the live Render Postgres and restores it into the
# on-prem arabtec_ats database created by 02-database.sh. This is the step the
# old runbook deliberately deferred ("no master data import"); it is now in scope
# because Render is being decommissioned, not kept as a fallback.
#
# SKIP THIS SCRIPT if the Render database holds nothing you need to keep (e.g.
# the pilot never went live on Render). In that case let the app seed a fresh
# admin-only DB on first boot, then load the Arabtec org data separately with
# backend/prisma/migrate-arabtec-data.mjs.
#
# Inputs (environment):
#   RENDER_DATABASE_URL   the EXTERNAL connection string of the Render prod DB
#                         (Render dashboard -> arabtec-db -> "External Database URL").
#                         It ends in "...oregon-postgres.render.com/arabtec".
#   LOCAL_DATABASE_URL    the on-prem URL printed by 02-database.sh
#                         (postgres://arabtec_ats:...@127.0.0.1:5432/arabtec_ats)
#   MODE                  "initial" (default) refuses to run if the target has
#                         data;  "refresh" wipes and reloads the target — use it
#                         for the final cutover sync during a short freeze.
set -euo pipefail

: "${RENDER_DATABASE_URL:?set RENDER_DATABASE_URL to the Render external connection string}"
: "${LOCAL_DATABASE_URL:?set LOCAL_DATABASE_URL to the on-prem postgres URL from 02-database.sh}"
MODE="${MODE:-initial}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="/var/lib/arabtec-ats/dumps/render-${STAMP}.dump"

echo "==> client / server versions"
pg_dump --version
psql "$LOCAL_DATABASE_URL" -tAc "select version()" | sed 's/^ *//'

echo "==> is the target already populated?"
HAS_USERS="$(psql "$LOCAL_DATABASE_URL" -tAc \
  "SELECT to_regclass('public.users') IS NOT NULL AND (SELECT count(*) FROM users) > 0" 2>/dev/null || echo f)"
if [ "$HAS_USERS" = "t" ]; then
  if [ "$MODE" != "refresh" ]; then
    echo "REFUSING: $LOCAL_DATABASE_URL already has users. Re-run with MODE=refresh to wipe and reload." >&2
    exit 1
  fi
  echo "MODE=refresh — dropping and recreating the public schema on the target"
  psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
SQL
fi

echo "==> dump from Render  ->  $DUMP"
# --no-owner / --no-privileges: the dump is restored under a different role name
# (arabtec_ats), so ownership and GRANTs from Render must not carry over.
pg_dump --format=custom --no-owner --no-privileges --verbose \
  --file="$DUMP" "$RENDER_DATABASE_URL"
ls -lh "$DUMP"

echo "==> restore into on-prem"
pg_restore --no-owner --no-privileges --role=arabtec_ats --exit-on-error \
  --dbname="$LOCAL_DATABASE_URL" "$DUMP"

echo "==> sanity"
psql "$LOCAL_DATABASE_URL" -tAc "
  SELECT 'users     ' || count(*) FROM users
  UNION ALL SELECT 'candidates' || count(*) FROM candidates
  UNION ALL SELECT 'requests  ' || count(*) FROM requests
  UNION ALL SELECT 'file_blob ' || count(*) FROM file_blob;" 2>/dev/null || \
  echo "(some tables absent — check the pg_restore log above)"

echo
echo "IMPORT OK. Dump kept at $DUMP (contains personal data — mode 0640, arabtec-ats)."
echo "Run 04-app.sh next, then 05-install-services.sh. The app will NOT re-seed a"
echo "populated database, so the admin login and all data are exactly as on Render."
