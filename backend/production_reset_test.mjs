// Production readiness reset — clear the pipeline, keep the company.
//
// Run: node --experimental-sqlite production_reset_test.mjs
//
// The ATS was hand-tested repeatedly before go-live, so the database carries
// candidates and hiring requests nobody wants the client to see. This proves the
// reset removes exactly those and nothing else — the failure that matters is not
// "it deleted too little", it is "it deleted the company".
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const DB = `/tmp/arabtec_prod_reset_${process.pid}.db`;
for (const f of [DB, `${DB}-journal`, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f); } catch {} }

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
  SEED_ADMIN_PASSWORD: 'ProdReset@Test1',
  SMTP_TRANSPORT: 'json',
};
const node = (args, env = baseEnv) =>
  spawnSync('node', ['--experimental-sqlite', ...args], { cwd: process.cwd(), env, encoding: 'utf8' });

const open = () => new DatabaseSync(DB);
const countIn = (db, t) => { try { return db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch { return null; } };
const snapshot = (tables) => { const db = open(); const o = {}; for (const t of tables) o[t] = countIn(db, t); db.close(); return o; };

const PIPELINE = ['candidate', 'application', 'recruitment_request', 'interview', 'offer', 'candidate_intake', 'notification'];
const COMPANY = ['users', 'role', 'permission', 'department', 'project', 'designation',
  'business_unit', 'branding_setting', 'button_config', 'system_setting', 'notification_config', 'audit_log'];

console.log('\n— production reset: clear the pipeline, keep the company —');

c('fixture seed succeeds', node(['prisma/seed.js']).status === 0);

// The org load is what makes this a realistic production box rather than an
// empty one: the reset must leave all of it standing.
c('real org data loads', node(['prisma/migrate-arabtec-data.mjs'],
  { ...baseEnv, ARABTEC_MANAGER_PASSWORD: 'Correct#Horse#Battery1' }).status === 0);

// Stand in for the hand-created test data.
(() => {
  const db = open();
  for (let i = 1; i <= 5; i++) {
    db.prepare('INSERT INTO candidate (candidate_no, full_name, email) VALUES (?,?,?)')
      .run(`CAN-0000${i}`, `Test Person ${i}`, `t${i}@example.test`);
  }
  for (let i = 1; i <= 3; i++) {
    db.prepare("INSERT INTO recruitment_request (ticket_no,title,status,headcount) VALUES (?,?,'sourcing',1)")
      .run(`REQ-2026-0000${i}`, `Test Requisition ${i}`);
  }
  db.prepare('INSERT INTO application (application_no,candidate_id,request_id,status) VALUES (?,?,?,?)')
    .run('APP-00001', 1, 1, 'sourced');
  db.prepare("INSERT INTO notification (user_id,type,title) VALUES (1,'x','stale alert')").run();
  for (const [k, v] of [['candidate_counter', '5'], ['request_counter', '3']]) {
    db.prepare('UPDATE system_setting SET value=? WHERE key=?').run(v, k);
  }
  db.close();
})();

const before = snapshot([...PIPELINE, ...COMPANY]);
c('fixture has a pipeline to clear', before.candidate === 5 && before.recruitment_request === 3);
c('fixture has company data to protect', before.department > 0 && before.designation > 0 && before.users > 0);

console.log('\n— it fails closed —');
const unconfirmed = node(['prisma/reset-transactional-data.mjs']);
c('refuses without ARABTEC_RESET_CONFIRM=RESET', unconfirmed.status !== 0, `status=${unconfirmed.status}`);
c('the refusal names the variable', /ARABTEC_RESET_CONFIRM/.test(`${unconfirmed.stdout}${unconfirmed.stderr}`));
const wrongValue = node(['prisma/reset-transactional-data.mjs'], { ...baseEnv, ARABTEC_RESET_CONFIRM: 'yes' });
c('refuses a confirmation that is not exactly RESET', wrongValue.status !== 0, `status=${wrongValue.status}`);
c('a refusal deletes nothing',
  JSON.stringify(snapshot([...PIPELINE, ...COMPANY])) === JSON.stringify(before));

console.log('\n— dry run reports without deleting —');
const dry = node(['prisma/reset-transactional-data.mjs', '--dry-run']);
c('dry run needs no confirmation and succeeds', dry.status === 0, `status=${dry.status}`);
c('dry run names what it would delete', /would delete 5 from candidate/.test(dry.stdout), '');
c('dry run changed nothing',
  JSON.stringify(snapshot([...PIPELINE, ...COMPANY])) === JSON.stringify(before));

console.log('\n— the reset itself —');
const reset = node(['prisma/reset-transactional-data.mjs'], { ...baseEnv, ARABTEC_RESET_CONFIRM: 'RESET' });
c('reset succeeds', reset.status === 0, reset.status === 0 ? '' : reset.stderr.slice(-300));

const after = snapshot([...PIPELINE, ...COMPANY]);
for (const t of PIPELINE) {
  if (after[t] === null) continue;
  c(`${t} is zero`, after[t] === 0, `got ${after[t]}`);
}
c('business-number counters are back to 0', (() => {
  const db = open();
  const rows = db.prepare("SELECT key,value FROM system_setting WHERE key LIKE '%_counter'").all();
  db.close();
  return rows.length > 0 && rows.every((r) => r.value === '0');
})());

console.log('\n— and the company is still there —');
for (const t of COMPANY) {
  if (before[t] === null) continue;
  // audit_log is expected to GROW: the reset records itself.
  const ok = t === 'audit_log' ? after[t] >= before[t] : after[t] === before[t];
  c(`${t} untouched`, ok, `${before[t]} -> ${after[t]}`);
}
c('the 41 imported managers survived', after.users === before.users && after.users >= 42, `users=${after.users}`);
c('the reset recorded itself in the audit log', (() => {
  const db = open();
  const row = db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='system.production_reset'").get();
  db.close();
  return row.c === 1;
})());

console.log('\n— review regressions —');

// A refused run must not even open the database (db.js opens it in its module
// body, so a static import mutated the target before the guard could refuse).
const VIRGIN = `/tmp/arabtec_prod_reset_virgin_${process.pid}.db`;
for (const f of [VIRGIN, `${VIRGIN}-journal`, `${VIRGIN}-wal`, `${VIRGIN}-shm`]) { try { fs.rmSync(f); } catch {} }
const refusedVirgin = node(['prisma/reset-transactional-data.mjs'],
  { ...baseEnv, DATABASE_URL: `file:${VIRGIN}`, ARABTEC_RESET_CONFIRM: '' });
c('a refused reset does not create the database file',
  refusedVirgin.status !== 0 && !fs.existsSync(VIRGIN),
  fs.existsSync(VIRGIN) ? 'the file was created' : '');
for (const f of [VIRGIN, `${VIRGIN}-journal`, `${VIRGIN}-wal`, `${VIRGIN}-shm`]) { try { fs.rmSync(f); } catch {} }

// The CV bytes must go with the rows, or real people's CVs survive in the blob
// store and in every backup taken afterwards.
c('stored CV blobs were purged with their rows', (() => {
  const db2 = open();
  let orphans = 0;
  try {
    orphans = db2.prepare("SELECT COUNT(*) c FROM file_blob WHERE original_name LIKE '%.pdf'").get().c;
  } catch { orphans = 0; }
  db2.close();
  return orphans === 0;
})());

// ...while assets that belong to the company survive.
c('unrelated blobs are left alone', (() => {
  const db2 = open();
  db2.prepare("INSERT INTO file_blob (stored_name,original_name,mime,size,data) VALUES ('brand.png','logo.png','image/png',3,X'010203')").run();
  db2.close();
  const r = node(['prisma/reset-transactional-data.mjs'], { ...baseEnv, ARABTEC_RESET_CONFIRM: 'RESET' });
  const db3 = open();
  const kept = db3.prepare("SELECT COUNT(*) c FROM file_blob WHERE stored_name='brand.png'").get().c;
  db3.close();
  return r.status === 0 && kept === 1;
})());

// A file left in CV_INBOX would be re-imported by the next scan and recreate
// the candidates just deleted, because the scanner de-dupes on the very hashes
// this reset removes.
const INBOX = `/tmp/arabtec_reset_inbox_${process.pid}`;
fs.rmSync(INBOX, { recursive: true, force: true });
fs.mkdirSync(INBOX, { recursive: true });
fs.writeFileSync(`${INBOX}/leftover-cv.pdf`, '%PDF-1.4 leftover');
const withInbox = node(['prisma/reset-transactional-data.mjs'],
  { ...baseEnv, ARABTEC_RESET_CONFIRM: 'RESET', CV_INBOX: INBOX });
c('the reset drains CV_INBOX so the next scan cannot re-import it',
  withInbox.status === 0 && !fs.existsSync(`${INBOX}/leftover-cv.pdf`), 'the file was left in place');
c('the drained file is archived, not destroyed', (() => {
  const archives = fs.readdirSync(INBOX).filter((d) => d.startsWith('.pre-golive-'));
  return archives.length === 1 && fs.existsSync(`${INBOX}/${archives[0]}/leftover-cv.pdf`);
})());
fs.rmSync(INBOX, { recursive: true, force: true });

console.log('\n— running it twice is safe —');
const again = node(['prisma/reset-transactional-data.mjs'], { ...baseEnv, ARABTEC_RESET_CONFIRM: 'RESET' });
c('second run succeeds and is a no-op', again.status === 0);
const third = snapshot([...PIPELINE, ...COMPANY]);
c('company data still intact after a second run',
  COMPANY.filter((t) => t !== 'audit_log').every((t) => third[t] === before[t]));

for (const f of [DB, `${DB}-journal`, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f); } catch {} }
console.log(`\n=== PRODUCTION RESET: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail ? 1 : 0);
