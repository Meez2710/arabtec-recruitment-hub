// DocumentParser for PDF, DOCX and text, using in-process libraries.
//
// WHY THIS EXISTS ALONGSIDE THE DOCLING ADAPTER. Docling is the primary layout
// engine, but it is a separate service that a deployment may not run. Without a
// local implementation of the same port, "no sidecar configured" would mean "no
// CV can be read at all" — a hard regression against the parser this pipeline
// replaces. This adapter keeps the pipeline complete on its own.
//
// It is NOT a fallback chain. Exactly one parser is selected at startup, so a
// deployment always knows which engine read its documents; a silent per-request
// fallback would hide a sidecar outage behind slightly worse results.
//
// WHAT IT RECOVERS. pdfjs reports a transform matrix per text fragment, which is
// real geometry. Fragments are grouped into lines by baseline and lines into
// blocks by vertical gap, and every block carries a page-fraction bounding box —
// so the structure builder can restore the reading order of a two-column CV
// instead of interleaving the columns.

import type {
  AIOutcome, DocumentParser, ParsedDocument, SourceDocument,
} from '../../../modules/shared/kernel/ai/index.js';
import { AI_CAPABILITIES } from '../../../modules/shared/kernel/ai/index.js';
import type { RawBlock } from '../document/structure-builder.js';
import {
  blocksFromMarkdown, buildStructuredDocument, flattenStructure,
} from '../document/structure-builder.js';

/* ------------------------------ pdfjs plumbing ----------------------------- */

/** Points of baseline jitter still counted as one visual line. */
const LINE_EPS = 2.0;
/** A horizontal gap wider than this share of the font height becomes a space. */
const GAP_RATIO = 0.28;
/** A vertical gap wider than this share of line height starts a new block. */
const BLOCK_GAP_RATIO = 1.6;
/** Font height above the page median by this factor reads as a heading. */
const HEADING_RATIO = 1.15;

interface TextItem {
  readonly str?: string;
  readonly width?: number;
  readonly transform?: readonly number[];
  readonly hasEOL?: boolean;
}

