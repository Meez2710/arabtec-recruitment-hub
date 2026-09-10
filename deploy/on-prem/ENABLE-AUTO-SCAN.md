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
sudo -u ats cp /path/to/a-real-cv.pdf /var/lib/arabtec-ats/cv_inbox/   # the service account is `ats` on 10.20.0.9
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
procedure, including how to tell whether `career@arabtecegy.com` is a user or a
shared mailbox. In short:

1. An Entra app registration, **single tenant**, **public client**
   ("Allow public client flows" = Yes), with **delegated `Mail.Read` +
   `offline_access`** and nothing else. No client secret, no redirect URI, no
   Application permission, no Exchange application access policy, no PowerShell.
   Whether a non-admin may consent depends on the tenant's user-consent policy —
   run the sign-in and read what Microsoft says rather than assuming.
2. `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_MAILBOX`, `MS_AUTH_MODE=device-code`,
   `MS_MAILBOX_ACCESS=own`, `MS_ENABLE_SEND=false` and
   `MICROSOFT_TOKEN_ENCRYPTION_KEY` in `/etc/arabtec-ats/ats.env`, then
   `sudo systemctl restart arabtec-ats`.
3. Run the sign-in once and finish it in a browser on your own machine:
   ```bash
   sudo -u ats bash -c 'set -a; . /etc/arabtec-ats/ats.env; set +a; \
     ATS_APP_ROOT=/opt/arabtec-ats /opt/node22/bin/node \
     /opt/arabtec-ats/deploy/on-prem/m365-connect.mjs'
   ```
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

1. Either an **existing app registration** suitable for reuse (its tenant ID and
   client ID — never its secret), or confirmation that a new single-tenant
   public client may be registered. See §1–§2 of
   `docs/MICROSOFT_365_INTEGRATION.md`. **Do not send any secret to me.**
2. Whether `career@arabtecegy.com` is a **user mailbox or a shared mailbox**
   (`Get-Mailbox career@arabtecegy.com | Select RecipientTypeDetails`). It
   decides `MS_MAILBOX_ACCESS` and which scope is requested.
3. `ANTHROPIC_API_KEY` in `/etc/arabtec-ats/ats.env`. Until it is set,
   `/api/health/parsing` reports every stage as `none` and downloaded CVs park
   as retryable instead of reaching Candidate Review.
4. Confirmation the server has outbound HTTPS to `graph.microsoft.com` and
   `login.microsoftonline.com`. *(Verified 10 Sep 2026: both return 200, and
   `api.anthropic.com` returns 401 — reachable, no key.)*
5. Whether the HR CV folder share (`arabtec-cv-scan.timer`) is still in use, or
   whether the mailbox is now the only intake source.
6. Where the existing **Power Automate** flow puts attachments today, so the
   cutover can be sequenced without double-processing.

**No longer needed.** Earlier revisions asked for the ATS public HTTPS hostname
and a finished Apache TLS vhost before the mailbox could be connected. The
device-code flow needs neither — nothing listens for a callback.
