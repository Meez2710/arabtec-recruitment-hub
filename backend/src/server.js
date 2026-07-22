import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureSchema } from './lib/schema.js';
import { ensureFeatureFlags, isEnabled } from './lib/feature-flags.js';
import { startWatcher, getWatcherStatus } from './lib/cv-watcher.js';
import { get as dbGet } from './lib/db.js';
import { initObservability, requestLogger, captureError } from './lib/observability.js';
import { securityHeaders, securityConfigSummary } from './lib/security-headers.js';
import { validateConfigOrThrow } from './lib/config.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import roleRoutes from './routes/roles.js';
import orgRoutes from './routes/org.js';
import settingsRoutes from './routes/settings.js';
import auditRoutes from './routes/audit.js';
import requestRoutes from './routes/requests.js';
import candidateRoutes from './routes/candidates.js';
import applicationRoutes from './routes/applications.js';
import interviewRoutes from './routes/interviews.js';
import offerRoutes from './routes/offers.js';
import dashboardRoutes from './routes/dashboard.js';
import assessmentRoutes from './routes/assessments.js';
import threadRoutes from './routes/thread.js';
import adminUiRoutes from './routes/admin-ui.js';
import notificationRoutes from './routes/notifications.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parse the TRUST_PROXY env into a value Express understands. Trusting exactly the
// number of proxies in front of the app (not "all") stops clients from spoofing
// X-Forwarded-For to forge req.ip and bypass the per-IP rate limiters.
//   TRUST_PROXY="1"   → trust 1 hop (Render / Coolify / Nginx) — the production default
//   TRUST_PROXY="0"   → do not trust any proxy
//   TRUST_PROXY="true"/"false" → boolean passthrough (advanced/testing)
function parseTrustProxy(raw, prod) {
  if (raw === undefined || raw === '') return prod ? 1 : false; // safe defaults
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const n = Number(raw);
  return Number.isFinite(n) ? n : (prod ? 1 : false);
}

const isProd = process.env.NODE_ENV === 'production';
const app = express();
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY, isProd));

// Security headers (CSP, HSTS in prod, frameguard, nosniff, referrer-policy).
// Applied to every response — static assets, API, and errors. See lib/security-headers.js.
app.use(securityHeaders);

// Schema/seed run AFTER the port is bound (see bottom) so the platform health
// check never times out on a slow first DB connection. Until init finishes,
// API calls (except health) return 503 so no request hits a missing table.
let APP_READY = false;

// CORS: explicit allowlist. In production we DO NOT reflect arbitrary origins.
// Same-origin requests (the app serves its own frontend) carry no Origin header
// and are always allowed. Set CORS_ORIGINS to a comma-list for any cross-origin clients.
const origins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);              // same-origin / curl / server-to-server
    if (origins.includes(origin)) return cb(null, true);
    if (!isProd && !origins.length) return cb(null, true); // dev convenience only
    return cb(null, false);                          // deny cross-origin in prod unless allowlisted
  },
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Structured per-request logging (one JSON line per request; assigns x-request-id).
app.use(requestLogger);

// Global rate limiter (C1.4): per-IP cap across ALL /api traffic, protecting every
// endpoint from abuse/scraping (the login limiter below is a tighter, separate cap).
// In-memory sliding window — fine for a single instance; move to Redis if scaled out.
// Health checks are exempt so uptime probes are never throttled.
const GLOBAL_MAX = Number(process.env.RATE_LIMIT_MAX || 300);       // requests
const GLOBAL_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60 * 1000); // per minute
const apiHits = new Map();
setInterval(() => apiHits.clear(), GLOBAL_WINDOW_MS).unref?.(); // periodic reset; don't hold the event loop
app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path === '/health/db') return next();
  if (process.env.NODE_ENV === 'test' || process.env.RATE_LIMIT_DISABLED === 'true') return next();
  const key = req.ip;
  const rec = apiHits.get(key) || { count: 0, ts: Date.now() };
  if (Date.now() - rec.ts > GLOBAL_WINDOW_MS) { rec.count = 0; rec.ts = Date.now(); }
  rec.count += 1;
  apiHits.set(key, rec);
  if (rec.count > GLOBAL_MAX) {
    res.setHeader('Retry-After', Math.ceil(GLOBAL_WINDOW_MS / 1000));
    return res.status(429).json({ error: 'Too many requests. Please slow down and retry shortly.' });
  }
  next();
});

// Basic in-memory rate limiter for auth endpoints (per IP).
const attempts = new Map();
app.use('/api/auth/login', (req, res, next) => {
  const key = req.ip;
  const now = Date.now();
  const rec = attempts.get(key) || { count: 0, ts: now };
  if (now - rec.ts > 15 * 60 * 1000) { rec.count = 0; rec.ts = now; }
  rec.count += 1;
  attempts.set(key, rec);
  if (rec.count > 20) {
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  }
  next();
});

