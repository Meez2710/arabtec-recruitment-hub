// Regression guard for the Talent Pool name column and CV review HTTP errors.
// Safe and read-only: no database, real candidate data, or network is accessed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = fs.readFileSync(path.resolve(here, '../frontend/public/app.jsx'), 'utf8');
const css = fs.readFileSync(path.resolve(here, '../frontend/public/arabtec-responsive.css'), 'utf8');

const start = app.indexOf('async function fetchDocBlobUrl(path) {');
const stop = app.indexOf('function fetchResumeBlobUrl(', start);
assert.ok(start >= 0 && stop > start, 'CV fetch helper exists');
const helper = app.slice(start, stop);
const context = {
  api: { token: 'synthetic-token' },
  URL: { createObjectURL: () => 'blob:synthetic-cv' },
  fetch: async () => ({ ok: false, status: 409, json: async () => ({
    error: 'This CV file no longer matches the document recorded for the candidate, so it is not shown. Ask an administrator to check it.',
  }) }),
};
vm.runInNewContext(helper + '\n globalThis.fetchDocBlobUrlForTest = fetchDocBlobUrl;', context);
await assert.rejects(context.fetchDocBlobUrlForTest('/candidates/999/resume'),
  /no longer matches the document recorded/, 'integrity rejection must be shown, not a generic load error');

context.fetch = async () => ({ ok: false, status: 404, json: async () => ({
  error: 'The CV file could not be found in storage; ask an administrator to restore it.',
}) });
await assert.rejects(context.fetchDocBlobUrlForTest('/candidates/999/resume'),
  /could not be found in storage/, 'a missing stored file must be distinguishable from an unlinked CV');

context.fetch = async () => ({ ok: false, status: 403, json: async () => ({
  error: 'Internal protected detail',
}) });
await assert.rejects(context.fetchDocBlobUrlForTest('/candidates/999/resume'),
  /do not have access/, 'authorization denial remains a concise generic message');

context.fetch = async () => ({ ok: true, status: 200,
  headers: { get: () => 'application/pdf; charset=binary' },
  blob: async () => ({ type: 'application/pdf' }) });
const result = await context.fetchDocBlobUrlForTest('/candidates/999/resume');
assert.equal(result.mimeType, 'application/pdf');
assert.equal(result.url, 'blob:synthetic-cv');

assert.match(css, /table\.talent-pool-table\.candidates-table[^\n]*min-width:\s*(?:12[6-9]\d|1[3-9]\d\d)px/,
  '8-column Talent Pool must not squeeze content below the readable table floor');
assert.match(css, /\.talent-pool-table[^\n]*\.pool-candidate[^\n]*\.cell-strong[^\{]*\{[^\}]*white-space:\s*normal/,
  'candidate names must be allowed to wrap instead of being clipped');
assert.match(app, /title=\{c\.fullName\}/, 'full candidate name remains available on hover');

console.log('PASS: CV error fidelity and readable Talent Pool name layout (synthetic)');
