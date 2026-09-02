// POST /api/ingest/cv — Outlook/Graph CV ingestion.
//
// THE NINE REQUIRED SCENARIOS
//   1. new CV                                    → 201 / accepted
//   2. same messageId + attachmentId twice       → second is duplicate
//   3. concurrent submissions of one attachment  → exactly one ingestion
//   4. different attachmentId, same messageId    → both accepted
//   5. missing messageId                         → validation error
//   6. missing attachmentId                      → validation error
//   7. invalid file                              → validation error
//   8. SHA-256 generated server-side             → matches the real bytes
//   9. duplicate does not trigger parsing twice  → parseAttempts stays 1
//
// PLUS: source `outlook` and `microsoft_365` both accepted and NOT distinct
// identities; senderEmail and receivedAt validation; file too small / too large;
// provenance round-trip; no document text in responses; the async contract
// (201 before the parse finishes, receipt settles afterwards); restart recovery
// of a stranded receipt; and — asserted throughout — that NO candidate and NO
// application is ever created by this route.
//
// READER INDEPENDENCE. Almost everything here is ingestion MECHANICS — identity,
// hashing, idempotency, provenance — none of which needs a CV reader. With no
// ANTHROPIC_API_KEY the pipeline answers "no reader configured", receipts settle
// NO_FIELDS, and every assertion below still holds. The one check that genuinely
// requires a parse is skipped loudly; skipping is not a pass.
//
// SYNTHETIC DATA ONLY. Every CV, name, address and message id below is invented.
//
// Run:  node --experimental-sqlite ingest_cv_test.mjs

process.env.DATABASE_URL = 'file:/tmp/arabtec_ingest_test.db';
process.env.PORT = '4193';
process.env.NODE_ENV = 'test';
process.env.SEED_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'Admin@12345';
// The seeded recruiter below only exists when demo data is seeded.
process.env.SEED_DEMO_DATA = 'true';
process.env.UPLOAD_DIR = '/tmp/arabtec_ingest_uploads';
// Hermetic: no external document service.
delete process.env.DOCLING_BASE_URL;
delete process.env.OCR_BASE_URL;

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';

const DB = '/tmp/arabtec_ingest_test.db';
for (const f of [DB, `${DB}-journal`, `${DB}-wal`, `${DB}-shm`]) {
  try { fs.rmSync(f); } catch { /* first run */ }
}
try { fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true }); } catch { /* first run */ }

let passed = 0;
let skipped = 0;
const failures = [];
const check = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL  ${name}\n        ${e.message}`); }
};
const skip = (name, why) => {
  skipped += 1; console.log(`  SKIP  ${name} — ${why} (not a pass)`);
};

/* ------------------------------ synthetic files ---------------------------- */

/** A structurally valid one-page PDF. Invented content. */
function makePdf(text) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R '
      + '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/**
 * A structurally valid .docx — a real ZIP with the three parts Word requires.
 * Built by hand so the suite pulls in no archive dependency.
 */
function makeDocx(text) {
  const files = [
    ['[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '</Types>'],
    ['_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + '</Relationships>'],
    ['word/document.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
      + '</w:body></w:document>'],
  ];

  const local = []; const central = []; let offset = 0;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const deflated = zlib.deflateRawSync(data);
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(deflated.length, 18);
    lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, deflated);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(deflated.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + deflated.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...local, centralBuf, end]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (CRC_TABLE === null) {
    CRC_TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

/* -------------------------------- multipart -------------------------------- */

function multipartBody(fieldMap, file) {
  const boundary = `----ingest${crypto.randomUUID().replace(/-/g, '')}`;
  const parts = [];
  for (const [k, v] of Object.entries(fieldMap)) {
    if (v === undefined || v === null) continue;
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
  }
  if (file) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n`
      + `Content-Type: ${file.type}\r\n\r\n`, 'utf8'));
    parts.push(file.bytes);
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/* ------------------------------ real app, real HTTP ------------------------ */

await import('./prisma/seed.js');
await import('./src/server.js');
await new Promise((r) => setTimeout(r, 1200));

const BASE = `http://127.0.0.1:${process.env.PORT}`;

