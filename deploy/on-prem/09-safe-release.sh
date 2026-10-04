#!/usr/bin/env bash
# Arabtec ATS — safer release of ONE exact commit to the on-prem service.
#
# Addresses the gaps in 08-redeploy.sh (which resets the live checkout before
# building, leaves changed source behind if the build fails, and needs the
# running process to find the database for any recovery):
#
#   1. preflight (read-only) and capture of the database DSN while the service
#      is still healthy, into a private file, so recovery never depends on a
#      running process;
#   2. a fresh database backup, checked readable with pg_restore --list;
#   3. the target commit is checked out and BUILT in a separate worktree —
#      the live checkout is not touched until the build has succeeded;
#   4. a short switch: previous node_modules/dist are moved aside (not
#      deleted), the live checkout moves to the exact SHA, the prebuilt
#      dependencies move in, the process is restarted;
#   5. readiness is verified; if the new process never becomes ready, the
#      previous source, dependencies and build are restored and the previous
#      version is restarted automatically.
#
# Never deletes anything: superseded files are moved under ~/releases/<run>/.
# Uploads, CV inbox and configuration live outside the checkout
# (/var/lib/arabtec-ats, /etc/arabtec-ats) and are not touched.
# The database is never restored automatically: schema changes at startup
# are additive, and a restore discards data written since the backup — that
# is an owner decision (the command is printed for it).
#
# Run as `ats` on 10.20.0.9 (no sudo needed: the unit has Restart=always and
# runs as this user, so ending the process is the restart).
#
#   ATS_SHA=<40-hex> ATS_BUNDLE=~/arabtec-release/release.bundle bash 09-safe-release.sh
#   ATS_SHA=<40-hex> bash 09-safe-release.sh          # fetch the SHA from origin instead
set -euo pipefail
umask 077

SHA="${ATS_SHA:-}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "REFUSING: ATS_SHA must be a full 40-character commit SHA" >&2; exit 2; }
APP_ROOT=/opt/arabtec-ats
UNIT=arabtec-ats
READY_WAIT="${ATS_READY_WAIT:-120}"
export PATH=/opt/node22/bin:$PATH

TS="$(date +%Y%m%d-%H%M%S)"
RUN="$HOME/releases/$TS-${SHA:0:7}"
[ -e "$RUN" ] && { echo "REFUSING: $RUN already exists" >&2; exit 2; }
mkdir -p "$RUN" "$HOME/backups"
exec > >(tee -a "$RUN/release.log") 2>&1
echo "==> release run $RUN"

