// Route-structure guard for the requests router.
//
//   node --experimental-sqlite route_manifest_test.mjs
//
// WHY THIS EXISTS
//
// A line-range edit to requests.js silently deleted POST /:id/submit. The module
// still imported cleanly and only a downstream functional suite noticed, via a
// 404 several steps later. That is an expensive way to find a missing route.
//
// This asserts the EXACT manifest: every method/path pair, the total count, and
// no duplicates. A route that is deleted, renamed, duplicated, re-verbed, or
// accidentally nested inside another handler fails here immediately and by name.
//
// When a route is added or removed ON PURPOSE, update EXPECTED in the same
// commit. The diff then shows the structural change explicitly, which is the
// point.

process.env.DATABASE_URL = 'file:/tmp/arabtec_routes_guard.db';
import fs from 'node:fs';
for (const f of ['/tmp/arabtec_routes_guard.db', '/tmp/arabtec_routes_guard.db-journal']) { try { fs.rmSync(f); } catch {} }

let pass = 0; let fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (x ? ` ${x}` : '')); ok ? pass++ : fail++; };

/**
 * The requisition router, in registration order.
 *
 * NOTE the verb on the edit route: it is PUT /:id, not PATCH. Recorded here
 * because the difference matters to any caller and was easy to misremember.
 */
const EXPECTED = [
  ['GET', '/'],
  ['GET', '/:id'],
  ['POST', '/'],
  ['PUT', '/:id'],
  ['POST', '/:id/submit'],
  ['POST', '/:id/approve'],
  ['POST', '/:id/reject'],
  ['POST', '/:id/assign'],
  ['POST', '/:id/hold'],
  ['POST', '/:id/resume'],
  ['POST', '/:id/cancel'],
  ['POST', '/:id/close'],
  ['POST', '/:id/reopen'],
  ['GET', '/meta/form'],
  ['POST', '/:id/attachment'],
  ['GET', '/:id/attachment'],
];

const manifest = (router) => router.stack
  .filter((layer) => layer.route)
  .map((layer) => [Object.keys(layer.route.methods)[0].toUpperCase(), layer.route.path]);

const { default: requestsRouter } = await import('./src/routes/requests.js');
const actual = manifest(requestsRouter);

const key = ([m, p]) => `${m} ${p}`;
const actualKeys = actual.map(key);
const expectedKeys = EXPECTED.map(key);

console.log('\n— requests router manifest —');
c(`route count is ${EXPECTED.length}`, actual.length === EXPECTED.length,
  `found ${actual.length}`);

const missing = expectedKeys.filter((k) => !actualKeys.includes(k));
const added = actualKeys.filter((k) => !expectedKeys.includes(k));
c('no expected route is missing', missing.length === 0, missing.join(', '));
c('no unexpected route appeared', added.length === 0, added.join(', '));

const dupes = actualKeys.filter((k, i) => actualKeys.indexOf(k) !== i);
c('no duplicate method/path pair', dupes.length === 0, [...new Set(dupes)].join(', '));

c('registration order is unchanged', actualKeys.join(' | ') === expectedKeys.join(' | '));

// Per-route assertions, so a failure names the route rather than a diff blob.
console.log('\n— each route individually —');
for (const [method, path] of EXPECTED) {
  c(`${method} ${path}`, actualKeys.includes(`${method} ${path}`));
}

// The two that the previous incident turned into a real risk.
console.log('\n— routes the last regression destroyed —');
c('PUT /:id (headcount edit) is registered', actualKeys.includes('PUT /:id'));
c('POST /:id/submit is registered and is a sibling, not nested', actualKeys.includes('POST /:id/submit'));
c('POST /:id/close and POST /:id/reopen both survive',
  actualKeys.includes('POST /:id/close') && actualKeys.includes('POST /:id/reopen'));

console.log(`\n${fail === 0 ? '✓' : '✗'} route manifest: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
