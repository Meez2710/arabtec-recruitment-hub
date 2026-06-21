// Minimal dependency-free multipart/form-data parser + disk storage.
// Avoids adding multer/busboy — handles a single file field ("file") + text fields,
// which is all the app needs (resume / request attachment).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

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
          fs.writeFileSync(path.join(UPLOAD_DIR, stored), content);
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

export function uploadPath(storedName) { return path.join(UPLOAD_DIR, storedName); }
export function fileExists(storedName) { return storedName && fs.existsSync(path.join(UPLOAD_DIR, storedName)); }
export { UPLOAD_DIR };
