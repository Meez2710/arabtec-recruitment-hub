// Starts the app in-process (no backgrounding) and runs the smoke suite, then exits.
process.env.DATABASE_URL = 'file:/tmp/arabtec_inproc.db';
process.env.PORT = '4099';
import fs from 'node:fs';
import { ADMIN_BOOTSTRAP_PASSWORD } from './test-support/admin-session.mjs';
import { waitForReady } from './test-support/wait-ready.mjs';
for (const f of ['/tmp/arabtec_inproc.db', '/tmp/arabtec_inproc.db-journal']) {
  try { fs.rmSync(f); } catch {}
}

// The seed generates a random admin password unless told otherwise; pin it so
// smoketest can sign in. See test-support/admin-session.mjs.
process.env.SEED_ADMIN_PASSWORD ||= ADMIN_BOOTSTRAP_PASSWORD;

// Seed first
await import('./prisma/seed.js');

// Start server
await import('./src/server.js');
// Wait for the readiness gate, not a guess about the machine: a fixed sleep let
// the first login hit the gate's 503 on a loaded CI box (test-support/wait-ready.mjs).
await waitForReady('http://localhost:4099');

// Run the smoke tests against the live in-process server
process.env.BASE = 'http://localhost:4099';
await import('./smoketest.mjs');
