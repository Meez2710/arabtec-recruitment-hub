// Live Docling/OCR fixture matrix — run this from an UNFILTERED network.
//
// WHY IT EXISTS SEPARATELY. The corporate FortiGuard filter on the authoring
// network blocks *.proxy.runpod.net as "Proxy Avoidance" (HTTP 403), so the
// matrix could not be executed there. This script is the whole remaining
// verification in one command, so it can be run from a phone hotspot or the
// eventual Linux host without re-deriving anything.
//
// Usage:
//   DOCLING_BASE_URL=https://<pod-id>-8089.proxy.runpod.net \
//     node --experimental-sqlite run_docling_matrix.mjs
//
// SYNTHETIC FIXTURES ONLY. The endpoint is public and unauthenticated; a real
// candidate CV must never be sent to it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'live-fixtures');
const BASE = (process.env.DOCLING_BASE_URL || '').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.DOCLING_TIMEOUT_MS || 300000);

if (!BASE) {
  console.error('DOCLING_BASE_URL is required.');
  process.exit(2);
}

const MIME = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * The matrix. `expect` lists ground truth that exists in the fixture; for the
 * image-only ones those strings exist ONLY inside the pixels, which is what
 * makes them a real OCR test rather than a text-layer read.
 */
const MATRIX = [
  { id: 'A', label: 'born-digital English PDF', file: 'digital-en.pdf',
    expect: ['Layla Mansour', 'Ain Shams', 'ETABS'], ocr: false },
  { id: 'B', label: 'image-only English PDF', file: 'image-only-en.pdf',
    expect: ['Ain Shams', '2014', 'ETABS'], ocr: true },
  { id: 'C', label: 'PNG resume (English)', file: 'image-only-en.png',
    expect: ['Ain Shams', 'ETABS'], ocr: true },
  { id: 'D', label: 'image-only Arabic PDF', file: 'image-only-ar.pdf',
    expect: ['Cairo University'], ocr: true },
  { id: 'E', label: 'mixed Arabic/English PDF', file: 'arabic-mixed.pdf',
    expect: ['Arabtec Construction'], ocr: false },
  { id: 'F', label: 'DOCX resume', file: 'docx-en.docx',
    expect: ['Layla Mansour', 'Ain Shams'], ocr: false },
  { id: 'G', label: 'multi-page PDF', file: 'multipage-en.pdf',
    expect: ['Nadia Kamal', 'Primavera'], ocr: false },
  { id: 'H', label: 'prompt-injection CV', file: 'injection-en.pdf',
    expect: ['Omar Fathy'], ocr: false },
];

const convert = async (file) => {
  const ext = path.extname(file);
  const bytes = fs.readFileSync(path.join(FIXTURES, file));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/v1/convert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: file, mimeType: MIME[ext], contentBase64: bytes.toString('base64'),
      }),
      signal: ctl.signal,
    });
    const ms = Date.now() - started;
    const type = res.headers.get('content-type') || '';
    const body = await res.text();
    if (!type.includes('json')) {
      return { ms, status: res.status, fatal: 'non-JSON response (instance died?)' };
    }
    return { ms, status: res.status, json: JSON.parse(body) };
  } catch (error) {
    return { ms: Date.now() - started, fatal: `${error.name}: ${error.message}` };
  } finally { clearTimeout(timer); }
};

console.log(`\nLive Docling/OCR matrix against ${BASE.replace(/\/\/[^.]+/, '//<pod>')}\n`);

const hctl = new AbortController();
const ht = setTimeout(() => hctl.abort(), 60000);
try {
  const res = await fetch(`${BASE}/v1/health`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: hctl.signal,
  });
  console.log(`health: HTTP ${res.status} :: ${(await res.text()).slice(0, 160)}\n`);
} catch (e) {
  console.error(`health FAILED: ${e.name} — aborting so no credit is wasted.\n`);
  process.exit(1);
} finally { clearTimeout(ht); }

const rows = [];
for (const item of MATRIX) {
  const out = await convert(item.file);
  if (out.fatal) {
    rows.push({ ...item, result: 'FAIL', detail: out.fatal, ms: out.ms });
    console.log(`${item.id} ${item.label.padEnd(28)} FAIL  ${out.ms}ms  ${out.fatal}`);
    // Stop on a dead instance: repeating it only burns credit.
    if (/died|non-JSON/.test(out.fatal)) { console.log('\nInstance appears to have died. Stopping.'); break; }
    continue;
  }
  const j = out.json;
  const text = j.text || '';
  const missing = item.expect.filter((needle) => !text.includes(needle));
  const ok = j.status === 'ok' && missing.length === 0;
  rows.push({
    ...item, result: ok ? 'PASS' : 'FAIL', ms: out.ms,
    docStatus: j.status, chars: text.length, pages: j.pageCount,
    ocrApplied: j.ocrApplied, missing,
  });
  console.log(
    `${item.id} ${item.label.padEnd(28)} ${ok ? 'PASS' : 'FAIL'}  ${String(out.ms).padStart(6)}ms  `
    + `status=${String(j.status).padEnd(11)} chars=${String(text.length).padStart(5)} `
    + `pages=${j.pageCount ?? '-'} ocrApplied=${j.ocrApplied}`
    + (missing.length ? `  MISSING: ${missing.join(', ')}` : ''),
  );
}

console.log('\n--- summary ---');
console.log(`${rows.filter((r) => r.result === 'PASS').length}/${rows.length} passed`);
console.log(JSON.stringify(rows, null, 1));
