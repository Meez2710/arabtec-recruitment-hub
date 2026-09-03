#!/usr/bin/env bash
# Arabtec ATS — provisioning. Idempotent; safe to re-run.
# Creates the service account, directories and Node runtime. Touches nothing
# belonging to Employee Workspace.
set -euo pipefail

APP_USER=arabtec-ats            # dedicated service account: ATS runs as nobody else
APP_ROOT=/opt/arabtec-ats       # code
DATA_ROOT=/var/lib/arabtec-ats  # persistent state (uploads, CV inbox, dumps) — survives redeploys
LOG_ROOT=/var/log/arabtec-ats
BACKUP_ROOT=/var/backups/arabtec-ats

echo "==> service account"
id -u "$APP_USER" &>/dev/null || sudo useradd --system --create-home \
  --home-dir /var/lib/"$APP_USER" --shell /usr/sbin/nologin "$APP_USER"

echo "==> directories"
sudo mkdir -p "$APP_ROOT" "$DATA_ROOT"/{uploads,cv_inbox,dumps} "$LOG_ROOT" "$BACKUP_ROOT" /etc/arabtec-ats
sudo chown -R "$APP_USER":"$APP_USER" "$APP_ROOT" "$DATA_ROOT" "$LOG_ROOT" "$BACKUP_ROOT"
sudo chmod 750 "$DATA_ROOT" "$DATA_ROOT"/uploads "$DATA_ROOT"/dumps "$BACKUP_ROOT"  # personal data: not world-readable
sudo chmod 700 /etc/arabtec-ats                    # holds env files with secrets

echo "==> packages"
sudo apt-get update -qq
sudo apt-get install -y -qq git curl ca-certificates jq
# postgresql-client-16 gives a pg_dump/pg_restore that matches the server's PG 16
# and Render's PG 16 — needed by 03-import-from-render.sh and by backup.sh.
sudo apt-get install -y -qq postgresql-client-16 || sudo apt-get install -y -qq postgresql-client

echo "==> Node 22 (package.json requires >=22.5.0 <23; Ubuntu 24.04 ships 18)"
if ! node -v 2>/dev/null | grep -q '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
node -v

echo "==> timezone (the 08:00 scanner and 02:00 backup are defined in Africa/Cairo)"
timedatectl show -p Timezone --value

echo "PROVISION OK"
