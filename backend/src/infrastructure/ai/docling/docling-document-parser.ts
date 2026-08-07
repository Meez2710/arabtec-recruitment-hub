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
  AIOutcome, DocumentParser, ParsedDocument, SourceDocument,
} from '../../../modules/shared/kernel/ai/index.js';
import { AI_CAPABILITIES } from '../../../modules/shared/kernel/ai/index.js';
import type { SidecarDocument, SidecarOptions, SidecarStatus } from './sidecar-client.js';
import { DoclingSidecarClient, SidecarError } from './sidecar-client.js';

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

    return {
      content: {
        text,
        pageCount: result.pageCount ?? pages.length,
        pages,
        ...(language !== undefined ? { detectedLanguage: language } : {}),
        ...(markdown !== undefined ? { markdown } : {}),
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
