import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJob, completeJob, failJob, getJob } from './src/lib/parsing/jobs.js';

test('parse jobs disclose processing and completed payloads only to their owner', () => {
  const id = createJob(101);
  assert.equal(getJob(id, 202), null);
  assert.equal(getJob(id), null);
  assert.equal(getJob(id, 101).status, 'processing');
  completeJob(id, { preview: ['private CV'] });
  assert.equal(getJob(id, 202), null);
  assert.deepEqual(getJob(id, 101).payload, { preview: ['private CV'] });
  failJob(id, 'failed');
  assert.equal(getJob(id, 202), null);
  assert.equal(getJob(id, 101).status, 'error');
});

test('parse jobs expire on reads and late completion cannot restore expired data', () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const id = createJob(101);
    completeJob(id, { preview: ['private CV'] });
    now += 15 * 60 * 1000 + 1;
    assert.equal(getJob(id, 101), null);
    completeJob(id, { preview: ['late private CV'] });
    assert.equal(getJob(id, 101), null);
    failJob(id, 'late failure');
    assert.equal(getJob(id, 101), null);
  } finally { Date.now = originalNow; }
});

test('parse-job retention is capped even when creation outpaces expiry', () => {
  const oldest = createJob(101);
  for (let i = 0; i < 1000; i++) createJob(101);
  assert.equal(getJob(oldest, 101), null);
});
