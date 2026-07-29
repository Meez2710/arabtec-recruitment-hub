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

let _pdfjs = null;
async function loadPdfjs() {
  if (_pdfjs) return _pdfjs;
  ensureDomMatrix();
  _pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return _pdfjs;
}

async function pdfText(filePath) {
  try {
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
      out += tc.items.map((it) => it.str || '').join(' ') + '\n';
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
