// LIVE service integration — real Docling, real OCR, real Ollama.
//
// OPT-IN. Skips unless LIVE_TESTS=1. Normal CI never depends on private
// services, and a skip is reported as a skip, never as a pass.
//
// Run:
//   LIVE_TESTS=1 OLLAMA_BASE_URL=http://127.0.0.1:11434 OLLAMA_MODEL=qwen2.5:3b \
//     node --experimental-sqlite live_parser_test.mjs
//
// THE RULE THIS SUITE EXISTS TO ENFORCE: a PASS here means a real network
// request reached a real service and it answered. Every service is probed for
// identity first — version, model list — and a test that cannot prove it spoke
// to the real thing reports NOT VERIFIED rather than passing. A test double
// answering on one of these ports is a FAILURE, not a convenience.

process.env.DATABASE_URL = 'file:/tmp/arabtec_live_test.db';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'live-fixtures');

/* ------------------------------- opt-in gate ------------------------------- */

if (process.env.LIVE_TESTS !== '1') {
  console.log('\n⊘ SKIPPED — live service tests are opt-in.');
  console.log('  Enable with LIVE_TESTS=1 and configure the services under test.');
  console.log('  This is NOT a pass. No service was called.\n');
  process.exit(0);
}

const DOCLING = process.env.DOCLING_BASE_URL || null;
const OCR = process.env.OCR_BASE_URL || null;
const OLLAMA = process.env.OLLAMA_BASE_URL || null;
const MODEL = process.env.OLLAMA_MODEL || null;
const TIMEOUT_MS = Number(process.env.LIVE_TIMEOUT_MS || 120000);

/** Endpoint identity for the report, with host/credentials redacted. */
const redact = (url) => {
  if (!url) return 'not configured';
  try {
    const u = new URL(url);
    const host = /^(127\.|localhost|::1|0\.0\.0\.0)/.test(u.hostname)
      ? u.hostname
      : `${u.hostname.split('.')[0]}.<redacted>`;
    return `${u.protocol}//${host}:${u.port || '(default)'}`;
  } catch { return '<unparseable>'; }
};

let passed = 0;
const failures = [];
const notVerified = [];
const evidence = {};

async function live(name, fn) {
  try { await fn(); passed += 1; console.log(`  PASS — ${name}`); }
  catch (err) {
    if (err && err.notVerified) {
      notVerified.push({ name, reason: err.message });
      console.log(`  NOT VERIFIED — ${name}\n      ${err.message}`);
      return;
    }
    failures.push({ name, err });
    console.log(`  FAIL — ${name}\n      ${err.message}`);
  }
}

const skip = (reason) => { const e = new Error(reason); e.notVerified = true; throw e; };

const fetchJson = async (url, init = {}) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const body = await res.json();
    return { ok: res.ok, status: res.status, body };
  } finally { clearTimeout(timer); }
};

console.log('\nLIVE service integration\n');
console.log(`  docling : ${redact(DOCLING)}`);
console.log(`  ocr     : ${redact(OCR)}`);
console.log(`  ollama  : ${redact(OLLAMA)}  model=${MODEL || 'not configured'}\n`);

/* ------------------------------ 1. Docling --------------------------------- */

