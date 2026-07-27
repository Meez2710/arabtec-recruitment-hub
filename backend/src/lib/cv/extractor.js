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

async function pdfText(filePath) {
  try {
    const { PDFParse } = require('pdf-parse');
    const buf = new Uint8Array(fs.readFileSync(filePath));
    const parser = new PDFParse(buf);
    await parser.load();
    const result = await parser.getText();
    return (result.text || '').trim();
  } catch { return ''; }
}

// NOTE: named "sync" for API compatibility but returns a Promise — pdf-parse has
// no synchronous API. Preserved exactly as-is; callers already await the result.
function pdfTextSync(filePath) {
  try {
    const { PDFParse } = require('pdf-parse');
    const buf = new Uint8Array(fs.readFileSync(filePath));
    const parser = new PDFParse(buf);
    return parser.load().then(() => parser.getText()).then((r) => (r.text || '').trim()).catch(() => '');
  } catch { return ''; }
}

async function docxText(filePath) {
  try {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ path: filePath });
    return (result.value || '').trim();
  } catch { return ''; }
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
