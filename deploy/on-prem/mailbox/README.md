# Careers mailbox → CV inbox bridge

The ATS folder watcher and the 08:00 `inbox-scan` both read a **filesystem
folder** (`CV_INBOX`). Neither speaks IMAP or Graph. This bridge is the piece
that puts mail attachments into that folder.

```
careers@arabtecegy.com  ──Graph──▶  cv-mailbox-sync.mjs  ──▶  /var/lib/arabtec-ats/cv_inbox
                                    (systemd timer, 10 min)          │
                                                                    ▼
                                              ATS folder watcher / inbox-scan  ──▶  candidates
```

Microsoft 365, via Microsoft Graph, application (client-credentials) auth. No npm
dependencies — plain `fetch` on the Node the app already runs.

## 1. Azure AD app registration (one-time, needs a Global/Cloud-App admin)

1. **Entra admin center → App registrations → New registration.**
   Name e.g. `Arabtec ATS — Careers Mailbox`. Single tenant. No redirect URI.
2. **API permissions → Add → Microsoft Graph → Application permissions:**
   - `Mail.Read`
   - `Mail.ReadWrite` (only needed for "mark read" / "move to Processed-ATS";
     drop it and set `MB_MARK_READ=false` + blank `MB_PROCESSED_FOLDER` if you
     want read-only — but then de-dup relies on the folder filename check only).
   Then **Grant admin consent**.
3. **Certificates & secrets → New client secret.** Copy the **Value** now.
4. Note **Directory (tenant) ID** and **Application (client) ID** from Overview.
5. **Scope it to just the careers mailbox** (recommended — otherwise the app can
   read every mailbox in the tenant). In Exchange Online PowerShell:
   ```powershell
   New-DistributionGroup -Name "ATS-Mailbox-Scope" -Type Security `
     -Members careers@arabtecegy.com
   New-ApplicationAccessPolicy -AppId <CLIENT_ID> `
     -PolicyScopeGroupId ATS-Mailbox-Scope@arabtecegy.com `
     -AccessRight RestrictAccess `
     -Description "Arabtec ATS may read only the careers mailbox"
   Test-ApplicationAccessPolicy -Identity careers@arabtecegy.com -AppId <CLIENT_ID>
   ```

## 2. Network

The server needs outbound HTTPS to `login.microsoftonline.com` and
`graph.microsoft.com`. Check:
```bash
curl -s -o /dev/null -w '%{http_code}\n' https://graph.microsoft.com/v1.0/$metadata
```

## 3. Install on ats@10.20.0.9

```bash
# the script ships in the repo checkout at /opt/arabtec-ats/deploy/on-prem/mailbox/
sudo install -m 600 -o arabtec-ats -g arabtec-ats \
  /opt/arabtec-ats/deploy/on-prem/mailbox/mailbox.env.template /etc/arabtec-ats/mailbox.env
sudo -e /etc/arabtec-ats/mailbox.env            # fill in tenant/client/secret/mailbox

sudo install -m 644 /opt/arabtec-ats/deploy/on-prem/mailbox/arabtec-cv-mailbox.service /etc/systemd/system/
sudo install -m 644 /opt/arabtec-ats/deploy/on-prem/mailbox/arabtec-cv-mailbox.timer   /etc/systemd/system/
sudo systemctl daemon-reload
```

Dry run first (lists what it would fetch, downloads nothing, marks nothing):
```bash
sudo -u arabtec-ats bash -c 'set -a; . /etc/arabtec-ats/mailbox.env; set +a; node /opt/arabtec-ats/deploy/on-prem/mailbox/cv-mailbox-sync.mjs --dry-run'
```

Then enable the timer:
```bash
sudo systemctl enable --now arabtec-cv-mailbox.timer
systemctl list-timers arabtec-cv-mailbox.timer
journalctl -u arabtec-cv-mailbox.service -n 50 --no-pager
```

## 4. How de-duplication works

A message is handled once: after its attachments are saved it is marked read
(and moved to `Processed-ATS` if configured), and the query only ever looks at
**unread** mail with attachments. If a save is interrupted, the filename+size
check skips files already in `CV_INBOX` on the next pass. The ATS itself also
de-dupes candidates by email on import.

## 5. Optional — import within minutes

By default the folder watcher polls every `CV_WATCH_INTERVAL_MIN` (60). To import
right after a sync, set `MB_TRIGGER_SCAN_URL` + a dedicated scanner account
(`candidate.add` only) in `mailbox.env`; the bridge then calls
`POST /api/candidates/inbox-scan` when it saved something.

## Not M365 / can't do the app registration?

Tell me and I'll add an IMAP variant (`outlook.office365.com:993`, OAuth2 or an
app password) — it needs the `imapflow` npm package added to `backend/`.