const api = async (path, { method = 'GET', token, body } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: json };
};

// A seeded recruiter — holds candidate.view and candidate.add, the two
// permissions this route requires. Seed defaults, not real credentials.
const login = await api('/api/auth/login', {
  method: 'POST',
  body: { email: 'recruiter@arabtec.com', password: 'Arabtec@123' },
});
assert.equal(login.status, 200, `recruiter login failed: HTTP ${login.status}`);
const TOKEN = login.body.token;
assert.ok(TOKEN, 'no token issued');

const ingest = async (fieldMap, file, token = TOKEN) => {
  const { body, contentType } = multipartBody(fieldMap, file);
  const res = await fetch(`${BASE}/api/ingest/cv`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
};

const getReceipt = async (id) => (await api(`/api/ingest/cv/${id}`, { token: TOKEN })).body;

/** Poll a receipt until the background parse settles it. */
const waitTerminal = async (id, ms = 8000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const r = await getReceipt(id);
    if (r && r.status !== 'RECEIVED') return r;
    if (Date.now() > deadline) return r;
    await new Promise((res) => setTimeout(res, 100));
  }
};

const countRows = async (sql, params = []) => {
  const { all } = await import('./src/lib/db.js');
  return all(sql, params).length;
};

const candidateCount = async () => countRows('SELECT id FROM candidate');
const applicationCount = async () => countRows('SELECT id FROM application');

const READER_WIRED = String(process.env.ANTHROPIC_API_KEY || '').trim() !== '';

const PDF = makePdf('Synthetic CV - Test Candidate - Civil Engineer - 7 years experience');
const DOCX = makeDocx('Synthetic CV - Test Candidate - QA/QC Engineer - 5 years experience');

const base = (over = {}) => ({
  source: 'outlook',
  messageId: 'AAMk-test-message-0001',
  attachmentId: 'ATT-0001',
  filename: 'Test_Candidate_CV.pdf',
  senderEmail: 'test.candidate@example.invalid',
  senderName: 'Test Candidate',
  subject: 'Application for Civil Engineer',
  receivedAt: '2026-09-01T07:42:00Z',
  ...over,
});

const pdfFile = (name = 'Test_Candidate_CV.pdf') =>
  ({ name, type: 'application/pdf', bytes: PDF });

const candidatesBefore = await candidateCount();
const applicationsBefore = await applicationCount();

console.log('\n──── 1. new CV ────');

let firstId = null;
await check('a new CV returns 201 and is identified as newly ingested', async () => {
  const r = await ingest(base(), pdfFile());
  assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.code, 'accepted');
  assert.equal(r.body.status, 'RECEIVED', 'the scanner should be answered before the parse');
  assert.equal(r.body.queued, true);
  assert.ok(r.body.ingestionId, 'no ingestionId returned');
  assert.equal(r.body.source, 'outlook');
  assert.equal(r.body.messageId, 'AAMk-test-message-0001');
  assert.equal(r.body.attachmentId, 'ATT-0001');
  firstId = r.body.ingestionId;
});

await check('the queued parse settles the receipt without the scanner waiting', async () => {
  const settled = await waitTerminal(firstId);
  assert.ok(['PARSED', 'NO_FIELDS'].includes(settled.status),
    `receipt never settled: ${settled.status}`);
  assert.equal(settled.parseAttempts, 1, 'parse ran a number of times other than once');
});

console.log('\n──── 8. server-side SHA-256 ────');

await check('SHA-256 is computed server-side from the real uploaded bytes', async () => {
  const expected = crypto.createHash('sha256').update(PDF).digest('hex');
  const r = await getReceipt(firstId);
  assert.equal(r.contentHash, expected, 'stored hash is not SHA-256 of the posted bytes');
});

await check('a client-supplied hash is ignored, never trusted', async () => {
  const bogus = 'deadbeef'.repeat(8);
  const r = await ingest(
    base({ messageId: 'AAMk-hash-0002', attachmentId: 'ATT-0002',
      contentHash: bogus, fileHash: bogus, sha256: bogus }),
    pdfFile(),
  );
  assert.equal(r.status, 201);
  const expected = crypto.createHash('sha256').update(PDF).digest('hex');
  assert.equal(r.body.contentHash, expected, 'a client-supplied hash was trusted');
  assert.notEqual(r.body.contentHash, bogus);
});

