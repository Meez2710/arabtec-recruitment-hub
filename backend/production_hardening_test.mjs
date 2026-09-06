// Production hardening regression checks.
// These are intentionally small release-safety tests, not feature tests.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const DB = `/tmp/arabtec_prod_hardening_${process.pid}.db`;
for (const f of [DB, `${DB}-journal`, `${DB}-wal`, `${DB}-shm`]) {
  try { fs.rmSync(f); } catch {}
}

let pass = 0; let fail = 0;
const c = (name, ok, extra = '') => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (extra ? ` ${extra}` : ''));
  ok ? pass++ : fail++;
};

const baseEnv = {
  ...process.env,
  DATABASE_URL: `file:${DB}`,
  NODE_ENV: 'test',
  SEED_DEMO_DATA: 'true',
  SEED_ADMIN_PASSWORD: 'ProdHardening@Test1',
  SMTP_TRANSPORT: 'json',
};

console.log('\n— destructive Arabtec data migration guard —');

const seeded = spawnSync('node', ['--experimental-sqlite', 'prisma/seed.js'], {
  cwd: process.cwd(), env: baseEnv, encoding: 'utf8',
});
c('fixture seed succeeds', seeded.status === 0, seeded.status === 0 ? '' : seeded.stderr.slice(-300));

const beforeDb = new DatabaseSync(DB);
const beforeDepartments = beforeDb.prepare('SELECT code,name FROM department ORDER BY code').all();
beforeDb.close();
c('fixture has departments to protect', beforeDepartments.length > 0, `n=${beforeDepartments.length}`);

const migrationEnv = { ...baseEnv, ARABTEC_MANAGER_PASSWORD: '' };
const migrated = spawnSync('node', ['--experimental-sqlite', 'prisma/migrate-arabtec-data.mjs'], {
  cwd: process.cwd(), env: migrationEnv, encoding: 'utf8',
});

c('migration refuses to run without ARABTEC_MANAGER_PASSWORD', migrated.status !== 0,
  `status=${migrated.status}`);
c('failure names ARABTEC_MANAGER_PASSWORD',
  /ARABTEC_MANAGER_PASSWORD/.test(`${migrated.stdout}\n${migrated.stderr}`));

const afterDb = new DatabaseSync(DB);
const afterDepartments = afterDb.prepare('SELECT code,name FROM department ORDER BY code').all();
afterDb.close();
c('refusal happens before destructive org-data wipe',
  JSON.stringify(afterDepartments) === JSON.stringify(beforeDepartments),
  `before=${beforeDepartments.length} after=${afterDepartments.length}`);

// Comparing departments alone was too weak. src/lib/db.js opens the database in
// its MODULE BODY — on SQLite that creates the file, switches journal_mode and
// creates/inserts/drops _journal_probe — so with a static import a refused run
// still touched the target database while printing "Nothing has been changed".
// The only assertion that catches it: point at a database that does not exist
// and require that the refusal leaves it non-existent.
const VIRGIN = `/tmp/arabtec_prod_hardening_virgin_${process.pid}.db`;
for (const f of [VIRGIN, `${VIRGIN}-journal`, `${VIRGIN}-wal`, `${VIRGIN}-shm`]) { try { fs.rmSync(f); } catch {} }
const virginRun = spawnSync('node', ['--experimental-sqlite', 'prisma/migrate-arabtec-data.mjs'], {
  cwd: process.cwd(), encoding: 'utf8',
  env: { ...baseEnv, DATABASE_URL: `file:${VIRGIN}`, ARABTEC_MANAGER_PASSWORD: '' },
});
c('a refused run against a fresh path refuses', virginRun.status !== 0, `status=${virginRun.status}`);
c('a refused run does not even CREATE the database file', !fs.existsSync(VIRGIN),
  fs.existsSync(VIRGIN) ? 'the file was created' : '');
for (const f of [VIRGIN, `${VIRGIN}-journal`, `${VIRGIN}-wal`, `${VIRGIN}-shm`]) { try { fs.rmSync(f); } catch {} }

console.log(`\n=== PRODUCTION HARDENING: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail ? 1 : 0);
