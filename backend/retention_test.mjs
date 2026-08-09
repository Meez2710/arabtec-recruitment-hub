// Retention policy gate.
//
// Pure policy tests — no DB, no server, no network. The point is that "how long
// do we keep an unconfirmed CV" has a testable answer, and that a confirmed
// candidate can never be swept by this module.
import assert from 'node:assert/strict';
import { classify, planSweep, RETENTION, describePolicy } from './src/lib/retention.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const now = Date.UTC(2026, 7, 9, 12, 0, 0);
const ago = (ms) => now - ms;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

console.log('retention policy');

check('defaults match the stated Stage 2 policy', () => {
  assert.equal(RETENTION.tempFilesImmediate, true);
  assert.equal(RETENTION.failedUploadMs, 24 * HOUR);
  assert.equal(RETENTION.unconfirmedDraftMs, 7 * DAY);
  assert.equal(RETENTION.redactDocumentContentInLogs, true);
});

check('confirmed candidate is NEVER swept, however old', () => {
  const d = classify({ state: 'confirmed', updatedAt: ago(3650 * DAY) }, now);
  assert.equal(d.action, 'keep');
  assert.match(d.reason, /ATS retention policy/);
});

check('confirmed flag also protects, regardless of state string', () => {
  const d = classify({ state: 'draft', confirmed: true, updatedAt: ago(365 * DAY) }, now);
  assert.equal(d.action, 'keep');
});

check('failed upload kept inside 24h', () => {
  assert.equal(classify({ state: 'failed', updatedAt: ago(23 * HOUR) }, now).action, 'keep');
});

check('failed upload deleted at 24h', () => {
  assert.equal(classify({ state: 'failed', updatedAt: ago(24 * HOUR) }, now).action, 'delete');
});

check('cancelled upload follows the failed-upload window', () => {
  assert.equal(classify({ state: 'cancelled', updatedAt: ago(25 * HOUR) }, now).action, 'delete');
});

check('unconfirmed draft kept inside 7d', () => {
  assert.equal(classify({ state: 'draft', updatedAt: ago(6 * DAY) }, now).action, 'keep');
});

check('unconfirmed draft deleted at 7d', () => {
  assert.equal(classify({ state: 'draft', updatedAt: ago(7 * DAY) }, now).action, 'delete');
});

check('parsed-but-unconfirmed follows the draft window', () => {
  assert.equal(classify({ state: 'parsed', updatedAt: ago(8 * DAY) }, now).action, 'delete');
});

check('unknown state is kept, never deleted', () => {
  const d = classify({ state: 'something-new', updatedAt: ago(999 * DAY) }, now);
  assert.equal(d.action, 'keep');
  assert.match(d.reason, /unknown state/);
});

check('planSweep separates delete from keep and reports the policy', () => {
  const plan = planSweep([
    { id: 1, state: 'confirmed', updatedAt: ago(100 * DAY) },
    { id: 2, state: 'failed', updatedAt: ago(48 * HOUR) },
    { id: 3, state: 'draft', updatedAt: ago(2 * DAY) },
    { id: 4, state: 'draft', updatedAt: ago(30 * DAY) },
  ], now);
  assert.equal(plan.total, 4);
  assert.deepEqual(plan.toDelete.map((d) => d.id).sort(), [2, 4]);
  assert.deepEqual(plan.toKeep.map((d) => d.id).sort(), [1, 3]);
  assert.equal(plan.policy.failedUploadHours, 24);
  assert.equal(plan.policy.unconfirmedDraftHours, 168);
});

check('planSweep is a plan only — it performs no deletion', () => {
  const items = [{ id: 9, state: 'draft', updatedAt: ago(30 * DAY) }];
  const before = JSON.stringify(items);
  planSweep(items, now);
  assert.equal(JSON.stringify(items), before, 'planSweep mutated its input');
});

check('describePolicy states every class without leaking content', () => {
  const text = describePolicy();
  for (const needle of ['temp conversion/OCR files', 'failed/cancelled uploads',
                        'unconfirmed drafts', 'confirmed candidates', 'CV content in logs']) {
    assert.ok(text.includes(needle), `missing: ${needle}`);
  }
});

if (failures > 0) {
  console.error(`\nretention: ${failures} failure(s)`);
  process.exit(1);
}
console.log('retention: all checks passed');
