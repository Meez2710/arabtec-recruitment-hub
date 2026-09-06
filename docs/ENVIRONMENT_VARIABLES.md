# Environment Variables

All configuration is via environment variables — **never commit real values**.
Template: `backend/.env.example`. In production set values in the host's secret
store (Render dashboard `sync:false`, or Coolify env/secrets). Values shown here
are DEFAULTS or FORMATS only, never real secrets.

The app validates this at boot (`src/lib/config.js`): in production a missing
**Required** variable stops startup; missing **Optional** ones log a warning and
the related feature stays off.

## Core (required in production)

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `DATABASE_URL` | ✅ prod | `file:./dev.db` (dev) | `postgres://…` in prod; `file:` = SQLite (dev only). |
| `JWT_SECRET` | ✅ prod | — | Token signing. App refuses to start in prod without it. 32+ random chars. |
| `NODE_ENV` | ✅ prod | `development` | `production` enables HSTS + fail-fast config validation. |
| `PORT` | — | `4000` | HTTP listen port. |
| `CORS_ORIGINS` | ⚠️ | dev localhosts | Comma-list of allowed browser origins. **Update to the custom domain at go-live.** |
| `TRUST_PROXY` | recommended | `1` (prod) / off (dev) | Proxy hops to trust for `req.ip` (anti-spoofing). Render/Coolify/Nginx = `1`. |

## Auth / limits (optional, have defaults)

| Variable | Default | Purpose |
|----------|---------|---------|
| `JWT_EXPIRES_IN` | `2h` | Access token lifetime. |
| `JWT_REMEMBER_EXPIRES_IN` | `7d` | "Remember me" lifetime. |
| `BCRYPT_ROUNDS` | `10` | Password hash cost. |
| `LOGIN_LOCK_THRESHOLD` | `5` | Failed logins before lockout. |
| `LOGIN_LOCK_MINUTES` | `15` | Lockout duration. |
| `RATE_LIMIT_MAX` | `300` | Global requests per window per IP. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window (ms). |

## Security headers (optional)

| Variable | Default | Purpose |
|----------|---------|---------|
| `HSTS_MAX_AGE` | `15552000` | HSTS max-age (s), applied only in production. |
| `CSP_REPORT_ONLY` | unset | `true` = observe CSP violations without blocking (safe rollout). |
| `SECURITY_HEADERS_DISABLED` | unset | Debug escape hatch — never in production. |

## Database tuning (optional)

| Variable | Purpose |
|----------|---------|
| `PG_ENGINE` | `pglite` for in-process Postgres verification only. |
| `PG_DATA` | PGlite persistence directory. |
| `PG_NO_SSL` | `true` disables TLS to Postgres (same-box/self-hosted only). |

## Microsoft 365 careers mailbox — delegated OAuth (optional; leave blank = OFF)

Set these together, or none of them. Setting any of the first three without
`MICROSOFT_TOKEN_ENCRYPTION_KEY` is a **startup error** — half-configured is the
one state that looks wired in the admin panel and then fails at the first token
write.

A System Admin connects the mailbox ONCE from **Configuration → Microsoft 365**;
MSAL keeps it alive with silent refresh, so there is no daily interactive login.

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `MS_TENANT_ID` | with the group | — | Directory (tenant) ID of the Arabtec M365 tenant. |
| `MS_CLIENT_ID` | with the group | — | Application (client) ID of the Entra app registration. |
| `MS_CLIENT_SECRET` | with the group | — | Client secret **value**. Backend only; never returned by any API. |
| `MS_MAILBOX` | — | `career@arabtecegy.com` | The ONLY account allowed to connect. Any other sign-in is refused. |
| `MS_REDIRECT_URI` | with the group | derived from `CORS_ORIGINS` | `https://<ATS public host>/api/integrations/microsoft/callback`. Must match a **Web** redirect URI on the app registration exactly. Entra accepts only `https://` (or `http://localhost`). |
| `MICROSOFT_TOKEN_ENCRYPTION_KEY` | ✅ when enabled | — | AES-256-GCM key for the MSAL token cache at rest. 32 bytes: `openssl rand -hex 32`. **Never commit.** Changing it invalidates the stored connection — reconnect after a rotation. |
| `MS_SYNC_OVERLAP_MIN` | — | `10` | Minutes a scan reaches back past the last success, to cover clock skew. Duplicates are impossible regardless (`mailbox_ingestion.dedup_key` is UNIQUE). |
| `MS_SYNC_BATCH` | — | `50` | Messages examined per pass (max 200). |
| `MS_AUTHORITY_METADATA` | — | — | Pre-fetched Entra OIDC discovery document (JSON). Optional: saves a discovery round trip on a slow-egress host. Used by the tests. |
| `MS_CLOUD_DISCOVERY_METADATA` | — | — | Pre-fetched instance-discovery document (JSON). Same purpose. |

