#!/usr/bin/env bash
# Arabtec ATS — install systemd units, the Apache vhost, and the scan + backup
# hooks. Run AFTER 01-04 and AFTER /etc/arabtec-ats/ats.env has real values.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "==> refuse to start without a real env file"
sudo test -f /etc/arabtec-ats/ats.env || { echo "MISSING /etc/arabtec-ats/ats.env (copy ats.env.template)"; exit 1; }
sudo grep -q REPLACE_ME /etc/arabtec-ats/ats.env && { echo "ats.env still has REPLACE_ME placeholders"; exit 1; }
sudo test -f /etc/arabtec-ats/scan.env || { echo "MISSING /etc/arabtec-ats/scan.env (copy scan.env.template)"; exit 1; }
sudo grep -q REPLACE_ME /etc/arabtec-ats/scan.env && { echo "scan.env still has REPLACE_ME placeholders"; exit 1; }
sudo chmod 600 /etc/arabtec-ats/ats.env /etc/arabtec-ats/scan.env
sudo chown root:root /etc/arabtec-ats/ats.env
sudo chown arabtec-ats:arabtec-ats /etc/arabtec-ats/scan.env

echo "==> hooks"
sudo mkdir -p /opt/arabtec-ats-bin
sudo install -m 0755 -o root -g root "$HERE/cv-scan.sh" /opt/arabtec-ats-bin/cv-scan.sh
sudo install -m 0755 -o root -g root "$HERE/backup.sh"  /opt/arabtec-ats-bin/backup.sh

echo "==> systemd units"
sudo install -m 0644 "$HERE/systemd/arabtec-ats.service"         /etc/systemd/system/
sudo install -m 0644 "$HERE/systemd/arabtec-cv-scan.service"     /etc/systemd/system/
sudo install -m 0644 "$HERE/systemd/arabtec-cv-scan.timer"       /etc/systemd/system/
sudo install -m 0644 "$HERE/systemd/arabtec-ats-backup.service"  /etc/systemd/system/
sudo install -m 0644 "$HERE/systemd/arabtec-ats-backup.timer"    /etc/systemd/system/
sudo install -m 0644 "$HERE/systemd/arabtec-m365-sync.service"   /etc/systemd/system/
sudo install -m 0644 "$HERE/systemd/arabtec-m365-sync.timer"     /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now arabtec-ats.service
sudo systemctl enable --now arabtec-cv-scan.timer
sudo systemctl enable --now arabtec-ats-backup.timer

# The careers mailbox: ONE scheduled trigger, 08:00 Africa/Cairo. The old
# app-only connector (arabtec-cv-mailbox.timer, deploy/on-prem/mailbox/) is
# deprecated — stop it here so the two can never both pull the same mail.
if systemctl list-unit-files | grep -q '^arabtec-cv-mailbox.timer'; then
  echo "==> retiring the deprecated app-only mailbox connector"
  sudo systemctl disable --now arabtec-cv-mailbox.timer || true
fi
# Enabled only once Microsoft 365 is actually connected in the ATS; until then
# every run would exit 0 with "not connected" and clutter the log.
if sudo -u arabtec-ats ATS_APP_ROOT=/opt/arabtec-ats bash -c \
     'set -a; . /etc/arabtec-ats/ats.env; set +a; node /opt/arabtec-ats/deploy/on-prem/m365-sync.mjs --status' >/dev/null 2>&1; then
  sudo systemctl enable --now arabtec-m365-sync.timer
  echo "    Microsoft 365 is connected — 08:00 Africa/Cairo mailbox scan enabled."
else
  # --now here too: plain `enable` only writes the boot symlink, so without it
  # the timer stays inactive until the next reboot and the promised 08:00 scan
  # never happens. Starting it now is harmless while disconnected — m365-sync.mjs
  # exits 0 with "not connected" until someone connects the mailbox.
  sudo systemctl enable --now arabtec-m365-sync.timer
  echo "    Microsoft 365 is NOT connected yet. The timer is installed and running;"
  echo "    connect the mailbox in the ATS (Configuration > Microsoft 365) and the"
  echo "    next 08:00 Africa/Cairo run will pick it up."
fi

echo "==> apache reverse proxy"
sudo a2enmod proxy proxy_http headers ssl rewrite >/dev/null
sudo install -m 0644 "$HERE/apache/arabtec-ats.conf" /etc/apache2/sites-available/arabtec-ats.conf
sudo a2ensite arabtec-ats >/dev/null
sudo apache2ctl configtest
sudo systemctl reload apache2

echo "SERVICES OK — now run 06-verify.sh"