console.log('\n──── 2 + 9. duplicate ────');

await check('the same messageId + attachmentId twice is a duplicate', async () => {
  const r = await ingest(base(), pdfFile());
  assert.equal(r.status, 200, `expected 200 duplicate, got ${r.status}`);
  assert.equal(r.body.status, 'duplicate');
  assert.equal(r.body.code, 'duplicate');
  assert.equal(r.body.messageId, 'AAMk-test-message-0001');
  assert.equal(r.body.attachmentId, 'ATT-0001');
  assert.equal(r.body.duplicateOf, firstId);
});

await check('a duplicate creates no second ingestion record', async () => {
  const n = await countRows(
    'SELECT id FROM cv_ingestion WHERE message_id=? AND attachment_id=?',
    ['AAMk-test-message-0001', 'ATT-0001'],
  );
  assert.equal(n, 1, `expected exactly 1 receipt, found ${n}`);
});

await check('a duplicate does NOT trigger parsing a second time', async () => {
  const before = await getReceipt(firstId);
  assert.equal(before.parseAttempts, 1, 'precondition: exactly one parse so far');

  for (let i = 0; i < 3; i += 1) {
    const r = await ingest(base(), pdfFile());
    assert.equal(r.body.code, 'duplicate');
  }
  await new Promise((res) => setTimeout(res, 400)); // let any stray parse start

  const after = await getReceipt(firstId);
  assert.equal(after.parseAttempts, 1,
    `duplicates triggered ${after.parseAttempts} parses; must stay at 1`);
  assert.equal(after.intakeId, before.intakeId, 'a duplicate produced a second intake');
});

await check('a duplicate creates no candidate and no application', async () => {
  assert.equal(await candidateCount(), candidatesBefore, 'a candidate was created');
  assert.equal(await applicationCount(), applicationsBefore, 'an application was created');
});

console.log('\n──── 3. concurrency ────');

await check('concurrent submissions of one attachment yield exactly one ingestion', async () => {
  const id = { messageId: 'AAMk-race-0001', attachmentId: 'ATT-RACE' };
  const results = await Promise.all(
    Array.from({ length: 8 }, () => ingest(base(id), pdfFile())),
  );
  const created = results.filter((r) => r.status === 201);
  const dupes = results.filter((r) => r.status === 200 && r.body?.code === 'duplicate');
  assert.equal(created.length, 1,
    `expected exactly 1 winner, got ${created.length} (statuses ${results.map((r) => r.status).join(',')})`);
  assert.equal(dupes.length, 7, `expected 7 duplicates, got ${dupes.length}`);

  const n = await countRows('SELECT id FROM cv_ingestion WHERE message_id=? AND attachment_id=?',
    [id.messageId, id.attachmentId]);
  assert.equal(n, 1, `the race left ${n} rows in the table`);

  const settled = await waitTerminal(created[0].body.ingestionId);
  assert.equal(settled.parseAttempts, 1,
    `the race caused ${settled.parseAttempts} parses; must be 1`);
});

console.log('\n──── 4. same message, different attachment ────');

await check('a different attachmentId under the same messageId is accepted', async () => {
  const a = await ingest(
    base({ messageId: 'AAMk-multi-0001', attachmentId: 'ATT-A' }), pdfFile('CV_One.pdf'));
  const b = await ingest(
    base({ messageId: 'AAMk-multi-0001', attachmentId: 'ATT-B' }), pdfFile('CV_Two.pdf'));
  assert.equal(a.status, 201, 'first attachment rejected');
  assert.equal(b.status, 201, 'second attachment on the same email was treated as a duplicate');
  assert.notEqual(a.body.ingestionId, b.body.ingestionId);

  const n = await countRows('SELECT id FROM cv_ingestion WHERE message_id=?', ['AAMk-multi-0001']);
  assert.equal(n, 2, `expected 2 receipts for one email, found ${n}`);
});

