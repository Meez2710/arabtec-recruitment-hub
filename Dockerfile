# Production image for VPS / Coolify deployment (NOT used by Render, which builds
# natively). Deterministic, pinned Node, non-root, with a container health check.
# Build context = repo root so both backend/ and frontend/ are available (the
# backend serves the SPA from ../../frontend/public).
FROM node:22.11.0-slim AS base

ENV NODE_ENV=production
WORKDIR /app

# Install backend dependencies first (better layer caching). npm ci = deterministic,
# lockfile-pinned install. Production uses PostgreSQL, so no SQLite flag is needed.
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev && npm cache clean --force

# App source
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Run as an unprivileged user (the node image ships a `node` user).
RUN chown -R node:node /app
USER node

WORKDIR /app/backend
EXPOSE 4000

# Container-level health check (Coolify/Docker restarts the container if unhealthy).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Flag-free production start (Postgres path). Local SQLite dev uses npm run start:sqlite.
CMD ["node", "src/server.js"]
