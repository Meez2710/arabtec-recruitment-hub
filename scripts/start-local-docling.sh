#!/usr/bin/env bash
# Start the Docling sidecar on LOOPBACK ONLY for the local Mac pilot.
#
# Binds 127.0.0.1 deliberately: the sidecar has no transport security of its
# own, so the only thing that may reach it directly is this machine. Public
# exposure goes through an authenticated tunnel, never a bound interface.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIDECAR="$ROOT/deploy/docling-sidecar"
LOGDIR="$ROOT/logs"
mkdir -p "$LOGDIR"

# Load the token without echoing it. `set -a` exports without printing.
if [ -f "$SIDECAR/.env.local" ]; then
  set -a; . "$SIDECAR/.env.local"; set +a
fi

if [ -z "${DOCLING_BEARER_TOKEN:-}" ]; then
  echo "WARNING: DOCLING_BEARER_TOKEN is unset — the sidecar will accept" >&2
  echo "         unauthenticated requests. Acceptable on loopback ONLY." >&2
fi

cd "$SIDECAR"
# caffeinate keeps the Mac awake while the service runs, WITHOUT changing any
# global power setting: the inhibition dies with this process.
exec caffeinate -dimsu "$SIDECAR/.venv/bin/uvicorn" app:app \
  --host 127.0.0.1 --port 8089 --workers 1 \
  >>"$LOGDIR/docling.log" 2>&1
