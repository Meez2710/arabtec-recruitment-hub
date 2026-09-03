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
sudo systemctl daemon-reload
sudo systemctl enable --now arabtec-ats.service
sudo systemctl enable --now arabtec-cv-scan.timer
sudo systemctl enable --now arabtec-ats-backup.timer

echo "==> apache reverse proxy"
sudo a2enmod proxy proxy_http headers ssl rewrite >/dev/null
sudo install -m 0644 "$HERE/apache/arabtec-ats.conf" /etc/apache2/sites-available/arabtec-ats.conf
sudo a2ensite arabtec-ats >/dev/null
sudo apache2ctl configtest
sudo systemctl reload apache2

echo "SERVICES OK — now run 06-verify.sh"