console.log('\n──── 5-7. validation ────');

for (const field of ['messageId', 'attachmentId', 'source', 'filename', 'senderEmail', 'receivedAt']) {
  await check(`missing ${field} is a validation error naming the field`, async () => {
    const fields = base({ messageId: `AAMk-miss-${field}`, attachmentId: `ATT-${field}` });
    delete fields[field];
    const r = await ingest(fields, pdfFile());
    assert.equal(r.status, 400, `expected 400 for missing ${field}, got ${r.status}`);
    assert.equal(r.body.code, 'provenance-missing');
    assert.ok(Array.isArray(r.body.missing) && r.body.missing.includes(field),
      `response did not name the missing field: ${JSON.stringify(r.body.missing)}`);
  });
}

await check('an invalid file type is a validation error', async () => {
  const r = await ingest(
    base({ messageId: 'AAMk-bad-type', attachmentId: 'ATT-PNG', filename: 'logo.png' }),
    { name: 'logo.png', type: 'image/png', bytes: Buffer.alloc(2048, 7) },
  );
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  assert.equal(r.body.code, 'unsupported-file-type');
});

await check('an invalid file type stores no ingestion record', async () => {
  const n = await countRows('SELECT id FROM cv_ingestion WHERE attachment_id=?', ['ATT-PNG']);
  assert.equal(n, 0, 'a rejected upload wrote a receipt');
});

await check('a request with no file at all is refused', async () => {
  const r = await ingest(base({ messageId: 'AAMk-nofile', attachmentId: 'ATT-NOFILE' }), null);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'file-missing');
});

await check('an empty / too-small attachment is refused', async () => {
  const r = await ingest(
    base({ messageId: 'AAMk-tiny', attachmentId: 'ATT-TINY' }),
    { name: 'tiny.pdf', type: 'application/pdf', bytes: Buffer.from('%PDF-1.4\n') },
  );
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'file-too-small');
});

await check('a malformed senderEmail is refused', async () => {
  const r = await ingest(
    base({ messageId: 'AAMk-mail', attachmentId: 'ATT-MAIL', senderEmail: 'not-an-email' }),
    pdfFile(),
  );
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'sender-email-invalid');
});

await check('an unparseable receivedAt is refused', async () => {
  const r = await ingest(
    base({ messageId: 'AAMk-date', attachmentId: 'ATT-DATE', receivedAt: 'last Tuesday' }),
    pdfFile(),
  );
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'received-at-invalid');
});

await check('an unknown source is refused', async () => {
  const r = await ingest(
    base({ source: 'dropbox', messageId: 'AAMk-src', attachmentId: 'ATT-SRC' }), pdfFile());
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'source-unknown');
});

await check('unauthenticated ingestion is refused', async () => {
  const { body, contentType } = multipartBody(base(), pdfFile());
  const res = await fetch(`${BASE}/api/ingest/cv`, {
    method: 'POST', headers: { 'Content-Type': contentType }, body,
  });
  assert.equal(res.status, 401);
});

console.log('\n──── source labels ────');

