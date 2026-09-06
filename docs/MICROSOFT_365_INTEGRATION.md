# Microsoft 365 careers mailbox — delegated OAuth

The ATS reads `career@arabtecegy.com` and sends recruitment email as it, using a
**delegated** Microsoft Graph grant that one System Admin establishes once by
signing in through a browser.

```
Admin clicks "Connect Microsoft 365"
        │
        ▼
Microsoft sign-in  ──(as career@arabtecegy.com)──▶  consent to 5 delegated scopes
        │
        ▼
/api/integrations/microsoft/callback   verifies tenant + account, stores the
        │                              MSAL token cache ENCRYPTED (AES-256-GCM)
        ▼
08:00 Africa/Cairo timer ──▶ acquireTokenSilent() ──▶ GET /me/mailFolders/inbox
        │
        ▼
CV attachments ──▶ the EXISTING intake flow ──▶ PENDING candidate_intake
        │
        ▼
Candidate Review ──▶ a person approves ──▶ candidate created
```

## What this replaced, and why

The previous design (`deploy/on-prem/mailbox/`, now **deprecated**) used
client-credentials app-only auth. It required:

| Old design | Delegated design |
|---|---|
| Tenant-wide **Application** `Mail.Read` + `Mail.ReadWrite` | Delegated `Mail.Read` + `Mail.Send` for one signed-in mailbox |
| Global admin consent for the whole directory | One mailbox owner consents for their own mailbox |
| Exchange `New-ApplicationAccessPolicy` to scope it back down | Nothing — the token *is* the mailbox |
| PowerShell + a security distribution group | Nothing |
| SMTP username + password for outgoing mail | Same delegated grant, `POST /me/sendMail` |
| De-duplication by **mutating the mailbox** (mark read, move to `Processed-ATS`) | De-duplication inside the ATS database (`mailbox_ingestion`, UNIQUE) |
| Dropped files into `CV_INBOX`; the watcher created candidates directly | Direct into the reviewed CV intake queue; **no candidate is created by email** |

The write permission on every mailbox in the tenant existed only to mark
messages read. Moving de-duplication into the ATS removed the need for it.

---

## 1. Entra app registration (one-time, needs a Cloud Application Administrator)

1. **Entra admin center → App registrations → New registration**
   - Name: `Arabtec ATS — Careers Mailbox`
   - Supported account types: **Accounts in this organizational directory only**
   - Redirect URI: platform **Web**, value
     `https://<ATS-PUBLIC-HOST>/api/integrations/microsoft/callback`
     (see §2 — Entra rejects a non-HTTPS redirect URI for anything but `localhost`)
2. **API permissions → Add a permission → Microsoft Graph → Delegated permissions**
   - `Mail.Read`
   - `Mail.Send`
   - `offline_access`, `openid`, `profile` are the standard OIDC scopes and are
     usually already present; add them if not.
   - **Do NOT add** any *Application* permission, `Mail.ReadWrite`, `.default`,
     or any directory permission.
   - "Grant admin consent" is optional. Without it, the mailbox owner consents
     for themselves at first sign-in, which is all this integration needs.
3. **Certificates & secrets → New client secret.** Copy the **Value** immediately
   (not the Secret ID) — it is shown once.
4. From **Overview**, note the **Directory (tenant) ID** and **Application
   (client) ID**.

Nothing else. No Exchange PowerShell, no application access policy, no
distribution group, no SMTP AUTH.

## 2. The redirect URI

It must be the ATS's own public HTTPS URL plus
`/api/integrations/microsoft/callback`, and it must match the app registration
character for character.

The on-prem deployment does **not** pin a hostname today — `ats.env.template`
carries `CORS_ORIGINS=https://REPLACE_ME` and the Apache vhost carries
`ServerName ats.arabtec.local  # REPLACE with the real hostname`. So the value
is whatever hostname is put in those two places, e.g.:

```
https://ats.arabtec.local/api/integrations/microsoft/callback
```

`http://10.20.0.9:4001/...` will **not** work: Entra accepts only `https://` for
a Web redirect URI (the sole exception is `http://localhost`). The Apache TLS
vhost has to be finished with a real hostname and certificate before the connect
flow can complete.

Leave `MS_REDIRECT_URI` unset and it is derived from the first `CORS_ORIGINS`
entry, which the deployment already sets to "the exact URL staff type".

## 3. Server configuration

In `/etc/arabtec-ats/ats.env` (chmod 600):

```bash
MS_TENANT_ID=<Directory (tenant) ID>
MS_CLIENT_ID=<Application (client) ID>
MS_CLIENT_SECRET=<the secret VALUE>
MS_MAILBOX=career@arabtecegy.com
MS_REDIRECT_URI=https://<ATS-PUBLIC-HOST>/api/integrations/microsoft/callback
MICROSOFT_TOKEN_ENCRYPTION_KEY=<openssl rand -hex 32>
```

`MICROSOFT_TOKEN_ENCRYPTION_KEY` encrypts the MSAL token cache at rest
(AES-256-GCM). The app **refuses to start** if the Microsoft variables are set
without it. Rotating it invalidates the stored connection — reconnect after a
rotation. Never commit it.

