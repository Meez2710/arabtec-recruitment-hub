# Upload — one consolidated commit (Phase 0 + C1.1 + Screening gate + C1.3/C1.4)

This folder is the **latest version of every file changed since your last GitHub
commit (7f8bcef)**, at the correct repo paths. Upload it in one go.

## Fastest way (single drag, preserves folders)
1. Go to: **https://github.com/Meez2710/arabtec-recruitment-hub/upload/main**
   (or push to a `staging` branch first — recommended — via `/upload/staging`).
2. Open this `UPLOAD_ALL` folder on your computer.
3. Select and drag **all four top items** — `.github`, `backend`, `frontend`, `render.yaml`
   — into the GitHub upload area. GitHub keeps the folder paths.
4. Commit message:
   `Phase 0 (CI/staging/observability) + C1.1 credential rotation + screening gate + C1.3/C1.4 security hardening`
5. Commit.

> Tip: if your OS hides the leading-dot `.github` folder, press **Cmd+Shift+.** (Mac)
> in Finder to reveal it, or drag its `workflows/ci.yml` into a path field manually.

## Then deploy / verify
- Render auto-deploys `main`. If you used `staging`, it deploys the `arabtec-staging`
  service (once you've synced the blueprint from the Phase 0 handoff).
- CI (GitHub Actions) runs automatically on the push — watch the **Core test suite** job go green.

## What's in this commit (22 files)
**Phase 0 — make change safe**
- `.github/workflows/ci.yml` — CI (core blocking + legacy advisory)
- `render.yaml` — staging service + SENTRY_DSN
- `backend/run_tests.mjs`, `backend/src/lib/observability.js` — test runner + Sentry/structured logs
- `backend/src/server.js` — request logging + global rate limiter
- `backend/package.json`, `smoketest.mjs`, `phase5_test.mjs`, `static_test.mjs` — deps + fixed stale assertions

**C1.1 — eliminate default credential + forced rotation**
- `backend/prisma/seed.js`, `backend/src/routes/auth.js`, `backend/src/lib/auth.js`
- `backend/auth_security_test.mjs`

**Screening gate (your process flow)**
- `backend/src/routes/candidates.js`, `backend/src/lib/models.js`, `backend/src/lib/schema.js`
- `frontend/public/app.jsx`, `backend/screening_test.mjs`

**C1.3/C1.4 — password policy, lockout, rate limiting**
- `backend/src/lib/passwords.js`, `backend/src/routes/users.js`, `backend/.env.example`
- `backend/rate_limit_test.mjs`

## Verified before packaging
All backend files parse (`node --check`), `app.jsx` compiles (Babel), `ci.yml` + `render.yaml`
valid YAML. New CI suites: auth_security 14/14, screening 10/10, rate_limit 3/3; full
regression green.

## Post-upload housekeeping
You can delete the stray `DEPLOY_NOTES.md` from the repo root (from an earlier commit) —
it's just notes.
