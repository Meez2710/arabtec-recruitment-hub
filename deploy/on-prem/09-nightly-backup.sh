#!/usr/bin/env bash
# Nightly database dump + retention for the on-prem Recruitment Hub (audit F6, 25 Oct 2026).
#
#   backup   → pg_dump (custom format) to ~/backups/nightly-YYYYmmdd-HHMMSS.dump, mode 0600
#   prune    → keep every dump from the last KEEP_DAYS days, plus the oldest dump
#              of each of the last KEEP_MONTHS months; delete the rest (pre-deploy dumps included)
#
# Runs as the `ats` service user (owner of ~/backups), no sudo needed:
#   crontab:  0 2 * * *  /opt/arabtec-ats/deploy/on-prem/09-nightly-backup.sh >> $HOME/backups/nightly.log 2>&1
# An off-box copy is still required for real disaster recovery — rsync/scp the
# newest dump to the IT backup share from this script once a target exists.
set -euo pipefail
UNIT=arabtec-ats
KEEP_DAYS="${KEEP_DAYS:-14}"
KEEP_MONTHS="${KEEP_MONTHS:-6}"
DIR="$HOME/backups"
umask 077
mkdir -p "$DIR"
chmod 700 "$DIR"

PID="$(systemctl show -p MainPID --value "$UNIT")"
DSN="$(tr '\0' '\n' < "/proc/$PID/environ" 2>/dev/null | sed -n 's/^DATABASE_URL=//p')"
[ -n "$DSN" ] || { echo "$(date -Is) REFUSING: could not read DATABASE_URL from the running service" >&2; exit 1; }

TS="$(date +%Y%m%d-%H%M%S)"
OUT="$DIR/nightly-$TS.dump"
pg_dump --format=custom --no-owner --dbname="$DSN" --file="$OUT"
chmod 600 "$OUT"
echo "$(date -Is) wrote $OUT ($(du -h "$OUT" | cut -f1))"

# Older than KEEP_DAYS: keep one per calendar month for KEEP_MONTHS months.
declare -A kept_month
removed=0
now_y=$(date +%Y); now_m=$(date +%-m)
while IFS= read -r f; do
  [ -n "$f" ] || continue
  m="$(date -r "$f" +%Y%m)"
  age_months=$(( (now_y * 12 + now_m) - (10#${m:0:4} * 12 + 10#${m:4:2}) ))
  if [ "$age_months" -le "$KEEP_MONTHS" ] && [ -z "${kept_month[$m]:-}" ]; then kept_month[$m]=1; continue; fi
  rm -f -- "$f"; removed=$((removed + 1))
done < <(find "$DIR" -maxdepth 1 -name '*.dump' -mtime +"$KEEP_DAYS" -printf '%T@ %p\n' | sort -n | cut -d' ' -f2-)
chmod 600 "$DIR"/*.dump 2>/dev/null || true
echo "$(date -Is) retention: removed $removed, $(ls "$DIR"/*.dump 2>/dev/null | wc -l) dump(s) kept, $(du -sh "$DIR" | cut -f1) total"
