#!/usr/bin/env bash
# Stop the local Docling sidecar. Matches only the loopback uvicorn on 8089.
set -euo pipefail
PIDS="$(pgrep -f 'uvicorn app:app .*--port 8089' || true)"
if [ -z "$PIDS" ]; then echo "sidecar not running"; exit 0; fi
echo "stopping: $PIDS"
kill $PIDS
sleep 2
pgrep -f 'uvicorn app:app .*--port 8089' >/dev/null && kill -9 $PIDS || true
echo "stopped"
