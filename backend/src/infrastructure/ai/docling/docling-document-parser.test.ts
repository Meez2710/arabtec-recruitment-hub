// Docling adapter contract tests. Stubbed HTTP throughout.
//
// SCOPE: these prove the MAPPING and the FAILURE CLASSIFICATION. They prove
// nothing about Docling's real output quality, which requires a running
// sidecar and the benchmark corpus.

import { describe, expect, it } from 'vitest';
import { DoclingDocumentParser } from './docling-document-parser.js';
import type { FetchLike } from './sidecar-client.js';
import { isProposal } from '../../../modules/shared/kernel/ai/index.js';
import type { SourceDocument } from '../../../modules/shared/kernel/ai/index.js';

const doc: SourceDocument = {
  documentId: 'doc-1',
  filename: 'ahmed-hassan.pdf',
  mimeType: 'application/pdf',
  bytes: new TextEncoder().encode('%PDF-1.7 …'),
};

/** A stub sidecar that answers with `body`, or throws `err`. */
const stub = (body: unknown, opts: { status?: number; err?: Error } = {}): FetchLike =>
  async () => {
    if (opts.err) throw opts.err;
    return {
      ok: (opts.status ?? 200) < 400,
      status: opts.status ?? 200,
      json: async () => body,
    };
  };

const parserWith = (fetchImpl: FetchLike): DoclingDocumentParser =>
  new DoclingDocumentParser({ fetchImpl, pipelineVersion: 'docling-2.x-pinned' });

const OK = {
  status: 'ok',
  text: 'Ahmed Hassan\nSite Engineer\nOrascom Construction',
  markdown: '# Ahmed Hassan\n\n**Site Engineer**\n\n## Experience\n\n| Employer | Role |\n|---|---|\n| Orascom | Site Engineer |',
  pages: ['Ahmed Hassan\nSite Engineer', 'Orascom Construction'],
  pageCount: 2,
  detectedLanguages: ['en'],
  ocrApplied: false,
};

describe('success mapping', () => {
  it('maps a converted document onto ParsedDocument, carrying markdown', async () => {
    const outcome = await parserWith(stub(OK)).parse(doc);
    expect(isProposal(outcome)).toBe(true);
    if (!isProposal(outcome)) return;

    expect(outcome.content.text).toContain('Ahmed Hassan');
    expect(outcome.content.pageCount).toBe(2);
    expect(outcome.content.pages).toHaveLength(2);
    expect(outcome.content.detectedLanguage).toBe('en');
    // The point of adopting a layout-aware parser: structure survives the port.
    expect(outcome.content.markdown).toContain('## Experience');
    expect(outcome.content.markdown).toContain('| Employer | Role |');
  });

  it('records provenance and latency for reproducibility', async () => {
    const outcome = await parserWith(stub(OK)).parse(doc);
    if (!isProposal(outcome)) throw new Error('expected a proposal');
    expect(outcome.provenance.capability).toBe('document.parse');
    expect(outcome.provenance.latencyMs).toBeTypeOf('number');
    expect(outcome.sourcesUsed).toEqual(['doc-1']);
  });

  it('pins the pipeline version into the parser version', () => {
    expect(parserWith(stub(OK)).version).toContain('docling-2.x-pinned');
    expect(new DoclingDocumentParser({ fetchImpl: stub(OK) }).version).toContain('unpinned');
  });

  it('omits markdown rather than inventing it when the sidecar returns none', async () => {
    const outcome = await parserWith(stub({ ...OK, markdown: '   ' })).parse(doc);
    if (!isProposal(outcome)) throw new Error('expected a proposal');
    expect(outcome.content.markdown).toBeUndefined();
    expect(outcome.content.text).not.toBe('');
  });

  it('reports lower confidence when an OCR pass was involved', async () => {
    const direct = await parserWith(stub(OK)).parse(doc);
    const ocr = await parserWith(stub({ ...OK, ocrApplied: true })).parse(doc);
    if (!isProposal(direct) || !isProposal(ocr)) throw new Error('expected proposals');
    expect(ocr.confidence).toBeLessThan(direct.confidence);
    expect(ocr.reasoningSummary).toMatch(/OCR/i);
  });

  it('falls back to a single page when the sidecar returns no page split', async () => {
    const outcome = await parserWith(stub({ status: 'ok', text: 'One page only' })).parse(doc);
    if (!isProposal(outcome)) throw new Error('expected a proposal');
    expect(outcome.content.pages).toEqual(['One page only']);
    expect(outcome.content.pageCount).toBe(1);
  });
});

