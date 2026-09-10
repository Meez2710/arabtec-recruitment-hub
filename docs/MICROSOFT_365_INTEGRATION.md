# Microsoft 365 careers mailbox — delegated OAuth, CV intake only

The ATS reads `career@arabtecegy.com` using a **delegated** Microsoft Graph
grant that one person establishes once, with a device code, from their own
machine. It reads mail. It does not send, mark read, move or delete anything.

```
operator runs m365-connect.mjs on 10.20.0.9
        │
        ▼
"open microsoft.com/devicelogin and enter HXBK7T29"   ← typed on the operator's Mac
        │
        ▼
consent to Mail.Read + offline_access      ← no Mail.Send, no Mail.ReadWrite,
        │                                     no .default, nothing tenant-wide
        ▼
verify tenant → verify account → store MSAL cache ENCRYPTED (AES-256-GCM)
        │                        → read the inbox to PROVE the grant works,
        │                          and delete the connection again if it does not
        ▼
08:00 Africa/Cairo timer ──▶ acquireTokenSilent() ──▶ GET <mailbox>/mailFolders/inbox
        │
        ▼
attachment BYTES ──▶ sha256 ──▶ the EXISTING intake flow ──▶ PENDING candidate_intake
        │
        ▼
Candidate Review ──▶ a person approves ──▶ candidate created
```

**No candidate is created by an email arriving**, and no email is ever sent.

## What this replaced, and why

The previous design (`deploy/on-prem/mailbox/`, now **deprecated**) used
client-credentials app-only auth. It required:

| Old design | Delegated design |
|---|---|
| Tenant-wide **Application** `Mail.Read` + `Mail.ReadWrite` | Delegated `Mail.Read` only, for one signed-in mailbox |
| Global admin consent for the whole directory | One mailbox owner consents for themselves — *if the tenant's consent policy allows it; see §2* |
| Exchange `New-ApplicationAccessPolicy` to scope it back down | Nothing — the token *is* the mailbox |
| PowerShell + a security distribution group | Nothing |
| SMTP username + password for outgoing mail | Out of scope — intake only; `Mail.Send` is not requested (see §6) |
| De-duplication by **mutating the mailbox** (mark read, move to `Processed-ATS`) | De-duplication inside the ATS database (`mailbox_ingestion`, UNIQUE) |
| Dropped files into `CV_INBOX`; the watcher created candidates directly | Direct into the reviewed CV intake queue; **no candidate is created by email** |

The write permission on every mailbox in the tenant existed only to mark
messages read. Moving de-duplication into the ATS removed the need for it.

---

## 1. Before anything: is there already an app registration to reuse?

Do not create a second registration if one already covers this. In the Entra
admin center → **App registrations → All applications**, look for one that has
**all** of:

- **Delegated** `Mail.Read` (not Application `Mail.Read`, which is the
  tenant-wide permission this design exists to avoid), and `offline_access`.
- Supported account types **single tenant**.
- Either a **public client** ("Allow public client flows" = Yes) for the
  device-code flow, or a Web redirect URI you are willing to add one to.

If you find one, you need only its **Directory (tenant) ID** and **Application
(client) ID**. Do not read out or reuse its client secret, and do not add or
remove permissions on a registration that belongs to another system — a shared
app is a shared blast radius. If the only candidate would need its permissions
changed, register a new one instead.

`az ad app list --query "[].{name:displayName,appId:appId}" -o table` lists them
from a shell if you have the Azure CLI and directory read rights.

## 2. Registering one (needs rights to register an application)

Whether you can do this yourself depends on the tenant's
**"Users can register applications"** setting. If it is set to No, an
administrator has to do it and there is no way around that from here.

1. **Entra admin center → App registrations → New registration**
   - Name: `Arabtec ATS — Careers Mailbox Intake`
   - Supported account types: **Accounts in this organizational directory only**
   - Redirect URI: **leave blank.**
2. **Authentication → Advanced settings → Allow public client flows: Yes.**
   This is what enables the device-code flow. It is also why there is no client
   secret to store, rotate or leak on the ATS host.
3. **API permissions → Add a permission → Microsoft Graph → Delegated
   permissions:**
   - `Mail.Read`
   - `offline_access` (so the grant survives without re-prompting)
   - `openid`, `profile` are OIDC sign-in scopes and are usually already there.
   - **Do NOT add** `Mail.Send`, `Mail.ReadWrite`, `.default`, any *Application*
     permission, or any directory permission. The ATS asks for none of them and
     `authScopes()` in `backend/src/lib/microsoft/config.js` is the single place
     that decides, so the consent screen and the code cannot drift apart.
4. From **Overview**, note the **Directory (tenant) ID** and **Application
   (client) ID**.

### Will admin consent be required?

**This depends on your tenant and cannot be assumed either way.** The tenant's
user-consent policy decides whether a non-admin may consent to `Mail.Read` for
themselves. Microsoft's default for a new tenant permits it for permissions
classified low-impact, but a great many tenants are set to
*"Do not allow user consent"*.

