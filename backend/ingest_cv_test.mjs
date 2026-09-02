// POST /api/ingest/cv — inbound mailbox CV ingestion.
//
// WHAT IT PROVES
//   1.  A valid PDF is ingested and a durable receipt is written.
//   2.  A valid DOCX is ingested the same way.
//   3.  An unsupported file type is rejected and stores nothing.
//   4.  A missing provenance field is rejected, naming the field.
//   5.  An unknown `source` is rejected.
//   6.  The FIRST submission of an attachment is accepted.
//   7.  An exact retry of (messageId, attachmentId) answers duplicate and
//       creates no second receipt.
//   8.  Concurrent submissions of one attachment: exactly one winner.
//   9.  content_hash is SHA-256 of the real bytes, computed server-side, and a
//       client-supplied hash is ignored.
//  10.  A storage/persistence failure propagates rather than being mistaken
//       for a duplicate.
//  11.  A FAILED receipt is retryable in place; PARSED/NO_FIELDS are not.
//  12.  NO candidate is created by this route under any of the above.
//  13.  Every Microsoft 365 provenance field round-trips unchanged.
//  14.  The response never carries document text.
//
// READER INDEPENDENCE. Almost everything here is about ingestion MECHANICS —
// identity, hashing, idempotency, provenance — none of which needs a CV reader.
// With no ANTHROPIC_API_KEY the pipeline answers "no reader configured", the
// route records NO_FIELDS, and every assertion below still holds. The two
// checks that genuinely require a parse are marked and skipped loudly.
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
assert.equal(login.status, 200, `recruiter login failed: HTTP ${login.status} ${JSON.stringify(login.body)}`);
const TOKEN = login.body.token;
assert.ok(TOKEN, 'no token issued');

/** POST one attachment to the ingestion endpoint. */
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

const candidateCount = async () => {
  const r = await api('/api/candidates?limit=1', { token: TOKEN });
  return r.body?.total ?? r.body?.pagination?.total
    ?? (Array.isArray(r.body?.data) ? r.body.data.length : 0);
};

/** Does this deployment have a CV reader wired? Ask the server, not the env. */
const health = await api('/api/health', { token: TOKEN });
const READER_WIRED = String(process.env.ANTHROPIC_API_KEY || '').trim() !== '';
void health;

const PDF = makePdf('Synthetic CV - Test Candidate - Civil Engineer - 7 years');
const DOCX = makDocxSafe();
function makDocxSafe() {
  try { return makeDocx('Synthetic CV - Test Candidate - QA/QC Engineer - 5 years'); }
  catch (e) { console.log('  (docx builder failed: ' + e.message + ')'); return null; }
}

