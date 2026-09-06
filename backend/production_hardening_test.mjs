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

console.log(`\n=== PRODUCTION HARDENING: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail ? 1 : 0);
