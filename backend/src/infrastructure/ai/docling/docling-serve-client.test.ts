// Docling Serve transport — contract tests. Stubbed HTTP throughout.
//
// SCOPE: the wire mapping, the OCR routing decision, the status classification
// and the page/bbox conversion. Nothing here proves Docling's output quality —
// that is the live matrix in docs/DOCLING_SERVE_API.md §14.
//
// The two-page fixture is a REAL response captured from the deployed image
// (page rasters stripped), so the geometry these tests assert is the geometry
// the service actually returns, not a shape invented for the test.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DoclingServeClient } from './docling-serve-client.js';
import { DoclingDocumentParser } from './docling-document-parser.js';
import type { FetchLike } from './sidecar-client.js';
import { isProposal } from '../../../modules/shared/kernel/ai/index.js';
import type { SourceDocument } from '../../../modules/shared/kernel/ai/index.js';

const REAL = JSON.parse(readFileSync(
  new URL('./__fixtures__/serve-two-page.json', import.meta.url), 'utf8',
)) as Record<string, unknown>;

const pdf: SourceDocument = {
  documentId: 'doc-1',
  filename: 'cv.pdf',
  mimeType: 'application/pdf',
  bytes: new TextEncoder().encode('%PDF-1.7 …'),
};
const png: SourceDocument = { ...pdf, filename: 'cv.png', mimeType: 'image/png' };

/** Records what was sent so the OCR routing decision can be asserted. */
const spy = (body: unknown, status = 200) => {
  const sent: Array<Record<string, string[]>> = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const form = init.body as unknown as FormData;
    const fields: Record<string, string[]> = {};
    if (form && typeof (form as FormData).forEach === 'function') {
      (form as FormData).forEach((v, k) => {
        if (typeof v === 'string') (fields[k] ??= []).push(v);
        else (fields[k] ??= []).push('<file>');
      });
    }
    sent.push(fields);
    return { ok: status < 400, status, json: async () => body };
  };
  return { fetchImpl, sent };
};

const OK = {
  status: 'success',
  errors: [],
  processing_time: 1,
  document: {
    filename: 'cv.pdf',
    md_content: '## Layla Mansour\n\nSite Engineer',
    json_content: {
      pages: { 1: { size: { width: 595, height: 842 } } },
      texts: [
        { label: 'section_header', text: 'Layla Mansour', prov: [{ page_no: 1, bbox: { l: 72, t: 800, r: 300, b: 780, coord_origin: 'BOTTOMLEFT' } }] },
        { label: 'text', text: 'Site Engineer', prov: [{ page_no: 1, bbox: { l: 72, t: 760, r: 250, b: 740, coord_origin: 'BOTTOMLEFT' } }] },
      ],
    },
  },
};

describe('OCR routing — the flag is decided, never guessed', () => {
  it('sends force_ocr for an image and asserts ocrApplied', async () => {
    const { fetchImpl, sent } = spy(OK);
    const out = await new DoclingServeClient({ fetchImpl }).convert(png);
    expect(sent[0]?.force_ocr).toEqual(['true']);
    expect(out.ocrApplied).toBe(true);
    expect(out.ocrEngine).toBe('tesseract');
  });

  it('does NOT ask for OCR when the local probe finds a text layer', async () => {
    const { fetchImpl, sent } = spy(OK);
    const client = new DoclingServeClient({ fetchImpl, nativeProbe: async () => 400 });
    const out = await client.convert(pdf);
    expect(sent[0]?.force_ocr).toEqual(['false']);
    expect(out.ocrApplied).toBe(false);
  });

  it('asks for OCR when the probe finds almost no native text', async () => {
    const { fetchImpl, sent } = spy(OK);
    const client = new DoclingServeClient({ fetchImpl, nativeProbe: async () => 3 });
    const out = await client.convert(pdf);
    expect(sent[0]?.force_ocr).toEqual(['true']);
    expect(out.ocrApplied).toBe(true);
  });

  it('leaves ocrApplied UNSET rather than claiming false when the probe cannot tell', async () => {
    // A silent `false` would make a scanned CV look like a digital one.
    const { fetchImpl } = spy(OK);
    const client = new DoclingServeClient({ fetchImpl, nativeProbe: async () => null });
    expect((await client.convert(pdf)).ocrApplied).toBeUndefined();
  });

  it('never lets a probe failure cost a conversion', async () => {
    const { fetchImpl } = spy(OK);
    const client = new DoclingServeClient({
      fetchImpl, nativeProbe: async () => { throw new Error('pdfjs blew up'); },
    });
    const out = await client.convert(pdf);
    expect(out.status).toBe('ok');
    expect(out.ocrApplied).toBeUndefined();
  });

  it('sends the parameters the live contract requires', async () => {
    const { fetchImpl, sent } = spy(OK);
    await new DoclingServeClient({ fetchImpl, apiKey: 'k' }).convert(pdf);
    const f = sent[0] ?? {};
    expect(f['to_formats']).toEqual(['md', 'json']);   // json carries page provenance
    expect(f['ocr_engine']).toEqual(['tesseract']);
    expect(f['ocr_lang']).toEqual(['eng']);
    expect(f['images_scale']).toEqual(['4']);
    expect(f['include_images']).toEqual(['false']);    // else responses are mostly page rasters
    expect(f['document_timeout']).toEqual(['120']);    // the image's own default is 7 days
  });
});

