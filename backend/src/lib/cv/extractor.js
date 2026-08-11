// Extractor — file bytes to plain text. The only layer that knows about file
// formats or third-party document libraries.
//
// Behaviour is carried over verbatim from the original cv-parser.js: every
// failure path returns '' rather than throwing, so a malformed CV degrades to an
// empty parse instead of breaking an import batch.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.doc', '.txt'];

export function isSupported(filePath) {
  return SUPPORTED_EXTENSIONS.includes(path.extname(String(filePath || '')).toLowerCase());
}

// D-09 fix. pdf-parse@2 pulls in @napi-rs/canvas, whose native binding is
// platform-specific and absent on any host where node_modules was installed for a
// different OS. When it fails to load, pdfjs has no DOMMatrix and getText() throws
// — and the old `catch { return '' }` made a total library failure look like an
// empty CV. We now talk to pdfjs-dist directly (already a transitive dependency)
// and polyfill the one DOM type it needs. Text extraction never needs a canvas;
// canvas is only required for RENDERING, which we do not do.
function ensureDomMatrix() {
  if (typeof globalThis.DOMMatrix !== 'undefined') return;
  class DOMMatrix {
    constructor(init) {
      let m = [1, 0, 0, 1, 0, 0];
      if (typeof init === 'string') m = init.replace(/matrix\(|\)/g, '').split(',').map(Number);
      else if (Array.isArray(init) && init.length >= 6) m = init.slice(0, 6).map(Number);
      [this.a, this.b, this.c, this.d, this.e, this.f] = m;
    }
    multiplySelf(o) {
      const { a, b, c, d, e, f } = this;
      this.a = a * o.a + c * o.b; this.b = b * o.a + d * o.b;
      this.c = a * o.c + c * o.d; this.d = b * o.c + d * o.d;
      this.e = a * o.e + c * o.f + e; this.f = b * o.e + d * o.f + f;
      return this;
    }
    #clone() { return new DOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f]); }
    multiply(o) { return this.#clone().multiplySelf(o); }
    translateSelf(tx = 0, ty = 0) { this.e += this.a * tx + this.c * ty; this.f += this.b * tx + this.d * ty; return this; }
    translate(tx, ty) { return this.#clone().translateSelf(tx, ty); }
    scaleSelf(sx = 1, sy = sx) { this.a *= sx; this.b *= sx; this.c *= sy; this.d *= sy; return this; }
    scale(sx, sy) { return this.#clone().scaleSelf(sx, sy); }
    transformPoint(pt = { x: 0, y: 0 }) {
      return { x: this.a * pt.x + this.c * pt.y + this.e, y: this.b * pt.x + this.d * pt.y + this.f };
    }
    toString() { return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f})`; }
  }
  globalThis.DOMMatrix = DOMMatrix;
}

// pdfjs returns positioned text fragments, not lines. Joining them all with
// spaces flattens a CV into one line per page, which destroys the line structure
// the section detector and name detector depend on — the name detector then falls
// back to the filename (a UUID). pdf-parse used to emit newlines; pdfjs does not.
//
// Group fragments by baseline Y (transform[5]), emit one line per baseline, and
// insert a space only where there is a real horizontal gap. EPS absorbs sub-pixel
// jitter so a single visual line is not split in two.
const LINE_EPS = 2.0;      // points of Y jitter still counted as the same line
const GAP_RATIO = 0.28;    // gap > this * fontHeight becomes a space

function itemsToLines(items) {
  const lines = [];
  for (const it of items || []) {
    const str = it.str || '';
    if (!str) continue;
    const tr = it.transform || [];
    const y = typeof tr[5] === 'number' ? tr[5] : 0;
    const x = typeof tr[4] === 'number' ? tr[4] : 0;
    const h = Math.abs(typeof tr[3] === 'number' ? tr[3] : 10) || 10;
    let bucket = null;
    for (const L of lines) { if (Math.abs(L.y - y) <= LINE_EPS) { bucket = L; break; } }
    if (!bucket) { bucket = { y, parts: [] }; lines.push(bucket); }
    bucket.parts.push({ x, w: it.width || 0, h, str });
    // pdfjs sets hasEOL on an explicit end-of-line marker; honour it.
    if (it.hasEOL) bucket.eol = true;
  }
  // Top-down (PDF Y grows upward), then left-to-right within each line.
  lines.sort((a, b) => b.y - a.y);
  return lines.map((L) => {
    L.parts.sort((a, b) => a.x - b.x);
    let text = '';
    let prevEnd = null;
    let prevH = 10;
    for (const p of L.parts) {
      if (prevEnd !== null) {
        const gap = p.x - prevEnd;
        const needsSpace = gap > GAP_RATIO * Math.max(prevH, p.h);
        if (needsSpace && !/\s$/.test(text) && !/^\s/.test(p.str)) text += ' ';
      }
      text += p.str;
      prevEnd = p.x + (p.w || 0);
      prevH = p.h;
    }
    return text.replace(/[ \t]+/g, ' ').trim();
  }).filter(Boolean).join('\n');
}

let _pdfjs = null;
async function loadPdfjs() {
  if (_pdfjs) return _pdfjs;
  ensureDomMatrix();
  _pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return _pdfjs;
}

async function pdfText(filePath) {
  try {
    if (process.env.DOCLING_BASE_URL) {
      const baseUrl = process.env.DOCLING_BASE_URL.replace(/\/$/, '');
      const formData = new FormData();
      formData.append('file', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
      
      const res = await fetch(`${baseUrl}/convert`, {
        method: 'POST',
        body: formData,
      });
      if (res.ok) {
        const data = await res.json();
        return data.markdown || '';
      }
      console.warn('[docling] Fallback to pdfjs due to Docling sidecar error:', res.status, await res.text());
    }
    const pdfjs = await loadPdfjs();
    const data = new Uint8Array(fs.readFileSync(filePath));
    const doc = await pdfjs.getDocument({
      data,
      isEvalSupported: false,     // never eval font programs
      disableFontFace: true,      // no font rendering needed for text
      useSystemFonts: false,      // avoids native font lookups
    }).promise;
    let out = '';
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      out += itemsToLines(tc.items) + '\n';
      page.cleanup();
    }
    await doc.destroy();
    return out.trim();
  } catch (err) {
    // Loud on purpose. A silent '' here is indistinguishable from an empty CV and
    // is exactly how D-09 stayed hidden for four phases. Never log CV content.
    console.error(JSON.stringify({
      level: 'error', msg: 'pdf.extract_failed',
      file: path.basename(String(filePath || '')), error: String(err && err.message || err),
    }));
    return '';
  }
}

// NOTE: named "sync" for API compatibility but returns a Promise — pdf-parse has
// no synchronous API. Preserved exactly as-is; callers already await the result.
function pdfTextSync(filePath) {
  return pdfText(filePath);   // same implementation; both return a Promise
}

async function docxText(filePath) {
  try {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ path: filePath });
    return (result.value || '').trim();
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', msg: 'docx.extract_failed',
      file: path.basename(String(filePath || '')), error: String(err && err.message || err),
    }));
    return '';
  }
}

function docxTextSync(filePath) {
  try {
    const mammoth = require('mammoth');
    return mammoth.extractRawText({ path: filePath }).then((r) => (r.value || '').trim()).catch(() => '');
  } catch { return ''; }
}

export function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === '.pdf') return pdfTextSync(filePath);
    if (ext === '.docx' || ext === '.doc') return docxTextSync(filePath);
    return fs.readFileSync(filePath, 'utf-8').trim();
  } catch { return ''; }
}

export async function extractTextAsync(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === '.pdf') return await pdfText(filePath);
    if (ext === '.docx' || ext === '.doc') return await docxText(filePath);
    return fs.readFileSync(filePath, 'utf-8').trim();
  } catch { return ''; }
}
