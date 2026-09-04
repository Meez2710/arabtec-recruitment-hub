# Turning on automatic CV scanning

As deployed on `ats@10.20.0.9` right now (`/api/health/watcher` + `/api/health/parsing`):

| Piece | State | Why |
|---|---|---|
| CV reader (Claude) | **off** — `parsing` reports all `none` | `ANTHROPIC_API_KEY` is not set in `/etc/arabtec-ats/ats.env` |
| Folder watcher | **off** — `watcher.running:false` | the `folder_watcher` feature flag is `disabled` (checked once at boot, `server.js`) |
| Mail → folder feed | **none** | the watcher/`inbox-scan` read a **disk folder**; nothing copies mail into it (`/api/ingest/cv` is 404 on this build) |

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

## 3. Feed the folder from the careers mailbox

See **`deploy/on-prem/mailbox/README.md`**. Summary: an Azure AD app registration
(`Mail.Read` application permission, scoped to the careers mailbox with an
application access policy), then a systemd timer runs
`deploy/on-prem/mailbox/cv-mailbox-sync.mjs` every 10 minutes to copy `.pdf/.docx/.doc`
attachments from `careers@arabtecegy.com` into `CV_INBOX` and mark the mail
handled. No npm dependencies.

Once 1–3 are on: a CV emailed to the careers address becomes a candidate within
~10–20 minutes, no recruiter action.

## What I need from you to finish step 3

1. The exact **careers mailbox address**.
2. Whether you can create the **Azure AD app registration** (or who can) —
   I need `tenant ID`, `client ID`, `client secret` set in
   `/etc/arabtec-ats/mailbox.env` (never sent to me).
3. Confirmation the server has **outbound HTTPS to `graph.microsoft.com` and
   `login.microsoftonline.com`**.
4. Whether recruiters want new CVs **auto-linked to a specific open requisition**
   or just landed in the Talent Pool (default).
