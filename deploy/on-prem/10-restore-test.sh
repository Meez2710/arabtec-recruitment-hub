#!/usr/bin/env bash
# Arabtec ATS — isolated restore test. Run as `ats` on 10.20.0.9 (no sudo).
#
# Restores a nightly backup into a THROWAWAY PostgreSQL 16 instance owned by the
# invoking user: its own data directory under $HOME, unix socket only in a 0700
# directory (listen_addresses=''), never the production cluster. It compares the
# restored row counts with production using a read-only transaction, checks the
# uploads archive against the live upload directory, then stops the instance and
# deletes it. Nothing is printed from the data itself: table names and counts only.
#
#   bash 10-restore-test.sh                       # newest /var/backups/arabtec-ats/db-*.dump
#   bash 10-restore-test.sh /path/to/file.dump    # a specific dump
set -euo pipefail
umask 077
PGBIN=/usr/lib/postgresql/16/bin
BK=/var/backups/arabtec-ats
DUMP="${1:-}"
[ -n "$DUMP" ] || DUMP="$(ls -1t "$BK"/db-*.dump 2>/dev/null | head -1 || true)"
[ -n "$DUMP" ] && [ -r "$DUMP" ] || { echo "REFUSING: no readable dump (${DUMP:-none})" >&2; exit 2; }
UPL="$(ls -1t "$BK"/uploads-*.tgz 2>/dev/null | head -1 || true)"

T="$(mktemp -d "$HOME/restore-test.XXXXXX")"
cleanup() { "$PGBIN/pg_ctl" -D "$T/data" -m fast stop >/dev/null 2>&1 || true; rm -rf "$T"; }
trap cleanup EXIT
SOCK=(-h "$T" -p 5499 -U restore)

echo "==> dump:   $(basename "$DUMP") ($(du -h "$DUMP" | cut -f1))"
"$PGBIN/initdb" -D "$T/data" -A trust -U restore >/dev/null
"$PGBIN/pg_ctl" -D "$T/data" -o "-c listen_addresses='' -k $T -p 5499" -l "$T/pg.log" -w start >/dev/null
createdb "${SOCK[@]}" ats_restore
echo "==> restoring into the throwaway instance"
pg_restore --no-owner --no-privileges --exit-on-error "${SOCK[@]}" -d ats_restore "$DUMP"

# Production, read-only: the DSN is taken from the running service, never echoed.
PID="$(systemctl show -p MainPID --value arabtec-ats)"
PROD="$(tr '\0' '\n' < "/proc/$PID/environ" | sed -n 's/^DATABASE_URL=//p')"
[ -n "$PROD" ] || { echo "REFUSING: cannot read DATABASE_URL from the running service" >&2; exit 1; }

echo "==> row counts (restored vs production now; small differences = writes since the backup)"
TABLES="$(psql "${SOCK[@]}" -d ats_restore -XAtc "SELECT schemaname||'.'||tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1")"
n=0; rows=0; diff=0; missing=0
while IFS= read -r t; do
  [ -n "$t" ] || continue
  r="$(psql "${SOCK[@]}" -d ats_restore -XAtc "SELECT count(*) FROM $t")"
  p="$(PGOPTIONS='-c default_transaction_read_only=on' psql "$PROD" -XAtc "SELECT count(*) FROM $t" 2>/dev/null || echo MISSING)"
  n=$((n+1)); rows=$((rows+r))
  if [ "$p" = "MISSING" ]; then missing=$((missing+1)); printf '  %-48s restored=%-8s production=MISSING\n' "$t" "$r"
  elif [ "$r" != "$p" ]; then diff=$((diff+1)); printf '  %-48s restored=%-8s production=%s\n' "$t" "$r" "$p"; fi
done <<< "$TABLES"
unset PROD
echo "    $n tables, $rows rows restored; $diff tables differ, $missing missing in production"

if [ -n "$UPL" ]; then
  LIVE="$(tr '\0' '\n' < "/proc/$PID/environ" | sed -n 's/^UPLOAD_DIR=//p')"
  a="$(tar -tzf "$UPL" | grep -vc '/$' || true)"; l="$(find "$LIVE" -type f | wc -l)"
  echo "==> uploads: $(basename "$UPL") holds $a files; live upload dir holds $l"
  tar -tzf "$UPL" >/dev/null && echo "    archive reads end to end"
else
  echo "==> uploads: no uploads-*.tgz yet"
fi
echo "==> throwaway instance stopped and deleted on exit"
[ "$missing" -eq 0 ] && echo "RESTORE TEST OK" || { echo "RESTORE TEST: REVIEW (tables missing in production)"; exit 1; }