Find out by running the sign-in in §4 and reading what Microsoft says:

| What the sign-in page says | Meaning |
|---|---|
| A consent prompt listing "Read your mail" | User consent is allowed. Accept it; done. |
| `AADSTS65004` / "Need admin approval" | An administrator must grant consent for this app. |
| `AADSTS7000218` / invalid client credential | The app is not registered as a public client — set "Allow public client flows" to Yes. |
| `AADSTS50059` / tenant not found | Wrong `MS_TENANT_ID`. |
| `AADSTS50105` / not assigned to a role | The app has user assignment required; assign the account. |

If it needs admin approval, ask an administrator to press **Grant admin
consent** on this one registration. Do **not** change the tenant's consent
policy to work around it.

## 3. Is `career@arabtecegy.com` a user mailbox or a shared mailbox?

This decides which scope you request and how the sign-in is done, so establish
it before registering anything.

| | User mailbox (`MS_MAILBOX_ACCESS=own`) | Shared mailbox (`MS_MAILBOX_ACCESS=shared`) |
|---|---|---|
| Sign-in | The mailbox signs in as itself | A delegate signs in as **themselves** |
| Licensed | Yes | No — sign-in is normally blocked |
| Scope | `Mail.Read` | `Mail.Read.Shared` |
| Graph path | `/me/...` | `/users/career@arabtecegy.com/...` |

How to tell:

```powershell
# Exchange Online PowerShell — the authoritative answer
Get-Mailbox career@arabtecegy.com | Select RecipientTypeDetails
#   UserMailbox    -> own
#   SharedMailbox  -> shared
```

Without Exchange admin rights, the practical test is the sign-in itself: a
classic shared mailbox has **sign-in blocked** and cannot complete §4 at all. If
§4 fails with "your account is disabled" or similar, it is shared — set
`MS_MAILBOX_ACCESS=shared` and sign in as a person who already has delegate
access. Do **not** enable direct sign-in on a shared mailbox to avoid this; that
is a change to how the mailbox is secured, not a deployment detail.

> **Observed, not proven:** the Claude Outlook connector is currently signed in
> *as* `career@arabtecegy.com` and reads its inbox through `/me`, which a
> classic shared mailbox cannot do. That is strong evidence for **user mailbox**,
> but it is not the Exchange attribute — run the cmdlet above if you need
> certainty.

### What the scope actually grants

Be precise about this, because "single tenant" is often misread as "one
mailbox". It is not:

- **Single tenant** restricts *which directory's users may sign in*. It says
  nothing about how many mailboxes the resulting token can reach.
- Delegated **`Mail.Read`** grants "mail in the signed-in user's mailbox" — so
  signing in *as* the careers mailbox genuinely confines it to that one mailbox.
- Delegated **`Mail.Read.Shared`** additionally grants "and any mailbox that user
  has been given access to". It is *wider than one mailbox by construction*.

Where `Mail.Read.Shared` is used, the confinement is enforced by **this
application**: `mailboxRoot()` builds every Graph path from `MS_MAILBOX` and
from nothing else — never from a value that arrived at runtime — so the ATS
reads exactly one mailbox regardless of what else the token could open.

## 4. Configure and connect

In `/etc/arabtec-ats/ats.env` (chmod 600, root-owned):

```bash
MS_TENANT_ID=<Directory (tenant) ID>
MS_CLIENT_ID=<Application (client) ID>
MS_MAILBOX=career@arabtecegy.com
MS_AUTH_MODE=device-code
MS_MAILBOX_ACCESS=own              # or: shared
MS_ENABLE_SEND=false
MICROSOFT_TOKEN_ENCRYPTION_KEY=<openssl rand -hex 32>
```

`MICROSOFT_TOKEN_ENCRYPTION_KEY` encrypts the MSAL token cache at rest
(AES-256-GCM). Rotating it invalidates the stored connection — reconnect after a
rotation. Never commit it. **Do not set `MS_CLIENT_SECRET`**: a public client
must not have one, and Entra rejects a token request that carries it.

Outbound HTTPS is needed to `login.microsoftonline.com` and
`graph.microsoft.com`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' 'https://graph.microsoft.com/v1.0/$metadata'
```

Then restart and check what the app thinks it has:

```bash
sudo systemctl restart arabtec-ats
sudo -u ats bash -c 'set -a; . /etc/arabtec-ats/ats.env; set +a; \
  ATS_APP_ROOT=/opt/arabtec-ats /opt/node22/bin/node \
  /opt/arabtec-ats/deploy/on-prem/m365-connect.mjs --check'
```

### The sign-in

```bash
sudo -u ats bash -c 'set -a; . /etc/arabtec-ats/ats.env; set +a; \
  ATS_APP_ROOT=/opt/arabtec-ats /opt/node22/bin/node \
  /opt/arabtec-ats/deploy/on-prem/m365-connect.mjs'
