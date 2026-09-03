#!/usr/bin/env bash
# Arabtec ATS — nightly backup, invoked by arabtec-ats-backup.timer at 02:00
# Africa/Cairo.
#
# On Render the free-tier database had NO backups. On-prem is now the only copy
# of the data, so this is not optional. It writes:
#   /var/backups/arabtec-ats/db-<stamp>.dump      pg_dump --format=custom
#   /var/backups/arabtec-ats/uploads-<stamp>.tgz  the UPLOAD_DIR tree
# and keeps 14 dailies + 8 weeklies (Sunday).
#
# Restore:
#   systemctl stop arabtec-ats
#   pg_restore --clean --if-exists --no-owner --role=arabtec_ats \
#     -d "$DATABASE_URL" /var/backups/arabtec-ats/db-<stamp>.dump
#   tar xzf /var/backups/arabtec-ats/uploads-<stamp>.tgz -C /
#   systemctl start arabtec-ats
set -euo pipefail

# shellcheck disable=SC1091
set -a; . /etc/arabtec-ats/ats.env; set +a
: "${DATABASE_URL:?}" "${UPLOAD_DIR:?}"

DEST=/var/backups/arabtec-ats
STAMP="$(date +%Y%m%d-%H%M%S)"
DOW="$(date +%u)"   # 7 = Sunday

pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" -f "$DEST/db-$STAMP.dump"
tar czf "$DEST/uploads-$STAMP.tgz" -C / "${UPLOAD_DIR#/}"

# keep this one as a weekly, too
if [ "$DOW" = "7" ]; then
  cp -p "$DEST/db-$STAMP.dump"      "$DEST/weekly-db-$STAMP.dump"
  cp -p "$DEST/uploads-$STAMP.tgz"  "$DEST/weekly-uploads-$STAMP.tgz"
fi

# retention: 14 dailies, 8 weeklies
ls -1t "$DEST"/db-*.dump         2>/dev/null | tail -n +15 | xargs -r rm -f
ls -1t "$DEST"/uploads-*.tgz     2>/dev/null | tail -n +15 | xargs -r rm -f
ls -1t "$DEST"/weekly-db-*.dump  2>/dev/null | tail -n +9  | xargs -r rm -f
ls -1t "$DEST"/weekly-uploads-*.tgz 2>/dev/null | tail -n +9 | xargs -r rm -f

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup ok: db-$STAMP.dump ($(du -h "$DEST/db-$STAMP.dump" | cut -f1))"
