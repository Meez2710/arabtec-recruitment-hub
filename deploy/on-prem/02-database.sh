#!/usr/bin/env bash
# Arabtec ATS — database. Uses the EXISTING PostgreSQL 16 cluster but a SEPARATE
# role and database, so the ATS is isolated from Employee Workspace at the
# permission level, not just by convention.
#
# Prints the generated DATABASE_URL ONCE. Put it straight into
# /etc/arabtec-ats/ats.env.
set -euo pipefail

DB_NAME=arabtec_ats
DB_USER=arabtec_ats

echo "==> refusing to clobber an existing database"
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
  echo "Database '$DB_NAME' already exists. Not touching it."
  echo "If this is a re-run, skip ahead. If it is stale, back it up and drop it BY HAND."
  exit 0
fi

DB_PASS="$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)"

echo "==> role + database"
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS';
CREATE DATABASE $DB_NAME OWNER $DB_USER ENCODING 'UTF8' TEMPLATE template0;
-- Isolation: this role may not read any other database's data, and no other
-- role gains rights here.
REVOKE ALL ON DATABASE $DB_NAME FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE $DB_NAME TO $DB_USER;
SQL

sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 <<SQL
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO $DB_USER;
GRANT ALL ON SCHEMA public TO $DB_USER;
SQL

echo
echo "=============================================================="
echo " DATABASE_URL — copy into /etc/arabtec-ats/ats.env, shown once"
echo
echo "DATABASE_URL=postgres://$DB_USER:$DB_PASS@127.0.0.1:5432/$DB_NAME"
echo
echo "=============================================================="
echo
echo "Next: either"
echo "  • 03-import-from-render.sh   — bring the live Render data across, OR"
echo "  • skip it and let the app seed a fresh admin-only DB on first boot"
echo "    (then run backend/prisma/migrate-arabtec-data.mjs for the org data)."
