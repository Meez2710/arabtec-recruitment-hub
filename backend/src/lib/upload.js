// Minimal dependency-free multipart/form-data parser + DURABLE file storage.
// Files are stored as bytes in the `file_blob` table so they survive redeploys
// on hosts without a persistent disk (Render free tier). A disk copy is also
// written when a writable dir exists (best-effort cache); the DB is the source
// of truth. Everything is keyed by `storedName`, so route code is unchanged.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { run, get } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Uploads live next to the DB on the persistent disk in production.
// UPLOAD_DIR env wins; else derive from a file: DATABASE_URL's directory; else local default.
function resolveUploadDir() {
  if (process.env.UPLOAD_DIR) return path.resolve(process.env.UPLOAD_DIR);
  const url = process.env.DATABASE_URL || '';
  if (url.startsWith('file:')) {
    const dbFile = url.slice(5);
    const dir = path.isAbsolute(dbFile) ? path.dirname(dbFile) : null;
    if (dir) return path.join(dir, 'uploads');
  }
  return path.resolve(__dirname, '../../data/uploads');
}
const UPLOAD_DIR = resolveUploadDir();
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB cap (approved for CV uploads)
const ALLOWED = new Set(['.pdf', '.doc', '.docx', '.png', '.jpg', '.jpeg', '.txt']);

// Retain at most MAX_BYTES from the request, including multipart framing.
// An oversized or interrupted stream settles once and releases retained chunks.
export function multipart(req, res, next) {
  const ct = req.headers['content-type'] || '';
  if (!/^multipart\/form-data(?:;|$)/i.test(ct)) return res.status(400).json({ error: 'Expected multipart/form-data.' });
  const m = ct.match(/;\s*boundary=(?:"([^"\r\n]+)"|([^;\s]+))/i);
  const token = m?.[1] || m?.[2];
  if (!token || token.length > 70) return res.status(400).json({ error: 'Missing or invalid multipart boundary.' });
  const chunks = [];
  let total = 0;
  let settled = false;
  const fail = (status, error) => {
    if (settled) return;
    settled = true;
    chunks.length = 0;
    res.status(status).json({ error });
    req.resume(); // Drain without retaining bytes, allowing the 413 to reach the client.
  };
  req.on('data', (chunk) => {
    if (settled) return;
    total += chunk.length;
    if (total > MAX_BYTES) return fail(413, 'File too large (max 20MB).');
    chunks.push(chunk);
  });
  req.on('error', () => fail(400, 'Upload stream error.'));
  req.on('aborted', () => fail(400, 'Upload interrupted.'));
  req.on('end', () => {
    if (settled) return;
    let parsed;
    try { parsed = parseMultipart(Buffer.concat(chunks, total), token); }
    catch (error) { return fail(400, error.message); }
    chunks.length = 0;
    req.fields = parsed.fields;
    req.uploadedFile = null;
    if (parsed.file) {
      try { req.uploadedFile = storeFile(parsed.file.originalName, parsed.file.content); }
      catch { return fail(503, 'Unable to persist upload. Please retry.'); }
    }
    settled = true;
    next();
  });
  if (Number(req.headers['content-length']) > MAX_BYTES) fail(413, 'File too large (max 20MB).');
}

function parseMultipart(body, token) {
  const boundary = Buffer.from('--' + token);
  const delimiter = Buffer.from('\r\n--' + token);
  if (!body.subarray(0, boundary.length).equals(boundary)) throw new Error('Invalid multipart body.');
  let offset = boundary.length;
  let file = null;
  const fields = Object.create(null);
  let parts = 0;
  while (true) {
    if (body.subarray(offset, offset + 2).toString() === '--') return { fields, file };
    if (body.subarray(offset, offset + 2).toString() !== '\r\n') throw new Error('Invalid multipart body.');
    offset += 2;
    if (++parts > 32) throw new Error('Too many multipart fields.');
    const headerEnd = body.indexOf('\r\n\r\n', offset);
    if (headerEnd < 0 || headerEnd - offset > 8192) throw new Error('Invalid multipart headers.');
    const header = body.subarray(offset, headerEnd).toString('utf8');
    const name = header.match(/(?:^|;)\s*name="([^"\r\n]*)"/im)?.[1];
    const filename = header.match(/(?:^|;)\s*filename="([^"\r\n]*)"/im)?.[1];
    if (name == null) throw new Error('Missing multipart field name.');
    let end = headerEnd + 4;
    while (true) {
      end = body.indexOf(delimiter, end);
      if (end < 0) throw new Error('Incomplete multipart body.');
      const suffix = body.subarray(end + delimiter.length, end + delimiter.length + 2).toString();
      if (suffix === '--' || suffix === '\r\n') break;
      end += delimiter.length;
    }
    const content = body.subarray(headerEnd + 4, end);
    if (filename) {
      if (file) throw new Error('Only one file is allowed per upload.');
      const originalName = path.basename(filename.replace(/\\/g, '/'));
      const ext = path.extname(originalName).toLowerCase();
      if (!ALLOWED.has(ext)) throw new Error(`File type ${ext || '(none)'} not allowed.`);
      file = { originalName, content };
    } else fields[name] = content.toString('utf8');
    offset = end + delimiter.length;
  }
}

