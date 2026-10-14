// A Word CV as readable HTML, so it can sit beside the review instead of
// being downloaded. PDFs and images already preview in the browser; .docx
// cannot, and most CVs Arabtec receives are Word files.
//
// The HTML is shown in an <iframe sandbox srcdoc>: no scripts, no same-origin
// access, no form submission. A crafted CV can at worst render oddly, never act
// in the ATS. mammoth itself emits no <script>, but the sandbox is the guard.
import mammoth from 'mammoth';
import { readBlob } from './upload.js';
import WordExtractor from 'word-extractor';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function isDocx(mime, name) {
  return mime === DOCX_MIME || /\.docx$/i.test(String(name || ''));
}

export const DOC_MIME = 'application/msword';

/** Legacy binary Word (.doc). mammoth reads only .docx, so this needs its own reader. */
export function isLegacyDoc(mime, name) {
  return mime === DOC_MIME || /\.doc$/i.test(String(name || ''));
}

/** Any Word CV the side panel can render. */
export function isWord(mime, name) { return isDocx(mime, name) || isLegacyDoc(mime, name); }

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const PAGE_STYLE = [
  'body{font:14px/1.55 Arial,Helvetica,sans-serif;color:#1a1a1a;margin:24px;max-width:760px}',
  'h1,h2,h3{line-height:1.25}img{max-width:100%;height:auto}',
  'table{border-collapse:collapse;margin:8px 0}td,th{border:1px solid #d9dce1;padding:4px 6px;vertical-align:top}',
].join('');

/** Render a .docx buffer as a standalone HTML page. */
export async function docxPreviewHtml(buffer) {
  const { value } = await mammoth.convertToHtml({ buffer }, { ignoreEmptyParagraphs: true });
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">`
    + `<style>${PAGE_STYLE}</style></head><body>${value || '<p>This document has no readable text.</p>'}</body></html>`;
}

/** Render a legacy .doc (or a .docx misnamed .doc) buffer as a standalone HTML page. */
export async function wordPreviewHtml(buffer, name, mime) {
  // A zip signature means a modern file wearing the wrong extension.
  if (buffer.length > 3 && buffer[0] === 0x50 && buffer[1] === 0x4b) return docxPreviewHtml(buffer);
  const extracted = await new WordExtractor().extract(buffer);
  const text = String(extracted.getBody() || '').replace(/\r/g, '');
  const paras = text.split(/\n{1,}/).map((l) => l.trim()).filter(Boolean).map((l) => `<p>${esc(l)}</p>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">`
    + `<style>${PAGE_STYLE}</style></head><body>${paras || '<p>This document has no readable text.</p>'}</body></html>`;
}

// `?as=html` for any stored file the caller is already allowed to open (a
// candidate's CV, an intake document, a file posted in a request thread).
// The caller checks permission first; this only reads and renders.
export async function sendDocxPreview(storedName, fallbackName, res) {
  const f = readBlob(storedName);
  if (!f) return res.status(404).json({ error: 'File not found.' });
  if (!isWord(f.mime, f.originalName || fallbackName)) {
    return res.status(415).json({ error: 'Only Word (.doc/.docx) CVs are rendered here; PDFs and images preview directly.' });
  }
  try {
    return res.json({ html: await wordPreviewHtml(f.data, f.originalName || fallbackName, f.mime) });
  } catch {
    return res.status(422).json({ error: 'This Word file could not be read. Download it instead.' });
  }
}