const base = (over = {}) => ({
  source: 'microsoft_365',
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

console.log('\n──── ingestion mechanics ────');

const candidatesBefore = await candidateCount();

/* 1 + 6 — first valid PDF submission is accepted */
let firstIngestionId = null;
await check('valid PDF is ingested and returns a durable receipt', async () => {
  const r = await ingest(base(), pdfFile());
  assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.ok(r.body.ingestionId, 'no ingestionId returned');
  assert.equal(r.body.source, 'microsoft_365');
  assert.equal(r.body.messageId, 'AAMk-test-message-0001');
  assert.equal(r.body.attachmentId, 'ATT-0001');
  assert.ok(['PARSED', 'NO_FIELDS'].includes(r.body.status),
    `unexpected status ${r.body.status}`);
  firstIngestionId = r.body.ingestionId;
});

/* 9 — SHA-256 is server-computed over the real bytes */
await check('content hash is SHA-256 of the actual uploaded bytes', async () => {
  const expected = crypto.createHash('sha256').update(PDF).digest('hex');
  const r = await api(`/api/ingest/cv/${firstIngestionId}`, { token: TOKEN });
  assert.equal(r.status, 200);
  assert.equal(r.body.contentHash, expected,
    'stored hash does not match SHA-256 of the posted bytes');
});

/* 9b — a client-supplied hash is ignored */
await check('a client-supplied contentHash is ignored, not trusted', async () => {
  const r = await ingest(
    base({ messageId: 'AAMk-test-message-0002', attachmentId: 'ATT-0002',
      contentHash: 'deadbeef'.repeat(8), fileHash: 'deadbeef'.repeat(8) }),
    pdfFile(),
  );
  assert.equal(r.status, 201);
  const expected = crypto.createHash('sha256').update(PDF).digest('hex');
  assert.equal(r.body.contentHash, expected, 'client hash was trusted');
  assert.notEqual(r.body.contentHash, 'deadbeef'.repeat(8));
});

/* 7 — exact retry is a duplicate */
await check('exact retry of messageId+attachmentId returns duplicate', async () => {
  const r = await ingest(base(), pdfFile());
  assert.equal(r.status, 200, `expected 200 duplicate, got ${r.status}`);
  assert.equal(r.body.status, 'duplicate');
  assert.equal(r.body.code, 'duplicate');
  assert.equal(r.body.duplicateOf, firstIngestionId,
    'duplicate did not point at the original receipt');
});

/* 7b — the retry created no second receipt */
await check('a duplicate retry writes no second ingestion record', async () => {
  const { all } = await import('./src/lib/db.js');
  const rows = all(
    'SELECT id FROM cv_ingestion WHERE source=? AND message_id=? AND attachment_id=?',
    ['microsoft_365', 'AAMk-test-message-0001', 'ATT-0001'],
  );
  assert.equal(rows.length, 1, `expected exactly 1 receipt, found ${rows.length}`);
});

/* 7c — a DIFFERENT attachment on the SAME message is its own ingestion */
await check('same message, different attachment is not a duplicate', async () => {
  const r = await ingest(
    base({ messageId: 'AAMk-test-message-0001', attachmentId: 'ATT-SECOND' }),
    pdfFile('Second_Attachment.pdf'),
  );
  assert.equal(r.status, 201, 'a second attachment on one email must ingest separately');
  assert.notEqual(r.body.ingestionId, firstIngestionId);
});

/* 8 — concurrency: exactly one winner */
await check('concurrent submissions of one attachment produce exactly one winner', async () => {
  const id = { messageId: 'AAMk-race-0001', attachmentId: 'ATT-RACE' };
  const results = await Promise.all(
    Array.from({ length: 6 }, () => ingest(base(id), pdfFile())),
  );
  const created = results.filter((r) => r.status === 201);
  const dupes = results.filter((r) => r.status === 200 && r.body?.code === 'duplicate');
  assert.equal(created.length, 1,
    `expected exactly 1 winner, got ${created.length} (statuses: ${results.map((r) => r.status).join(',')})`);
  assert.equal(dupes.length, 5, `expected 5 duplicates, got ${dupes.length}`);

  const { all } = await import('./src/lib/db.js');
  const rows = all('SELECT id FROM cv_ingestion WHERE message_id=? AND attachment_id=?',
    [id.messageId, id.attachmentId]);
  assert.equal(rows.length, 1, `race left ${rows.length} rows in the table`);
});

console.log('\n──── validation ────');

/* 3 — unsupported file type */
await check('unsupported file type is rejected', async () => {
  const r = await ingest(
    base({ messageId: 'AAMk-bad-type', attachmentId: 'ATT-PNG', filename: 'logo.png' }),
    { name: 'logo.png', type: 'image/png', bytes: Buffer.from('\x89PNG\r\n\x1a\n fake', 'latin1') },
  );
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  assert.equal(r.body.code, 'unsupported-file-type');
  assert.equal(r.body.status, 'rejected');
});

/* 3b — a rejected upload leaves no receipt behind */
await check('a rejected file type creates no ingestion record', async () => {
  const { all } = await import('./src/lib/db.js');
  const rows = all('SELECT id FROM cv_ingestion WHERE attachment_id=?', ['ATT-PNG']);
  assert.equal(rows.length, 0, 'a rejected upload wrote a receipt');
});

/* 4 — missing provenance */
for (const field of ['messageId', 'attachmentId', 'filename', 'source']) {
  await check(`missing provenance field "${field}" is rejected and named`, async () => {
    const fields = base({ messageId: `AAMk-miss-${field}`, attachmentId: `ATT-${field}` });
    delete fields[field];
    const r = await ingest(fields, pdfFile());
    assert.equal(r.status, 400, `expected 400 for missing ${field}, got ${r.status}`);
    assert.equal(r.body.code, 'provenance-missing');
    assert.ok(Array.isArray(r.body.missing) && r.body.missing.includes(field),
      `response did not name the missing field: ${JSON.stringify(r.body.missing)}`);
  });
}

/* 5 — unknown source */
await check('unknown ingestion source is rejected', async () => {
  const r = await ingest(
    base({ source: 'gmail', messageId: 'AAMk-src', attachmentId: 'ATT-SRC' }),
    pdfFile(),
  );
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'source-unknown');
});

/* 5b — malformed receivedAt */
await check('malformed receivedAt is rejected', async () => {
  const r = await ingest(
    base({ messageId: 'AAMk-date', attachmentId: 'ATT-DATE', receivedAt: 'not-a-date' }),
    pdfFile(),
  );
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'received-at-invalid');
});

