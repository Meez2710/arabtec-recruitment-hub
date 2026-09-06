// One process-wide queue shared by manual scans and the automatic watcher.
// Parsing awaits happen outside tx(); candidate/document/blob writes are atomic.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tx, run } from './db.js';
import { Candidates, CandidateDocuments, CandidateActivity } from './models.js';
import { getParser } from './parsing/registry.js';
import { toCandidatePayload, toParseMetadata } from './cv-mapper.js';
import { storeFile, cacheFile, MAX_BYTES } from './upload.js';

const DEFAULT_INBOX = fileURLToPath(new URL('../../cv_inbox', import.meta.url));
const EXTENSIONS = new Set(['.pdf', '.docx', '.doc', '.txt']);
export const inboxDirectory = () => path.resolve(process.env.CV_INBOX || DEFAULT_INBOX);
export const isInboxFile = file => EXTENSIONS.has(path.extname(file).toLowerCase());
let importTail = Promise.resolve();

export function importInboxFile(filePath, options = {}) {
  const pending = importTail.then(() => importFile(filePath, options));
  importTail = pending.catch(() => {});
  return pending;
}

async function importFile(filePath, { user = null, onCreated = null } = {}) {
  // Snapshot once, bounded even if the source grows during this read. The hash,
  // parser, and durable document all refer to these same bytes.
  const fd = fs.openSync(filePath, 'r');
  let bytes;
  try {
    if (!fs.fstatSync(fd).isFile()) return { skipped: true, reason: 'Not a regular file' };
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_BYTES) throw new Error('File too large (max 20MB).');
    bytes = buffer.subarray(0, length);
  } finally { fs.closeSync(fd); }
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (CandidateDocuments.byHash(hash).length) return { skipped: true, reason: 'Duplicate document' };

  const file = path.basename(filePath);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-import-'));
  let entities;
  try {
    const snapshot = path.join(tempDir, file);
    fs.writeFileSync(snapshot, bytes);
    entities = await getParser().parseEntities(snapshot);
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
  const { payload } = toCandidatePayload(entities);
  if (entities.metadata?.parse_status === 'failed' || !payload.fullName) {
    return { skipped: true, reason: entities.metadata?.parse_status_reason || 'No candidate name was supported by the document' };
  }
  const result = tx(() => {
    // Check again after parsing: other candidate operations may have committed.
    if (CandidateDocuments.byHash(hash).length) return { skipped: true, reason: 'Duplicate document' };
    if (payload.email) {
      const duplicate = Candidates.findDuplicates({ email: payload.email })[0];
      if (duplicate) return { skipped: true, reason: `Duplicate email (${duplicate.candidate_no})` };
    }
    const stored = storeFile(file, bytes, { cache: false });
    const candidateNo = Candidates.nextNo();
    const candidate = Candidates.create({ candidateNo, ...payload, source: 'folder_drop', ownerRecruiterId: user?.id ?? null, createdBy: user?.id ?? null });
    // Candidates.create intentionally does not map resume columns.
    run('UPDATE candidate SET resume_name=?, resume_path=? WHERE id=?', [file, stored.storedName, candidate.id]);
    Candidates.setParseMeta(candidate.id, toParseMetadata(entities));
    const doc = CandidateDocuments.add({ candidateId: candidate.id, docType: 'cv', fileName: file, fileHash: hash, fileSize: bytes.length, uploadedBy: user?.id ?? null });
    run('UPDATE candidate_document SET stored_path=? WHERE id=?', [stored.storedName, doc.id]);
    CandidateActivity.add({ candidateId: candidate.id, actorId: user?.id ?? null, actorName: user?.fullName || 'watcher', type: 'candidate_created', note: `${candidateNo} (folder_drop: ${file})` });
    const created = Candidates.byId(candidate.id);
    const extra = onCreated?.(created);
    if (extra && typeof extra.then === 'function') throw new Error('Import onCreated must be synchronous');
    return { skipped: false, created, candidateNo, storedName: stored.storedName, extra };
  });
  if (!result.skipped) cacheFile(result.storedName, bytes);
  return result;
}