interface Line {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * pdfjs needs DOMMatrix, which Node does not have.
 *
 * Text extraction never rasterises anything, so the handful of operations
 * pdfjs performs on a matrix is all that has to exist. Pulling in a canvas
 * implementation for this would add a platform-specific native binding to a
 * pure-text path.
 */
const ensureDomMatrix = (): void => {
  const global = globalThis as Record<string, unknown>;
  if (global['DOMMatrix'] !== undefined) return;

  class Matrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;

    constructor(init?: string | number[]) {
      let m = [1, 0, 0, 1, 0, 0];
      if (typeof init === 'string') {
        m = init.replace(/matrix\(|\)/g, '').split(',').map(Number);
      } else if (Array.isArray(init) && init.length >= 6) {
        m = init.slice(0, 6).map(Number);
      }
      [this.a = 1, this.b = 0, this.c = 0, this.d = 1, this.e = 0, this.f = 0] = m;
    }

    private clone(): Matrix {
      return new Matrix([this.a, this.b, this.c, this.d, this.e, this.f]);
    }

    multiplySelf(o: Matrix): Matrix {
      const { a, b, c, d, e, f } = this;
      this.a = a * o.a + c * o.b; this.b = b * o.a + d * o.b;
      this.c = a * o.c + c * o.d; this.d = b * o.c + d * o.d;
      this.e = a * o.e + c * o.f + e; this.f = b * o.e + d * o.f + f;
      return this;
    }

    multiply(o: Matrix): Matrix { return this.clone().multiplySelf(o); }

    translateSelf(tx = 0, ty = 0): Matrix {
      this.e += this.a * tx + this.c * ty; this.f += this.b * tx + this.d * ty; return this;
    }

    translate(tx: number, ty: number): Matrix { return this.clone().translateSelf(tx, ty); }

    scaleSelf(sx = 1, sy = sx): Matrix {
      this.a *= sx; this.b *= sx; this.c *= sy; this.d *= sy; return this;
    }

    scale(sx: number, sy?: number): Matrix { return this.clone().scaleSelf(sx, sy); }

    transformPoint(pt: { x: number; y: number } = { x: 0, y: 0 }): { x: number; y: number } {
      return {
        x: this.a * pt.x + this.c * pt.y + this.e,
        y: this.b * pt.x + this.d * pt.y + this.f,
      };
    }

    toString(): string {
      return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f})`;
    }
  }
  global['DOMMatrix'] = Matrix;
};

/** Group positioned fragments into visual lines, left to right, top to bottom. */
const itemsToLines = (items: readonly TextItem[]): Line[] => {
  interface Bucket { y: number; parts: Array<{ x: number; w: number; h: number; str: string }> }
  const buckets: Bucket[] = [];

  for (const item of items) {
    const str = item.str ?? '';
    if (str === '') continue;
    const tr = item.transform ?? [];
    const y = typeof tr[5] === 'number' ? tr[5] : 0;
    const x = typeof tr[4] === 'number' ? tr[4] : 0;
    const h = Math.abs(typeof tr[3] === 'number' ? tr[3] : 10) || 10;
    let bucket = buckets.find((b) => Math.abs(b.y - y) <= LINE_EPS);
    if (bucket === undefined) { bucket = { y, parts: [] }; buckets.push(bucket); }
    bucket.parts.push({ x, w: item.width ?? 0, h, str });
  }

  // PDF space grows upward, so descending Y is top-down on the page.
  buckets.sort((a, b) => b.y - a.y);

  const lines: Line[] = [];
  for (const bucket of buckets) {
    bucket.parts.sort((a, b) => a.x - b.x);
    let text = '';
    let prevEnd: number | null = null;
    let prevH = 10;
    for (const part of bucket.parts) {
      if (prevEnd !== null) {
        const gap = part.x - prevEnd;
        if (gap > GAP_RATIO * Math.max(prevH, part.h)
          && !/\s$/.test(text) && !/^\s/.test(part.str)) text += ' ';
      }
      text += part.str;
      prevEnd = part.x + (part.w ?? 0);
      prevH = part.h;
    }
    const cleaned = text.replace(/[ \t]+/g, ' ').trim();
    if (cleaned === '') continue;
    const first = bucket.parts[0];
    const last = bucket.parts[bucket.parts.length - 1];
    const x = first?.x ?? 0;
    const height = Math.max(...bucket.parts.map((p) => p.h));
    lines.push({
      text: cleaned,
      x,
      y: bucket.y,
      width: ((last?.x ?? x) + (last?.w ?? 0)) - x,
      height,
    });
  }
  return lines;
};

/** Turn one page's lines into blocks with page-fraction geometry. */
const linesToBlocks = (
  lines: readonly Line[],
  page: number,
  pageWidth: number,
  pageHeight: number,
): RawBlock[] => {
  if (lines.length === 0) return [];

  const heights = [...lines].map((l) => l.height).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] ?? 10;

  const blocks: RawBlock[] = [];
  let group: Line[] = [];

  const flush = (): void => {
    if (group.length === 0) return;
    const text = group.map((l) => l.text).join('\n');
    const top = Math.max(...group.map((l) => l.y + l.height));
    const bottom = Math.min(...group.map((l) => l.y));
    const left = Math.min(...group.map((l) => l.x));
    const right = Math.max(...group.map((l) => l.x + l.width));
    const tallest = Math.max(...group.map((l) => l.height));

    // A short, larger-than-body run of text is a heading. Restricting it to a
    // single line avoids promoting a whole paragraph set in a large face.
    const isHeading = group.length === 1
      && tallest > median * HEADING_RATIO
      && text.length <= 80;

    blocks.push({
      page,
      kind: isHeading ? 'heading' : 'paragraph',
      text,
      method: 'native',
      ...(isHeading ? { level: 2 } : {}),
      box: {
        x: pageWidth === 0 ? 0 : left / pageWidth,
        // Flip to a top-left origin, which is what LayoutBox specifies.
        y: pageHeight === 0 ? 0 : Math.max(0, (pageHeight - top) / pageHeight),
        width: pageWidth === 0 ? 0 : Math.max(0, (right - left) / pageWidth),
        height: pageHeight === 0 ? 0 : Math.max(0, (top - bottom) / pageHeight),
      },
    });
    group = [];
  };

  let previous: Line | null = null;
  for (const line of lines) {
    if (previous !== null) {
      const gap = previous.y - (line.y + line.height);
      // A wide vertical gap, or a jump back up the page (the next column),
      // starts a new block.
      if (gap > median * BLOCK_GAP_RATIO || line.y > previous.y) flush();
    }
    group.push(line);
    previous = line;
  }
  flush();
  return blocks;
};

/* -------------------------------- the parser ------------------------------- */

export interface LocalParserOptions {
  /** Refuse oversized documents before spending memory on them. */
  readonly maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

export class LocalDocumentParser implements DocumentParser {
  readonly modelId = 'local-pdfjs-mammoth';

  readonly version = 'local-parser/1.0.0';

  private readonly maxBytes: number;

  constructor(opts: LocalParserOptions = {}) {
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async parse(document: SourceDocument): Promise<AIOutcome<ParsedDocument>> {
    const startedAt = Date.now();
    const provenance = {
      capability: AI_CAPABILITIES.DOCUMENT_PARSE,
      modelId: this.modelId,
      promptVersionId: 'n/a', // decoding and layout analysis, not prompting
      producedAt: new Date(),
    };

    if (document.bytes.byteLength === 0) {
      return { abstained: true, reason: 'The document is empty.', permanent: true, provenance };
    }
    if (document.bytes.byteLength > this.maxBytes) {
      // PERMANENT: the same bytes will be the same size next time.
      return {
        abstained: true,
        reason: `The document exceeds the ${this.maxBytes}-byte limit.`,
        permanent: true,
        provenance,
      };
    }

    let blocks: RawBlock[];
    try {
      if (document.mimeType === 'application/pdf') {
        blocks = await this.readPdf(document.bytes);
      } else if (document.mimeType.includes('word') || document.mimeType.includes('msword')) {
        blocks = await this.readDocx(document.bytes);
      } else if (document.mimeType.startsWith('text/')
        || document.mimeType === 'application/json' || document.mimeType === 'application/xml') {
        const text = new TextDecoder('utf-8', { fatal: false }).decode(document.bytes);
        blocks = text.split('\f').flatMap((page, index) => blocksFromMarkdown(page, index + 1));
      } else {
        // PERMANENT: an image needs OCR, which is the pipeline's job, not this
        // adapter's. Saying so plainly lets the pipeline route it correctly.
        return {
          abstained: true,
          reason: `${document.mimeType} cannot be read without OCR.`,
          permanent: true,
          provenance,
        };
      }
    } catch (error) {
      // A library failure is the environment, not a verdict on the document —
      // so it stays retryable rather than discarding a CV. The previous parser
      // returned '' here, which was indistinguishable from an empty CV.
      return {
        abstained: true,
        reason: `The document could not be read: ${(error as Error).message}`,
        permanent: false,
        provenance,
      };
    }

    const withText = blocks.filter((b) => b.text.trim() !== '');
    if (withText.length === 0) {
      // PERMANENT for this adapter — but the pipeline may still route the
      // document to OCR, which is exactly the scanned-PDF case.
      return {
        abstained: true,
        reason: 'The document produced no text.',
        permanent: true,
        provenance,
      };
    }

    const structure = buildStructuredDocument({
      blocks,
      provenance: {
        parser: this.modelId,
        parserVersion: this.version,
        convertedAt: new Date(),
      },
    });

    return {
      content: {
        text: flattenStructure(structure),
        pageCount: structure.pages.length,
        pages: structure.pages.map((page) => page.text),
        structure,
      },
      // Decoding and geometric grouping are deterministic; this is not a guess
      // about meaning.
      confidence: 1,
      reasoningSummary: `Read ${structure.pages.length} page(s) into `
        + `${structure.blocks.length} block(s) with layout geometry.`,
      sourcesUsed: [document.documentId],
      provenance: { ...provenance, latencyMs: Date.now() - startedAt },
    };
  }

  private async readPdf(bytes: Uint8Array): Promise<RawBlock[]> {
    ensureDomMatrix();
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as {
      getDocument: (opts: Record<string, unknown>) => { promise: Promise<PdfDocument> };
    };

    const doc = await pdfjs.getDocument({
      // A copy: pdfjs transfers the buffer, and the caller still owns the
      // original bytes (the pipeline may hand them to OCR next).
      data: new Uint8Array(bytes),
      isEvalSupported: false, // never eval font programs
      disableFontFace: true, // no font rendering is needed for text
      useSystemFonts: false, // avoids native font lookups
    }).promise;

    try {
      const blocks: RawBlock[] = [];
      for (let number = 1; number <= doc.numPages; number += 1) {
        const page = await doc.getPage(number);
        try {
          const viewport = page.getViewport({ scale: 1 });
          const content = await page.getTextContent();
          const lines = itemsToLines(content.items);
          const pageBlocks = linesToBlocks(lines, number, viewport.width, viewport.height);
          // A page with no text still has to exist in the structure, or the
          // quality gate cannot flag it for OCR.
          blocks.push(...(pageBlocks.length > 0
            ? pageBlocks
            : [{ page: number, kind: 'unknown' as const, text: '', method: 'native' as const }]));
        } finally {
          page.cleanup();
        }
      }
      return blocks;
    } finally {
      await doc.destroy();
    }
  }

  private async readDocx(bytes: Uint8Array): Promise<RawBlock[]> {
    const mammoth = await import('mammoth') as unknown as {
      convertToMarkdown: (input: { buffer: Buffer }) => Promise<{ value: string }>;
      extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string }>;
    };
    const buffer = Buffer.from(bytes);

    // Markdown, not raw text: it preserves the headings and lists that a DOCX
    // actually contains, which is the structure this pipeline is built around.
    let markdown = '';
    try {
      markdown = (await mammoth.convertToMarkdown({ buffer })).value;
    } catch {
      markdown = '';
    }
    if (markdown.trim() === '') {
      markdown = (await mammoth.extractRawText({ buffer })).value;
    }
    // A DOCX has no fixed pages; reporting one page is honest, and inventing
    // page breaks would put false page numbers into every piece of evidence.
    return blocksFromMarkdown(markdown, 1);
  }
}

/* ------------------------------ pdfjs surface ------------------------------ */
// The narrowest shape this adapter uses. Declared locally so no pdfjs type
// crosses a port and so the import stays dynamic.

interface PdfPage {
  getViewport(opts: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<{ items: TextItem[] }>;
  cleanup(): void;
}

interface PdfDocument {
  readonly numPages: number;
  getPage(index: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}
