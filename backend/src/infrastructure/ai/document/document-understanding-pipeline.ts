// The document-understanding pipeline.
//
//   document → ingestion/routing → layout parsing → structured document
//            → quality gate → CONDITIONAL OCR → reconciliation → ParsedDocument
//
// It IS a `DocumentParser`. That is the whole trick: everything already written
// against that port — `runResumeParse`, the AI worker, the legacy provider seam
// — gets the full pipeline by having one object swapped in the composition
// root, and nothing downstream learns that OCR or reconciliation happened
// except through `ParsedDocument.structure`.
//
// THREE RULES IT ENFORCES
//   1. Docling (or whatever layout parser is wired) is the primary reader. OCR
//      is never the layout engine.
//   2. OCR runs per PAGE and only when the quality gate asks for it. A clean
//      digital PDF never touches the OCR engine.
//   3. The document is never flattened before the extractor sees it. `text` and
//      `pages` are derived views of `structure`, not replacements for it.

import type {
  AIOutcome, DocumentParser, OcrEngine, OcrPageResult, ParsedDocument,
  SourceDocument, StructuredDocument,
} from '../../../modules/shared/kernel/ai/index.js';
import { AI_CAPABILITIES, isProposal } from '../../../modules/shared/kernel/ai/index.js';
import type { DocumentPage } from '../../../modules/shared/kernel/ai/document.js';
import type { QualityThresholds } from './quality-gate.js';
import { assessDocumentQuality } from './quality-gate.js';
import { reconcilePages } from './reconcile.js';
import type { PageImageSource } from './routing.js';
import { classifyDocument, SourceBytesPageImages } from './routing.js';
import { buildStructuredDocument, flattenStructure, structureOf } from './structure-builder.js';

export interface PipelineOptions {
  /**
   * Layout-aware parser for PDF, Office formats and images. Docling in
   * production. Absent means this deployment can only read text documents.
   */
  readonly layoutParser?: DocumentParser;
  /**
   * Used when the primary layout parser cannot be REACHED.
   *
   * Only on a temporary (environment) abstention — a sidecar that is down,
   * timing out or unreachable. A document the primary parser READ and rejected
   * is not retried here: that verdict is about the bytes and a second parser
   * would only produce a worse answer to the same question.
   *
   * Not silent: `structure.provenance.parser` records which one produced the
   * document, so a sidecar outage shows up in the data rather than hiding as a
   * quiet quality regression.
   */
  readonly fallbackParser?: DocumentParser;
  /** Decoder for text documents. Always present; decoding is not optional. */
  readonly textParser: DocumentParser;
  /** Conditional OCR. Absent leaves unreadable pages marked degraded. */
  readonly ocrEngine?: OcrEngine;
  /** Supplies page pixels for OCR. Defaults to image documents only. */
  readonly pageImages?: PageImageSource;
  readonly thresholds?: QualityThresholds;
}

/**
 * The highest confidence an OCR-touched document may be reported with.
 *
 * ENFORCED HERE, not left to a caller. OCR is a READING of pixels, and a
 * reading is never as good as a decode — so once any page has been recognised,
 * the document cannot be presented downstream at the confidence a clean native
 * parse would earn, however certain the engine claimed to be.
 */
export const OCR_CONFIDENCE_CEILING = 0.8;

/** A document with pages nobody could read at all is weaker still. */
const DEGRADED_CONFIDENCE_CEILING = 0.5;

/** Arabic script share above which the document is treated as Arabic. */
const ARABIC_SHARE = 0.2;

/**
 * Cheap script detection, used for OCR language hints and reported to the
 * extractor. Script, not language — telling Arabic from Farsi is not something
 * a character count can do, and pretending otherwise would be a lie in the
 * provenance record.
 */
const detectScript = (text: string): string | undefined => {
  const letters = text.match(/\p{L}/gu);
  if (letters === null || letters.length === 0) return undefined;
  const arabic = text.match(/\p{Script=Arabic}/gu)?.length ?? 0;
  const share = arabic / letters.length;
  if (share >= 1 - ARABIC_SHARE) return 'ar';
  if (share >= ARABIC_SHARE) return 'ar-en';
  return 'en';
};

export class DocumentUnderstandingPipeline implements DocumentParser {
  readonly version: string;

  private readonly opts: PipelineOptions;

  private readonly pageImages: PageImageSource;

  constructor(opts: PipelineOptions) {
    this.opts = opts;
    this.pageImages = opts.pageImages ?? new SourceBytesPageImages();
    this.version = [
      'document-pipeline/1.0.0',
      `layout=${opts.layoutParser?.version ?? 'none'}`,
      `text=${opts.textParser.version ?? 'none'}`,
      `ocr=${opts.ocrEngine?.name ?? 'none'}`,
    ].join('+');
  }

