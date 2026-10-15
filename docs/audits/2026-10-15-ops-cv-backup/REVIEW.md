# CV file security and automated backups — pre-change review (15 Oct 2026)

Host `ats@10.20.0.9`, production `c682ec8`. Everything below was gathered **read-only** (no sudo, no file or database writes); no credentials or file contents were printed. No production change has been made. Separate from, and does not close, the Safari UI alignment work.

## Priority 1 — CV file security

### Evidence
| Item | Observed |
|---|---|
| Service identity | `node src/server.js` runs as **ats:ats** (unit `/etc/systemd/system/arabtec-ats.service`, `User=ats`, `ProtectSystem=no`) |
| Process umask | **0022** → every new upload is created `644` (world-readable) |
| Storage (from the running env) | `UPLOAD_DIR=/var/lib/arabtec-ats/uploads`, `CV_INBOX=/var/lib/arabtec-ats/cv_inbox` |
| Directory modes | `/var/lib/arabtec-ats`, `uploads`, `cv_inbox`: **755 ats:ats**; no subdirectories |
| File modes | 373 files, all ats:ats: **353 × 644, 20 × 664** → all readable by every account on the host |
| Who else is on the host | `ats` (uid 1000) is the only login account; exposure is to system accounts (`www-data`, `postgres`, …) and anything running as them |
| Other processes touching storage | only the ATS service; `arabtec-m365-sync` also runs as `ats` (`ReadWritePaths=/var/lib/arabtec-ats`) |
| How CVs are served | read inside Node (`backend/src/lib/upload.js`, `modules/talent/infrastructure/document-store.ts`) and returned through authenticated API routes. Apache only proxies (`ProxyPass / http://127.0.0.1:4001/`); no `Alias`/`DocumentRoot` to `/var/lib` in `sites-enabled` |

Conclusion: only the `ats` user needs access. Removing "other" access cannot affect preview, download, parsing, M365 sync or backups (all run as `ats`).

### Proposed change (requires authorization)
A — permissions on what exists (owner is `ats`, no sudo):
```bash
ssh ats@10.20.0.9 'chmod 750 /var/lib/arabtec-ats /var/lib/arabtec-ats/uploads /var/lib/arabtec-ats/cv_inbox && find /var/lib/arabtec-ats/uploads /var/lib/arabtec-ats/cv_inbox -type f -exec chmod 640 {} +'
```
B — new files private by default (sudo; restarts the ATS for a few seconds):
```bash
ssh -t ats@10.20.0.9 'for u in arabtec-ats arabtec-m365-sync; do sudo mkdir -p /etc/systemd/system/$u.service.d && printf "[Service]\nUMask=0027\n" | sudo tee /etc/systemd/system/$u.service.d/umask.conf >/dev/null; done && sudo systemctl daemon-reload && sudo systemctl restart arabtec-ats && systemctl show arabtec-ats -p UMask'
```
A alone closes the exposure (others cannot enter a `750` directory). B keeps future files `640` even if a directory mode is ever loosened.

### Verification after the change
```bash
ssh ats@10.20.0.9 'stat -c "%a %n" /var/lib/arabtec-ats /var/lib/arabtec-ats/uploads /var/lib/arabtec-ats/cv_inbox; find /var/lib/arabtec-ats -type f -perm /o=rwx | wc -l; find /var/lib/arabtec-ats/uploads -type f ! -readable | wc -l; curl -fsS http://127.0.0.1:4001/api/health/ready'
```
Expected: `750` ×3, `0` world-accessible files, `0` files unreadable by `ats`, `{"ok":true,"ready":true}`.
Unauthorized-account check (sudo):
```bash
ssh -t ats@10.20.0.9 'f=$(find /var/lib/arabtec-ats/uploads -type f | head -1); for u in www-data nobody postgres; do sudo -u $u test -r "$f" && echo "$u CAN read (FAIL)" || echo "$u cannot read (PASS)"; done'
```
Application check: in Safari, open one candidate's CV preview and download it.
Rollback: `chmod 755` on the three directories and `chmod 644` on the files; remove the two `umask.conf` drop-ins and restart.

