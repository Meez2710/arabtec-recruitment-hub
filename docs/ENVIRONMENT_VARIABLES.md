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

## Email — feature: notifications (optional; leave blank = OFF)

| Variable | Default | Purpose |
|----------|---------|---------|
| `SMTP_HOST` | `smtp.gmail.com` | SMTP server (`smtp.office365.com` for M365). |
| `SMTP_PORT` | `587` | 587 = STARTTLS, 465 = implicit TLS. |
| `SMTP_USER` | — | Mailbox / sender login. **Required to send email.** |
| `SMTP_PASS` | — | App password (not the account password). **Required to send email.** |
| `MAIL_FROM` | = `SMTP_USER` | From address. |
| `MAIL_FROM_NAME` | `Arabtec Careers` | From display name. |
| `SMTP_TRANSPORT` | unset | `json` = dry-run (tests). |

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
