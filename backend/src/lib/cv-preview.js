// A Word CV as readable HTML, so it can sit beside the review instead of
// being downloaded. PDFs and images already preview in the browser; .docx
// cannot, and most CVs Arabtec receives are Word files.
//
// The HTML is shown in an <iframe sandbox srcdoc>: no scripts, no same-origin
// access, no form submission. A crafted CV can at worst render oddly, never act
// in the ATS. mammoth itself emits no <script>, but the sandbox is the guard.
import mammoth from 'mammoth';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function isDocx(mime, name) {
  return mime === DOCX_MIME || /\.docx$/i.test(String(name || ''));
}

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
