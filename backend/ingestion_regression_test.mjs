import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ingestion-regression-'));
process.env.DATABASE_URL = `file:${path.join(temp, 'test.db')}`;
process.env.UPLOAD_DIR = path.join(temp, 'uploads');
process.env.CV_INBOX = path.join(temp, 'inbox');
process.env.CV_WATCH_INTERVAL_MIN = '0';
fs.mkdirSync(process.env.CV_INBOX);
const { ensureSchema } = await import('./src/lib/schema.js');
ensureSchema();
const { multipart, readBlob } = await import('./src/lib/upload.js');
const { get, exec, run } = await import('./src/lib/db.js');
run("INSERT INTO system_setting (key, value) VALUES ('candidate_counter', '0')");
run("INSERT INTO users (id, full_name, email, password_hash) VALUES (1, 'Test Recruiter', 'ingestion@example.test', 'x')");
const watcher = await import('./src/lib/cv-watcher.js');
const registry = await import('./src/lib/parsing/registry.js');
function request(contentType = 'multipart/form-data; boundary=test') {
  const req = new EventEmitter(); req.headers = { 'content-type': contentType }; req.resume = () => {};
  const responses = []; let nextCount = 0;
  const res = { status(code) { this.code = code; return this; }, json(body) { responses.push({ code: this.code, body }); return this; } };
  multipart(req, res, () => nextCount++);
  return { req, responses, nextCount: () => nextCount };
}
const body = (name = 'cv.txt', text = 'Jane Doe') => Buffer.from(`--test\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n\r\n${text}\r\n--test--\r\n`);
test('upload rejects oversized stream immediately and settles once', () => {
  const x = request(); const chunk = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < 21; i++) x.req.emit('data', chunk);
  assert.equal(x.responses[0]?.code, 413);
  x.req.emit('error', new Error('late')); x.req.emit('end');
  assert.equal(x.responses.length, 1); assert.equal(x.nextCount(), 0);
});
test('quoted multipart boundary preserves binary bytes and persists durable file', () => {
  const x = request('multipart/form-data; boundary="test"');
  x.req.emit('data', body()); x.req.emit('end');
  assert.equal(x.nextCount(), 1); assert.ok(x.req.uploadedFile);
  assert.equal(readBlob(x.req.uploadedFile.storedName).data.toString(), 'Jane Doe');
});
test('durable blob failure cannot report upload success', () => {
  exec("CREATE TRIGGER reject_blob BEFORE INSERT ON file_blob BEGIN SELECT RAISE(ABORT, 'injected blob failure'); END");
  try {
    const x = request(); x.req.emit('data', body()); x.req.emit('end');
    assert.equal(x.nextCount(), 0); assert.equal(x.responses[0]?.code, 503);
  } finally { exec('DROP TRIGGER reject_blob'); }
});
test('watcher interval zero stays disabled', () => {
  watcher.startWatcher();
  try { assert.equal(watcher.getWatcherStatus().running, false); assert.equal(watcher.getWatcherStatus().intervalMin, 0); }
  finally { watcher.stopWatcher(); }
});
test('shared import deduplicates concurrent no-email resumes and stores retrievable snapshot', async () => {
  const { importInboxFile } = await import('./src/lib/cv-import.js');
  const file = path.join(process.env.CV_INBOX, 'jane.txt'); fs.writeFileSync(file, 'Jane Doe');
  registry.registerParser('fixture', { name: 'fixture', parseLegacy: async () => ({}), parseEntities: async () => {
    await new Promise(resolve => setImmediate(resolve));
    return { personal: { full_name: { value: 'Jane Doe', validation: 'verified' } }, metadata: { parse_status: 'success' } };
  } }); registry.selectParser('fixture');
  const results = await Promise.all([importInboxFile(file), importInboxFile(file)]);
  assert.equal(results.filter(r => !r.skipped).length, 1);
  const c = results.find(r => !r.skipped).created;
  assert.ok(c.resume_path); assert.equal(path.isAbsolute(c.resume_path), false);
  fs.unlinkSync(file); assert.equal(readBlob(c.resume_path).data.toString(), 'Jane Doe');
  const doc = get('SELECT * FROM candidate_document WHERE candidate_id=?', [c.id]);
  assert.match(doc.file_hash, /^[a-f0-9]{64}$/); assert.equal(doc.stored_path, c.resume_path);
});
test('shared import rolls back candidate, document and blob after activity failure', async () => {
  const { importInboxFile } = await import('./src/lib/cv-import.js');
  const file = path.join(process.env.CV_INBOX, 'rollback.txt'); fs.writeFileSync(file, 'Different document');
  const before = ['candidate', 'candidate_document', 'file_blob'].map(t => get(`SELECT COUNT(*) n FROM ${t}`).n);
  exec("CREATE TRIGGER reject_activity BEFORE INSERT ON candidate_activity BEGIN SELECT RAISE(ABORT, 'injected activity failure'); END");
  try { await assert.rejects(importInboxFile(file), /injected activity failure/); }
  finally { exec('DROP TRIGGER reject_activity'); }
  assert.deepEqual(['candidate', 'candidate_document', 'file_blob'].map(t => get(`SELECT COUNT(*) n FROM ${t}`).n), before);
  assert.equal((await importInboxFile(file)).skipped, false);
});
test('manual inbox scan and automatic watcher share deduplication and durable downloads', async () => {
  const { default: router } = await import('./src/routes/candidates.js');
  const handler = router.stack.find(layer => layer.route?.path === '/inbox-scan').route.stack.at(-1).handle;
  const file = path.join(process.env.CV_INBOX, 'manual.txt');
  fs.writeFileSync(file, 'Manual Watcher Shared Document');
  const before = get('SELECT COUNT(*) n FROM candidate').n;
  const scansBefore = watcher.getWatcherStatus().scanCount;
  process.env.CV_WATCH_INTERVAL_MIN = '60';
  const response = { status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  const req = { body: {}, user: { id: 1, fullName: 'Test Recruiter', permissions: ['candidate.add'] }, headers: {} };
  // Start the manual path first so the automatic path must honor its lock.
  const manual = handler(req, response);
  watcher.startWatcher();
  await manual;
  for (let i = 0; i < 1000 && watcher.getWatcherStatus().scanCount === scansBefore; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  watcher.stopWatcher();
  process.env.CV_WATCH_INTERVAL_MIN = '0';
  assert.equal(watcher.getWatcherStatus().scanCount, scansBefore + 1);
  assert.equal(response.body.imported, 1, 'manual scan must import txt through shared entity parser');
  assert.equal(response.body.errors, 0);
  assert.equal(get('SELECT COUNT(*) n FROM candidate').n, before + 1);
  const candidate = get('SELECT * FROM candidate ORDER BY id DESC LIMIT 1');
  fs.unlinkSync(file);
  assert.equal(readBlob(candidate.resume_path).data.toString(), 'Manual Watcher Shared Document');
});
test.after(() => { watcher.stopWatcher(); fs.rmSync(temp, { recursive: true, force: true }); });
