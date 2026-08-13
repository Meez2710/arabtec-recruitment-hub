// DocumentParser backed by the local Docling sidecar.
//
// The mapping boundary. Everything Docling-shaped stops here; what leaves is a
// neutral `ParsedDocument`, so the domain, the application services and the
// extractor never learn which engine produced the text.
//
// ABSTENTION IS THE CONTRACT, NOT AN ERROR PATH. Every failure becomes an
// `AIAbstention` carrying `permanent`, because that flag decides whether a CV
// is delayed or the task is terminal:
//
//   permanent  — the document cannot yield text. Encrypted, corrupt, empty,
//                unsupported format, or too large. Retrying re-reads the same
//                bytes and reaches the same conclusion.
//   temporary  — the sidecar could not answer. Down, timed out, 5xx, or
//                speaking a protocol this client does not understand. The
//                document is fine; the environment is not.
//
// There is NO fallback to another parser. A silent fallback would keep a second
// parsing system alive and make a Docling outage invisible.

import type {
  AIOutcome, BlockKind, DocumentParser, DocumentTable, LayoutBox, ParsedDocument,
  SourceDocument, StructuredDocument, TableCell,
} from '../../../modules/shared/kernel/ai/index.js';
import { AI_CAPABILITIES } from '../../../modules/shared/kernel/ai/index.js';
import type { RawBlock } from '../document/structure-builder.js';
import { blocksFromMarkdown, buildStructuredDocument } from '../document/structure-builder.js';
import type {
  SidecarBlock, SidecarDocument, SidecarOptions, SidecarStatus,
} from './sidecar-client.js';
import { DoclingSidecarClient, SidecarError } from './sidecar-client.js';

/** Sidecar element names mapped onto the neutral block vocabulary. */
const BLOCK_KINDS: Record<string, BlockKind> = {
  title: 'title',
  section_header: 'heading',
  heading: 'heading',
  paragraph: 'paragraph',
  text: 'paragraph',
  list_item: 'list-item',
  'list-item': 'list-item',
  table: 'table',
  caption: 'caption',
  picture: 'figure',
  figure: 'figure',
  page_header: 'header',
  page_footer: 'footer',
};

const readBox = (bbox: readonly number[] | undefined): LayoutBox | undefined => {
  if (bbox === undefined || bbox.length < 4) return undefined;
  const [x, y, width, height] = bbox;
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x, y, width, height };
};

const readTable = (block: SidecarBlock): DocumentTable | undefined => {
  const table = block.table;
  if (table === undefined) return undefined;
  const cells: TableCell[] = (table.cells ?? []).map((cell) => ({
    row: cell.row ?? 0,
    column: cell.column ?? 0,
    text: cell.text ?? '',
    ...(cell.rowSpan !== undefined ? { rowSpan: cell.rowSpan } : {}),
    ...(cell.columnSpan !== undefined ? { columnSpan: cell.columnSpan } : {}),
    ...(cell.header !== undefined ? { header: cell.header } : {}),
  }));
  return {
    rowCount: table.rowCount ?? (cells.length === 0
      ? 0 : Math.max(...cells.map((c) => c.row)) + 1),
    columnCount: table.columnCount ?? (cells.length === 0
      ? 0 : Math.max(...cells.map((c) => c.column)) + 1),
    cells,
  };
};

/**
 * Map the sidecar's layout elements onto neutral blocks.
 *
 * Returns undefined when the sidecar reported no usable elements, so the
 * pipeline falls back to recovering structure from the Markdown instead of
 * receiving an empty structure that looks authoritative.
 */
const toStructure = (
  result: SidecarDocument,
  parserVersion: string,
): StructuredDocument | undefined => {
  const source = result.blocks;

  // The sidecar reported no layout elements, so structure has to be recovered
  // from its Markdown. Do it HERE rather than letting the pipeline do it,
  // because only this layer knows whether the sidecar used OCR — and that flag
  // is the difference between "decoded" and "recognised" for every block on
  // the page. Losing it made a scanned CV indistinguishable from a digital one.
  if (source === undefined || source.length === 0) {
    const markdown = result.markdown ?? result.text ?? '';
    if (markdown.trim() === '') return undefined;
    const method = result.ocrApplied === true ? 'ocr' : 'native';
    const derived = blocksFromMarkdown(markdown, 1, method);
    if (derived.length === 0) return undefined;
    return buildStructuredDocument({
      blocks: derived,
      provenance: {
        parser: 'docling-sidecar',
        parserVersion,
        convertedAt: new Date(),
        ...(result.ocrApplied === true
          ? { ocrEngine: result.ocrEngine ?? 'sidecar-internal' } : {}),
        ...(result.pipelineVersion !== undefined
          ? { pipelineVersion: result.pipelineVersion } : {}),
      },
    });
  }

  const blocks: RawBlock[] = [];
  for (const block of source) {
    const text = (block.text ?? '').trim();
    const table = readTable(block);
    // A table block carries its grid even when its linearised text is empty;
    // every other kind with no text is layout noise and is dropped.
    if (text === '' && table === undefined) continue;
    const box = readBox(block.bbox);
    blocks.push({
      page: block.page ?? 1,
      kind: BLOCK_KINDS[(block.kind ?? '').toLowerCase()] ?? 'unknown',
      text,
      // The sidecar's own OCR pass is OCR, and saying so here is what keeps the
      // quality gate from sending an already-recognised page round again.
      method: block.ocr === true ? 'ocr' : 'native',
      ...(block.level !== undefined ? { level: block.level } : {}),
      ...(box !== undefined ? { box } : {}),
      ...(table !== undefined ? { table } : {}),
      ...(block.confidence !== undefined ? { confidence: block.confidence } : {}),
    });
  }
  if (blocks.length === 0) return undefined;

  return buildStructuredDocument({
    blocks,
    provenance: {
      parser: 'docling-sidecar',
      parserVersion,
      convertedAt: new Date(),
      ...(result.pipelineVersion !== undefined
        ? { pipelineVersion: result.pipelineVersion } : {}),
    },
  });
};