describe('permanent abstention — the document cannot yield text', () => {
  it.each([
    ['unsupported', /not supported/i],
    ['encrypted', /password/i],
    ['corrupt', /damaged/i],
    ['empty', /no readable content/i],
  ])('abstains permanently on %s', async (status, pattern) => {
    const outcome = await parserWith(stub({ status })).parse(doc);
    expect(isProposal(outcome)).toBe(false);
    if (isProposal(outcome)) return;
    expect(outcome.permanent).toBe(true);
    expect(outcome.reason).toMatch(pattern);
  });

  it('abstains permanently when ok text is blank — never a proposal with nothing in it', async () => {
    const outcome = await parserWith(stub({ status: 'ok', text: '   \n  ' })).parse(doc);
    if (isProposal(outcome)) throw new Error('expected an abstention');
    expect(outcome.permanent).toBe(true);
  });

  it('rejects an oversized document without spending a request', async () => {
    let called = false;
    const parser = new DoclingDocumentParser({
      maxBytes: 10,
      fetchImpl: (async () => { called = true; throw new Error('should not be reached'); }) as FetchLike,
    });
    const outcome = await parser.parse({ ...doc, bytes: new Uint8Array(100) });
    if (isProposal(outcome)) throw new Error('expected an abstention');
    expect(outcome.permanent).toBe(true);
    expect(outcome.reason).toMatch(/exceeds/i);
    expect(called).toBe(false);
  });

  it('does not retry a 4xx — the same bytes meet the same refusal', async () => {
    const outcome = await parserWith(stub({}, { status: 400 })).parse(doc);
    if (isProposal(outcome)) throw new Error('expected an abstention');
    expect(outcome.permanent).toBe(true);
  });
});

describe('temporary abstention — the environment failed, the CV is not lost', () => {
  it('abstains temporarily when the sidecar is unreachable', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { name: 'FetchError' });
    const outcome = await parserWith(stub(null, { err })).parse(doc);
    if (isProposal(outcome)) throw new Error('expected an abstention');
    expect(outcome.permanent).toBe(false);
    expect(outcome.reason).toMatch(/unreachable/i);
  });

  it('abstains temporarily on timeout', async () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const outcome = await parserWith(stub(null, { err })).parse(doc);
    if (isProposal(outcome)) throw new Error('expected an abstention');
    expect(outcome.permanent).toBe(false);
    expect(outcome.reason).toMatch(/timed out/i);
  });

  it('abstains temporarily on a 5xx', async () => {
    const outcome = await parserWith(stub({}, { status: 503 })).parse(doc);
    if (isProposal(outcome)) throw new Error('expected an abstention');
    expect(outcome.permanent).toBe(false);
  });

  it.each([
    ['a non-object body', 'not-json'],
    ['an unknown status', { status: 'weird' }],
    ['ok without text', { status: 'ok' }],
  ])('treats %s as a retryable protocol fault', async (_label, body) => {
    const outcome = await parserWith(stub(body)).parse(doc);
    if (isProposal(outcome)) throw new Error('expected an abstention');
    // A protocol mismatch is a deployment problem, not a verdict on the CV.
    expect(outcome.permanent).toBe(false);
  });
});

describe('no silent fallback', () => {
  it('never returns content when the sidecar failed', async () => {
    const err = Object.assign(new Error('down'), { name: 'FetchError' });
    const outcome = await parserWith(stub(null, { err })).parse(doc);
    expect('content' in outcome).toBe(false);
  });
});
