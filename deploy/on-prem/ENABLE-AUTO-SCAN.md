# Turning on automatic CV scanning

As deployed on `ats@10.20.0.9` right now (`/api/health/watcher` + `/api/health/parsing`):

| Piece | State | Why |
|---|---|---|
| CV reader (Claude) | **off** — `parsing` reports all `none` | `ANTHROPIC_API_KEY` is not set in `/etc/arabtec-ats/ats.env` |
| Folder watcher | **off** — `watcher.running:false` | the `folder_watcher` feature flag is `disabled` (checked once at boot, `server.js`) |
| Mailbox feed | **none** | replaced by the delegated Microsoft 365 integration — see step 3; it bypasses the folder entirely |

All three must be on. Do them in this order.

## 1. Wire the CV reader

```bash
sudo -e /etc/arabtec-ats/ats.env
#   ANTHROPIC_API_KEY=sk-ant-...           (required)
#   ANTHROPIC_MODEL=claude-haiku-4-5-20251001   (optional; cheaper/faster for bulk)
#   CV_WATCH_INTERVAL_MIN=10               (poll every 10 min; default is 60)
sudo systemctl restart arabtec-ats
curl -s http://127.0.0.1:4001/api/health/parsing        # expect a documentParser / extractor, not "none"
```

## 2. Turn on the folder watcher

Sign in as the System Admin → **Settings → Feature Flags** → enable
**`folder_watcher`** (and **`ai_parsing`**). The flag lives in the DB; the app
only reads it at startup, so:

```bash
sudo systemctl restart arabtec-ats
curl -s http://127.0.0.1:4001/api/health/watcher        # expect "running":true
```

Test the folder path end to end:
```bash
sudo -u arabtec-ats cp /path/to/a-real-cv.pdf /var/lib/arabtec-ats/cv_inbox/
# within CV_WATCH_INTERVAL_MIN:
curl -s http://127.0.0.1:4001/api/health/watcher        # scanCount increments, lastScanResult shows imported/skipped
journalctl -u arabtec-ats -n 40 --no-pager | grep watcher
```

A file that imports is **moved out of the folder** into a candidate record; a
file that can't be read is left and reported as skipped with a reason.

### Alternative to the in-process watcher: the 08:00 timer

`deploy/on-prem/` also ships `arabtec-cv-scan.timer` → `POST /api/candidates/inbox-scan`
at 08:00 Africa/Cairo. It needs a dedicated `candidate.add`-only account in
`/etc/arabtec-ats/scan.env`. Use **one** trigger, not both — if you enable the
timer, set `CV_WATCH_INTERVAL_MIN=0` so the folder isn't scanned twice.

Both of these concern the **HR CV folder share** only. The careers mailbox has
its own single trigger (`arabtec-m365-sync.timer`) and no longer writes into
`CV_INBOX`, so the two sources cannot double-import the same CV.

## 3. Connect the careers mailbox

This step no longer touches the folder at all. The mailbox is read directly by
the ATS over **delegated** Microsoft Graph and files CVs straight into the
review queue — see **`docs/MICROSOFT_365_INTEGRATION.md`** for the full
procedure. In short:

1. An Entra app registration with **delegated** `Mail.Read` + `Mail.Send` and a
   Web redirect URI of `https://<ATS-PUBLIC-HOST>/api/integrations/microsoft/callback`.
   No Application permissions, no admin consent across the directory, no
   Exchange application access policy, no PowerShell.
2. `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_MAILBOX`,
   `MS_REDIRECT_URI` and `MICROSOFT_TOKEN_ENCRYPTION_KEY` in
   `/etc/arabtec-ats/ats.env`, then `sudo systemctl restart arabtec-ats`.
3. A System Admin signs in **once** at Configuration → Microsoft 365 →
   **Connect Microsoft 365**, as `career@arabtecegy.com`.
4. `sudo systemctl enable --now arabtec-m365-sync.timer` — 08:00 Africa/Cairo,
   daily, the one authoritative mailbox trigger.

```bash
sudo systemctl disable --now arabtec-cv-mailbox.timer   # retire the old app-only bridge
systemctl list-timers arabtec-m365-sync.timer
```

**What changes for recruiters:** a CV emailed to the careers address appears in
**Candidate Review** as a pending intake at the next 08:00 run (or immediately
via "Scan inbox now"). A candidate is created when a person approves it — an
email arriving is no longer enough on its own. That is deliberate: the old
folder-drop path created candidates from whatever the parser returned, with no
review.

## What I still need from you

1. The **ATS public HTTPS hostname**. The Apache vhost still says
   `ServerName ats.arabtec.local  # REPLACE` and `ats.env` still says
   `CORS_ORIGINS=https://REPLACE_ME`. Microsoft will not accept a redirect URI
   on plain `http://10.20.0.9:4001`, so the TLS vhost has to be finished first.
2. Whether you can create the **Entra app registration** (or who can) — I need
   `tenant ID`, `client ID` and a `client secret` placed in
   `/etc/arabtec-ats/ats.env` on the server. **Do not send any of them to me.**
3. Confirmation the server has **outbound HTTPS to `graph.microsoft.com` and
   `login.microsoftonline.com`**.
4. Whether the HR CV folder share (`arabtec-cv-scan.timer`) is still in use, or
   whether the mailbox is now the only intake source.
