# Server baseline (read-only, 2026-10-04, ssh ats@10.20.0.9)

- Deployed SHA: `5272780e054246e2c789e8cd1ecfe9ec267116f8` (HEAD and /opt/arabtec-ats/DEPLOYED_SHA agree)
- Working tree: clean (no tracked edits)
- Remote: origin https://github.com/Meez2710/arabtec-recruitment-hub.git
- Last commit: 5272780 2026-09-30 "Merge pull request #45 … desktop-layout-comments"
- Service `arabtec-ats`: active since Thu 2026-10-01 07:47:28 UTC
- Node on host: v22.23.2 (/opt/node22)
- Disk: / 98G, 9.8G used (11%)
- Existing backups (~/backups): pre-deploy-20261001-074657.dump (61 MB) is the latest; older pre-deploy/pre-reunify/pre-labelling dumps present
- Rollback target: SHA 5272780 + `deploy/on-prem/99-rollback.sh`; DB restore from the pre-deploy dump taken by 08-redeploy.sh

Not captured: service environment names and /api/health* responses — the
session's permission classifier refused further production reads. Requires an
explicit owner permission rule (see SUPERVISOR_STATUS.md).
- Code rollback command (on host): `ATS_REF=5272780e054246e2c789e8cd1ecfe9ec267116f8 bash ~/arabtec-deploy/08-redeploy.sh` (99-rollback.sh stops the service; it is not a code rollback)