```

It prints a URL and a short code. On **your own machine**, open
<https://microsoft.com/devicelogin>, enter the code, and sign in as
`career@arabtecegy.com` (or, in `shared` mode, as the delegate). The mailbox
password is typed **at Microsoft** — never into the ATS, never stored, never
seen by the server.

The tool then, in order: verifies the tenant, verifies the account is entitled
to `MS_MAILBOX`, stores the encrypted token cache, and **reads the inbox to
prove the grant actually works**. If that read fails the connection is deleted
again, so a grant that cannot reach the mailbox is never left behind looking
healthy. Nothing is printed but the outcome — no token, no code, no secret.

Signing in as an account that is not entitled to the mailbox is refused and its
tokens are never written: the exchange runs against an in-memory staging cache
and is persisted only after the account has been verified.

**Why a device code and not a browser redirect.** Entra accepts only `https://`
for a Web redirect URI, with `http://localhost` as the documented exception. On
`10.20.0.9:4001` — no DNS name, no certificate, no inbound access — the redirect
flow would force a TLS vhost to be built first for no other reason. (Earlier
revisions of this document said the TLS vhost was a hard prerequisite. It is
not: `http://localhost:4001/api/integrations/microsoft/callback` reached over an
SSH tunnel is also accepted. The device-code flow avoids the question entirely.)

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

**Off by default, and the scope request follows it.** With `MS_ENABLE_SEND`
unset or false the ATS never asks Microsoft for `Mail.Send`, `sendMailAs()`
refuses before it resolves a recipient, and `MAIL_PROVIDER=auto` will not select
Graph — so a read-only grant cannot produce a 403 on every notification, and
cannot fall through to SMTP and deliver the same mail twice. SMTP is then the
only outgoing path.

To send recruitment mail as the careers mailbox: add delegated `Mail.Send` to
the app registration, set `MS_ENABLE_SEND=true`, and **reconnect** (the stored
grant does not carry a scope nobody consented to). `MAIL_PROVIDER=auto` then
prefers Graph whenever the connection is healthy; pin `graph` to forbid the SMTP
fallback outright, or `smtp` to ignore Microsoft. `SMTP_TRANSPORT=json` (the
dry-run transport) wins over both and is pinned for the whole automated test
suite.

Sending *as a shared mailbox* is refused outright regardless: it needs
`Mail.Send.Shared` plus a Send As grant in Exchange, and `POST /me/sendMail`
would otherwise quietly send from the delegate's own address instead.

## 7. Failure states and what each one means

| Badge / code | Meaning | Action |
|---|---|---|
| Not configured | Environment variables missing | Set them in `ats.env`, restart. Run `m365-connect.mjs --check` — it names them |
| `AADSTS65004` at sign-in | The tenant requires admin consent for this app | An administrator grants consent on **this registration**. Do not change tenant policy |
| `AADSTS7000218` at sign-in | The app is not registered as a public client | Authentication → Allow public client flows → **Yes** |
| Disconnected | Nobody has signed in yet, or an admin disconnected | Connect Microsoft 365 |
| `wrong-account` | Someone signed in who is not entitled to this mailbox | Sign in as `career@arabtecegy.com` — or as a delegate, with `MS_MAILBOX_ACCESS=shared` |
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

On 10.20.0.9 the service account is `ats` and Node lives at
`/opt/node22/bin/node` (v22 — `/usr/bin/node` is v24, outside the range
`backend/package.json` declares):

```bash
# what the app thinks it is configured for — names only, never values
sudo -u ats bash -c 'set -a; . /etc/arabtec-ats/ats.env; set +a; \
  ATS_APP_ROOT=/opt/arabtec-ats /opt/node22/bin/node \
  /opt/arabtec-ats/deploy/on-prem/m365-connect.mjs --check'

# prove the stored grant still reaches the mailbox — reads nothing, imports nothing
sudo -u ats bash -c 'set -a; . /etc/arabtec-ats/ats.env; set +a; \
  ATS_APP_ROOT=/opt/arabtec-ats /opt/node22/bin/node \
  /opt/arabtec-ats/deploy/on-prem/m365-connect.mjs --probe'

# connection state and the last scan's counts
sudo -u ats bash -c 'set -a; . /etc/arabtec-ats/ats.env; set +a; \
  ATS_APP_ROOT=/opt/arabtec-ats /opt/node22/bin/node \
  /opt/arabtec-ats/deploy/on-prem/m365-sync.mjs --status'

# one scan, now
sudo systemctl start arabtec-m365-sync.service
journalctl -u arabtec-m365-sync -n 50 --no-pager
systemctl list-timers arabtec-m365-sync.timer
```

Or from the ATS: **Configuration → Microsoft 365 → Test connection / Scan inbox
now**, then check **Candidate Review** for the new pending intakes.
