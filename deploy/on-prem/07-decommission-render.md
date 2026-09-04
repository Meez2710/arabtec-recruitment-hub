# Decommissioning Render

Do this only **after** `06-verify.sh` passes on-prem and staff have used the
on-prem hostname for a burn-in window (recommended: 5–7 working days) with no
issues. Until then, Render stays live and `99-rollback.sh` is the fast path back.

## 1. Freeze + final data sync

Pick a quiet 15-minute window.

1. Tell recruiters to stop using the Render URL.
2. In the Render dashboard: **arabtec** service → Settings → **Suspend**
   (this stops writes without deleting anything).
3. On the box, re-run the import in refresh mode to pull anything entered on
   Render since the initial import:

   ```bash
   export RENDER_DATABASE_URL='...Render external URL...'
   export LOCAL_DATABASE_URL='postgres://arabtec_ats:...@127.0.0.1:5432/arabtec_ats'
   MODE=refresh bash 03-import-from-render.sh
   sudo systemctl restart arabtec-ats
   bash 06-verify.sh
   ```

4. Point DNS / the staff bookmark at the on-prem hostname. On-prem is now
   production.

## 2. Keep Render suspended as a cold standby (14 days)

Leave the suspended service and its database in place for two weeks. If on-prem
has a serious problem in that window you can un-suspend Render, re-point DNS, and
you have lost only what was entered on-prem since the freeze — export that with
`backup.sh` output and replay it by hand.

## 3. Delete Render (after the 14 days)

1. Render dashboard → **arabtec-db** → **Download a manual backup** (last
   snapshot). Copy it to `/var/backups/arabtec-ats/render-final-<date>.dump` on
   the box.
2. Delete the **arabtec** web service.
3. Delete the **arabtec-db** database.
4. Delete the staging service + DB (`arabtec-staging`, `arabtec-db-staging`) if
   you are not keeping a Render staging tier.
5. Remove billing / close the account if nothing else uses it.

## 4. Repo cleanup (one PR)

- Move `render.yaml` → `deploy/legacy/render.yaml` with a header note that Render
  is retired, or delete it.
- `docs/DEPLOYMENT.md`, `docs/PRODUCTION_BLOCKERS.md`, `docs/DEPLOY_STATUS.md`:
  state that on-prem `ats@10.20.0.9` is production; drop the "Render is
  temporary" language and the R-01 / PG-01 blockers.
- `README` / user manual: replace the `*.onrender.com` URL with the on-prem one.
- Redeploy on-prem (`04-app.sh`) so the box picks up the doc changes — nothing
  functional changes.

## Rollback note

Once step 3 is done there is **no Render to roll back to**. From that point the
recovery story is: `99-rollback.sh` to stop a bad release, `04-app.sh` pinned to
the previous good SHA (`ATS_REF=<sha>`) to redeploy, and
`/var/backups/arabtec-ats/` + the restore recipe in `backup.sh` if the database
is the problem. Test that restore recipe once on a scratch database before
step 3.