## Priority 2 — automated backups

### Evidence
| Item | Observed |
|---|---|
| Installed today | **no backup timer or service** in `/etc/systemd/system`; `/var/backups/arabtec-ats` does not exist. Only copies: the release script's `~/backups/pre-release-*.dump` (same disk, not pruned) |
| Units reviewed | `deploy/on-prem/systemd/arabtec-ats-backup.{service,timer}`; server copies byte-identical to the repo (sha256 `0d3a6ba8…`, `e4be1817…`); `systemd-analyze verify` exit 0 |
| Schedule | `OnCalendar=*-*-* 02:00:00 Africa/Cairo`, `Persistent=true` (missed runs catch up at boot). `systemd-analyze calendar`: next 23:00 UTC (02:00 Cairo while UTC+3); systemd follows the zone across the DST change |
| Runs as / sandbox | `User=ats`, `EnvironmentFile=/etc/arabtec-ats/ats.env` (root 600, read by systemd), `ProtectSystem=strict`, writable only `/var/backups/arabtec-ats` — **this directory must exist before the first run** |
| Coverage | `backup.sh`: `pg_dump --format=custom` of `DATABASE_URL` + `tar czf` of `UPLOAD_DIR`. **`CV_INBOX` is not backed up** (currently empty, 4 KB; transient inbox) |
| Versions | `pg_dump` 16.15 = server 16.15 |
| Retention | 30 daily db + 30 daily uploads; Sundays also copied as weekly, 8 kept. Pruning keeps the newest by timestamped name; daily and weekly globs do not overlap |
| Size | db ≈ 143 MB, uploads 134 MB → ≈ 0.28 GB/day; full retention ≈ 10–11 GB at today's size. Disk: 74 GB free of 98 GB |
| Archive integrity | newest pre-release dump read end to end with `pg_restore -f /dev/null` (2.4 s, no database touched) |
| Isolated restore | PostgreSQL 16 `initdb`/`pg_ctl` present → `10-restore-test.sh` can restore into a throwaway instance as `ats`, socket-only, never the production cluster |

### Proposed change (requires authorization)
```bash
ssh -t ats@10.20.0.9 'sudo install -d -o ats -g ats -m 700 /var/backups/arabtec-ats && sudo cp /opt/arabtec-ats/deploy/on-prem/systemd/arabtec-ats-backup.service /opt/arabtec-ats/deploy/on-prem/systemd/arabtec-ats-backup.timer /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now arabtec-ats-backup.timer && systemctl list-timers arabtec-ats-backup.timer --no-pager'
```
One backup now, then the isolated restore test:
```bash
ssh -t ats@10.20.0.9 'sudo systemctl start arabtec-ats-backup.service && sudo journalctl -u arabtec-ats-backup.service -n 3 --no-pager && ls -lh /var/backups/arabtec-ats'
```
```bash
scp deploy/on-prem/10-restore-test.sh ats@10.20.0.9:~/arabtec-deploy/ && ssh ats@10.20.0.9 'bash ~/arabtec-deploy/10-restore-test.sh'
```
Expected: `backup ok: db-<stamp>.dump`, a `db-*.dump` and `uploads-*.tgz` in `/var/backups/arabtec-ats`, `RESTORE TEST OK`, uploads archive file count = live file count.
Rollback: `sudo systemctl disable --now arabtec-ats-backup.timer` (archives are kept).

### Off-server requirement (not solved by this change)
The archives sit on the same disk as the data they protect; a disk, VM or host loss takes both. Required: a nightly copy to separate storage (another host, NAS or object store), encrypted at rest because it contains CVs and personal data, access limited to named administrators, its own retention, and a periodic restore drill using `10-restore-test.sh`. The owner must choose the destination; nothing is configured for it today.
