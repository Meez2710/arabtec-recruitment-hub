// Runs the behaviour suites for the board-demo fixes against a REAL, disposable
// PostgreSQL (production's engine), each in a NEW database that is kept
// afterwards (nothing is dropped). Names are appended to PG_DB_LOG.
//   PG_ADMIN_URL=postgres://user:pass@127.0.0.1:PORT/postgres node --experimental-sqlite run_pg_behavior.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import pg from 'pg';
const ADMIN = process.env.PG_ADMIN_URL;
if (!ADMIN) { console.error('PG_ADMIN_URL is required (a local, disposable server).'); process.exit(2); }
const au = new URL(ADMIN.replace(/^postgres(ql)?:/, 'http:'));
if (!['127.0.0.1', 'localhost'].includes(au.hostname)) { console.error('REFUSING: PG_ADMIN_URL must be loopback'); process.exit(2); }
const SUITES = process.argv.slice(2).length ? process.argv.slice(2) : [
  'candidate_scope_test.mjs', 'scheduler_validation_test.mjs', 'interview_calendar_test.mjs',
  'assessment_review_fixes_test.mjs', 'assessment_pdf_test.mjs', 'assessment_policy_test.mjs',
  'phase4_test.mjs', 'phase5_test.mjs', 'interview_assessment_link_test.mjs', 'dashboard_director_test.mjs', 'request_control_test.mjs',
];
const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const admin = new pg.Client({ connectionString: ADMIN }); await admin.connect();
const failed = []; const created = [];
for (const suite of SUITES) {
  const db = `arabtec_scratch_test_${stamp}_${suite.replace(/_test\.mjs$|\.mjs$/, '').replace(/[^a-z0-9]/g, '_')}`;
  await admin.query(`CREATE DATABASE ${db}`); created.push(db);
  if (process.env.PG_DB_LOG) fs.appendFileSync(process.env.PG_DB_LOG, db + '\n');
  const url = new URL(ADMIN); url.pathname = '/' + db;
  process.stdout.write(`\n──────── ${suite} (PostgreSQL ${db}) ────────\n`);
  const r = spawnSync('node', ['--experimental-sqlite', suite], { stdio: 'inherit', env: { ...process.env, SUITE_PG_URL: url.toString(), SEED_DEMO_DATA: 'true', NODE_ENV: 'test', SMTP_TRANSPORT: 'json', READY_TIMEOUT_MS: process.env.READY_TIMEOUT_MS || '120000', SEED_ADMIN_PASSWORD: process.env.SEED_ADMIN_PASSWORD || 'Admin@12345' } });
  if (r.status !== 0) failed.push(suite);
}
await admin.end();
process.stdout.write(`\n════════ PG BEHAVIOUR SUMMARY ════════\nRan ${SUITES.length} suites on PostgreSQL · ${SUITES.length - failed.length} passed, ${failed.length} failed\n${failed.length ? 'FAILED: ' + failed.join(', ') + '\n' : ''}Databases kept: ${created.join(', ')}\n`);
process.exit(failed.length ? 1 : 0);
