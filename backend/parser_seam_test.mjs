// Parser injection seam — proves the LIVE route resolves through the registry
// and that the legacy provider still produces byte-identical output.
//
// Run: node --experimental-sqlite parser_seam_test.mjs
//
// No server boot and no database: this suite is about wiring, so it reads the
// route source and exercises the registry directly. Booting would test Express.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTE = path.join(__dirname, 'src/routes/candidates.js');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  ✗ ${name}\n      ${err.message}`); }
}

console.log('\nParser injection seam\n');

/* ---------------------------- 1. wiring ---------------------------------- */

await test('the live route no longer imports a parser implementation directly', () => {
  const src = fs.readFileSync(ROUTE, 'utf8');
  // The whole point of the seam: no static binding to an implementation.
  assert.equal(/from\s+['"]\.\.\/lib\/cv-parser\.js['"]/.test(src), false,
    'candidates.js still statically imports ../lib/cv-parser.js');
  assert.equal(/from\s+['"]\.\.\/lib\/cv\//.test(src), false,
    'candidates.js still imports a parser module from lib/cv/');
});

await test('the live route resolves every parse through getParser()', () => {
  const src = fs.readFileSync(ROUTE, 'utf8');
  assert.match(src, /import \{ getParser \} from '\.\.\/lib\/parsing\/registry\.js'/);
  // Every call site goes through the seam; none call an implementation.
  const viaSeam = (src.match(/getParser\(\)\.(parseLegacy|parseEntities)\(/g) || []).length;
  assert.ok(viaSeam >= 3, `expected >=3 seam call sites, found ${viaSeam}`);
  assert.equal(/await parseCV\(/.test(src), false, 'a direct parseCV() call remains');
  assert.equal(/await parseEntitiesFromFile\(/.test(src), false,
    'a direct parseEntitiesFromFile() call remains');
});

await test('server.js registers the provider at module scope, before any request', () => {
  const src = fs.readFileSync(path.join(__dirname, 'src/server.js'), 'utf8');
  assert.match(src, /import \{ configureParsing \} from '\.\/lib\/parsing\/composition\.js'/);
  const call = src.indexOf('configureParsing();');
  const listen = src.indexOf('app.listen(');
  assert.ok(call > -1, 'configureParsing() is never called');
  assert.ok(call < listen, 'configureParsing() must run before app.listen()');
});

/* --------------------------- 2. registry --------------------------------- */

const registry = await import('./src/lib/parsing/registry.js');
const { configureParsing, DEFAULT_PARSER_PROVIDER } = await import('./src/lib/parsing/composition.js');

await test('an unconfigured registry throws instead of guessing', () => {
  registry.resetParserRegistry();
  assert.throws(() => registry.getParser(), /No CV parser provider selected/);
});

await test('the default provider is legacy — behaviour is unchanged by this phase', () => {
  registry.resetParserRegistry();
  const selected = configureParsing();
  assert.equal(selected, 'legacy');
  assert.equal(DEFAULT_PARSER_PROVIDER, 'legacy');
  assert.equal(registry.getParser().name, 'legacy');
});

await test('selecting an unknown provider fails loudly', () => {
  registry.resetParserRegistry();
  configureParsing();
  assert.throws(() => registry.selectParser('docling'), /unknown provider "docling"/);
});

await test('a provider missing a required method is rejected at registration', () => {
  registry.resetParserRegistry();
  assert.throws(() => registry.registerParser('broken', { name: 'broken' }),
    /must implement parseLegacy and parseEntities/);
});

await test('exactly one provider is active — selection replaces, never chains', () => {
  registry.resetParserRegistry();
  configureParsing();
  const stub = { name: 'stub', parseLegacy: async () => ({}), parseEntities: async () => ({}) };
  registry.registerParser('stub', stub);
  registry.selectParser('stub');
  assert.equal(registry.getParser(), stub);
  assert.equal(registry.selectedParserName(), 'stub');
  registry.selectParser('legacy');
  assert.equal(registry.getParser().name, 'legacy');
});

/* ------------------- 3. legacy compatibility ------------------------------ */

await test('legacy provider output is identical to calling the parser directly', async () => {
  registry.resetParserRegistry();
  configureParsing();

  const cv = path.join(os.tmpdir(), `seam-cv-${process.pid}.txt`);
  fs.writeFileSync(cv, [
    'Ahmed Hassan',
    'Site Engineer',
    'Email: ahmed.hassan@example.com',
    'Mobile: +20 100 123 4567',
    '',
    'EXPERIENCE',
    'Orascom Construction — Site Engineer (2019 - Present)',
    '',
    'EDUCATION',
    'Cairo University — BSc Civil Engineering, 2018',
  ].join('\n'));

  try {
    const direct = await import('./src/lib/cv-parser.js');
    const viaSeam = registry.getParser();

    const a = await direct.parseHeuristic(cv);
    const b = await viaSeam.parseLegacy(cv);
    assert.deepEqual(b, a, 'parseLegacy diverged from parseHeuristic');

    const c = await direct.parseEntitiesFromFile(cv);
    const d = await viaSeam.parseEntities(cv);
    assert.deepEqual(d, c, 'parseEntities diverged from parseEntitiesFromFile');

    // Sanity: the fixture really did parse, so equality is not vacuous.
    assert.equal(a.full_name, 'Ahmed Hassan');
    assert.equal(a.email, 'ahmed.hassan@example.com');
    assert.ok(c.metadata.parse_status);
  } finally {
    fs.rmSync(cv, { force: true });
  }
});

/* ------------------------------ summary ---------------------------------- */

console.log(`\n${failures.length === 0 ? '✓' : '✗'} ${passed} passed, ${failures.length} failed\n`);
process.exit(failures.length === 0 ? 0 : 1);
