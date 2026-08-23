// HTTP-level regression for the intake route-shadowing defect.
//
// THE DEFECT THIS EXISTS TO CATCH. `GET /:id` is registered in
// routes/candidates.js BEFORE the literal `/intakes` routes. Express matches in
// registration order, so `/api/candidates/intakes` reaches the `:id` handler
// first with `req.params.id === 'intakes'`. Without the numeric guard that
// handler runs `Number('intakes')` → NaN, finds nothing, and answers
// `404 Candidate not found` — the real intake list is unreachable and the
// review screen is permanently empty.
//
// A unit test on `pendingIntakes()` cannot see this: the store is fine, the
// ROUTING is broken. So this test drives the real Express app over real HTTP
// with a throwaway SQLite database, and asserts on status codes and bodies.
//
// SYNTHETIC DATA ONLY. The CV below is invented; no real candidate PII.
//
// Run:  node --experimental-sqlite intake_route_http_test.mjs

process.env.DATABASE_URL = 'file:/tmp/arabtec_intake_route.db';
process.env.PORT = '4102';
process.env.NODE_ENV = 'test';
// Hermetic: this is a routing test, not a document-understanding test. With no
// Docling endpoint the pipeline uses the in-process local parser, so the suite
// never depends on an external service.
delete process.env.DOCLING_BASE_URL;
delete process.env.OCR_BASE_URL;

import assert from 'node:assert/strict';
import fs from 'node:fs';

const DB = '/tmp/arabtec_intake_route.db';
for (const f of [DB, `${DB}-journal`, `${DB}-wal`, `${DB}-shm`]) {
  try { fs.rmSync(f); } catch { /* first run */ }
}
try { fs.rmSync('/tmp/uploads', { recursive: true }); } catch { /* first run */ }

let passed = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL  ${name}\n        ${e.message}`); }
};

/* ----------------------------- real app, real HTTP ----------------------------- */

await import('./prisma/seed.js');
await import('./src/server.js');
await new Promise((r) => setTimeout(r, 800));

const BASE = `http://127.0.0.1:${process.env.PORT}`;

const api = async (path, { method = 'GET', token, body } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body is itself a finding */ }
  return { status: res.status, json };
};