describe('page provenance — real geometry from a real response', () => {
  it('maps both pages, converting BOTTOMLEFT points to top-left fractions', async () => {
    const { fetchImpl } = spy(REAL);
    const out = await new DoclingServeClient({ fetchImpl, nativeProbe: async () => 500 }).convert(pdf);

    expect(out.pageCount).toBe(2);
    expect(out.blocks?.map((b) => b.page)).toEqual([1, 2]);

    // Page 1 header: l=72 t=710.052 r=320.92 b=653.102 on a 595x842 page.
    const [first] = out.blocks ?? [];
    const [x, y, w, h] = first?.bbox as number[];
    expect(x).toBeCloseTo(72 / 595, 5);
    // BOTTOMLEFT: the top edge is 710.052 measured UP from the bottom, so the
    // top-left origin puts it at (842 - 710.052) / 842. Reading it as t/height
    // would place the citation on the wrong half of the page.
    expect(y).toBeCloseTo((842 - 710.052) / 842, 5);
    expect(w).toBeCloseTo((320.92 - 72) / 595, 5);
    expect(h).toBeCloseTo((710.052 - 653.102) / 842, 5);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
  });

  it('attributes page-2 content to page 2 — the defect this replaces', async () => {
    const { fetchImpl } = spy(REAL);
    const out = await new DoclingServeClient({ fetchImpl, nativeProbe: async () => 500 }).convert(pdf);
    const second = (out.blocks ?? [])[1];
    expect(second?.page).toBe(2);
    expect(second?.text).toContain('Page two');
  });

  it('carries page numbers all the way into the parsed document', async () => {
    const { fetchImpl } = spy(REAL);
    const parser = new DoclingDocumentParser({
      transport: new DoclingServeClient({ fetchImpl, nativeProbe: async () => 500 }),
      parserName: 'docling-serve',
    });
    const out = await parser.parse(pdf);
    if (!isProposal(out)) throw new Error(`abstained: ${out.reason}`);
    const s = out.content.structure;
    expect(s?.provenance.parser).toBe('docling-serve');
    expect([...new Set(s?.blocks.map((b) => b.page))]).toEqual([1, 2]);
    expect(s?.pages.length).toBe(2);
  });
});

describe('status classification — decides DELAYED vs TERMINAL', () => {
  const reject = async (body: unknown) => {
    const { fetchImpl } = spy(body);
    return new DoclingServeClient({ fetchImpl, nativeProbe: async () => 500 }).convert(pdf);
  };

  it('reads a password error as encrypted, not as a service fault', async () => {
    const r = await reject({ status: 'failure', document: {}, errors: [{ component_type: 'document_backend', error_message: 'File is password protected' }] });
    expect(r.status).toBe('encrypted');
  });

  it('reads an unsupported-format error as unsupported', async () => {
    const r = await reject({ status: 'failure', document: {}, errors: [{ component_type: 'user_input', error_message: 'unsupported format' }] });
    expect(r.status).toBe('unsupported');
  });

  it('falls back to corrupt for an unexplained failure', async () => {
    const r = await reject({ status: 'failure', document: {}, errors: [] });
    expect(r.status).toBe('corrupt');
  });

  it('calls a successful conversion with no text EMPTY, not ok', async () => {
    // This is the shape a scanned page returns when OCR is unavailable: HTTP
    // 200, status success, errors [], and nothing in it.
    const r = await reject({ status: 'success', errors: [], document: { md_content: '' } });
    expect(r.status).toBe('empty');
  });

  it('rejects a body with no status as a protocol fault', async () => {
    await expect(reject({ document: {} })).rejects.toMatchObject({ kind: 'protocol', retryable: true });
  });
});

describe('failure classification reaches the parser as permanent vs temporary', () => {
  const parserWith = (body: unknown, status = 200) => new DoclingDocumentParser({
    transport: new DoclingServeClient({ ...spy(body, status), nativeProbe: async () => 500 }),
    parserName: 'docling-serve',
  });

  it('an encrypted document is a PERMANENT abstention', async () => {
    const out = await parserWith({ status: 'failure', document: {}, errors: [{ error_message: 'password protected' }] }).parse(pdf);
    expect(isProposal(out)).toBe(false);
    if (!isProposal(out)) expect(out.permanent).toBe(true);
  });

  it('a 500 is a TEMPORARY abstention — the CV is delayed, not lost', async () => {
    const out = await parserWith({}, 503).parse(pdf);
    if (!isProposal(out)) expect(out.permanent).toBe(false);
    else throw new Error('expected an abstention');
  });

  it('a 401 is temporary — misconfiguration must not discard a CV', async () => {
    const out = await parserWith({}, 401).parse(pdf);
    if (!isProposal(out)) expect(out.permanent).toBe(false);
    else throw new Error('expected an abstention');
  });

  it('refuses an oversized document without spending a request', async () => {
    const { fetchImpl, sent } = spy(OK);
    const client = new DoclingServeClient({ fetchImpl, maxBytes: 4 });
    await expect(client.convert(pdf)).rejects.toMatchObject({ kind: 'too-large', retryable: false });
    expect(sent).toHaveLength(0);
  });

  it('never returns content when the service failed', async () => {
    const out = await parserWith({}, 500).parse(pdf);
    expect(isProposal(out)).toBe(false);
  });
});

describe('health', () => {
  it('reports honestly that this image gives no version', async () => {
    const { fetchImpl } = spy({ status: 'ok' });
    const h = await new DoclingServeClient({ fetchImpl }).health();
    expect(h.ok).toBe(true);
    // The sidecar returns a real Docling version; Docling Serve's /health does
    // not. Inventing one here would make provenance unfalsifiable.
    expect(h.doclingVersion).toBe('unknown');
  });
});
