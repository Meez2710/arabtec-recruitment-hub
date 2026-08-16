#!/usr/bin/env bash
# Backup and RESTORE rehearsal for the Arabtec ATS database.
#
# A backup that has never been restored is a hope, not a backup. This script
# performs the full round trip against a REAL PostgreSQL and fails loudly if the
# restored database does not match the original — which is the only thing that
# makes the backup procedure in docs/BACKUP_AND_RESTORE.md trustworthy.
#
# WHY IT IS A SCRIPT RATHER THAN A TEST. `pg_dump`/`pg_restore` are client
# binaries. The `embedded-postgres` dev dependency ships only initdb, pg_ctl and
# postgres, so the round trip CANNOT be rehearsed on a developer machine that
# has no PostgreSQL client installed. Run this where those binaries exist: the
# database host, a CI job, or a workstation with `postgresql-client`.
#
# It NEVER touches the source database beyond reading it, and it restores into a
# throwaway database it creates and drops itself.
#
# Usage:
#   DATABASE_URL='postgres://user:pass@host:5432/arabtec' ./scripts/pg-backup-restore-rehearsal.sh
#
# Optional:
#   KEEP_DUMP=1     keep the dump file instead of deleting it
#   VERIFY_DB=name  name of the throwaway restore target (default arabtec_restore_check)

set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to the database to rehearse against}"
VERIFY_DB="${VERIFY_DB:-arabtec_restore_check}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="${TMPDIR:-/tmp}/arabtec_${STAMP}.dump"

for bin in pg_dump pg_restore psql createdb dropdb; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "MISSING: $bin — install the PostgreSQL client tools and re-run." >&2; exit 2; }
done

# Admin connection on the same server, for creating/dropping the throwaway DB.
ADMIN_URL="${DATABASE_URL%/*}/postgres"

cleanup() {
  dropdb --if-exists -d "$ADMIN_URL" "$VERIFY_DB" >/dev/null 2>&1 || true
  [ "${KEEP_DUMP:-0}" = "1" ] || rm -f "$DUMP"
}
trap cleanup EXIT

echo "1. Dumping (custom format, the restorable one) …"
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-acl --file "$DUMP"
SIZE=$(wc -c < "$DUMP" | tr -d ' ')
echo "   wrote $DUMP ($SIZE bytes)"
[ "$SIZE" -gt 1024 ] || { echo "FAIL: the dump is implausibly small." >&2; exit 1; }

echo "2. Restoring into a throwaway database ($VERIFY_DB) …"
dropdb --if-exists -d "$ADMIN_URL" "$VERIFY_DB" >/dev/null 2>&1 || true
createdb -d "$ADMIN_URL" "$VERIFY_DB"
RESTORE_URL="${DATABASE_URL%/*}/$VERIFY_DB"
# --exit-on-error: a partial restore that "mostly worked" is the failure mode
# this rehearsal exists to catch.
pg_restore --dbname "$RESTORE_URL" --no-owner --no-acl --exit-on-error "$DUMP"

echo "3. Comparing row counts, table by table …"
COUNT_SQL="
SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname;"
# n_live_tup is an estimate; count the tables that carry the records that matter.
TABLES="users candidate candidate_intake candidate_proposal recruitment_request application interview offer audit_log"
FAILED=0
for t in $TABLES; do
  A=$(psql -tAq "$DATABASE_URL" -c "SELECT COUNT(*) FROM $t" 2>/dev/null || echo "n/a")
  B=$(psql -tAq "$RESTORE_URL"  -c "SELECT COUNT(*) FROM $t" 2>/dev/null || echo "n/a")
  if [ "$A" = "$B" ]; then
    printf '   %-22s %8s = %-8s OK\n' "$t" "$A" "$B"
  else
    printf '   %-22s %8s ≠ %-8s MISMATCH\n' "$t" "$A" "$B"; FAILED=1
  fi
done

echo "4. Checking the restored schema is usable, not just present …"
psql -tAq "$RESTORE_URL" -c "SELECT 1 FROM candidate LIMIT 1" >/dev/null
CONSTRAINTS=$(psql -tAq "$RESTORE_URL" -c \
  "SELECT COUNT(*) FROM pg_constraint WHERE contype IN ('p','f','u')")
echo "   primary/foreign/unique constraints restored: $CONSTRAINTS"
[ "$CONSTRAINTS" -gt 0 ] || { echo "FAIL: no constraints in the restored database." >&2; exit 1; }

if [ "$FAILED" = "1" ]; then
  echo; echo "RESTORE REHEARSAL FAILED — the restored database does not match the source." >&2
  exit 1
fi

echo
echo "RESTORE REHEARSAL PASSED — dump restores cleanly and matches the source."
echo "Record the date, the dump size and the PostgreSQL version in the runbook."
psql -tAq "$DATABASE_URL" -c "SELECT version()" | head -1
