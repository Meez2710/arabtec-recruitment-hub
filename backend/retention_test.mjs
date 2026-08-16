// Retention enforcement — the destructive control, so it is tested as such.
//
// The assertions that matter most are the negative ones: that it does NOTHING
// unless an operator opted in, that a dry run touches nothing, and that a
// candidate still inside its window is never erased. An over-eager retention
// sweep destroys candidate data irreversibly.
//
// Run:  node --experimental-sqlite retention_test.mjs

const RID = `${process.pid}_${Date.now()}`;
const DBF = `/tmp/arabtec_retention_${RID}.db`;
process.env.DATABASE_URL = `file:${DBF}`;
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import fs from 'node:fs';

for (const f of [DBF, `${DBF}-journal`]) { try { fs.rmSync(f); } catch { /* first run */ } }

const { ensureSchema } = await import('./src/lib/schema.js');
ensureSchema();
const { run: dbRun, get: dbGet } = await import('./src/lib/db.js');
for (const [k, v] of [['candidate_counter', '0'], ['candidate_prefix', 'CAN'], ['retention_months', '24']]) {
  if (!dbGet('SELECT value FROM system_setting WHERE key=?', [k])) {
    dbRun('INSERT INTO system_setting (key, value) VALUES (?,?)', [k, v]);
  }
}
if (!dbGet('SELECT id FROM users WHERE id=1')) {
  dbRun("INSERT INTO users (id,full_name,email,password_hash) VALUES (1,'Op','op@example.test','x')");
}

const { Candidates } = await import('./src/lib/models.js');
const retention = await import('./src/lib/retention.js');

let passed = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL  ${name}\n        ${e.message}`); }
};

/** A candidate whose retention window lapsed a year ago. */
const overdue = (name, email) => {
  const c = Candidates.create({ candidateNo: Candidates.nextNo(), fullName: name, email, createdBy: 1 });
  const past = new Date(Date.now() - 365 * 86400000).toISOString();
  dbRun('UPDATE candidate SET retention_until=? WHERE id=?', [past, c.id]);
  return Candidates.byId(c.id);
};
/** A candidate still well inside its window. */
const current = (name, email) => {
  const c = Candidates.create({ candidateNo: Candidates.nextNo(), fullName: name, email, createdBy: 1 });
  const future = new Date(Date.now() + 365 * 86400000).toISOString();
  dbRun('UPDATE candidate SET retention_until=? WHERE id=?', [future, c.id]);
  return Candidates.byId(c.id);
};

console.log('\nRetention enforcement\n');

const lapsed = overdue('Lapsed Person', 'lapsed@example.test');
const inWindow = current('Current Person', 'current@example.test');
const auditBefore = dbGet('SELECT COUNT(*) c FROM audit_log').c;

check('it is OFF unless an operator opts in', () => {
  delete process.env.RETENTION_ENFORCEMENT;
  assert.equal(retention.getRetentionStatus().enforcement, 'manual');
  const started = retention.startRetentionEnforcement();
  assert.equal(started.running, false, 'a sweep was scheduled without RETENTION_ENFORCEMENT');
});

check('a dry run reports what would go, and erases nothing', () => {
  const r = retention.runRetentionSweep({ dry: true });
  assert.equal(r.dry, true);
  assert.equal(r.overdue, 1, 'expected exactly one overdue candidate');
  assert.equal(r.erased, 0, 'a dry run erased something');
  assert.equal(r.candidates[0].candidateNo, lapsed.candidate_no);
  assert.equal(Candidates.byId(lapsed.id).full_name, 'Lapsed Person', 'the record was modified by a dry run');
  assert.equal(dbGet('SELECT COUNT(*) c FROM audit_log').c, auditBefore, 'a dry run wrote audit rows');
});

check('the report identifies by candidate number, never by name', () => {
  const r = retention.runRetentionSweep({ dry: true });
  const keys = Object.keys(r.candidates[0]);
  assert.ok(!keys.includes('fullName') && !keys.includes('email'),
    `the sweep result carries personal data: ${keys.join(', ')}`);
});

const swept = retention.runRetentionSweep({ dry: false });

check('an enforced sweep erases only the lapsed candidate', () => {
  assert.equal(swept.erased, 1, 'expected one erasure');
  assert.equal(swept.failed, 0);
  const gone = Candidates.byId(lapsed.id);
  assert.equal(gone.full_name, '[Erased]', 'personal data survived the sweep');
  assert.equal(gone.email, null);
  assert.equal(gone.candidate_state, 'erased');
});

check('a candidate inside its window is untouched', () => {
  const kept = Candidates.byId(inWindow.id);
  assert.equal(kept.full_name, 'Current Person');
  assert.equal(kept.candidate_state, 'active');
});

check('the row survives so audit, counts and foreign keys stay intact', () => {
  assert.ok(Candidates.byId(lapsed.id), 'the candidate row was deleted rather than erased');
  assert.ok(dbGet('SELECT erased_at FROM candidate WHERE id=?', [lapsed.id]).erased_at);
});

check('the erasure is attributed to the policy, not to a person', () => {
  // entity_id is stored as TEXT (Audit.write stringifies it), so a numeric
  // bind would silently match nothing in SQLite.
  const row = dbGet(
    "SELECT * FROM audit_log WHERE action='candidate.data_erased' AND entity_id=? ORDER BY id DESC",
    [String(lapsed.id)]);
  assert.ok(row, 'no audit entry for an automatic erasure');
  assert.equal(row.actor_id, null, 'an automatic erasure was attributed to a user');
  assert.equal(row.actor_role, 'system');
  assert.match(String(row.new_value), /retention_policy/);
});

check('a second sweep finds nothing left to do', () => {
  const again = retention.runRetentionSweep({ dry: false });
  assert.equal(again.overdue, 0, 'an erased candidate is still reported as overdue');
  assert.equal(again.erased, 0);
});

retention.stopRetentionEnforcement();
console.log(`\n${failures.length === 0 ? 'ALL PASS' : 'FAILURES'} — ${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('failed:', failures.join(' | '));
process.exit(failures.length === 0 ? 0 : 1);