Outbound HTTPS is needed to `login.microsoftonline.com` and
`graph.microsoft.com`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://graph.microsoft.com/v1.0/$metadata
```

Then restart:

```bash
sudo systemctl restart arabtec-ats
```

## 4. Connect (the only interactive step)

1. Sign into the ATS as a System Admin.
2. **Configuration → Microsoft 365 → Connect Microsoft 365.**
3. Microsoft's sign-in page opens. Sign in as **career@arabtecegy.com** and
   accept the permissions.
4. The browser returns to the ATS with the status badge on **Connected**.

Signing in as any other account is refused with a clear error, and that
account's tokens are never written to the database — the code exchange runs
against an in-memory staging cache and the blob is persisted only after the
account is verified.

Enter the mailbox password **at Microsoft**. It is never typed into the ATS,
never stored, and never seen by the server.

## 5. Scheduled scanning

`arabtec-m365-sync.timer` runs `deploy/on-prem/m365-sync.mjs` at **08:00
Africa/Cairo**, daily. That is the **one** scheduled mailbox trigger:

```bash
sudo systemctl enable --now arabtec-m365-sync.timer
systemctl list-timers arabtec-m365-sync.timer
journalctl -u arabtec-m365-sync.service -n 50 --no-pager
```

The script loads the app's own modules and runs the same function the admin's
"Scan inbox now" button runs — no ATS login and no service-account password on
disk.

What a scan does:

- Reads **Inbox only**, messages received since the last successful scan minus a
  small overlap window, never earlier than the connection's baseline.
- Accepts `.pdf`, `.docx`, `.doc` file attachments up to the app's 20 MB cap.
- Ignores inline attachments, item attachments and every other file type.
- Downloads each accepted attachment, parses it with the same reader the upload
  route uses, and files a **PENDING `candidate_intake`**.
- Records every attachment it saw in `mailbox_ingestion`, keyed by a UNIQUE
  `dedup_key` over (mailbox, message, attachment).
- Marks nothing read, moves nothing, deletes nothing.

**No candidate is created by an email arriving.** Mailbox CVs land in
**Candidate Review** beside uploaded ones and a person approves them.

### First connection does not import the historic mailbox

`microsoft_connection.baseline_at` is stamped when the admin connects, and no
scan ever reads earlier than it. A mailbox with years of applications does not
become years of review queue.

### Other triggers

| Trigger | Source | Status |
|---|---|---|
| `arabtec-m365-sync.timer` | careers mailbox (delegated Graph) | **the authoritative one** |
| `arabtec-cv-mailbox.timer` | careers mailbox (app-only Graph → `CV_INBOX`) | **deprecated — disable it** |
| `arabtec-cv-scan.timer` | the HR CV folder share | unchanged, a different source |
| `CV_WATCH_INTERVAL_MIN` in-process watcher | the same disk folder | keep at `0` on-prem |

The delegated connector no longer writes into `CV_INBOX`, so the mailbox and the
folder can never double-import the same CV.

## 6. Outgoing email

With Microsoft 365 connected, `MAIL_PROVIDER=auto` (the default) sends every
notification through Graph `POST /me/sendMail` as the careers mailbox. SMTP
stays available as a fallback only when `SMTP_USER`/`SMTP_PASS` are set; pin
`MAIL_PROVIDER=graph` to forbid the fallback outright, or `smtp` to ignore
Microsoft. `SMTP_TRANSPORT=json` (the dry-run transport) wins over both and is
pinned for the whole automated test suite.

## 7. Failure states and what each one means

| Badge / code | Meaning | Action |
|---|---|---|
| Not configured | Environment variables missing | Set them in `ats.env`, restart |
| Disconnected | Nobody has signed in yet, or an admin disconnected | Connect Microsoft 365 |
| `wrong-account` | Someone signed in as a different mailbox | Sign in as `career@arabtecegy.com` |
| `wrong-tenant` | The account is in another Microsoft tenant | Use the Arabtec account |
| `consent-denied` | Consent was refused at the Microsoft screen | Connect again and accept |
| **Reconnect required** | The refresh grant lapsed (password change, revoked consent, MFA policy) | A System Admin clicks **Reconnect**. Message: *Microsoft 365 connection requires sign-in again.* |
| `graph-throttled` | Graph returned 429 | Nothing — `Retry-After` is honoured and the next scan retries |
| `graph-unavailable` | Graph or the network is down | Check outbound HTTPS |
| Error | Something else; `lastError` shows a safe summary | See `journalctl -u arabtec-ats` |

One bad attachment is recorded as `FAILED` in `mailbox_ingestion` and the rest of
the batch continues. An interaction-required condition never crashes the app;
the scan exits and the admin panel says what to do.

## 8. Security properties

- **Client secret** is backend-only. No API returns it; the admin panel is told
  only which variable **names** are unset.
- **Token cache** is AES-256-GCM encrypted at rest, keyed from the environment.
  A database dump yields ciphertext.
- **No tokens are logged**, ever — not on success, not on failure.
- **OAuth state** is 32 random bytes, stored hashed, single-use, 10-minute TTL,
  bound to the initiating admin's user id and session.
- **RBAC**: every route requires `system.manage` (System Admin).
- **Audit**: `microsoft.connect_started`, `microsoft.connected`,
  `microsoft.connect_rejected`, `microsoft.test`, `microsoft.sync`,
  `microsoft.disconnected` are all written to the audit log.
- **Disconnect** removes the token material and nothing else — the ingestion
  ledger survives, so reconnecting does not re-import reviewed mail.

## 9. Verifying

```bash
# connection state, no scan
sudo -u arabtec-ats bash -c 'set -a; . /etc/arabtec-ats/ats.env; set +a; \
  node /opt/arabtec-ats/deploy/on-prem/m365-sync.mjs --status'

# one scan, now
sudo systemctl start arabtec-m365-sync.service
journalctl -u arabtec-m365-sync.service -n 50 --no-pager
```

Or from the ATS: **Configuration → Microsoft 365 → Test connection / Scan inbox
now**, then check **Candidate Review** for the new pending intakes.