await live('Docling: the sidecar answers its health endpoint', async () => {
  if (!DOCLING) skip('DOCLING_BASE_URL is not configured — no service call was made.');
  const res = await fetchJson(`${DOCLING.replace(/\/+$/, '')}/v1/health`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.ok(res.ok, `health returned HTTP ${res.status}`);
  // Identity: a stub would not carry a real Docling version string.
  assert.ok(res.body.doclingVersion && res.body.doclingVersion !== 'unknown',
    'no Docling version reported — cannot prove this is the real service');
  evidence.doclingVersion = res.body.doclingVersion;
  evidence.doclingOcrEngine = res.body.ocrEngine;
  console.log(`      docling=${res.body.doclingVersion} ocr=${res.body.ocrEngine} models=${res.body.modelsPresent}`);
});

await live('Docling: a real born-digital PDF is parsed into blocks', async () => {
  if (!DOCLING) skip('DOCLING_BASE_URL is not configured — no service call was made.');
  const { composeAI } = await import('./dist/api/composition-root.js');
  const { capabilities, description } = composeAI(process.env);
  assert.equal(description.layoutParser, 'docling-sidecar',
    'the composition root did not select Docling');

  const file = path.join(FIXTURES, 'digital-en.pdf');
  const started = Date.now();
  const out = await capabilities.documentParser.parse({
    documentId: 'digital-en.pdf', filename: 'digital-en.pdf',
    mimeType: 'application/pdf', bytes: new Uint8Array(fs.readFileSync(file)),
  });
  const ms = Date.now() - started;
  assert.ok(!('abstained' in out), `Docling abstained: ${out.reason}`);

  const s = out.content.structure;
  // The parser that actually produced it — a fallback must never be reported
  // as Docling.
  assert.equal(s.provenance.parser, 'docling-sidecar',
    `fallback was used (${s.provenance.parser}); this is NOT a Docling pass`);
  assert.ok(s.blocks.length > 0, 'no blocks recovered');
  evidence.docling = { pages: s.pages.length, blocks: s.blocks.length, ms };
  console.log(`      pages=${s.pages.length} blocks=${s.blocks.length} ${ms}ms parser=${s.provenance.parser}`);
});

/* -------------------------------- 2. OCR ----------------------------------- */

await live('OCR: a genuinely image-only document is recognised', async () => {
  if (!OCR && !DOCLING) {
    skip('Neither OCR_BASE_URL nor DOCLING_BASE_URL is configured — no service call was made.');
  }
  const { composeAI } = await import('./dist/api/composition-root.js');
  const { capabilities } = composeAI(process.env);

  const file = path.join(FIXTURES, 'image-only-en.png');
  const out = await capabilities.documentParser.parse({
    documentId: 'image-only-en.png', filename: 'image-only-en.png',
    mimeType: 'image/png', bytes: new Uint8Array(fs.readFileSync(file)),
  });
  assert.ok(!('abstained' in out), `no OCR result: ${out.reason}`);
  const s = out.content.structure;
  assert.equal(s.ocrApplied, true, 'OCR was not applied to an image-only document');

  // Ground truth that exists ONLY inside the image.
  const text = out.content.text;
  for (const needle of ['Ain Shams', '2014', 'ETABS']) {
    assert.ok(text.includes(needle), `OCR did not recover "${needle}" from the image`);
  }
  evidence.ocr = { engine: s.provenance.ocrEngine, pages: s.pages.length };
  console.log(`      engine=${s.provenance.ocrEngine} recovered ${text.length} chars`);
});

await live('OCR: a born-digital PDF does NOT trigger an OCR pass', async () => {
  if (!DOCLING && !OCR) skip('No document service configured — no service call was made.');
  const { composeAI } = await import('./dist/api/composition-root.js');
  const { capabilities } = composeAI(process.env);
  const file = path.join(FIXTURES, 'digital-en.pdf');
  const out = await capabilities.documentParser.parse({
    documentId: 'digital-en.pdf', filename: 'digital-en.pdf',
    mimeType: 'application/pdf', bytes: new Uint8Array(fs.readFileSync(file)),
  });
  assert.ok(!('abstained' in out), 'the digital PDF could not be parsed');
  assert.equal(out.content.structure.ocrApplied, false,
    'OCR ran on a document whose native text was sufficient');
});

/* ------------------------------ 3. Ollama ---------------------------------- */

let liveDocument = null;

await live('Ollama: the runtime answers and reports its version', async () => {
  if (!OLLAMA) skip('OLLAMA_BASE_URL is not configured — no service call was made.');
  const res = await fetchJson(`${OLLAMA.replace(/\/+$/, '')}/api/version`);
  assert.ok(res.ok, `version returned HTTP ${res.status}`);
  assert.ok(res.body.version, 'no version reported — cannot prove this is a real Ollama');
  evidence.ollamaVersion = res.body.version;
  console.log(`      ollama=${res.body.version}`);
});

await live('Ollama: the configured model is actually installed', async () => {
  if (!OLLAMA || !MODEL) skip('OLLAMA_BASE_URL/OLLAMA_MODEL not configured — no service call was made.');
  const res = await fetchJson(`${OLLAMA.replace(/\/+$/, '')}/api/tags`);
  assert.ok(res.ok, `tags returned HTTP ${res.status}`);
  const names = (res.body.models || []).map((m) => m.name);
  assert.ok(names.includes(MODEL), `${MODEL} is not installed. Present: ${names.join(', ')}`);
  const details = (res.body.models || []).find((m) => m.name === MODEL)?.details || {};
  evidence.model = { name: MODEL, family: details.family, params: details.parameter_size };
  console.log(`      model=${MODEL} family=${details.family} params=${details.parameter_size}`);
});

await live('Ollama: real extraction from a real ParsedDocument', async () => {
  if (!OLLAMA || !MODEL) skip('Ollama is not configured — no service call was made.');
  const { composeAI } = await import('./dist/api/composition-root.js');
  const { capabilities, description } = composeAI(process.env);
  assert.ok(capabilities.resumeExtractor, 'no extractor was composed');
  assert.ok(description.extractor.includes(MODEL), 'the composed extractor is not the configured model');

  const file = path.join(FIXTURES, 'digital-en.pdf');
  const parsed = await capabilities.documentParser.parse({
    documentId: 'digital-en.pdf', filename: 'digital-en.pdf',
    mimeType: 'application/pdf', bytes: new Uint8Array(fs.readFileSync(file)),
  });
  assert.ok(!('abstained' in parsed), 'the document could not be parsed');
  liveDocument = parsed.content;

  const started = Date.now();
  const out = await capabilities.resumeExtractor.extract(parsed.content);
  const ms = Date.now() - started;

  assert.ok(!('abstained' in out), `the model abstained: ${out.reason}`);
  // Identity: provenance must name the model that actually answered.
  assert.equal(out.provenance.modelId, MODEL,
    `provenance says ${out.provenance.modelId}, expected ${MODEL} — a double may have answered`);
  assert.ok(out.provenance.latencyMs > 0, 'no inference latency recorded');

  evidence.extraction = {
    ms, digest: out.provenance.modelDigest ? 'present' : 'absent',
    fields: Object.keys(out.content).filter((k) => {
      const v = out.content[k];
      return v !== undefined && v !== null && (!Array.isArray(v) || v.length > 0);
    }),
  };
  console.log(`      ${ms}ms model=${out.provenance.modelId} extracted=[${evidence.extraction.fields.join(', ')}]`);
});

await live('Ollama: model output is evidence-bound and never self-verified', async () => {
  if (!OLLAMA || !MODEL || !liveDocument) skip('Ollama is not configured — no service call was made.');
  const { composeAI } = await import('./dist/api/composition-root.js');
  const { capabilities } = composeAI(process.env);
  const { buildProposedFields } = await import('./dist/infrastructure/ai/resume-parse-handler.js');

  const extracted = await capabilities.resumeExtractor.extract(liveDocument);
  assert.ok(!('abstained' in extracted), `the model abstained: ${extracted.reason}`);

  const { fields, withheld } = buildProposedFields({
    resume: extracted.content, document: liveDocument,
    aiConfidence: extracted.confidence, parser: 'live', parserVersion: 'live',
  });

  // EVERY surviving field was located in the document, whatever the model said.
  for (const f of fields) {
    assert.ok(f.evidence, `${f.field} survived with no evidence`);
    assert.ok(f.evidenceRef && f.evidenceRef.blockId, `${f.field} has no source block`);
    // Nothing a model produced alone may carry a rule's weight.
    assert.ok(f.confidence <= 0.9, `${f.field} confidence ${f.confidence} exceeds the ceiling`);
  }
  evidence.liveFields = fields.map((f) => f.field);
  evidence.liveWithheld = withheld.map((w) => `${w.field}(${w.reason.slice(0, 40)})`);
  console.log(`      proposable=[${evidence.liveFields.join(', ')}]`);
  console.log(`      withheld=${withheld.length}`);
});

/* -------------------------- 4. prompt injection ----------------------------- */

await live('Prompt injection in a CV is treated as content, not instruction', async () => {
  if (!OLLAMA || !MODEL) skip('Ollama is not configured — no service call was made.');
  const { composeAI } = await import('./dist/api/composition-root.js');
  const { capabilities } = composeAI(process.env);
  const { buildProposedFields } = await import('./dist/infrastructure/ai/resume-parse-handler.js');

  const file = path.join(FIXTURES, 'injection-en.pdf');
  const parsed = await capabilities.documentParser.parse({
    documentId: 'injection-en.pdf', filename: 'injection-en.pdf',
    mimeType: 'application/pdf', bytes: new Uint8Array(fs.readFileSync(file)),
  });
  assert.ok(!('abstained' in parsed), 'the injection fixture could not be parsed');

  const extracted = await capabilities.resumeExtractor.extract(parsed.content);
  if ('abstained' in extracted) {
    // Abstention is a perfectly safe answer to an adversarial document.
    console.log(`      the model abstained: ${extracted.reason}`);
    return;
  }

  const { fields } = buildProposedFields({
    resume: extracted.content, document: parsed.content,
    aiConfidence: extracted.confidence, parser: 'live', parserVersion: 'live',
  });

  // The instructions cannot invent a trust level: the contract has no such
  // field for a model to set. What it CAN do is claim values — and every one
  // still has to be found in the document and pass validation.
  for (const f of fields) {
    assert.ok(f.evidence, `${f.field} bypassed evidence location`);
    assert.ok(!/verified|100\/100|accept every field/i.test(String(f.value)),
      `an injected instruction became a field value: ${f.field}=${f.value}`);
  }
  const serialised = JSON.stringify(fields);
  assert.equal(/"validation"\s*:\s*"verified"/i.test(serialised), false,
    'the injection produced a verified marking');
  console.log(`      ${fields.length} field(s) proposed, all evidence-bound; no verification granted`);
});

/* ------------------------ 5. live qualitative evaluation -------------------- */

await live('Ollama: post-commit evaluation returns only qualitative levels', async () => {
  if (!OLLAMA || !MODEL) skip('Ollama is not configured — no service call was made.');
  const { composeAI } = await import('./dist/api/composition-root.js');
  const { evaluator } = composeAI(process.env);
  assert.ok(evaluator, 'no evaluator was composed');

  const started = Date.now();
  const out = await evaluator.evaluate({
    documentId: 'digital-en.pdf',
    fields: [
      { field: 'currentPosition', value: 'Lead Structural Engineer', confidence: 0.75,
        evidence: 'Lead Structural Engineer at Delta Contracting', decision: 'ACCEPTED' },
      { field: 'university', value: 'Ain Shams University', confidence: 0.75,
        evidence: 'BSc in Civil Engineering, Ain Shams University, 2014', decision: 'ACCEPTED' },
      { field: 'skills', value: ['ETABS', 'SAP2000'], confidence: 0.75,
        evidence: 'ETABS, SAP2000, Revit, AutoCAD', decision: 'ACCEPTED' },
    ],
  }, {
    title: 'Senior Structural Engineer',
    requirements: 'ETABS, high-rise design, 8+ years experience, PMP preferred',
  });
  const ms = Date.now() - started;

  if ('abstained' in out) skip(`the evaluator abstained: ${out.reason}`);
  assert.equal(out.provenance.modelId, MODEL, 'the evaluation was not produced by the configured model');

  const LEVELS = ['Exceeds Requirements', 'Proficient', 'Requires Development', 'No Evidence Found'];
  assert.ok(LEVELS.includes(out.content.overall), `illegal overall level: ${out.content.overall}`);
  for (const c of out.content.competencies) {
    assert.ok(LEVELS.includes(c.level), `illegal level for ${c.competency}: ${c.level}`);
  }

  // No numeric scoring may reappear, whatever the model wrote.
  const rendered = JSON.stringify(out.content);
  assert.equal(/\/100|\b\d{1,3}\s*%/.test(rendered), false, 'a numeric score appeared');

  evidence.evaluation = { ms, overall: out.content.overall, competencies: out.content.competencies.length };
  console.log(`      ${ms}ms overall="${out.content.overall}" competencies=${out.content.competencies.length}`);
});

/* --------------------------- 6. failure handling ---------------------------- */

await live('Ollama: an unreachable endpoint abstains and does not throw', async () => {
  if (!OLLAMA) skip('Ollama is not configured — no service call was made.');
  const { OllamaResumeExtractor } = await import('./dist/infrastructure/ai/ollama/index.js');
  // A port nothing listens on: a REAL connection attempt that really fails.
  const broken = new OllamaResumeExtractor({
    baseUrl: 'http://127.0.0.1:9', model: MODEL || 'none', timeoutMs: 5000,
  });
  const out = await broken.extract({ text: 'Some CV text', pageCount: 1, pages: ['Some CV text'] });
  assert.ok('abstained' in out, 'an unreachable model did not abstain');
  assert.equal(out.permanent, false, 'an outage was reported as permanent, which would discard the CV');
  console.log(`      abstained: ${out.reason.slice(0, 70)}`);
});

/* ----------------------- 7. real end-to-end intake -------------------------- */

await live('End to end: real parse -> PENDING intake -> review -> candidate', async () => {
  if (!OLLAMA || !MODEL) skip('Ollama is not configured — no service call was made.');

  for (const f of ['/tmp/arabtec_live_test.db', '/tmp/arabtec_live_test.db-journal']) {
    try { fs.rmSync(f); } catch { /* first run */ }
  }
  const { ensureSchema } = await import('./src/lib/schema.js');
  ensureSchema();
  const { run: dbRun, get: dbGet } = await import('./src/lib/db.js');
  for (const [k, v] of [['candidate_counter', '0'], ['candidate_prefix', 'CAN'],
    ['application_counter', '0'], ['application_prefix', 'APP']]) {
    if (!dbGet('SELECT value FROM system_setting WHERE key=?', [k])) {
      dbRun('INSERT INTO system_setting (key, value) VALUES (?,?)', [k, v]);
    }
  }
  if (!dbGet('SELECT id FROM users WHERE id=1')) {
    dbRun("INSERT INTO users (id, full_name, email, password_hash) VALUES (1,'Live Reviewer','live@example.test','x')");
  }
  dbRun(`INSERT INTO recruitment_request
    (id, ticket_no, title, status, headcount, requester_id, created_by, created_at, updated_at)
    VALUES (9,'REQ-LIVE-9','Senior Structural Engineer','sourcing',1,1,1,datetime('now'),datetime('now'))`);

  const { Candidates } = await import('./src/lib/models.js');
  const { configureParsing } = await import('./src/lib/parsing/composition.js');
  const registry = await import('./src/lib/parsing/registry.js');
  const { parseDocument } = await import('./src/lib/parsing/pipeline-provider.js');
  const { createIntake, intakeById, reviewIntake } = await import('./src/lib/intake-store.js');
  const { proposalById } = await import('./src/lib/proposal-store.js');
  const { evaluateAgainstRequest } = await import('./src/lib/parsing/evaluation.js');

  registry.resetParserRegistry();
  configureParsing();

  const cv = path.join(FIXTURES, 'digital-en.pdf');
  const parsed = await parseDocument(cv);          // real parse + REAL Ollama extraction
  assert.ok(parsed.ok, `the live parse produced nothing: ${parsed.reason}`);
  assert.ok(parsed.generation, 'no generation record — the model was not consulted');
  assert.equal(parsed.generation.modelId, MODEL, 'the parse did not use the configured model');

  const before = {
    candidates: dbGet('SELECT COUNT(*) c FROM candidate').c,
    applications: dbGet('SELECT COUNT(*) c FROM application').c,
  };

  const intake = createIntake({
    storedName: 'digital-en.pdf', fileName: 'digital-en.pdf', mimeType: 'application/pdf',
    fileHash: 'live-hash-1', origin: 'resume.extract',
    documentId: parsed.documentId, generation: parsed.generation,
    fields: parsed.fields, requestId: 9, createdBy: 1,
  });

  // BEFORE review: nothing exists.
  assert.equal(intake.status, 'PENDING');
  assert.equal(intake.candidateId, null);
  assert.equal(intake.proposalId, null);
  assert.equal(intake.applicationId, null);
  assert.equal(intake.requestId, 9, 'requestId was not preserved');
  assert.equal(dbGet('SELECT COUNT(*) c FROM candidate').c, before.candidates,
    'a candidate existed before review');
  assert.equal(dbGet('SELECT COUNT(*) c FROM application').c, before.applications,
    'an application existed before review');
  for (const f of intake.fields) {
    assert.ok(f.evidence, `${f.field} reached the intake with no evidence`);
    assert.equal(f.decision, 'PENDING');
  }

  // A COMPLETE decision map. Accept identity + education, reject the rest.
  const accept = new Set(['fullName', 'email', 'phone', 'university', 'skills']);
  const decisions = Object.fromEntries(intake.fields.map((f) => [f.field, accept.has(f.field)]));

  const result = await reviewIntake(intake.id, decisions, { id: 1, fullName: 'Live Reviewer' },
    { expectedVersion: 0 });

  assert.equal(result.status, 'CONVERTED');
  assert.equal(dbGet('SELECT COUNT(*) c FROM candidate').c, before.candidates + 1,
    'expected exactly one new candidate');
  assert.equal(dbGet('SELECT COUNT(*) c FROM application').c, before.applications + 1,
    'expected exactly one new application');
  assert.ok(result.applicationId, 'no application was linked');

  const candidate = Candidates.byId(result.candidateId);
  assert.ok(candidate.full_name, 'the candidate has no name');
  // A rejected field must be absent from the record.
  for (const f of intake.fields) {
    if (accept.has(f.field)) continue;
    if (f.field === 'currentCompany') {
      assert.equal(candidate.current_company, null, 'a rejected field was persisted');
    }
  }
  assert.equal(proposalById(result.proposalId).status, 'APPLIED');

  // A retry creates nothing more.
  let retried = false;
  try {
    await reviewIntake(intake.id, decisions, { id: 1, fullName: 'Live Reviewer' });
  } catch { retried = true; }
  assert.ok(retried, 'a converted intake was reviewed twice');
  assert.equal(dbGet('SELECT COUNT(*) c FROM candidate').c, before.candidates + 1,
    'a retry created a second candidate');

  // POST-COMMIT: the real evaluation, dispatched after the transaction.
  const request = { title: 'Senior Structural Engineer', requirements: 'ETABS, high-rise design, 8+ years' };
  const evaluation = await evaluateAgainstRequest(cv, request);
  if (evaluation === null) {
    console.log('      evaluation abstained (a normal outcome); persistence unaffected');
  } else {
    assert.equal(/\/100|\b\d{1,3}\s*%/.test(evaluation.body), false,
      'a numeric score reached the note body');
    console.log(`      evaluation levels present, no numeric score`);
  }
  // Whatever the evaluation did, the committed records stand.
  assert.equal(intakeById(intake.id).status, 'CONVERTED');
  assert.ok(Candidates.byId(result.candidateId));

  evidence.endToEnd = {
    intakeFields: intake.fields.length,
    accepted: result.applied, rejected: result.rejected.length,
    candidateId: result.candidateId, applicationId: result.applicationId,
  };
  console.log(`      intake=${intake.id} fields=${intake.fields.length} accepted=[${result.applied.join(', ')}] candidate=${result.candidateId} application=${result.applicationId}`);
});

/* ---------------------------------- report ---------------------------------- */

console.log(`\n  evidence: ${JSON.stringify(evidence)}`);
console.log(`\n${failures.length === 0 ? '✓' : '✗'} ${passed} passed, ${failures.length} failed, ${notVerified.length} not verified\n`);
process.exit(failures.length === 0 ? 0 : 1);