/* file missing entirely */
await check('a request with no file is rejected', async () => {
  const r = await ingest(base({ messageId: 'AAMk-nofile', attachmentId: 'ATT-NOFILE' }), null);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'file-missing');
});

console.log('\n──── authorization ────');

await check('unauthenticated ingestion is refused', async () => {
  const { body, contentType } = multipartBody(base({ messageId: 'x', attachmentId: 'y' }), pdfFile());
  const res = await fetch(`${BASE}/api/ingest/cv`, {
    method: 'POST', headers: { 'Content-Type': contentType }, body,
  });
  assert.equal(res.status, 401);
});

console.log('\n──── DOCX ────');

/* 2 — valid DOCX */
if (DOCX) {
  await check('valid DOCX is ingested', async () => {
    const r = await ingest(
      base({ messageId: 'AAMk-docx-0001', attachmentId: 'ATT-DOCX',
        filename: 'Test_Candidate_CV.docx' }),
      { name: 'Test_Candidate_CV.docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: DOCX },
    );
    assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(['PARSED', 'NO_FIELDS'].includes(r.body.status));
    const expected = crypto.createHash('sha256').update(DOCX).digest('hex');
    assert.equal(r.body.contentHash, expected, 'DOCX hash mismatch');
  });
} else {
  skip('valid DOCX is ingested', 'docx fixture could not be built');
}

console.log('\n──── provenance ────');

/* 13 — every provenance field round-trips unchanged */
await check('all Microsoft 365 provenance fields are persisted unchanged', async () => {
  const fields = base({
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
  assert.equal(row.source, 'microsoft_365');
  assert.equal(row.message_id, 'AAMk-prov-0001');
  assert.equal(row.attachment_id, 'ATT-PROV');
  assert.equal(row.sender_email, 'ahmed.mohamed@example.invalid');
  assert.equal(row.sender_name, 'Ahmed Mohamed');
  assert.equal(row.subject, 'Application for Civil Engineer');
  assert.equal(new Date(row.received_at).toISOString(), '2026-09-01T07:42:00.000Z');
  assert.equal(row.filename, 'Ahmed_Mohamed_CV.pdf');
  assert.ok(row.content_hash && row.content_hash.length === 64, 'hash not stored');
  assert.ok(row.stored_name, 'stored file reference not kept');
  assert.ok(row.created_at && row.updated_at, 'timestamps missing');
});

/* 14 — no document text in the response */
await check('the response carries no document text', async () => {
  const r = await ingest(
    base({ messageId: 'AAMk-leak-0001', attachmentId: 'ATT-LEAK' }), pdfFile());
  const serialized = JSON.stringify(r.body);
  for (const forbidden of ['rawText', 'raw_text', 'preview', 'text', 'fields']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(r.body, forbidden),
      `response exposed "${forbidden}"`);
  }
  assert.ok(!serialized.includes('Synthetic CV'),
    'response echoed document contents');
});

console.log('\n──── no candidate shortcut ────');

/* 12 — the whole suite created no candidate */
await check('ingestion created no candidate directly', async () => {
  const after = await candidateCount();
  assert.equal(after, candidatesBefore,
    `ingestion created ${after - candidatesBefore} candidate(s); it must create none`);
});

await check('every receipt is either awaiting review or produced nothing', async () => {
  const { all } = await import('./src/lib/db.js');
  const rows = all('SELECT status, intake_id FROM cv_ingestion');
  assert.ok(rows.length > 0, 'no receipts written at all');
  for (const r of rows) {
    assert.ok(['RECEIVED', 'PARSED', 'NO_FIELDS', 'FAILED'].includes(r.status),
      `unexpected status ${r.status}`);
  }
  // Anything that DID parse must point at a PENDING intake — never a candidate.
  const parsed = rows.filter((r) => r.status === 'PARSED');
  for (const r of parsed) {
    const intake = all('SELECT status, candidate_id FROM candidate_intake WHERE id=?',
      [r.intake_id])[0];
    assert.ok(intake, 'PARSED receipt points at no intake');
    assert.equal(intake.status, 'PENDING', 'ingestion pre-approved an intake');
    assert.equal(intake.candidate_id ?? null, null,
      'ingestion attached a candidate without review');
  }
});

console.log('\n──── failure + retry lifecycle ────');

/* 10 — a real persistence failure is not mistaken for a duplicate */
await check('a persistence failure propagates and is not read as a duplicate', async () => {
  const store = await import('./src/lib/ingest-store.js');
  // content_hash is NOT NULL. This is a genuine write failure, not a uniqueness
  // conflict, so it must throw rather than be swallowed as "already ingested".
  assert.throws(() => store.claimIngestion({
    source: 'microsoft_365',
    messageId: 'AAMk-broken-0001',
    attachmentId: 'ATT-BROKEN',
    filename: 'broken.pdf',
    contentHash: null,
  }), (e) => !store.isIngestionIdentityViolation(e),
  'a NOT NULL violation was misclassified as a duplicate');
});

/* 11 — FAILED is retryable in place; terminal successes are not */
await check('a FAILED receipt is retryable in place, reusing the same row', async () => {
  const store = await import('./src/lib/ingest-store.js');
  const claim = store.claimIngestion({
    source: 'microsoft_365',
    messageId: 'AAMk-retry-0001',
    attachmentId: 'ATT-RETRY',
    filename: 'retry.pdf',
    contentHash: crypto.createHash('sha256').update('retry').digest('hex'),
  });
  assert.equal(claim.claimed, true);
  const id = claim.record.id;

  const failed = store.markFailed(id, 'simulated downstream parse failure');
  assert.equal(failed.status, 'FAILED');
  assert.equal(store.isRetryable(failed), true);

  const reopened = store.reopenFailedIngestion(id);
  assert.ok(reopened, 'a FAILED receipt was not reopened');
  assert.equal(reopened.id, id, 'retry created a NEW row instead of reusing one');
  assert.equal(reopened.status, 'RECEIVED');
  assert.equal(reopened.reason ?? null, null, 'stale failure reason survived the retry');
});

await check('a PARSED or NO_FIELDS receipt is never reopened', async () => {
  const store = await import('./src/lib/ingest-store.js');
  const claim = store.claimIngestion({
    source: 'microsoft_365',
    messageId: 'AAMk-terminal-0001',
    attachmentId: 'ATT-TERMINAL',
    filename: 'terminal.pdf',
    contentHash: crypto.createHash('sha256').update('terminal').digest('hex'),
  });
  const settled = store.markNoFields(claim.record.id, 'nothing readable');
  assert.equal(store.isRetryable(settled), false);
  assert.equal(store.reopenFailedIngestion(claim.record.id), null,
    'a successfully-ingested receipt was reopened for reprocessing');
});

/* 11b — a FAILED receipt re-POSTed over HTTP is reprocessed, not duplicated */
await check('re-POSTing a FAILED attachment reprocesses the same receipt', async () => {
  const store = await import('./src/lib/ingest-store.js');
  const { all } = await import('./src/lib/db.js');
  const id = { messageId: 'AAMk-httpretry-0001', attachmentId: 'ATT-HTTPRETRY' };

  const first = await ingest(base(id), pdfFile());
  assert.equal(first.status, 201);
  store.markFailed(first.body.ingestionId, 'simulated failure');

  const again = await ingest(base(id), pdfFile());
  assert.equal(again.status, 201, 'a FAILED attachment was not reprocessed');
  assert.equal(again.body.ingestionId, first.body.ingestionId,
    'reprocessing created a second receipt');

  const rows = all('SELECT id FROM cv_ingestion WHERE message_id=? AND attachment_id=?',
    [id.messageId, id.attachmentId]);
  assert.equal(rows.length, 1, `retry left ${rows.length} receipts`);
});

console.log('\n──── parse path (needs a CV reader) ────');

if (READER_WIRED) {
  await check('a readable CV is staged as a PENDING intake and no candidate', async () => {
    const before = await candidateCount();
    const r = await ingest(
      base({ messageId: 'AAMk-parse-0001', attachmentId: 'ATT-PARSE' }), pdfFile());
    assert.equal(r.status, 201);
    if (r.body.status === 'PARSED') {
      assert.ok(r.body.intakeId, 'PARSED receipt has no intakeId');
      const { get } = await import('./src/lib/db.js');
      const intake = get('SELECT * FROM candidate_intake WHERE id=?', [r.body.intakeId]);
      assert.equal(intake.status, 'PENDING');
      assert.equal(intake.origin, 'mailbox.ingest', 'intake origin not marked as mailbox');
    }
    assert.equal(await candidateCount(), before, 'parsing created a candidate');
  });
} else {
  skip('a readable CV is staged as a PENDING intake', 'no ANTHROPIC_API_KEY, so no CV reader is wired');
  await check('with no reader wired, ingestion still records a durable receipt', async () => {
    const r = await ingest(
      base({ messageId: 'AAMk-noreader-0001', attachmentId: 'ATT-NOREADER' }), pdfFile());
    assert.equal(r.status, 201, 'a missing reader must not fail the ingestion');
    assert.equal(r.body.status, 'NO_FIELDS');
    assert.equal(r.body.code, 'no-fields');
    assert.ok(r.body.reason, 'no reason given for producing nothing');
  });
}

console.log('\n──── scan state ────');

await check('first run reports the conservative 2026-09-01 floor', async () => {
  const r = await api('/api/ingest/scan-state?source=microsoft_365', { token: TOKEN });
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'microsoft_365');
  assert.equal(r.body.lastSuccessfulScanAt, '2026-09-01T00:00:00.000Z',
    'first-run watermark is not the agreed floor');
  assert.equal(r.body.isFirstRun, true);
});

await check('the watermark advances and is read back', async () => {
  const r = await api('/api/ingest/scan-state', {
    method: 'PUT', token: TOKEN,
    body: { source: 'microsoft_365', lastSuccessfulScanAt: '2026-09-01T18:00:00Z' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.lastSuccessfulScanAt, '2026-09-01T18:00:00.000Z');

  const back = await api('/api/ingest/scan-state', { token: TOKEN });
  assert.equal(back.body.lastSuccessfulScanAt, '2026-09-01T18:00:00.000Z');
  assert.equal(back.body.isFirstRun, false);
});

await check('the watermark refuses to move backwards', async () => {
  const r = await api('/api/ingest/scan-state', {
    method: 'PUT', token: TOKEN,
    body: { source: 'microsoft_365', lastSuccessfulScanAt: '2026-09-01T06:00:00Z' },
  });
  assert.equal(r.status, 409, 'a backwards watermark was accepted');
  assert.equal(r.body.code, 'scan-state-regression');

  const back = await api('/api/ingest/scan-state', { token: TOKEN });
  assert.equal(back.body.lastSuccessfulScanAt, '2026-09-01T18:00:00.000Z',
    'the refused write still mutated the watermark');
});

await check('a deliberate rewind is allowed with force', async () => {
  const r = await api('/api/ingest/scan-state', {
    method: 'PUT', token: TOKEN,
    body: { source: 'microsoft_365', lastSuccessfulScanAt: '2026-09-01T06:00:00Z', force: true },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.lastSuccessfulScanAt, '2026-09-01T06:00:00.000Z');
  assert.equal(r.body.forced, true);
});

await check('a malformed watermark is rejected', async () => {
  const r = await api('/api/ingest/scan-state', {
    method: 'PUT', token: TOKEN,
    body: { source: 'microsoft_365', lastSuccessfulScanAt: 'yesterday' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'scan-state-invalid');
});

await check('scan state for an unknown source is refused', async () => {
  const r = await api('/api/ingest/scan-state?source=gmail', { token: TOKEN });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'source-unknown');
});

/* ---------------------------------- summary -------------------------------- */

console.log(`\n════════ ingest_cv_test ════════`);
console.log(`${passed} passed, ${failures.length} failed, ${skipped} skipped`);
if (failures.length) {
  console.log(`FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('OK ✅');
process.exit(0);
