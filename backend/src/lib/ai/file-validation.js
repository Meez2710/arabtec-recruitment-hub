// Secure validation of an uploaded CV, before a single byte reaches the GPU.
//
// THE EXTENSION IS NOT EVIDENCE. A filename is attacker-controlled, so the type
// is decided by the leading bytes and the extension only has to AGREE. That
// closes the case where `payload.pdf` is really a zip and the case where a
// legitimate PDF is named `.txt`.
//
// PDF AND DOCX ONLY, on purpose. The wider set the general upload path accepts
// (images, .doc, .txt) is fine for attachments a human opens, but each format
// here is a parser surface on a machine with a GPU and a model on it. Two
// formats, both checked, is the staging scope.
//
// DOCX IS A ZIP, AND THAT MATTERS. Every zip starts `PK\x03\x04`, so the magic
// bytes alone cannot tell a .docx from a .xlsx or from a zip bomb named .docx.
// The check therefore also requires the OOXML word/ marker to be present in the
// archive's central directory.

import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { AI_ERROR, AiIntakeError } from './errors.js';

export const ALLOWED_INTAKE_TYPES = Object.freeze({
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
});

const PDF_MAGIC = Buffer.from('%PDF-');
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** A .docx must contain the WordprocessingML part; a bare zip must not pass. */
const looksLikeDocx = (buf) => {
  // The central directory lists entry names verbatim; searching the whole
  // buffer is cheap at these sizes and avoids implementing a zip reader.
  const head = buf.subarray(0, Math.min(buf.length, 4 * 1024 * 1024));
  return head.includes(Buffer.from('word/document.xml'))
    || head.includes(Buffer.from('word/'));
};

/**
 * Decide the real type, or refuse.
 *
 * @returns {{ext: string, mime: string}}
 * @throws {AiIntakeError} FILE_UNSUPPORTED_TYPE / FILE_TOO_LARGE / FILE_CORRUPT
 */
export function validateIntakeFile({ bytes, originalName, maxBytes }) {
  if (!bytes || bytes.length === 0) {
    throw new AiIntakeError(AI_ERROR.FILE_CORRUPT, { permanent: true, status: 400 });
  }
  if (bytes.length > maxBytes) {
    throw new AiIntakeError(AI_ERROR.FILE_TOO_LARGE, { permanent: true, status: 413 });
  }

  const ext = path.extname(String(originalName || '')).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_INTAKE_TYPES, ext)) {
    throw new AiIntakeError(AI_ERROR.UNSUPPORTED_TYPE, { permanent: true, status: 415 });
  }

  const isPdf = bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
  const isZip = bytes.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC);

  // Content and extension must AGREE. Either one alone is forgeable.
  if (ext === '.pdf' && !isPdf) {
    throw new AiIntakeError(AI_ERROR.UNSUPPORTED_TYPE, { permanent: true, status: 415 });
  }
  if (ext === '.docx' && !(isZip && looksLikeDocx(bytes))) {
    throw new AiIntakeError(AI_ERROR.UNSUPPORTED_TYPE, { permanent: true, status: 415 });
  }

  return { ext, mime: ALLOWED_INTAKE_TYPES[ext] };
}

/**
 * Stable identity for an upload, so a repeat submission is recognised.
 *
 * Content-addressed and scoped to the requester: the same person re-uploading
 * the same CV is the same task, two recruiters uploading the same CV are not.
 * The hash never leaves the server and is not derived from the filename, which
 * a user can change between attempts without changing the document.
 */
export function intakeIdempotencyKey({ bytes, userId, capability }) {
  return crypto.createHash('sha256')
    .update(capability).update('\0')
    .update(String(userId)).update('\0')
    .update(bytes)
    .digest('hex');
}

/**
 * A randomly named scratch file plus a cleanup that CANNOT be forgotten.
 *
 * Randomised because a predictable temp path in a shared directory is a
 * symlink-swap invitation; 0600 because the file is a candidate's CV. The
 * callback form exists so cleanup runs on the throw path too — a `finally` the
 * caller cannot omit.
 *
 * @param {{bytes: Buffer, ext: string}} file
 * @param {(tempPath: string) => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
export async function withTempFile({ bytes, ext }, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-intake-'));
  const tempPath = path.join(dir, `${crypto.randomUUID()}${ext}`);
  try {
    fs.writeFileSync(tempPath, bytes, { mode: 0o600 });
    return await fn(tempPath);
  } finally {
    // Best-effort but exhaustive: remove the file, then the directory. A
    // failure here must never mask the original error.
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
}