// Health check — LIVENESS: always 200 once the HTTP server is up, so the
// platform's deploy health check never times out while the DB worker warms up.
// DB connectivity is reported as extra info (and at /api/health/db for a strict check).
app.get('/api/health', (req, res) => {
  let db = 'unknown';
  try { dbGet('SELECT 1 AS ok'); db = 'up'; } catch { db = 'starting'; }
  res.json({ ok: true, service: 'arabtec-recruitment-hub', db });
});
app.get('/api/health/watcher', (req, res) => {
  res.json(getWatcherStatus());
});

app.get('/api/health/db', (req, res) => {
  try { dbGet('SELECT 1 AS ok'); res.json({ ok: true, db: 'up' }); }
  catch (e) { res.status(503).json({ ok: false, db: 'down', error: String(e && e.message || e).slice(0, 300) }); }
});

// Readiness gate: until schema+seed finish, API calls return 503 (with Retry-After)
// rather than erroring on a not-yet-created table. Health endpoints are exempt.
app.use('/api', (req, res, next) => {
  if (APP_READY) return next();
  res.setHeader('Retry-After', '5');
  return res.status(503).json({ error: 'Service starting, please retry in a moment.' });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/org', orgRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/candidates', candidateRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/api/interviews', interviewRoutes);
app.use('/api/offers', offerRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/assessments', assessmentRoutes);
app.use('/api/thread', threadRoutes);
app.use('/api/admin-ui', adminUiRoutes);
app.use('/api/notifications', notificationRoutes);

// Serve the frontend (single-page app) from ../../frontend/public.
// Cache policy: the HTML shell must ALWAYS revalidate so a version bump on
// app.jsx?v=… / styles.css?v=… is picked up immediately (this is what caused the
// app to appear "reverted" to an old build). Other assets may be cached for a
// short time and are revalidated via ETag; versioned URLs bust themselves.
const frontendDir = path.resolve(__dirname, '../../frontend/public');
app.use(express.static(frontendDir, {
  etag: true,
  lastModified: true,
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.setHeader('Cache-Control', 'no-cache'); // SPA shell: always revalidate
  res.sendFile(path.join(frontendDir, 'index.html'));
});

// Central error handler — also reports to Sentry (no-op if not configured).
app.use((err, req, res, next) => {
  console.error(JSON.stringify({ level: 'error', msg: 'unhandled', requestId: req?.requestId, error: String(err && err.message || err) }));
  captureError(err, req);
  res.status(500).json({ error: 'Internal server error.', requestId: req?.requestId });
});

// Boot-seed: on a fresh deploy (empty DB) populate roles, permissions, admin and
// demo data automatically so the live site is usable immediately. Idempotent and
// safe — skips entirely once any user exists.
async function bootSeedIfEmpty() {
  try {
    const { get } = await import('./lib/db.js');
    const hasUsers = get('SELECT 1 AS x FROM users LIMIT 1');
    if (!hasUsers) {
      // In production, seed ONLY the admin + reference data unless SEED_DEMO_DATA=true.
      // Outside production (local dev), the demo users are seeded for convenience.
      const demo = process.env.SEED_DEMO_DATA === 'true' || process.env.NODE_ENV !== 'production';
      console.log(`  • Empty database detected — seeding ${demo ? 'initial + demo' : 'admin-only'} data…`);
      const { seed } = await import('../prisma/seed.js');
      await seed({ demo });
      console.log('  ✓ Initial data seeded.');
    }
  } catch (e) {
    console.error('  ! Boot-seed check failed (continuing):', e.message);
  }
}

const PORT = process.env.PORT || 4000;

// Validate configuration BEFORE binding the port. In production a missing REQUIRED
// variable (DATABASE_URL / JWT_SECRET) throws here and the process exits — a
// misconfigured deploy fails loudly instead of silently serving on the wrong DB.
// (Validation is synchronous and instant, so it does not delay the health check.)
validateConfigOrThrow();

// Bind the port FIRST so the platform's health check sees an open port immediately
// (Render fails a deploy if no port opens within ~60s). Schema + seed run in the
// background; APP_READY flips true when done, opening the API gate.
app.listen(PORT, () => {
  console.log(`\n🏗️  Arabtec Recruitment Hub listening on ${PORT} (initialising…)`);
  console.log(JSON.stringify({ level: 'info', msg: 'security.headers', ...securityConfigSummary() }));
  (async () => {
    try {
      await initObservability(); // Sentry (no-op without SENTRY_DSN)
      ensureSchema();            // create/upgrade tables + migrate workflow stages
      ensureFeatureFlags();      // seed feature toggles (idempotent)
      await bootSeedIfEmpty();   // seed admin/reference data if empty
      APP_READY = true;
      console.log(`   ✓ Ready. API health: http://localhost:${PORT}/api/health\n`);
      // Start the CV inbox folder watcher if the feature flag is enabled
      if (isEnabled('folder_watcher')) {
        startWatcher();
        console.log('   📁 CV inbox watcher started.\n');
      }
    } catch (e) {
      console.error('  ! Initialisation failed:', e.message);
      // Open the gate anyway so the operator can see real errors rather than 503s.
      APP_READY = true;
    }
  })();
});
