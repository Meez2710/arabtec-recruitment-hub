# Deployment

Two targets: the **current** Render setup (temporary, unsafe for prod — free tier) and
the **planned** VPS/Coolify target (Stage 2). Stage 1 made both paths safer without
migrating anything.

## Build & start commands (after Stage 1)

| | Command | Notes |
|--|---------|-------|
| Build | `npm ci` | Deterministic, lockfile-pinned (was `npm install`). |
| Start (prod) | `npm start` → `node src/server.js` | No `--experimental-sqlite` (prod uses Postgres). |
| Start (local SQLite) | `npm run start:sqlite` | Adds the experimental flag for the SQLite engine. |
| Dev | `npm run dev` | Watch mode + SQLite flag. |
| Tests | `npm test` | Runs the core suites. |

## Health checks

- `GET /api/health` — liveness (always 200 once the port is open). Used as the platform
  health check path.
- `GET /api/health/db` — strict DB check (503 if Postgres is unreachable). **Point an
  external uptime monitor here** so DB outages actually alert (HC-01).
- `GET /api/health/watcher` — CV watcher status.

## A. Current: Render (temporary)

`render.yaml` defines production + staging web services and Postgres. Stage 1 changes:
`buildCommand: npm ci`, removed `NODE_OPTIONS=--experimental-sqlite`, added
`TRUST_PROXY=1`, and listed required feature secrets as `sync:false` (set their values
in the dashboard, never in the file).

Deploy: push to `staging` → verify → merge/promote to `main` (auto-deploy). Avoid the
manual file-upload path (R-02). **Do not treat Render free tier as production** — no DB
backups, 90-day DB expiry, cold starts (R-01/PG-01).

## B. Planned: VPS + Coolify (Stage 2 target)

A `Dockerfile` and `.dockerignore` were added at the repo root for this. The image:
pins Node 22.11.0, installs with `npm ci --omit=dev`, runs as the non-root `node` user,
serves the SPA from `frontend/public`, and has a container `HEALTHCHECK` on `/api/health`.

Suggested bring-up (high level — execute in Stage 2, needs the server + decisions):

1. Provision the VPS (e.g. Hetzner) and install Coolify.
2. Create a **PostgreSQL** service (managed or container) with a volume + backups
   (see `BACKUP_AND_RESTORE.md`).
3. New Coolify resource from this repo using the `Dockerfile`.
4. Set environment variables/secrets from `ENVIRONMENT_VARIABLES.md`
   (`DATABASE_URL`, `JWT_SECRET`, `NODE_ENV=production`, `CORS_ORIGINS`=domain,
   `TRUST_PROXY=1`, plus email/AI/monitoring as desired). Mount a volume and set
   `UPLOAD_DIR` to it.
5. Add the custom domain in Coolify; it issues Let's Encrypt TLS and terminates HTTPS
   (so app-level HSTS from Stage 1 is correct). Verify HSTS + CORS on the real domain.
6. Migrate data from Render Postgres with `pg_dump | pg_restore`
   (see `BACKUP_AND_RESTORE.md`). Cut DNS over. Keep Render as rollback for a few days.

## Custom domain cutover checklist (CORS-01 / SSL-01)

- [ ] `CORS_ORIGINS` = `https://<final-domain>` (drop onrender.com).
- [ ] Confirm `Strict-Transport-Security` present over HTTPS on the domain.
- [ ] Confirm `TRUST_PROXY` matches the real proxy count.
- [ ] Re-run the smoke test (§ Testing in the Stage 1 summary) against the domain.

## Monitoring & logging (LOG-01 / HC-01)

- Set `SENTRY_DSN` to enable error tracking (integration already in code).
- Uptime probe on `/api/health/db`.
- On the VPS, ship container stdout to a retained store (Coolify log drain / logrotate);
  Render free-tier retention is too short for incident review.

## Rollback

- Render: redeploy the previous commit from the dashboard.
- Coolify: redeploy the previous image/commit; DB restore per `BACKUP_AND_RESTORE.md`.
- Prefer forward-fixes; keep the old host live until the new one is verified.