/** Multipart upload built by hand — the app ships its own parser, no form-data dep. */
const upload = async (path, token, { filename, mimeType, content, fields = {} }) => {
  const boundary = `----arabtecIntakeRouteTest${Math.abs(Number(process.pid))}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
    + `Content-Type: ${mimeType}\r\n\r\n`));
  parts.push(Buffer.from(content));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: Buffer.concat(parts),
  });
  let json = null;
  try { json = await res.json(); } catch { /* see above */ }
  return { status: res.status, json };
};

/* --------------------------------- 1. auth --------------------------------- */

// A seeded recruiter — holds candidate.view and candidate.add, which are the two
// permissions the intake routes require. Credentials are seed defaults, not real.
const login = await api('/api/auth/login', {
  method: 'POST',
  body: { email: 'recruiter@arabtec.com', password: 'Arabtec@123' },
});
assert.equal(login.status, 200, `recruiter login failed: HTTP ${login.status}`);
const token = login.json.token;

check('the seeded reviewer holds candidate view and add', () => {
  const perms = login.json.user?.permissions || [];
  assert.ok(perms.includes('candidate.view'), 'missing candidate.view');
  assert.ok(perms.includes('candidate.add'), 'missing candidate.add');
});

/* ------------------------- 2. the route is reachable ------------------------ */

const intakesBefore = await api('/api/candidates/intakes', { token });

check('GET /api/candidates/intakes answers 200', () => {
  assert.equal(intakesBefore.status, 200, `got HTTP ${intakesBefore.status}`);
});

check('the response carries an intakes array', () => {
  assert.ok(Array.isArray(intakesBefore.json?.intakes),
    `expected an intakes array, got ${JSON.stringify(intakesBefore.json)?.slice(0, 120)}`);
});

check('it is NOT served by the /:id handler', () => {
  // The three fingerprints of the defect, each checked separately so a failure
  // says which one regressed.
  assert.notEqual(intakesBefore.status, 404, '404 — `intakes` was read as a candidate id');
  assert.ok(!('candidate' in (intakesBefore.json || {})),
    'the body is a candidate payload — /:id handled the request');
  assert.doesNotMatch(String(intakesBefore.json?.error ?? ''), /Candidate not found/,
    'answered "Candidate not found" — `intakes` was read as a candidate id');
});

const missing = await api('/api/candidates/999999', { token });

check('the /:id handler is still live for a real numeric id', () => {
  // Without this the test above could pass simply because /:id stopped working.
  // A numeric id must still reach it and 404 honestly.
  assert.equal(missing.status, 404, `expected 404 for an unknown candidate, got ${missing.status}`);
  assert.match(String(missing.json?.error ?? ''), /Candidate not found/);
});

/* --------------------------- 3. upload a synthetic CV ------------------------ */

const CV = [
  'Nadia Kamal',
  'Cairo, Egypt',
  'nadia.kamal@example.test',
  '+20 100 555 0177',
  '',
  'SUMMARY',
  'Planning engineer with 7 years of experience on infrastructure projects.',
  '',
  'EXPERIENCE',
  'Senior Planning Engineer at Orion Contracting',
  '2019 - Present',
  '',
  'EDUCATION',
  'BSc in Civil Engineering, Cairo University, 2016',
  '',
  'SKILLS',
  'Primavera P6, AutoCAD, Excel',
].join('\n');

const countCandidates = async () => {
  const res = await api('/api/candidates?page=1&pageSize=1', { token });
  assert.equal(res.status, 200, `candidate list failed: HTTP ${res.status}`);
  return res.json.pagination.total;
};

const candidatesBefore = await countCandidates();

const parsed = await upload('/api/candidates/parse-cv', token, {
  filename: 'synthetic-cv.txt', mimeType: 'text/plain', content: CV,
});

check('POST /api/candidates/parse-cv accepts the upload', () => {
  assert.equal(parsed.status, 200, `got HTTP ${parsed.status}: ${JSON.stringify(parsed.json)?.slice(0, 200)}`);
  assert.ok(parsed.json?.intake, `no intake was returned: ${parsed.json?.reason ?? 'no reason given'}`);
});

check('the returned intake is PENDING and holds nothing decided', () => {
  const intake = parsed.json.intake;
  assert.equal(intake.status, 'PENDING', `intake status is ${intake.status}`);
  assert.equal(intake.candidateId ?? null, null, 'a candidate was created by parsing');
  assert.ok(intake.fields.length > 0, 'the intake carries no fields');
  for (const f of intake.fields) {
    assert.equal(f.decision, 'PENDING', `${f.field} was already decided`);
  }
});

const candidatesAfterParse = await countCandidates();

check('parsing created NO candidate', () => {
  assert.equal(candidatesAfterParse, candidatesBefore,
    `candidate count moved ${candidatesBefore} → ${candidatesAfterParse} without a review`);
});

/* --------------------- 4. the new intake shows up on the route --------------- */

const intakesAfter = await api('/api/candidates/intakes', { token });

check('the new intake appears in GET /api/candidates/intakes', () => {
  assert.equal(intakesAfter.status, 200, `got HTTP ${intakesAfter.status}`);
  const ids = (intakesAfter.json.intakes || []).map((i) => i.id);
  assert.ok(ids.includes(parsed.json.intake.id),
    `intake ${parsed.json.intake.id} is not in [${ids.join(', ')}]`);
  assert.equal(intakesAfter.json.intakes.length, intakesBefore.json.intakes.length + 1,
    'the pending list did not grow by exactly one');
});

/* ---------------------------------- report ---------------------------------- */

console.log(`\n${failures.length === 0 ? 'ALL PASS' : 'FAILURES'} — ${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('failed:', failures.join(' | '));
process.exit(failures.length === 0 ? 0 : 1);
