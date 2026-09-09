# Approved UI and email settings: on-prem release

Target: the existing Arabtec ATS at `ats@10.20.0.9`, `/opt/arabtec-ats`, systemd service `arabtec-ats`, PostgreSQL. This is not the separate Employee Workspace Docker deployment.

## What was reconciled

- Both uploaded frontend ZIPs are identical and predate the merged P0 changes. They are references, not replacement production folders.
- The design handoff explicitly says no app code was changed. PR #14 applied P0 only. This release completes the remaining implemented UI changes and adds a working Email & Mailbox page.
- The supplied Power Automate guide describes analysis and outgoing messages, but explicitly leaves ATS persistence unbuilt. The repository already has delegated Microsoft OAuth, reviewed CV intake, and the daily on-prem sync service. This release retains that existing integration; it does not create a second ingestion pipeline or invent a SharePoint dependency.
- SMTP settings are saved encrypted using the existing `MICROSOFT_TOKEN_ENCRYPTION_KEY`. Omitted passwords preserve the credential. Testing a draft writes no settings. SMTP credentials never appear in API/audit responses. The outgoing provider can be Automatic, Microsoft 365, or SMTP; `SMTP_TRANSPORT=json` still prevents actual delivery.
- Message counts start with this release and use UTC calendar months. Graph controls its own sender name/address in Outlook; SMTP sender fields do not pretend to override that identity.

## Deployment procedure

Run from a terminal inside the company network after SSH login. Use the **full tested commit SHA** supplied with the release, not a moving branch name. No database reset, company-data migration, seed, mailbox scan, or candidate email send is part of this procedure.

1. Inspect the existing checkout and services. If the working tree has changes, stop and preserve them before proceeding.

```bash
sudo -u arabtec-ats git -C /opt/arabtec-ats status --short
sudo -u arabtec-ats git -C /opt/arabtec-ats rev-parse HEAD
sudo systemctl status arabtec-ats --no-pager
```

Record that current SHA as your rollback point. Set `RELEASE_SHA` to the full 40-character tested SHA and fetch it:

```bash
RELEASE_SHA=FULL_TESTED_COMMIT_SHA
sudo -u arabtec-ats git -C /opt/arabtec-ats fetch origin
sudo -u arabtec-ats git -C /opt/arabtec-ats cat-file -e "$RELEASE_SHA^{commit}"
```

2. Copy the release's deployment scripts to a temporary local directory before switching the running checkout. This includes the fixed backup script and avoids accidentally running stale copies from `~/arabtec-deploy`.

```bash
RELEASE_TOOLS=$(mktemp -d)
sudo -u arabtec-ats git -C /opt/arabtec-ats archive "$RELEASE_SHA" deploy/on-prem | tar -x -C "$RELEASE_TOOLS"
```

3. Check that no scan is running before the short update window. Wait for any active scan to finish. Note which timers are currently active so they can be resumed after the update. Stop active ingestion timers for the window, then stop the app and back up the database/uploads.

```bash
sudo systemctl is-active arabtec-m365-sync.service arabtec-cv-scan.service arabtec-cv-mailbox.service
sudo systemctl list-timers --all 'arabtec-*' --no-pager
```

Only stop timers which exist on this server; a missing unit is not a reason to create a legacy integration. The usual existing units are:

```bash
sudo systemctl stop arabtec-m365-sync.timer arabtec-cv-scan.timer
sudo systemctl stop arabtec-ats
sudo bash "$RELEASE_TOOLS/deploy/on-prem/backup.sh"
```

If backup fails, restart the existing app and previously active timers; do not proceed with checkout/build.

4. Build the tested commit, then restart before verification. Existing environment variables and database/uploads stay in their current paths.

```bash
sudo ATS_REF="$RELEASE_SHA" bash "$RELEASE_TOOLS/deploy/on-prem/04-app.sh"
sudo install -m 0755 -o root -g root /opt/arabtec-ats/deploy/on-prem/backup.sh /opt/arabtec-ats-bin/backup.sh
sudo systemctl restart arabtec-ats
sudo systemctl start arabtec-m365-sync.timer arabtec-cv-scan.timer
sudo bash /opt/arabtec-ats/deploy/on-prem/06-verify.sh
```

If a timer was intentionally inactive before the update, leave it inactive. Do not re-run `05-install-services.sh` as a routine update: it also copies an Apache vhost template and could overwrite your actual hostname/TLS setup.

If Microsoft 365 units were not previously installed, install only those units from this checkout and reload systemd. Enable the timer after confirming the mailbox connection in the ATS. Retire an active legacy `arabtec-cv-mailbox.timer` when switching to delegated sync so two mailbox paths do not run together.

5. Confirm the marker equals the requested commit and verify new served assets. Use the actual local port from the existing environment file; the on-prem template uses 4001.

```bash
cat /opt/arabtec-ats/DEPLOYED_SHA
sudo -u arabtec-ats git -C /opt/arabtec-ats rev-parse HEAD
curl --fail --silent http://127.0.0.1:4001/api/health/ready
curl --fail --silent http://127.0.0.1:4001/email-settings.jsx | sha256sum
sha256sum /opt/arabtec-ats/frontend/public/email-settings.jsx
curl --fail --silent http://127.0.0.1:4001/app.jsx | sha256sum
sha256sum /opt/arabtec-ats/frontend/public/app.jsx
```

The two SHA pairs must match. Open the actual staff URL, reload, check the browser console and verify the updated controls, Talent Pool filters, both pipeline boards, and Email & Mailbox at desktop/tablet/mobile widths. An HTTP 200 or successful build alone does not prove the browser renders the right UI.

## Mail activation checks

In Administration → Microsoft 365, confirm the career mailbox is connected and inspect the last successful sync. In Email & Mailbox, inspect the active provider and use **Verify saved connection**. A dry-run status means no real messages are sent. Do not send a real test email until you choose its recipient intentionally.

The attached Power Automate flow's runtime state was not accessible in this session. Once direct mailbox intake/delivery is verified, review that flow before leaving it enabled alongside the ATS: its own acknowledgement email could duplicate an ATS notification. Do not claim that a flow marked On proves it wrote anything into the ATS.

## Recovery

If the build/restart fails, use `04-app.sh` with the recorded previous SHA, restart `arabtec-ats`, resume only previously active timers, and verify again. This release adds no database table migration. Do not automatically restore a database backup; restoring would discard newer production changes and is a separate operator decision.

## Verification limits

The on-prem SSH probe returned `Network is unreachable`. Cloud Browser refused local preview navigation with `ERR_BLOCKED_BY_CLIENT`; desktop/tablet/mobile screenshots and computed-style comparisons could not be collected. Therefore the high-risk P3 subtractive CSS cleanup is deferred, and visual sign-off must be performed on the staff URL. No production data, live mailbox, or remote service was changed from this session.
