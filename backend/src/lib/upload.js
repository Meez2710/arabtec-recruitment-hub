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

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB cap
const ALLOWED = new Set(['.pdf', '.doc', '.docx', '.png', '.jpg', '.jpeg', '.txt']);

// Express middleware: parses multipart body, writes the file to disk, sets
// req.uploadedFile = { storedPath, originalName, size, ext } and req.fields = {...}.
export function multipart(req, res, next) {
  const ct = req.headers['content-type'] || '';
  if (!ct.startsWith('multipart/form-data')) return res.status(400).json({ error: 'Expected multipart/form-data.' });
  const m = ct.match(/boundary=(.+)$/);
  if (!m) return res.status(400).json({ error: 'Missing multipart boundary.' });
  const boundary = Buffer.from('--' + m[1]);

  const chunks = [];
  let total = 0;
  let tooBig = false;
  req.on('data', (c) => { total += c.length; if (total > MAX_BYTES) { tooBig = true; } chunks.push(c); });
  req.on('end', () => {
    if (tooBig) return res.status(413).json({ error: 'File too large (max 15MB).' });
    try {
      const body = Buffer.concat(chunks);
      const parts = splitBuffer(body, boundary);
      req.fields = {};
      req.uploadedFile = null;
      for (const part of parts) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd < 0) continue;
        const header = part.slice(0, headerEnd).toString('utf8');
        let content = part.slice(headerEnd + 4);
        // trailing CRLF
        if (content.slice(-2).toString() === '\r\n') content = content.slice(0, -2);
        const nameM = header.match(/name="([^"]*)"/);
        const fileM = header.match(/filename="([^"]*)"/);
        if (!nameM) continue;
        const field = nameM[1];
        if (fileM && fileM[1]) {
          const original = path.basename(fileM[1]);
          const ext = path.extname(original).toLowerCase();
          if (!ALLOWED.has(ext)) return res.status(400).json({ error: `File type ${ext || '(none)'} not allowed.` });
          const stored = crypto.randomUUID() + ext;
          // Durable: store bytes in the DB (survives redeploys everywhere).
          saveBlob(stored, original, mimeForExt(ext), content);
          // Best-effort local cache copy (ignored if dir not writable).
          try { fs.writeFileSync(path.join(UPLOAD_DIR, stored), content); } catch {}
          req.uploadedFile = { storedName: stored, originalName: original, size: content.length, ext };
        } else {
          req.fields[field] = content.toString('utf8');
        }
      }
      next();
    } catch (e) { res.status(400).json({ error: 'Failed to parse upload.' }); }
  });
  req.on('error', () => res.status(400).json({ error: 'Upload stream error.' }));
}

function splitBuffer(buf, sep) {
  const parts = []; let start = 0; let idx;
  while ((idx = buf.indexOf(sep, start)) !== -1) {
    if (idx > start) parts.push(buf.slice(start, idx));
    start = idx + sep.length;
  }
  return parts.filter((p) => p.length > 4); // drop boundary noise / trailing "--"
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
  try {
    run('INSERT INTO file_blob (stored_name, original_name, mime, size, data) VALUES (?,?,?,?,?)',
      [storedName, originalName, mime, buf.length, new Uint8Array(buf)]);
  } catch (e) { /* if blob store unavailable, disk copy still serves locally */ }
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
export { UPLOAD_DIR };
