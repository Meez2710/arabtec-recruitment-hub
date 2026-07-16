#!/usr/bin/env bash
# Arabtec Recruitment Hub — one-click launcher (macOS / Linux).
# Double-click on macOS, or run `./start.command` from a terminal.
set -e
cd "$(dirname "$0")/backend"

echo ""
echo "  Arabtec Recruitment Hub — starting up…"
echo "  ------------------------------------------------"

# 1. Node version check (needs >= 22.5 for the built-in SQLite driver)
if ! command -v node >/dev/null 2>&1; then
  echo "  ✗ Node.js is not installed. Install Node 22.5+ from https://nodejs.org and re-run."
  read -n 1 -s -r -p "  Press any key to close."
  exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
NODE_MINOR=$(node -p "process.versions.node.split('.')[1]")
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
  echo "  ✗ Node $(node -v) found, but 22.5+ is required. Please upgrade Node and re-run."
  read -n 1 -s -r -p "  Press any key to close."
  exit 1
fi
echo "  ✓ Node $(node -v)"

# 2. Install dependencies once
if [ ! -d node_modules ]; then
  echo "  • Installing dependencies (first run only)…"
  npm install --silent
fi

# 3. Seed the database the first time
if [ ! -f prisma/dev.db ]; then
  echo "  • Setting up the database with demo data…"
  npm run seed >/dev/null
fi

# 4. Pick a free port (4000, else 4010…)
PORT=4000
if command -v lsof >/dev/null 2>&1; then
  while lsof -i :"$PORT" >/dev/null 2>&1; do PORT=$((PORT+10)); done
fi
export PORT
URL="http://localhost:$PORT"

echo "  ✓ Launching at $URL"
echo "  ------------------------------------------------"
echo "  Demo logins:"
echo "    Admin     admin@arabtec.com     / Admin@12345"
echo "    Recruiter recruiter@arabtec.com / Arabtec@123"
echo "  (other roles: <role>@arabtec.com / Arabtec@123)"
echo "  ------------------------------------------------"
echo "  Keep this window open while you use the app. Close it to stop."
echo ""

# 5. Open the browser shortly after the server boots
( sleep 2; (command -v open >/dev/null && open "$URL") || (command -v xdg-open >/dev/null && xdg-open "$URL") || true ) &

# 6. Start the server (foreground)
npm start