// DB persistence is required. Callers may include this in a synchronous tx().
// Folder imports cache only after commit so a rollback leaves no disk orphan.
export function storeFile(originalName, content, { cache = true } = {}) {
  const ext = path.extname(originalName).toLowerCase();
  if (!ALLOWED.has(ext)) throw new Error('File type not allowed.');
  if (content.length > MAX_BYTES) throw new Error('File too large (max 20MB).');
  const storedName = crypto.randomUUID() + ext;
  saveBlob(storedName, originalName, mimeForExt(ext), content);
  if (cache) cacheFile(storedName, content);
  return { storedName, originalName, size: content.length, ext };
}

export function cacheFile(storedName, content) {
  try { fs.writeFileSync(path.join(UPLOAD_DIR, storedName), content); } catch { /* durable DB copy exists */ }
}

function mimeForExt(ext) {
  return ({
    '.pdf': 'application/pdf', '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.txt': 'text/plain',
  })[ext] || 'application/octet-stream';
}

// Persist file bytes in the DB. node:sqlite takes a Uint8Array for BLOB params;
// the Postgres path stores base64 text transparently (see db.js binary handling).
function saveBlob(storedName, originalName, mime, buf) {
  run('INSERT INTO file_blob (stored_name, original_name, mime, size, data) VALUES (?,?,?,?,?)',
    [storedName, originalName, mime, buf.length, new Uint8Array(buf)]);
}

// Read a stored file as a Buffer — DB first (durable), disk fallback (cache).
export function readBlob(storedName) {
  if (!storedName) return null;
  try {
    const row = get('SELECT data, mime, original_name FROM file_blob WHERE stored_name=?', [storedName]);
    if (row && row.data != null) {
      const data = row.data instanceof Uint8Array ? Buffer.from(row.data)
        : Buffer.isBuffer(row.data) ? row.data
        : typeof row.data === 'string' ? Buffer.from(row.data, 'base64')
        : Buffer.from(row.data);
      return { data, mime: row.mime, originalName: row.original_name };
    }
  } catch {}
  // disk fallback
  const p = path.join(UPLOAD_DIR, storedName);
  if (fs.existsSync(p)) return { data: fs.readFileSync(p), mime: null, originalName: null };
  return null;
}

// Stream a stored file to an Express response (used by download endpoints).
export function streamFile(storedName, res, fallbackName, opts = {}) {
  const f = readBlob(storedName);
  if (!f) { res.status(404).json({ error: 'File not found.' }); return false; }
  // Hardening: nosniff always. Documents are served as downloads (attachment).
  // Images explicitly requested inline (e.g. the logo) display in the page; this
  // is safe because only known image mime types reach here.
  res.setHeader('Content-Type', f.mime || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const disp = opts.inline ? 'inline' : 'attachment';
  res.setHeader('Content-Disposition', `${disp}; filename="${(f.originalName || fallbackName || 'file').replace(/"/g, '')}"`);
  res.end(f.data);
  return true;
}

export function uploadPath(storedName) { return path.join(UPLOAD_DIR, storedName); }
export function fileExists(storedName) {
  if (!storedName) return false;
  try { if (get('SELECT 1 AS x FROM file_blob WHERE stored_name=?', [storedName])) return true; } catch {}
  return fs.existsSync(path.join(UPLOAD_DIR, storedName));
}
export { UPLOAD_DIR, MAX_BYTES };
