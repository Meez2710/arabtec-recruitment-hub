// The conditional-OCR decision. Pure, deterministic, no I/O.
//
// OCR MUST NOT RUN ON EVERY CV. It is slow, it is lossy compared to a real text
// layer, and running it over a perfectly good digital PDF replaces exact text
// with a recognition of a rendering of that text. So this module answers one
// question per page: is the native extraction good enough to use as-is?
//
// "The parser failed completely" is deliberately NOT the only trigger. A CV with
// nine clean pages and one scanned certificate page must OCR exactly one page,
// which a document-level check cannot express.
//
// It decides; it does not act. The pipeline owns running the engine, so the
// policy stays testable without a network.

import type { DocumentBlock, StructuredDocument } from '../../../modules/shared/kernel/ai/index.js';

/** Why a page was judged insufficient. Stable strings — logged and asserted on. */
export type QualityFinding =
  | 'no-text'
  | 'sparse-text'
  | 'image-only'
  | 'unreadable-characters'
  | 'low-parser-confidence';

export interface PageQuality {
  readonly page: number;
  /** True when native extraction can be used without an OCR pass. */
  readonly sufficient: boolean;
  readonly findings: readonly QualityFinding[];
  /** One-line explanation, safe to log. Never contains document text. */
  readonly reason: string;
}

export interface DocumentQuality {
  readonly pages: readonly PageQuality[];
  /** 1-based page numbers needing an OCR pass, ascending. */
  readonly needsOcr: readonly number[];
}

export interface QualityThresholds {
  /**
   * Characters below which a page is "sparse".
   *
   * A CV page carries hundreds of characters. Around eighty is roughly a name
   * and a phone number — enough to prove the text layer is not empty, not
   * enough to believe it is complete, which is exactly the case a scan-with-a-
   * header produces.
   */
  readonly minCharsPerPage: number;
  /**
   * Share of characters that may be replacement/control junk before the page is
   * treated as mis-decoded. A broken CMap yields text that is present, long,
   * and entirely meaningless — length alone cannot catch it.
   */
  readonly maxUnreadableRatio: number;
  /** Parser-reported block confidence below which a page is distrusted. */
  readonly minBlockConfidence: number;
}

export const DEFAULT_THRESHOLDS: QualityThresholds = {
  minCharsPerPage: 80,
  maxUnreadableRatio: 0.2,
  minBlockConfidence: 0.5,
};

/** U+FFFD, private-use glyphs, and C0 controls that survive a bad decode. */
const UNREADABLE = /[\uFFFD\uE000-\uF8FF\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

const unreadableRatio = (text: string): number => {
  if (text.length === 0) return 0;
  const hits = text.match(UNREADABLE);
  return hits === null ? 0 : hits.length / text.length;
};

/** Text that carries meaning — figure/caption chrome is not page content. */
const isContentBlock = (block: DocumentBlock): boolean => block.kind !== 'figure'
  && block.kind !== 'header' && block.kind !== 'footer';

const REASONS: Record<QualityFinding, string> = {
  'no-text': 'the page has no native text',
  'sparse-text': 'the page has too little native text to be complete',
  'image-only': 'the page is an image with no extractable text layer',
  'unreadable-characters': 'the page decoded to unreadable characters',
  'low-parser-confidence': 'the parser reported low confidence for this page',
};

/**
 * Judge each page of a parsed document.
 *
 * Pages already read by OCR are reported sufficient: re-running OCR on an OCR
 * result would compare a reading against itself and could loop.
 */
export const assessDocumentQuality = (
  structure: StructuredDocument,
  thresholds: QualityThresholds = DEFAULT_THRESHOLDS,
): DocumentQuality => {
  const pages: PageQuality[] = structure.pages.map((page) => {
    const blocks = structure.blocks.filter((b) => b.page === page.number);
    const content = blocks.filter(isContentBlock);
    const text = content.map((b) => b.text).join('\n').trim();
    const findings: QualityFinding[] = [];

    if (page.method === 'ocr' || page.method === 'reconciled') {
      return {
        page: page.number,
        sufficient: true,
        findings: [],
        reason: 'already read by OCR',
      };
    }

    const hasFigure = blocks.some((b) => b.kind === 'figure');

    if (text === '') {
      // An image with no text layer is the classic scanned page. Distinguished
      // from a genuinely blank page only by the presence of a figure, so both
      // findings are recorded and the page is sent to OCR either way.
      findings.push(hasFigure ? 'image-only' : 'no-text');
    } else {
      if (text.length < thresholds.minCharsPerPage) {
        findings.push(hasFigure ? 'image-only' : 'sparse-text');
      }
      if (unreadableRatio(text) > thresholds.maxUnreadableRatio) {
        findings.push('unreadable-characters');
      }
    }

    const scored = content.filter((b) => typeof b.confidence === 'number');
    if (scored.length > 0
      && scored.every((b) => (b.confidence ?? 1) < thresholds.minBlockConfidence)) {
      findings.push('low-parser-confidence');
    }

    return {
      page: page.number,
      sufficient: findings.length === 0,
      findings,
      reason: findings.length === 0
        ? 'native text is sufficient'
        : findings.map((f) => REASONS[f]).join('; '),
    };
  });

  return {
    pages,
    needsOcr: pages.filter((p) => !p.sufficient).map((p) => p.page),
  };
};
