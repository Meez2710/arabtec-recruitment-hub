# Production Blockers — Status Tracker

Source of truth: the Production Readiness Report (DevOps audit). This file tracks
what Stage 1 changed and what is still blocked. Finding IDs map to that report.

Legend: ✅ fixed in code/config · 🟡 prepared (needs infra/decision) · ⛔ blocked (needs you)

| ID | Finding | Status | Notes |
|----|---------|--------|-------|
| HDR-01 | No security headers | ✅ | `securityHeaders` middleware adds CSP, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy. |
| SSL-01 | No HSTS | ✅ | HSTS sent when `NODE_ENV=production` (`HSTS_MAX_AGE`, default 180d). |
| SSL-02 | `trust proxy` trusts all | ✅ | Now configurable via `TRUST_PROXY`; defaults to `1` in prod, off in dev. |
| B-01 | `npm install` build | ✅ | `render.yaml` build command is now `npm ci`; Dockerfile uses `npm ci --omit=dev`. |
| ST-01 | Experimental SQLite flag in prod start | ✅ | Prod start is flag-free (`npm start` → `node src/server.js`); `NODE_OPTIONS` removed from `render.yaml`. Local SQLite = `npm run start:sqlite`. |
| ENV-01 | Undefined prod env vars | ✅ | Full set documented in `ENVIRONMENT_VARIABLES.md`; `.env.example` expanded; `render.yaml` lists required secrets as `sync:false`; boot-time validation added. |
| SEC-01 | Secrets in local `.env` | 🟡/⛔ | Cleanup + rotation steps in `SECURITY_HARDENING.md`. **Requires your approval** to rotate the key. No secrets were touched. |
| LOG-01 / HC-01 | Logging / monitoring | 🟡 | Plan in `DEPLOYMENT.md` + `SECURITY_HARDENING.md`: enable `SENTRY_DSN`, external uptime probe on `/api/health/db`, log retention on VPS. |
| CORS-01 | Allowlist pinned to onrender.com | 🟡 | Update `CORS_ORIGINS` to the custom domain at cutover (steps in `DEPLOYMENT.md`). |
| FS-01 / PG-02 | File blobs in Postgres | 🟡 | Risk + migration path documented in `BACKUP_AND_RESTORE.md` and `DEPLOYMENT.md`. Not migrated in Stage 1 (reversible-only rule). |
| R-01 / PG-01 | Free hosting, no backups | ⛔ | Hosting **not migrated** per instruction. App/config/docs are now VPS/Coolify-ready (Dockerfile added). Backup procedure in `BACKUP_AND_RESTORE.md`. **Requires Hetzner/Coolify + paid DB decision.** |

## Important: CSP and the in-browser Babel frontend

The current production frontend (`frontend/public`) compiles JSX in the browser
with Babel (`<script type="text/babel">`). That requires `script-src 'unsafe-eval'`
(and `'unsafe-inline'`), which **weakens XSS protection**. Stage 1 keeps the app
working by allowing these, but the correct fix before a public launch is to serve a
**pre-built/compiled** frontend (the `frontend-v2` Vite app) and then remove
`'unsafe-eval'` / `'unsafe-inline'` from `src/lib/security-headers.js`. Tracked as a
Stage 2 item.

## What remains blocked until Hetzner/Coolify

- Moving off Render free tier to a persistent, backed-up host (R-01/PG-01).
- Enabling automated database backups + a tested restore (needs the target DB).
- Pointing `UPLOAD_DIR` at a persistent volume and/or moving blobs to object storage.
- Final `CORS_ORIGINS` + HSTS validation on the real custom domain.