await check('microsoft_365 is accepted as a synonym for outlook', async () => {
  const r = await ingest(
    base({ source: 'microsoft_365', messageId: 'AAMk-m365', attachmentId: 'ATT-M365' }),
    pdfFile(),
  );
  assert.equal(r.status, 201, `microsoft_365 was rejected: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.source, 'microsoft_365', 'source was not preserved verbatim');
});

await check('relabelling the source does NOT create a second ingestion', async () => {
  // The same attachment, announced under the other label. If source were part of
  // the identity this would ingest twice — and renaming the scanner would
  // silently re-ingest the whole mailbox.
  const id = { messageId: 'AAMk-relabel', attachmentId: 'ATT-RELABEL' };
  const first = await ingest(base({ ...id, source: 'outlook' }), pdfFile());
  assert.equal(first.status, 201);
  const second = await ingest(base({ ...id, source: 'microsoft_365' }), pdfFile());
  assert.equal(second.status, 200, 'a relabelled duplicate was ingested again');
  assert.equal(second.body.code, 'duplicate');

  const n = await countRows('SELECT id FROM cv_ingestion WHERE message_id=?', [id.messageId]);
  assert.equal(n, 1, `relabelling produced ${n} receipts`);
});

console.log('\n──── DOCX ────');

await check('a valid DOCX is ingested', async () => {
  const r = await ingest(
    base({ messageId: 'AAMk-docx-0001', attachmentId: 'ATT-DOCX',
      filename: 'Test_Candidate_CV.docx' }),
    { name: 'Test_Candidate_CV.docx',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: DOCX },
  );
  assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
  const expected = crypto.createHash('sha256').update(DOCX).digest('hex');
  assert.equal(r.body.contentHash, expected, 'DOCX hash mismatch');
  const settled = await waitTerminal(r.body.ingestionId);
  assert.ok(['PARSED', 'NO_FIELDS'].includes(settled.status));
});

console.log('\n──── provenance ────');

await check('every provenance field is persisted unchanged', async () => {
  const fields = base({
    source: 'outlook',
    messageId: 'AAMk-prov-0001',
    attachmentId: 'ATT-PROV',
    filename: 'Ahmed_Mohamed_CV.pdf',
    senderEmail: 'ahmed.mohamed@example.invalid',
    senderName: 'Ahmed Mohamed',
    subject: 'Application for Civil Engineer',
    receivedAt: '2026-09-01T07:42:00Z',
  });
  const r = await ingest(fields, pdfFile('Ahmed_Mohamed_CV.pdf'));
  assert.equal(r.status, 201);

  const { get } = await import('./src/lib/db.js');
  const row = get('SELECT * FROM cv_ingestion WHERE id=?', [r.body.ingestionId]);
  assert.equal(row.source, 'outlook');
  assert.equal(row.message_id, 'AAMk-prov-0001');
  assert.equal(row.attachment_id, 'ATT-PROV');
  assert.equal(row.sender_email, 'ahmed.mohamed@example.invalid');
  assert.equal(row.sender_name, 'Ahmed Mohamed');
  assert.equal(row.subject, 'Application for Civil Engineer');
  assert.equal(new Date(row.received_at).toISOString(), '2026-09-01T07:42:00.000Z');
  assert.equal(row.filename, 'Ahmed_Mohamed_CV.pdf');
  assert.equal(row.mime_type, 'application/pdf');
  assert.equal(row.size_bytes, PDF.length, 'file size not recorded');
  assert.ok(row.content_hash && row.content_hash.length === 64, 'hash not stored');
  assert.ok(row.stored_name, 'stored file reference not kept');
  assert.ok(row.status, 'ingestion status not recorded');
  assert.ok(row.created_at && row.updated_at, 'timestamps missing');
});

await check('the stored file is retrievable from durable blob storage', async () => {
  const { get } = await import('./src/lib/db.js');
  const { readBlob } = await import('./src/lib/upload.js');
  const row = get('SELECT stored_name FROM cv_ingestion WHERE attachment_id=?', ['ATT-PROV']);
  const blob = readBlob(row.stored_name);
  assert.ok(blob && blob.data, 'the CV bytes are not in durable storage');
  assert.equal(crypto.createHash('sha256').update(blob.data).digest('hex'),
    crypto.createHash('sha256').update(PDF).digest('hex'),
    'stored bytes differ from what was uploaded');
});

await check('no response carries document text', async () => {
  const r = await ingest(
    base({ messageId: 'AAMk-leak-0001', attachmentId: 'ATT-LEAK' }), pdfFile());
  for (const forbidden of ['rawText', 'raw_text', 'preview', 'text', 'fields']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(r.body, forbidden),
      `response exposed "${forbidden}"`);
  }
  assert.ok(!JSON.stringify(r.body).includes('Synthetic CV'),
    'response echoed document contents');

  const settled = await waitTerminal(r.body.ingestionId);
  assert.ok(!JSON.stringify(settled).includes('Synthetic CV'),
    'the receipt poll echoed document contents');
});

console.log('\n──── no candidate / application shortcut ────');

await check('ingestion created no candidate and no application at any point', async () => {
  assert.equal(await candidateCount(), candidatesBefore,
    'the ingestion route created a candidate');
  assert.equal(await applicationCount(), applicationsBefore,
    'the ingestion route created an application');
});

await check('anything that parsed points at a PENDING, unapproved intake', async () => {
  const { all } = await import('./src/lib/db.js');
  const rows = all('SELECT status, intake_id FROM cv_ingestion');
  assert.ok(rows.length > 0, 'no receipts written at all');
  for (const r of rows) {
    assert.ok(['RECEIVED', 'PARSED', 'NO_FIELDS', 'FAILED'].includes(r.status),
      `unexpected status ${r.status}`);
  }
  for (const r of rows.filter((x) => x.status === 'PARSED')) {
    const intake = all('SELECT status, candidate_id FROM candidate_intake WHERE id=?',
      [r.intake_id])[0];
    assert.ok(intake, 'a PARSED receipt points at no intake');
    assert.equal(intake.status, 'PENDING', 'ingestion pre-approved an intake');
    assert.equal(intake.candidate_id ?? null, null,
      'ingestion attached a candidate without review');
  }
});

console.log('\n──── failure, retry and restart recovery ────');

await check('a persistence failure propagates and is not read as a duplicate', async () => {
  const store = await import('./src/lib/ingest-store.js');
  // content_hash is NOT NULL. A genuine write failure, not a uniqueness
  // conflict, so it must throw rather than be swallowed as "already ingested".
  assert.throws(() => store.claimIngestion({
    source: 'outlook', messageId: 'AAMk-broken', attachmentId: 'ATT-BROKEN',
    filename: 'broken.pdf', contentHash: null,
  }), (e) => !store.isIngestionIdentityViolation(e),
  'a NOT NULL violation was misclassified as a duplicate');
});

await check('a FAILED receipt is retried in place, reusing the same row', async () => {
  const store = await import('./src/lib/ingest-store.js');
  const id = { messageId: 'AAMk-retry-0001', attachmentId: 'ATT-RETRY' };
  const first = await ingest(base(id), pdfFile());
  assert.equal(first.status, 201);
  await waitTerminal(first.body.ingestionId);

  store.markFailed(first.body.ingestionId, 'simulated downstream failure');
  const again = await ingest(base(id), pdfFile());
  assert.equal(again.status, 201, 'a FAILED attachment was not reprocessed');
  assert.equal(again.body.ingestionId, first.body.ingestionId,
    'the retry created a second receipt');

  const n = await countRows('SELECT id FROM cv_ingestion WHERE message_id=?', [id.messageId]);
  assert.equal(n, 1, `the retry left ${n} receipts`);
});

await check('a PARSED or NO_FIELDS receipt is never reopened', async () => {
  const store = await import('./src/lib/ingest-store.js');
  const claim = store.claimIngestion({
    source: 'outlook', messageId: 'AAMk-terminal', attachmentId: 'ATT-TERMINAL',
    filename: 'terminal.pdf',
    contentHash: crypto.createHash('sha256').update('terminal').digest('hex'),
  });
  const settled = store.markNoFields(claim.record.id, 'nothing readable');
  assert.equal(store.isRetryable(settled), false);
  assert.equal(store.reopenFailedIngestion(claim.record.id), null,
    'a successfully-ingested receipt was reopened for reprocessing');
});

await check('a receipt stranded by a restart is recoverable, not lost', async () => {
  const store = await import('./src/lib/ingest-store.js');
  const { run } = await import('./src/lib/db.js');
  const { recoverStranded } = await import('./src/lib/ingest-parser.js');

  // Exactly what a crash mid-parse leaves behind: claimed, never settled.
  const claim = store.claimIngestion({
    source: 'outlook', messageId: 'AAMk-stranded', attachmentId: 'ATT-STRANDED',
    filename: 'stranded.pdf', storedName: 'nonexistent-stranded.pdf',
    contentHash: crypto.createHash('sha256').update('stranded').digest('hex'),
  });
  // Age it past the grace window so recovery considers it abandoned.
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  run('UPDATE cv_ingestion SET created_at=?, parse_started_at=NULL WHERE id=?',
    [old, claim.record.id]);

  const stranded = store.strandedIngestions();
  assert.ok(stranded.some((r) => r.id === claim.record.id),
    'a stranded receipt was not detected as recoverable');

  const result = await recoverStranded();
  assert.ok(result.recovered >= 1, 'recovery re-drove nothing');

  const after = store.ingestionById(claim.record.id);
  assert.notEqual(after.status, 'RECEIVED', 'the stranded receipt was left unsettled');
  assert.ok(after.parseAttempts >= 1, 'recovery did not record a parse attempt');
});

console.log('\n──── scan state ────');

await check('first run reports the conservative 2026-09-01 floor', async () => {
  const r = await api('/api/ingest/scan-state?source=outlook', { token: TOKEN });
  assert.equal(r.status, 200);
  assert.equal(r.body.lastSuccessfulScanAt, '2026-09-01T00:00:00.000Z');
  assert.equal(r.body.isFirstRun, true);
});

await check('the watermark advances and is read back', async () => {
  const r = await api('/api/ingest/scan-state', {
    method: 'PUT', token: TOKEN,
    body: { source: 'outlook', lastSuccessfulScanAt: '2026-09-01T18:00:00Z' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const back = await api('/api/ingest/scan-state', { token: TOKEN });
  assert.equal(back.body.lastSuccessfulScanAt, '2026-09-01T18:00:00.000Z');
  assert.equal(back.body.isFirstRun, false);
});

await check('the watermark is shared across source labels', async () => {
  const r = await api('/api/ingest/scan-state?source=microsoft_365', { token: TOKEN });
  assert.equal(r.body.lastSuccessfulScanAt, '2026-09-01T18:00:00.000Z',
    'renaming the source reset the watermark');
});

await check('the watermark refuses to move backwards', async () => {
  const r = await api('/api/ingest/scan-state', {
    method: 'PUT', token: TOKEN,
    body: { source: 'outlook', lastSuccessfulScanAt: '2026-09-01T06:00:00Z' },
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'scan-state-regression');
});

await check('a deliberate rewind is allowed with force', async () => {
  const r = await api('/api/ingest/scan-state', {
    method: 'PUT', token: TOKEN,
    body: { source: 'outlook', lastSuccessfulScanAt: '2026-09-01T06:00:00Z', force: true },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.forced, true);
});

console.log('\n──── parse path (needs a CV reader) ────');

if (READER_WIRED) {
  await check('a readable CV is staged as a PENDING intake and no candidate', async () => {
    const before = await candidateCount();
    const r = await ingest(
      base({ messageId: 'AAMk-parse-0001', attachmentId: 'ATT-PARSE' }), pdfFile());
    assert.equal(r.status, 201);
    const settled = await waitTerminal(r.body.ingestionId, 60000);
    if (settled.status === 'PARSED') {
      const { get } = await import('./src/lib/db.js');
      const intake = get('SELECT * FROM candidate_intake WHERE id=?', [settled.intakeId]);
      assert.equal(intake.status, 'PENDING');
      assert.equal(intake.origin, 'mailbox.ingest', 'intake origin not marked as mailbox');
    }
    assert.equal(await candidateCount(), before, 'parsing created a candidate');
  });
} else {
  skip('a readable CV is staged as a PENDING intake',
    'no ANTHROPIC_API_KEY, so no CV reader is wired');
  await check('with no reader wired, ingestion still records a durable receipt', async () => {
    const r = await ingest(
      base({ messageId: 'AAMk-noreader', attachmentId: 'ATT-NOREADER' }), pdfFile());
    assert.equal(r.status, 201, 'a missing reader must not fail the ingestion');
    const settled = await waitTerminal(r.body.ingestionId);
    assert.equal(settled.status, 'NO_FIELDS');
    assert.ok(settled.reason, 'no reason recorded for producing nothing');
  });
}

/* ---------------------------------- summary -------------------------------- */

console.log(`\n════════ ingest_cv_test ════════`);
console.log(`${passed} passed, ${failures.length} failed, ${skipped} skipped`);
if (failures.length) {
  console.log(`FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('OK ✅');
process.exit(0);
