#!/usr/bin/env bash
# Arabtec ATS — stop the on-prem instance.
#
# Use during the burn-in window, while Render is still reachable as a fallback.
# It does NOT drop the database and does NOT delete /var/lib/arabtec-ats — losing
# data is never the fast path.
#
# After Render has been decommissioned (07-decommission-render.md) there is no
# fallback: fix forward instead, and restore from /var/backups/arabtec-ats if the
# database itself is the problem.
set -euo pipefail
echo "==> stopping on-prem ATS"
sudo systemctl disable --now arabtec-cv-scan.timer      || true
sudo systemctl disable --now arabtec-ats-backup.timer   || true
sudo systemctl disable --now arabtec-ats.service        || true
sudo a2dissite arabtec-ats || true
sudo systemctl reload apache2 || true
echo
echo "On-prem ATS stopped. Database 'arabtec_ats' and /var/lib/arabtec-ats are INTACT."
echo "Roll forward again with:"
echo "  sudo systemctl enable --now arabtec-ats.service arabtec-cv-scan.timer arabtec-ats-backup.timer"
echo "  sudo a2ensite arabtec-ats && sudo systemctl reload apache2"
