#!/usr/bin/env bash
# READ-ONLY. Run this FIRST on ats@10.20.0.9 and read the output before anything
# else. It changes nothing; it answers the questions the migration assumes.
#
#   scp -r deploy/on-prem ats@10.20.0.9:~/arabtec-deploy
#   ssh ats@10.20.0.9 'bash ~/arabtec-deploy/00-inspect.sh' | tee ~/arabtec-inspect.txt
set -uo pipefail
line(){ printf '\n=== %s ===\n' "$1"; }

line "host";              hostnamectl 2>/dev/null | sed -n '1,6p'; lsb_release -ds 2>/dev/null
line "timezone";          timedatectl | sed -n '1,6p'
line "resources";         free -h | head -2; df -h / /opt /var 2>/dev/null | sort -u
line "node";              (node -v && which node) 2>/dev/null || echo "node NOT installed"
line "postgres";          (psql --version; systemctl is-active postgresql) 2>/dev/null || echo "psql not on PATH"
line "postgres clusters"; pg_lsclusters 2>/dev/null || echo "pg_lsclusters unavailable"
line "pg_dump / pg_restore version"; (pg_dump --version; pg_restore --version) 2>/dev/null || echo "client tools NOT on PATH (needed for the Render import)"
line "existing databases";  sudo -u postgres psql -tAc "SELECT datname FROM pg_database ORDER BY 1" 2>/dev/null || echo "cannot read (needs sudo)"
line "existing roles";    sudo -u postgres psql -tAc "SELECT rolname FROM pg_roles ORDER BY 1" 2>/dev/null || echo "cannot read (needs sudo)"
line "apache";            (apache2 -v; systemctl is-active apache2) 2>/dev/null || echo "apache2 not found"
line "apache modules";    apache2ctl -M 2>/dev/null | grep -E "proxy|headers|ssl|rewrite" || echo "cannot list"
line "apache vhosts";     ls -1 /etc/apache2/sites-enabled/ 2>/dev/null
line "ports in use";      ss -tlnp 2>/dev/null | awk 'NR==1||/:(80|443|4000|4001|5432)\s/'
line "what already runs here (Employee Workspace?)"; systemctl list-units --type=service --state=running --no-pager 2>/dev/null | grep -viE "systemd|dbus|cron|ssh|rsyslog|polkit|udev|getty|networkd|resolved|journald|timesync|unattended|snapd" | head -20
line "existing arabtec/ats units"; systemctl list-unit-files --no-pager 2>/dev/null | grep -iE "arabtec|ats" || echo "none"
line "HR CV folder — is anything mounted/available?"; mount | grep -iE "cifs|nfs|smb" || echo "no network mounts"; ls -ld /mnt/* /media/* 2>/dev/null
line "outbound https (Anthropic reachable?)"; curl -s -o /dev/null -w "api.anthropic.com -> %{http_code}\n" --max-time 8 https://api.anthropic.com/v1/models || echo "no outbound https"
line "outbound https (Render reachable? — needed once, for the data import)"; curl -s -o /dev/null -w "%{http_code}\n" --max-time 8 https://api.render.com || echo "no outbound https to Render"
line "git";               git --version 2>/dev/null || echo "git NOT installed"
line "can the box reach GitHub?"; curl -s -o /dev/null -w "github.com -> %{http_code}\n" --max-time 8 https://github.com || echo "no outbound https to GitHub — you will need to push the repo from a bastion or copy a tarball"
line "sudo rights";       sudo -n true 2>/dev/null && echo "passwordless sudo: YES" || echo "passwordless sudo: NO (migration needs sudo — run each step with a sudo-capable login)"