/**
 * Document-level rejections, and whether re-running could ever change them.
 *
 * All four are permanent: they are properties of the bytes, not of the runtime.
 */
const REJECTIONS: Record<Exclude<SidecarStatus, 'ok'>, string> = {
  unsupported: 'The document format is not supported by the document intelligence layer.',
  encrypted: 'The document is password-protected and cannot be read.',
  corrupt: 'The document is damaged and cannot be read.',
  empty: 'The document contains no readable content.',
};

export interface DoclingParserOptions extends SidecarOptions {
  /**
   * Pinned sidecar image/config identifier, recorded on every proposal.
   *
   * A proposal must be reproducible, and knowing the extraction model is not
   * enough when the parser that fed it changed. Set this from the pinned
   * deployment tag.
   */
  readonly pipelineVersion?: string;
}

export class DoclingDocumentParser implements DocumentParser {
  readonly modelId = 'docling-sidecar';

  /** Adapter revision. Bump on any behaviour change; see DocumentParser.version. */
  readonly version: string;

  private readonly client: DoclingSidecarClient;

  constructor(opts: DoclingParserOptions = {}) {
    this.client = new DoclingSidecarClient(opts);
    this.version = `docling-adapter/1.0.0+${opts.pipelineVersion ?? 'unpinned'}`;
  }

  /** Exposed for the health endpoint. Never called on the parse path. */
  health(): ReturnType<DoclingSidecarClient['health']> {
    return this.client.health();
  }

  async parse(document: SourceDocument): Promise<AIOutcome<ParsedDocument>> {
    const startedAt = Date.now();
    const provenance = {
      capability: AI_CAPABILITIES.DOCUMENT_PARSE,
      modelId: this.modelId,
      promptVersionId: 'n/a', // decoding, not prompting
      producedAt: new Date(),
    };

    let result: SidecarDocument;
    try {
      result = await this.client.convert({
        filename: document.filename,
        mimeType: document.mimeType,
        bytes: document.bytes,
      });
    } catch (error) {
      if (error instanceof SidecarError) {
        return {
          abstained: true,
          reason: error.message,
          // The client classified it; it is the only layer that knows whether
          // the request or the environment failed.
          permanent: !error.retryable,
          provenance,
        };
      }
      // An unexpected throw is a defect in this adapter, not a verdict on the
      // document — so it stays retryable rather than discarding a CV.
      return {
        abstained: true,
        reason: `Document intelligence failed unexpectedly: ${(error as Error).message}`,
        permanent: false,
        provenance,
      };
    }

    if (result.status !== 'ok') {
      return {
        abstained: true,
        reason: result.reason ?? REJECTIONS[result.status],
        permanent: true,
        provenance,
      };
    }

    const text = result.text ?? '';
    if (text.trim() === '') {
      return {
        abstained: true,
        reason: 'The document produced no text.',
        permanent: true,
        provenance,
      };
    }

    const pages = Array.isArray(result.pages) && result.pages.length > 0
      ? result.pages.filter((p): p is string => typeof p === 'string')
      : [text];

    const markdown = typeof result.markdown === 'string' && result.markdown.trim() !== ''
      ? result.markdown
      : undefined;

    const language = result.detectedLanguages?.[0];
    const structure = toStructure(result, this.version);

    return {
      content: {
        text,
        pageCount: result.pageCount ?? pages.length,
        pages,
        ...(language !== undefined ? { detectedLanguage: language } : {}),
        ...(markdown !== undefined ? { markdown } : {}),
        ...(structure !== undefined ? { structure } : {}),
      },
      // Decoding and layout recovery are deterministic given the same pipeline;
      // this is not a model's guess about meaning. OCR is not — an OCR'd page
      // is a reading, so it is reported with lower confidence.
      confidence: result.ocrApplied === true ? 0.8 : 1,
      reasoningSummary: result.ocrApplied === true
        ? 'Converted with layout analysis and an OCR pass.'
        : 'Converted with layout analysis; text extracted directly.',
      sourcesUsed: [document.documentId],
      provenance: { ...provenance, latencyMs: Date.now() - startedAt },
    };
  }
}