  async parse(document: SourceDocument): Promise<AIOutcome<ParsedDocument>> {
    const startedAt = Date.now();
    const provenance = {
      capability: AI_CAPABILITIES.DOCUMENT_PARSE,
      modelId: 'document-pipeline',
      promptVersionId: 'n/a', // decoding and layout analysis, not prompting
      producedAt: new Date(),
    };

    /* ---------------------------- 1. routing ------------------------------ */
    const route = classifyDocument({
      filename: document.filename,
      mimeType: document.mimeType,
      bytes: document.bytes,
    });

    if (!route.supported) {
      // PERMANENT: a property of the bytes. Re-reading reaches the same verdict.
      return {
        abstained: true,
        reason: route.reason ?? 'The document format is not supported.',
        permanent: true,
        provenance,
      };
    }

    const parser = route.parserKind === 'layout' ? this.opts.layoutParser : this.opts.textParser;
    if (parser === undefined) {
      // TEMPORARY: the document is fine; this deployment has no parser for it.
      // Marking it permanent would discard a CV because a sidecar was not wired.
      return {
        abstained: true,
        reason: `No layout-aware parser is configured for ${route.format} documents.`,
        permanent: false,
        provenance,
      };
    }

    /* ------------------------ 2. layout parsing --------------------------- */
    // The corrected media type is passed on, so a DOCX uploaded as
    // application/octet-stream is not refused by the parser's own type gate.
    const request = { ...document, mimeType: route.mimeType };
    let usedParser = parser;
    let parsed = await parser.parse(request);

    // The primary parser could not be reached. Fall back, and record it.
    if ('abstained' in parsed && !parsed.permanent
      && this.opts.fallbackParser !== undefined && parser !== this.opts.fallbackParser) {
      usedParser = this.opts.fallbackParser;
      parsed = await usedParser.parse(request);
    }

    if (!isProposal(parsed)) {
      // A scanned image the layout parser could not read is exactly the case
      // OCR exists for. Every other abstention is propagated unchanged.
      const recovered = await this.ocrOnly(document, route.mimeType, route.singlePageImage);
      if (recovered === null) return parsed;
      return {
        content: recovered.content,
        // Entirely OCR-derived, so the ceiling binds absolutely.
        confidence: OCR_CONFIDENCE_CEILING,
        reasoningSummary: `The layout parser abstained (${parsed.reason}); the page was read by OCR.`,
        sourcesUsed: [document.documentId],
        provenance: { ...provenance, latencyMs: Date.now() - startedAt },
      };
    }

    /* --------------------- 3. structured document ------------------------- */
    // `usedParser`, not `parser`: provenance must name the engine that actually
    // produced this document, or a fallback is invisible after the fact.
    const nativeStructure = this.toStructure(parsed.content, usedParser);

    /* ------------------------- 4. quality gate ---------------------------- */
    const quality = assessDocumentQuality(nativeStructure, this.opts.thresholds);

    if (quality.needsOcr.length === 0) {
      // The overwhelmingly common path: native text is good, no OCR engine is
      // touched, and the structured document is returned as parsed.
      return {
        content: this.toParsedDocument(nativeStructure, parsed.content),
        confidence: parsed.confidence,
        reasoningSummary: 'Layout analysis produced sufficient native text; OCR was not required.',
        sourcesUsed: [document.documentId],
        provenance: { ...provenance, latencyMs: Date.now() - startedAt },
      };
    }

    /* ---------------------- 5. conditional OCR ---------------------------- */
    const languageHints = this.languageHints(nativeStructure);
    const ocrResults: OcrPageResult[] = [];
    const pageStatus = new Map<number, { ocrStatus: DocumentPage['ocrStatus']; reason?: string }>();

    for (const pageQuality of quality.pages) {
      if (pageQuality.sufficient) {
        pageStatus.set(pageQuality.page, { ocrStatus: 'not-needed' });
        continue;
      }
      const outcome = await this.ocrPage(
        document, route.mimeType, pageQuality.page, languageHints,
      );
      if (outcome === null) {
        pageStatus.set(pageQuality.page, {
          ocrStatus: 'unavailable',
          reason: `${pageQuality.reason}; no OCR engine could read this page`,
        });
        continue;
      }
      if (!outcome.ok) {
        pageStatus.set(pageQuality.page, {
          ocrStatus: 'failed',
          reason: `${pageQuality.reason}; OCR failed: ${outcome.reason}`,
        });
        continue;
      }
      ocrResults.push(outcome.result);
      pageStatus.set(pageQuality.page, {
        ocrStatus: 'applied',
        reason: pageQuality.reason,
      });
    }

    /* ------------------------ 6. reconciliation --------------------------- */
    const { blocks, report } = reconcilePages(nativeStructure.blocks, ocrResults);

    const reconciled = buildStructuredDocument({
      blocks,
      pageStatus,
      provenance: {
        ...nativeStructure.provenance,
        ...(this.opts.ocrEngine !== undefined && ocrResults.length > 0
          ? {
            ocrEngine: this.opts.ocrEngine.name,
            ...(this.opts.ocrEngine.version !== undefined
              ? { ocrEngineVersion: this.opts.ocrEngine.version } : {}),
          }
          : {}),
      },
    });

    const degraded = reconciled.degradedPages.length;
    return {
      content: this.toParsedDocument(reconciled, parsed.content),
      // An OCR'd page is a reading, not a decode, so the document as a whole is
      // reported with less confidence than a clean native parse. The ceiling is
      // a hard cap, not a suggestion — see OCR_CONFIDENCE_CEILING.
      confidence: degraded > 0
        ? Math.min(parsed.confidence, DEGRADED_CONFIDENCE_CEILING)
        : Math.min(parsed.confidence, OCR_CONFIDENCE_CEILING),
      reasoningSummary: [
        `Layout analysis flagged ${quality.needsOcr.length} page(s) as insufficient.`,
        `OCR read ${ocrResults.length}; ${degraded} page(s) remain degraded.`,
        `Reconciliation resolved ${report.conflicts} conflict(s) and recovered ${report.recovered} region(s).`,
      ].join(' '),
      sourcesUsed: [document.documentId],
      provenance: { ...provenance, latencyMs: Date.now() - startedAt },
    };
  }

