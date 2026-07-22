# Deploy Status & Handoff — 2026-07-22

## TL;DR
The **live site is running an OLD build.** Your "Deploy latest commit" did not bring
production up to the current code, because the newer commits are not on GitHub yet
(GitHub is unreachable from the assistant's tooling — only you can push). The correct,
agreed UI is on your **local `main`** and is ready to push.

## Evidence (verified, not assumed)
Fetched the live server directly (server-side, so this is NOT a browser-cache effect):

- `GET https://arabtec.onrender.com/api/health` → `{ ok: true, db: "up" }` (service is up)
- `GET https://arabtec.onrender.com/app.jsx` → **~90,870 chars**, and it is **missing**
  `Disqualify`, `interview_technical`, `Big Five` (assessment form), and `Scan CV Inbox`.
- Local committed `frontend/public/app.jsx` → **~233,000 chars**, and **contains** all of
  those (the agreed layout: 6-column pipeline, assessment form, CV inbox scan, etc.).

Conclusion: the deployed build predates the current agreed UI. This is deploy/commit
drift on the server, not a browser cache issue.

## What is ready on local `main` now
Fast-forwarded to include everything, in order:

1. `b68646c` — agreed UI (nav, 6-col pipeline, logo, simplifications, assessment form)
2. `906b639` — Stage 1 production hardening (security headers, TRUST_PROXY, npm ci,
   no experimental flag, boot config validation, docs, Dockerfile)
3. `3b2feae` — cache-bust `app.jsx` + `express.static` cache policy (prevents future
   "stale build" recurrence)
4. this `DEPLOY_STATUS.md`

`main` and branch `stage1-production-blockers` now point to the same commit.

## Action required (you, from your Mac terminal) — the assistant cannot push
GitHub is blocked from the assistant's environment, so these are yours to run/review:

```bash
cd ~/Downloads/arabtec-recruitment-hub

# 1) Clear the stuck git lock files (the mounted FS blocked their deletion)
rm -f .git/HEAD.lock .git/index.lock

# 2) Sanity check — expect 3b2feae/consolidated tip and a clean tree
git log --oneline -5
git status

# 3) Push main to GitHub (this is what reaches production)
git push origin main

# 4) Deploy on Render
#    render.yaml has autoDeploy: true, so a push to main should trigger it.
#    If the webhook is flaky (see DEPLOY_NOTES.md): Render dashboard → service "arabtec"
#    → Manual Deploy → "Clear build cache & deploy" (clearing cache matters here).
```

## What this push will deploy (review before pushing)
- The current agreed frontend (fixes the "old version" you saw)
- Cache-busting so it can't silently revert again
- Stage 1 backend hardening: security headers, `TRUST_PROXY=1`, `npm ci` build,
  flag-free start, boot-time config validation
- `render.yaml` now lists required secrets as `sync:false` — set their VALUES in the
  Render dashboard (email/AI/monitoring) or those features stay off. See
  `docs/ENVIRONMENT_VARIABLES.md`.

## Post-deploy verification (10 seconds)
After the deploy finishes:
- Re-fetch `https://arabtec.onrender.com/app.jsx` — it should now be ~233 KB and contain
  `Big Five` / `Disqualify`. (Ask the assistant to re-check and it will confirm.)
- In the browser, hard-refresh (Cmd+Shift+R) once.

## Rollback
- Undo the local consolidation: `git reset --hard b68646c` (main returns to pre-Stage-1).
- Roll back a bad production deploy: Render dashboard → redeploy the previous commit.
- Everything is reversible; nothing was force-pushed or deleted.

## Still not done (unchanged from Stage 1)
Hosting migration (Render free → VPS/Coolify), DB backups, secret rotation (SEC-01),
object storage for uploads. Tracked in `docs/PRODUCTION_BLOCKERS.md`.
