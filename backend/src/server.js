import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureSchema } from './lib/schema.js';
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

dotenv.config();

// Ensure tables exist before serving (idempotent).
ensureSchema();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', true);

const origins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: origins.length ? origins : true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

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

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'arabtec-recruitment-hub', phase: 1 }));

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

// Serve the frontend (single-page app) from ../../frontend/public
const frontendDir = path.resolve(__dirname, '../../frontend/public');
app.use(express.static(frontendDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(frontendDir, 'index.html'));
});

// Central error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

// Boot-seed: on a fresh deploy (empty DB) populate roles, permissions, admin and
// demo data automatically so the live site is usable immediately. Idempotent and
// safe — skips entirely once any user exists.
async function bootSeedIfEmpty() {
  try {
    const { get } = await import('./lib/db.js');
    const hasUsers = get('SELECT 1 AS x FROM users LIMIT 1');
    if (!hasUsers) {
      console.log('  • Empty database detected — seeding initial data…');
      const { seed } = await import('../prisma/seed.js');
      await seed();
      console.log('  ✓ Initial data seeded.');
    }
  } catch (e) {
    console.error('  ! Boot-seed check failed (continuing):', e.message);
  }
}

const PORT = process.env.PORT || 4000;
bootSeedIfEmpty().finally(() => {
  app.listen(PORT, () => {
    console.log(`\n🏗️  Arabtec Recruitment Hub running at http://localhost:${PORT}`);
    console.log(`   API health: http://localhost:${PORT}/api/health\n`);
  });
});