  /* ------------------------------ internals ------------------------------- */

  /** Delegates to the one shared definition. See `structureOf`. */
  private toStructure(parsed: ParsedDocument, parser: DocumentParser): StructuredDocument {
    return structureOf(
      parsed,
      (parser as { modelId?: string }).modelId ?? 'unknown-parser',
      parser.version ?? 'unversioned',
    );
  }

  /** Derive the flat views from the structure. Never a second source of truth. */
  private toParsedDocument(
    structure: StructuredDocument,
    original: ParsedDocument,
  ): ParsedDocument {
    const text = flattenStructure(structure);
    const language = detectScript(text) ?? original.detectedLanguage;
    return {
      text,
      pageCount: structure.pages.length,
      pages: structure.pages.map((page) => page.text),
      structure,
      ...(original.markdown !== undefined ? { markdown: original.markdown } : {}),
      ...(language !== undefined ? { detectedLanguage: language } : {}),
    };
  }

  private languageHints(structure: StructuredDocument): readonly string[] {
    const script = detectScript(flattenStructure(structure));
    if (script === 'ar') return ['ar'];
    if (script === 'ar-en') return ['ar', 'en'];
    return ['en'];
  }

  private async ocrPage(
    document: SourceDocument,
    mimeType: string,
    page: number,
    languageHints: readonly string[],
  ): Promise<Awaited<ReturnType<OcrEngine['recognize']>> | null> {
    const engine = this.opts.ocrEngine;
    if (engine === undefined) return null;
    const image = await this.pageImages.pageImage({
      documentId: document.documentId, bytes: document.bytes, mimeType, page,
    });
    if (image === null) return null;
    return engine.recognize({
      documentId: document.documentId,
      page,
      imageBytes: image.bytes,
      mimeType: image.mimeType,
      languageHints,
    });
  }

  /**
   * Last resort for a document the layout parser refused: read page one with
   * OCR alone.
   *
   * Returns null when that is not possible, so the caller propagates the
   * parser's original abstention rather than inventing a new one.
   */
  private async ocrOnly(
    document: SourceDocument,
    mimeType: string,
    singlePageImage: boolean,
  ): Promise<{ content: ParsedDocument } | null> {
    if (!singlePageImage || this.opts.ocrEngine === undefined) return null;
    const outcome = await this.ocrPage(document, mimeType, 1, ['ar', 'en']);
    if (outcome === null || !outcome.ok) return null;

    const { blocks } = reconcilePages([], [outcome.result]);
    if (blocks.length === 0) return null;

    const engine = this.opts.ocrEngine;
    const structure = buildStructuredDocument({
      blocks,
      pageStatus: new Map([[1, {
        ocrStatus: 'applied' as const,
        reason: 'the layout parser could not read this document',
      }]]),
      provenance: {
        parser: 'ocr-only',
        parserVersion: this.version,
        ocrEngine: engine.name,
        ...(engine.version !== undefined ? { ocrEngineVersion: engine.version } : {}),
        convertedAt: new Date(),
      },
    });

    const text = flattenStructure(structure);
    const language = detectScript(text);
    return {
      content: {
        text,
        pageCount: structure.pages.length,
        pages: structure.pages.map((page) => page.text),
        structure,
        ...(language !== undefined ? { detectedLanguage: language } : {}),
      },
    };
  }
}