**Delegated scopes only:** `openid`, `profile`, `offline_access`,
`https://graph.microsoft.com/Mail.Read`, `https://graph.microsoft.com/Mail.Send`.
No application permissions, no `.default`, no `Mail.ReadWrite`, no directory
scopes. The ATS never marks mail read, moves it or deletes it — de-duplication
is a database constraint inside the ATS instead.

## Email — feature: notifications (optional; leave blank = OFF)

Provider order is **dry-run → Graph → SMTP**. With Microsoft 365 connected there
is no SMTP password anywhere: mail is sent as the careers mailbox through
`POST /me/sendMail` on the same delegated grant that reads the inbox.

| Variable | Default | Purpose |
|----------|---------|---------|
| `MAIL_PROVIDER` | `auto` | `auto` = Graph when the Microsoft connection is healthy, else SMTP. `graph` = Graph only (never falls back). `smtp` = SMTP only. |
| `SMTP_HOST` | `smtp.office365.com` | SMTP server. **Fallback provider only.** |
| `SMTP_PORT` | `587` | 587 = STARTTLS, 465 = implicit TLS. |
| `SMTP_USER` | — | Mailbox / sender login. Required only for the SMTP fallback. |
| `SMTP_PASS` | — | App password (not the account password). Required only for the SMTP fallback. |
| `MAIL_FROM` | = `SMTP_USER` | From address (SMTP path). |
| `MAIL_FROM_NAME` | `Arabtec Careers` | From display name. |
| `SMTP_TRANSPORT` | unset | `json` = dry-run. Wins over **every** provider, so an automated test can never post real mail; `run_tests.mjs` pins it for the whole suite. |

## AI CV parsing (optional; leave blank = heuristic parser)

| Variable | Default | Purpose |
|----------|---------|---------|
| `DEEPSEEK_API_KEY` | — | Enables AI parsing in the CV watcher. |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` | Provider base URL (SiliconFlow etc.). |
| `DEEPSEEK_MODEL` | `deepseek-chat` | Model name. |
| `ANTHROPIC_API_KEY` | — | Enables the on-demand Anthropic CV parser. **Requires `@anthropic-ai/sdk` installed** (currently not a dependency). |
| `ANTHROPIC_MODEL` | `claude-haiku-4-5-20251001` | Model for the Anthropic parser. |

## Uploads & CV watcher (optional)

| Variable | Default | Purpose |
|----------|---------|---------|
| `UPLOAD_DIR` | derived | Persistent upload directory. Point at a mounted volume on VPS/Coolify. |
| `CV_INBOX` | `../../cv_inbox` | Watched folder for dropped CVs. |
| `CV_WATCH_INTERVAL_MIN` | `60` | Poll interval (min); `0` disables. |

## Seed admin (first run only)

| Variable | Default | Purpose |
|----------|---------|---------|
| `SEED_ADMIN_EMAIL` | `admin@arabtec.com` | First admin login. |
| `SEED_ADMIN_PASSWORD` | — | **Leave BLANK in prod** → strong random generated once; rotate at first login. |
| `SEED_ADMIN_NAME` | `System Administrator` | Display name. |
| `SEED_DEMO_DATA` | `false` (prod) | `true` seeds demo users (staging/dev only). |

## Monitoring (optional but recommended in prod)

| Variable | Default | Purpose |
|----------|---------|---------|
| `SENTRY_DSN` | — | Enables Sentry error tracking. |
| `SENTRY_TRACES_SAMPLE_RATE` | `0` | Performance trace sampling (0–1). |

## Minimum set to launch (internal use)

`DATABASE_URL` (postgres), `JWT_SECRET`, `NODE_ENV=production`, `CORS_ORIGINS`
(custom domain), `TRUST_PROXY=1`. Add `SMTP_*` to turn on email, `SENTRY_DSN` for
monitoring, and `UPLOAD_DIR` once a persistent volume exists.
