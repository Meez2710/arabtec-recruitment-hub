// Parser injection seam — proves the LIVE route resolves through the registry
// and that the selected provider is the document pipeline.
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

await test('attaching a CV to an existing candidate proposes, it does not fill', () => {
  const src = fs.readFileSync(ROUTE, 'utf8');
  // The old behaviour: parse a CV and write every value into the candidate's
  // empty columns. Replaced by raising a PENDING proposal.
  assert.equal(/parseAndFill/.test(src), false, 'parseAndFill still exists');
  assert.match(src, /async function parseAndPropose\(/);
  assert.match(src, /raiseProposal\(/);
  // The reparse route no longer takes an overwrite flag, because it no longer
  // writes anything to overwrite.
  assert.equal(/parseAndPropose\([^)]*overwrite/.test(src), false,
    'the propose path still accepts an overwrite flag');
});

await test('the review endpoint is the only path from a proposal to the record', () => {
  const src = fs.readFileSync(ROUTE, 'utf8');
  assert.match(src, /proposals\/:pid\/review/);
  // reviewProposal owns the candidate UPDATE; the routes never build one for a
  // proposed value themselves.
  assert.match(src, /reviewProposal\(/);
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

await test('the default provider is the document pipeline', () => {
  registry.resetParserRegistry();
  const selected = configureParsing();
  assert.equal(selected, 'document-pipeline');
  assert.equal(DEFAULT_PARSER_PROVIDER, 'document-pipeline');
  assert.equal(registry.getParser().name, 'document-pipeline');
});

await test('the legacy heuristic provider is no longer registered', () => {
  registry.resetParserRegistry();
  configureParsing();
  // Exactly ONE production parsing path. The legacy files still exist on disk
  // (removal is a later, separately verified step) but nothing can select them.
  assert.throws(() => registry.selectParser('legacy'), /unknown provider "legacy"/);
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
  registry.selectParser('document-pipeline');
  assert.equal(registry.getParser().name, 'document-pipeline');
});

/* ------------------- 3. the pipeline provider ----------------------------- */

await test('the selected provider extracts evidence-bearing fields from a real CV', async () => {
  registry.resetParserRegistry();
  configureParsing();

  const cv = path.join(os.tmpdir(), `seam-cv-${process.pid}.txt`);
  fs.writeFileSync(cv, [
    'Ahmed Hassan',
    'Cairo, Egypt',
    'ahmed.hassan@example.test',
    '+20 100 123 4567',
    '',
    'EXPERIENCE',
    'Senior Structural Engineer at Arabtec Construction',
    '',
    'EDUCATION',
    'BSc in Civil Engineering, Cairo University, 2015',
  ].join('\n'));

  try {
    const provider = registry.getParser();

    const flat = await provider.parseLegacy(cv);
    assert.equal(flat.full_name, 'Ahmed Hassan');
    assert.equal(flat.email, 'ahmed.hassan@example.test');
    assert.notEqual(flat.extraction_status, 'failed');

    const rich = await provider.parseEntities(cv);
    assert.equal(rich.metadata.parsed_by, 'document-pipeline');
    assert.equal(rich.personal.full_name.value, 'Ahmed Hassan');
    assert.equal(rich.education.university.value, 'Cairo University');
    assert.equal(rich.education.graduation_year.value, 2015);

    // EVERY persisted value cites where it was read from — the thing the
    // previous parser could not do at all.
    for (const group of ['personal', 'employment', 'education']) {
      for (const [name, field] of Object.entries(rich[group])) {
        if (field.value === null) continue;
        assert.ok(field.evidence, `${name} has no evidence snippet`);
        assert.ok(field.source && field.source.blockId, `${name} has no source block`);
      }
    }
  } finally {
    fs.rmSync(cv, { force: true });
  }
});

await test('a value the document does not contain is never persistable', async () => {
  registry.resetParserRegistry();
  configureParsing();

  const cv = path.join(os.tmpdir(), `seam-thin-${process.pid}.txt`);
  // No name anywhere: the old heuristic invented one from the FILENAME.
  fs.writeFileSync(cv, 'ahmed.hassan@example.test\n+20 100 123 4567\n');

  try {
    const rich = await registry.getParser().parseEntities(cv);
    const { toCandidatePayload } = await import('./src/lib/cv-mapper.js');
    const { payload } = toCandidatePayload(rich);
    assert.equal(payload.fullName, undefined, 'a name was invented from the filename');
    assert.equal(payload.email, 'ahmed.hassan@example.test');
  } finally {
    fs.rmSync(cv, { force: true });
  }
});

/* ------------------------------ summary ---------------------------------- */

console.log(`\n${failures.length === 0 ? '✓' : '✗'} ${passed} passed, ${failures.length} failed\n`);
process.exit(failures.length === 0 ? 0 : 1);
