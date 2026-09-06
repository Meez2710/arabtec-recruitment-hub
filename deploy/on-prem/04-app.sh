#!/usr/bin/env bash
# Arabtec ATS — fetch and build the production code.
#
# Defaults to origin/main; ATS_REF also accepts a branch, tag, or commit SHA.
# The resolved commit SHA is
# recorded to /opt/arabtec-ats/DEPLOYED_SHA so 06-verify.sh can prove the running
# tree is the one that was built.
set -euo pipefail

APP_USER=arabtec-ats
APP_ROOT=/opt/arabtec-ats
REPO="${ATS_REPO:-https://github.com/Meez2710/arabtec-recruitment-hub.git}"
REF="${ATS_REF:-main}"

# Reject revision expressions and option-like input before creating or changing
# a checkout. Explicit refs disambiguate branch/tag names that happen to match.
case "$REF" in
  refs/heads/*) KIND=branch; NAME="${REF#refs/heads/}" ;;
  refs/tags/*) KIND=tag; NAME="${REF#refs/tags/}" ;;
  origin/*) KIND=branch; NAME="${REF#origin/}" ;;
  *) KIND=auto; NAME="$REF" ;;
esac
if [[ "$NAME" == -* ]] || ! git check-ref-format "refs/heads/$NAME"; then
  echo "REFUSING: invalid ATS_REF: $REF" >&2
  exit 1
fi

app_git() { sudo -u "$APP_USER" git -C "$APP_ROOT" "$@"; }
require_clean_tree() {
  local status
  status="$(app_git status --porcelain --untracked-files=all)"
  if [ -n "$status" ]; then
    echo "REFUSING: working tree is dirty" >&2
    exit 1
  fi
}

# Check before fetch and checkout: even a successful checkout can otherwise
# change HEAD underneath the operator's uncommitted files.
if [ -d "$APP_ROOT/.git" ]; then
  require_clean_tree
fi
echo "==> fetch ($REPO @ $REF)"
if [ ! -d "$APP_ROOT/.git" ]; then
  sudo -u "$APP_USER" git clone "$REPO" "$APP_ROOT"
fi
app_git fetch --prune --tags origin

TARGET=""
case "$KIND" in
  branch) TARGET="refs/remotes/origin/$NAME" ;;
  tag) TARGET="refs/tags/$NAME" ;;
  auto)
    if app_git show-ref --verify --quiet "refs/remotes/origin/$NAME"; then
      TARGET="refs/remotes/origin/$NAME"
    fi
    if app_git show-ref --verify --quiet "refs/tags/$NAME"; then
      if [ -n "$TARGET" ]; then
        echo "REFUSING: ambiguous ATS_REF; use refs/heads/$NAME or refs/tags/$NAME" >&2
        exit 1
      fi
      TARGET="refs/tags/$NAME"
    fi
    if [ -z "$TARGET" ] && [[ "$NAME" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
      TARGET="$NAME"
    fi
    ;;
esac
if [ -z "$TARGET" ] || ! SHA="$(app_git rev-parse --verify --end-of-options "${TARGET}^{commit}" 2>/dev/null)"; then
  echo "REFUSING: ATS_REF does not resolve to a fetched commit: $REF" >&2
  exit 1
fi
require_clean_tree
app_git checkout --detach "$SHA"

echo "==> building $SHA"

# --include=dev: NODE_ENV=production would prune TypeScript, and the document
# pipeline must be compiled to dist/ before the server starts. Same reasoning as
# render.yaml's buildCommand — this mirrors what production already does.
cd "$APP_ROOT/backend"
sudo -u "$APP_USER" npm ci --include=dev
sudo -u "$APP_USER" npm run build
test -d dist || { echo "REFUSING: dist/ missing after build"; exit 1; }

echo "$SHA" | sudo -u "$APP_USER" tee "$APP_ROOT/DEPLOYED_SHA" >/dev/null
echo "APP OK — built $SHA"