ready() { curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health/ready" >/dev/null 2>&1; }
mainpid() { systemctl show -p MainPID --value "$UNIT"; }
wait_ready() {  # $1 = PID that must NOT be the one answering
  local old="$1" i
  for i in $(seq 1 "$READY_WAIT"); do
    local now; now="$(mainpid)"
    if [ "$now" != "0" ] && [ "$now" != "$old" ] && ready; then return 0; fi
    sleep 1
  done
  return 1
}

# ── 1. preflight (read-only) ────────────────────────────────────────────────
PREV="$(git -C "$APP_ROOT" rev-parse HEAD)"
echo "$PREV" > "$RUN/PREVIOUS_SHA"
echo "    deployed now: $PREV"
echo "    target:       $SHA"
[ "$PREV" = "$SHA" ] && { echo "Nothing to do: $SHA is already deployed."; exit 0; }
DIRTY="$(git -C "$APP_ROOT" status --porcelain --untracked-files=no)"
[ -z "$DIRTY" ] || { echo "REFUSING: the live checkout has tracked edits:" >&2; echo "$DIRTY" >&2; exit 1; }
PID="$(mainpid)"
[ "$PID" != "0" ] || { echo "REFUSING: $UNIT is not running" >&2; exit 1; }
PORT="$(tr '\0' '\n' < "/proc/$PID/environ" | sed -n 's/^PORT=//p')"; PORT="${PORT:-4001}"
ready || { echo "REFUSING: the current service is not ready; fix that before releasing" >&2; exit 1; }
# Captured once, while healthy, never echoed. Recovery and backup use this file.
tr '\0' '\n' < "/proc/$PID/environ" | sed -n 's/^DATABASE_URL=//p' > "$RUN/.dsn"
[ -s "$RUN/.dsn" ] || { echo "REFUSING: could not read DATABASE_URL from the running service" >&2; exit 1; }
echo "    service pid $PID on :$PORT is ready"

# ── 2. fresh backup ─────────────────────────────────────────────────────────
DUMP="$HOME/backups/pre-release-$TS-${SHA:0:7}.dump"
echo "==> backup -> $DUMP"
pg_dump --format=custom --no-owner --dbname="$(cat "$RUN/.dsn")" --file="$DUMP"
pg_restore --list "$DUMP" > "$RUN/backup-toc.txt"
echo "    $(du -h "$DUMP" | cut -f1), $(grep -c ' TABLE DATA ' "$RUN/backup-toc.txt") table-data entries, sha256 $(sha256sum "$DUMP" | cut -c1-16)…"

# ── 3. get and build the exact commit OUTSIDE the live checkout ────────────
echo "==> fetch $SHA"
if [ -n "${ATS_BUNDLE:-}" ]; then
  git -C "$APP_ROOT" bundle verify "$ATS_BUNDLE" >/dev/null
  git -C "$APP_ROOT" fetch "$ATS_BUNDLE" "+refs/heads/*:refs/release-bundles/$TS/*"
else
  git -C "$APP_ROOT" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
  git -C "$APP_ROOT" fetch --prune origin
fi
git -C "$APP_ROOT" cat-file -e "$SHA^{commit}" || { echo "REFUSING: $SHA not found after fetch" >&2; exit 1; }
git -C "$APP_ROOT" worktree add --detach "$RUN/src" "$SHA"
echo "==> build in $RUN/src (live checkout untouched)"
( cd "$RUN/src/backend" && npm ci --no-audit --no-fund && npm run build ) || {
  echo "BUILD FAILED — nothing on the live service changed. Build tree kept at $RUN/src." >&2; exit 1; }

# ── 4. switch ───────────────────────────────────────────────────────────────
LIVE="$APP_ROOT/backend"
restore_previous() {
  echo "!!> restoring $PREV" >&2
  git -C "$APP_ROOT" checkout --quiet --detach "$PREV" || true
  [ -d "$LIVE/node_modules" ] && mv "$LIVE/node_modules" "$RUN/node_modules.failed" || true
  [ -d "$LIVE/dist" ] && mv "$LIVE/dist" "$RUN/dist.failed" || true
  [ -d "$RUN/node_modules.prev" ] && mv "$RUN/node_modules.prev" "$LIVE/node_modules" || true
  [ -d "$RUN/dist.prev" ] && mv "$RUN/dist.prev" "$LIVE/dist" || true
  echo "$PREV" > "$APP_ROOT/DEPLOYED_SHA"
}
echo "==> switch"
trap 'restore_previous' ERR
[ -d "$LIVE/node_modules" ] && mv "$LIVE/node_modules" "$RUN/node_modules.prev"
[ -d "$LIVE/dist" ] && mv "$LIVE/dist" "$RUN/dist.prev"
git -C "$APP_ROOT" checkout --quiet --detach "$SHA"
mv "$RUN/src/backend/node_modules" "$LIVE/node_modules"
[ -d "$RUN/src/backend/dist" ] && cp -a "$RUN/src/backend/dist" "$LIVE/dist"
echo "$SHA" > "$APP_ROOT/DEPLOYED_SHA"
trap - ERR
echo "==> restart (pid $PID)"
kill "$PID"

# ── 5. verify, or recover ──────────────────────────────────────────────────
if wait_ready "$PID" && [ "$(git -C "$APP_ROOT" rev-parse HEAD)" = "$SHA" ]; then
  echo
  echo "Released $SHA (was $PREV). New pid $(mainpid). Backup: $DUMP"
  echo "Previous dependencies kept at $RUN/node_modules.prev (nothing deleted)."
  echo "Code rollback: ATS_SHA=$PREV ATS_BUNDLE=… bash $0"
  exit 0
fi
echo "NEW VERSION NEVER BECAME READY within ${READY_WAIT}s — rolling back code." >&2
FAILED_PID="$(mainpid)"
restore_previous
[ "$FAILED_PID" != "0" ] && kill "$FAILED_PID" 2>/dev/null || true
if wait_ready "$FAILED_PID"; then
  echo "Recovered: $PREV is serving again. The failed attempt is kept at $RUN for inspection." >&2
else
  echo "RECOVERY DID NOT BECOME READY. Inspect: journalctl -u $UNIT -n 120 --no-pager; /var/log/arabtec-ats/ats.log" >&2
fi
echo "Database was NOT restored. If the owner decides it must be, from this host:" >&2
echo "  pg_restore --clean --if-exists --no-owner --dbname=\"\$(cat $RUN/.dsn)\" $DUMP" >&2
exit 1
