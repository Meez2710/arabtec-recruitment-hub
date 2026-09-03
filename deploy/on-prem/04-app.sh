#!/usr/bin/env bash
# Arabtec ATS — fetch and build the production code.
#
# Deploys origin/main (what Render prod tracks today). The resolved commit SHA is
# recorded to /opt/arabtec-ats/DEPLOYED_SHA so 06-verify.sh can prove the running
# tree is the one that was built.
set -euo pipefail

APP_USER=arabtec-ats
APP_ROOT=/opt/arabtec-ats
REPO="${ATS_REPO:-https://github.com/Meez2710/arabtec-recruitment-hub.git}"
REF="${ATS_REF:-main}"

echo "==> fetch ($REPO @ $REF)"
if [ ! -d "$APP_ROOT/.git" ]; then
  sudo -u "$APP_USER" git clone "$REPO" "$APP_ROOT"
fi
sudo -u "$APP_USER" git -C "$APP_ROOT" fetch --prune origin
sudo -u "$APP_USER" git -C "$APP_ROOT" checkout --detach "origin/$REF"

SHA="$(sudo -u "$APP_USER" git -C "$APP_ROOT" rev-parse HEAD)"
echo "==> building $SHA"
sudo -u "$APP_USER" git -C "$APP_ROOT" status --porcelain | grep . \
  && { echo "REFUSING: working tree is dirty"; exit 1; } || true

# --include=dev: NODE_ENV=production would prune TypeScript, and the document
# pipeline must be compiled to dist/ before the server starts. Same reasoning as
# render.yaml's buildCommand — this mirrors what production already does.
cd "$APP_ROOT/backend"
sudo -u "$APP_USER" npm ci --include=dev
sudo -u "$APP_USER" npm run build
test -d dist || { echo "REFUSING: dist/ missing after build"; exit 1; }

echo "$SHA" | sudo -u "$APP_USER" tee "$APP_ROOT/DEPLOYED_SHA" >/dev/null
echo "APP OK — built $SHA"
