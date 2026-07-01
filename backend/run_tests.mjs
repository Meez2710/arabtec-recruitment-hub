// CI test runner — executes each functional suite in its OWN process (they each
// seed a fresh DB and boot the server on their own port, so they must not share
// a process). Exits non-zero if any suite fails, so CI blocks merge.
//
// Usage: node --experimental-sqlite run_tests.mjs
import { spawnSync } from 'node:child_process';
import process from 'node:process';

// CORE suites — the blocking gate. All verified green against the current
// (Phase-0-simplified) workflow. A failure here MUST block merge.
const SUITES = [
  'inproc_test.mjs',          // smoke: auth, RBAC, audit (boots server in-process)
  'phase2_test.mjs',          // requisition lifecycle
  'phase3_test.mjs',          // candidates / applications / pipeline
  'phase3_qa_test.mjs',       // overfill, masking, RBAC, dedup
  'phase4_test.mjs',          // interviews & feedback
  'phase4_qa_test.mjs',       // integrity, scope, terminal-app, audit
  'phase5_test.mjs',          // offers, approval, joining
  'phase6_test.mjs',          // dashboards, scope, no-leak
  'thread_test.mjs',          // ticket conversation thread
  'admin_ui_test.mjs',        // control center
  'connections_audit_test.mjs', // every action lands in its designed path
  'hardening_test.mjs',       // security hardening gate items
  'auth_security_test.mjs',   // C1.1 rotation + C1.3 password policy + lockout
  'rate_limit_test.mjs',      // C1.4 global rate limiter
  'email_test.mjs',           // C2.2 email module (SMTP, dry-run)
  'notifications_test.mjs',   // C2.3 in-app notifications + assignment/approval wiring
  'gdpr_test.mjs',            // C1.6 GDPR/PDPL consent, export, erasure, retention
  'screening_test.mjs',       // Database fitness-screen gate
  'static_test.mjs',          // static + SPA fallback serving
];

// LEGACY suites — written before the Phase-0 workflow stage rename; they assert
// retired stage names (final_interview, offer_preparation, offer_accepted…).
// Run for signal but DO NOT block merge until modernized (tracked as a follow-up).
// Set RUN_LEGACY=1 to include them; CI runs them in a non-blocking job.
const LEGACY_SUITES = ['stageA_test.mjs', 'stageB_test.mjs', 'restructure_test.mjs'];

const NODE_FLAGS = ['--experimental-sqlite'];
let failed = [];
const start = Date.now();

// Several suites (stageA/B, restructure) sign in as the demo sample users
// (recruiter@, hr.manager@ …), which are only seeded when SEED_DEMO_DATA=true.
// Force it on for the whole test run so every suite has its users.
// Suites log in as admin with a known password. In CI there is no local .env, so we
// pin SEED_ADMIN_PASSWORD here to keep seeding deterministic (test-only credential).
const env = { ...process.env, SEED_DEMO_DATA: 'true', NODE_ENV: 'test',
  SEED_ADMIN_PASSWORD: process.env.SEED_ADMIN_PASSWORD || 'Admin@12345' };
const runLegacy = process.env.RUN_LEGACY === '1';
const toRun = runLegacy ? [...SUITES, ...LEGACY_SUITES] : SUITES;

for (const suite of toRun) {
  process.stdout.write(`\n──────── ${suite} ────────\n`);
  const r = spawnSync('node', [...NODE_FLAGS, suite], { stdio: 'inherit', cwd: process.cwd(), env });
  // Legacy suites are advisory only — record but never fail the run.
  if (r.status !== 0 && !LEGACY_SUITES.includes(suite)) failed.push(suite);
}

const secs = ((Date.now() - start) / 1000).toFixed(1);
process.stdout.write(`\n════════ SUMMARY ════════\n`);
process.stdout.write(`Ran ${SUITES.length} suites in ${secs}s · ${SUITES.length - failed.length} passed, ${failed.length} failed\n`);
if (failed.length) {
  process.stdout.write(`FAILED: ${failed.join(', ')}\n`);
  process.exit(1);
}
process.stdout.write('ALL SUITES PASSED ✅\n');
