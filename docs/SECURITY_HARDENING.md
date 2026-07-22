# Security Hardening

What Stage 1 changed, why, and what is still open. No secrets appear in this file.

## 1. HTTP security headers

Implemented in `src/lib/security-headers.js` and applied globally in `src/server.js`
to every response (API, static assets, errors). This is a dependency-free equivalent
of Helmet (chosen because the npm registry is not reachable from the build sandbox and
the project already favours zero-dependency infra). It can be swapped for `helmet`
later with no behavioural change — see §5.

| Header | Value | Protects against |
|--------|-------|------------------|
| `Content-Security-Policy` | see §2 | XSS, injection, data exfiltration |
| `X-Frame-Options` | `DENY` | Clickjacking |
| `X-Content-Type-Options` | `nosniff` | MIME sniffing |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Referrer leakage |
| `Permissions-Policy` | geolocation/mic/camera/payment `()` | Feature abuse |
| `Strict-Transport-Security` | `max-age=<HSTS_MAX_AGE>; includeSubDomains` | Protocol downgrade (**prod only**) |
| `X-Powered-By` | removed | Framework fingerprinting |

HSTS is emitted **only when `NODE_ENV=production`** (TLS is terminated at the
Render/Coolify/Nginx proxy). It is never sent over local http dev.

## 2. Content Security Policy — current risk

```
default-src 'self';
script-src 'self' 'unsafe-eval' 'unsafe-inline';
style-src  'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src   'self' https://fonts.gstatic.com data:;
img-src    'self' data: blob:;
connect-src 'self'; object-src 'none'; frame-ancestors 'none';
base-uri 'self'; form-action 'self'; [upgrade-insecure-requests in prod]
```

**Risk:** `script-src` includes `'unsafe-eval'` and `'unsafe-inline'`. These are
required by the current production frontend (`frontend/public`), which compiles JSX
in the browser with Babel (`<script type="text/babel">`) and uses an inline font
loader. Allowing them means a successful XSS has fewer guardrails.

**Recommendation (Stage 2, before public launch):** serve a **pre-built** frontend
(the `frontend-v2` Vite app produces static, already-compiled JS). Then remove
`'unsafe-eval'` and `'unsafe-inline'` from `script-src` in `security-headers.js`.
Roll out safely by first setting `CSP_REPORT_ONLY=true`, watching for violations,
then enforcing.

## 3. Proxy trust (`TRUST_PROXY`)

Previously `app.set('trust proxy', true)` trusted **every** hop, so a client could
spoof `X-Forwarded-For` to forge `req.ip` and bypass the per-IP rate limiters and
poison audit-log IPs. Now `src/server.js` reads `TRUST_PROXY`:
`1` in production (single proxy: Render/Coolify/Nginx), off in dev. Set it to the
actual number of proxies in front of the app.

## 4. Boot-time config validation

`src/lib/config.js` runs before the port binds. In production it **throws and exits**
if `DATABASE_URL` or `JWT_SECRET` is missing (fail loud, not silent-wrong-DB), and
logs warnings for half-configured optional features. It never logs secret values.

## 5. Swapping in Helmet later (optional)

If you prefer the `helmet` package: `npm install helmet`, then in `server.js` replace
the `securityHeaders` middleware with a `helmet({...})` call using the same directives
documented in §1–§2. Behaviour is intended to match, so no header changes for clients.

## 6. Local secret cleanup & rotation (SEC-01) — ACTION REQUIRED, needs approval

Findings (no values shown): `backend/.env` contains a real `DEEPSEEK_API_KEY` and a
set `SEED_ADMIN_PASSWORD`; `backend/.env.backup-20260716` duplicates secrets. Both are
git-ignored (verified) and were **not** modified.

Recommended steps (do NOT run without approval — destructive/irreversible for the key):

1. **Rotate `DEEPSEEK_API_KEY`** in the DeepSeek/SiliconFlow dashboard; put the new
   value only in the host secret store (Render/Coolify), never in a file in the repo.
2. **Delete `backend/.env.backup-20260716`** (stale secret copy).
3. In production, keep `SEED_ADMIN_PASSWORD` **unset** so a random one is generated and
   rotated at first login. If the current admin password was ever the fixed local value,
   rotate it after first login.
4. Confirm `.gitignore` still excludes `.env` and `.env.*` (it does today).

Blocked on you: approval to rotate the key, and access to the provider dashboard.

## 7. Still open (see PRODUCTION_BLOCKERS.md)

- Compiled frontend to drop `unsafe-eval` (Stage 2).
- Enable `SENTRY_DSN`, uptime probe on `/api/health/db`, log retention (needs host).
- Verify HSTS + `CORS_ORIGINS` on the real custom domain.
- Postgres TLS: on self-hosted VPS, pin the CA and set `rejectUnauthorized: true`
  (currently `false` for Render's internal network — `src/lib/pg-worker.mjs`).
