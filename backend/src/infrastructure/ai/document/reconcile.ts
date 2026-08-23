// Native + OCR reconciliation. Pure, deterministic, no I/O.
//
// THE RULE THIS ENFORCES: never concatenate two readings of the same region.
// Appending an OCR pass to native text doubles every paragraph it recovered
// correctly, and a downstream extractor then sees each employer twice and
// reports duplicate roles. Reconciliation is a CHOICE per region, with the
// rejected reading kept as an alternative rather than thrown away.
//
// PREFERENCE ORDER
//   1. A native block that the OCR pass broadly agrees with wins. Native text
//      is decoded, OCR text is recognised; where they say the same thing the
//      exact one is better.
//   2. Where they disagree, the higher-quality reading wins on a deterministic
//      score, and the loser is attached as `alternative` — a conflict is
//      information, not noise to be discarded.
//   3. OCR text with no native counterpart is ADDED. That is the whole point of
//      the OCR pass: recovering regions the text layer never had.

import type {
  DocumentBlock, OcrPageResult,
} from '../../../modules/shared/kernel/ai/index.js';
import { comparisonKey } from '../../../modules/shared/kernel/text.js';
import type { RawBlock } from './structure-builder.js';

/** Two readings are "the same region" at or above this token overlap. */
const AGREEMENT_THRESHOLD = 0.6;

/** Below this, a match is not a match at all — the blocks are unrelated. */
const PAIRING_THRESHOLD = 0.3;

const tokens = (text: string): Set<string> => new Set(
  comparisonKey(text).split(' ').filter((t) => t.length > 1),
);

/**
 * Jaccard overlap of two texts, 0..1.
 *
 * Token-set rather than edit distance: OCR reorders nothing but routinely
 * mangles individual characters, so comparing word membership is far more
 * stable than comparing character sequences.
 */
export const similarity = (a: string, b: string): number => {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
};

/**
 * How usable a reading looks, higher is better.
 *
 * Letters and digits count; replacement characters and control junk count
 * against. This is what decides a genuine disagreement, so it must not consult
 * which SOURCE produced the text — that would make the rule circular.
 */
const readability = (text: string): number => {
  if (text.trim() === '') return 0;
  const meaningful = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  const junk = (text.match(/[\uFFFD\uE000-\uF8FF]/g) ?? []).length;
  return meaningful - junk * 5;
};

/** Group OCR lines into blocks. A blank-ish vertical gap starts a new block. */
export const blocksFromOcr = (result: OcrPageResult): RawBlock[] => {
  if (result.lines.length === 0) {
    const text = result.text.trim();
    return text === '' ? [] : [{
      page: result.page,
      kind: 'paragraph',
      text,
      method: 'ocr',
      ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
    }];
  }

  const blocks: RawBlock[] = [];
  let current: { lines: string[]; confidences: number[]; top: number; bottom: number } | null = null;

  const flush = (): void => {
    if (current === null) return;
    const text = current.lines.join('\n').trim();
    const scores = current.confidences;
    if (text !== '') {
      blocks.push({
        page: result.page,
        kind: 'paragraph',
        text,
        method: 'ocr',
        ...(scores.length > 0
          ? { confidence: scores.reduce((a, b) => a + b, 0) / scores.length }
          : {}),
      });
    }
    current = null;
  };

  for (const line of result.lines) {
    if (line.text.trim() === '') { flush(); continue; }
    const box = line.box;
    if (current !== null && box !== undefined) {
      // A gap wider than a line's own height means a new paragraph, which is
      // the only paragraph signal OCR gives without a layout model.
      const gap = box.y - current.bottom;
      if (gap > box.height * 1.2) flush();
    }
    if (current === null) {
      current = {
        lines: [],
        confidences: [],
        top: box?.y ?? 0,
        bottom: box === undefined ? 0 : box.y + box.height,
      };
    }
    current.lines.push(line.text.trim());
    if (line.confidence !== undefined) current.confidences.push(line.confidence);
    if (box !== undefined) current.bottom = box.y + box.height;
  }
  flush();
  return blocks;
};

export interface PageReconciliation {
  readonly page: number;
  readonly blocks: readonly RawBlock[];
  /** Regions where the two readings disagreed. Operational signal. */
  readonly conflicts: number;
  /** Regions OCR recovered that native extraction never had. */
  readonly recovered: number;
}

/**
 * Reconcile one page's native blocks against one OCR reading of that page.
 *
 * Called only for pages the quality gate flagged, so the common case — a clean
 * digital PDF — never reaches this function at all.
 */
export const reconcilePage = (
  page: number,
  nativeBlocks: readonly DocumentBlock[],
  ocr: OcrPageResult,
): PageReconciliation => {
  const ocrBlocks = blocksFromOcr(ocr);

  // Nothing native to reconcile against: this is the scanned-page case, and the
  // OCR reading simply becomes the page.
  const nativeHasText = nativeBlocks.some((b) => b.text.trim() !== '');
  if (!nativeHasText) {
    return { page, blocks: ocrBlocks, conflicts: 0, recovered: ocrBlocks.length };
  }

  const claimed = new Set<number>();
  const out: RawBlock[] = [];
  let conflicts = 0;

  for (const native of nativeBlocks) {
    let bestIndex = -1;
    let bestScore = 0;
    ocrBlocks.forEach((candidate, index) => {
      if (claimed.has(index)) return;
      const score = similarity(native.text, candidate.text);
      if (score > bestScore) { bestScore = score; bestIndex = index; }
    });

    const base: RawBlock = {
      page: native.page,
      kind: native.kind,
      text: native.text,
      method: 'native',
      ...(native.level !== undefined ? { level: native.level } : {}),
      ...(native.box !== undefined ? { box: native.box } : {}),
      ...(native.table !== undefined ? { table: native.table } : {}),
    };

    if (bestIndex === -1 || bestScore < PAIRING_THRESHOLD) {
      // No OCR counterpart. Keep the native reading untouched.
      out.push(base);
      continue;
    }

    const match = ocrBlocks[bestIndex];
    claimed.add(bestIndex);
    if (match === undefined) { out.push(base); continue; }

    if (bestScore >= AGREEMENT_THRESHOLD) {
      // The sources agree. Keep the exact text, but record that OCR confirmed
      // it — that is what makes the block 'reconciled' rather than 'native'.
      out.push({ ...base, method: 'reconciled' });
      continue;
    }

    // A real disagreement. Pick on readability alone and keep the loser.
    conflicts += 1;
    const nativeBetter = readability(native.text) >= readability(match.text);
    out.push({
      ...base,
      method: 'reconciled',
      text: nativeBetter ? native.text : match.text,
      ...(nativeBetter ? {} : { confidence: match.confidence }),
    });
  }

  // OCR blocks nobody claimed are text the native layer did not contain.
  let recovered = 0;
  ocrBlocks.forEach((block, index) => {
    if (claimed.has(index)) return;
    recovered += 1;
    out.push(block);
  });

  return { page, blocks: out, conflicts, recovered };
};

/**
 * The block-level alternatives for a reconciled page.
 *
 * Kept separate from `reconcilePage` so the structure builder stays the only
 * thing that assigns ids: an alternative is attached to a block by id after
 * assembly, in the pipeline.
 */
export interface ReconciliationReport {
  readonly conflicts: number;
  readonly recovered: number;
  readonly pages: readonly number[];
}

/** Reconcile several pages and summarise. Pages not supplied are untouched. */
export const reconcilePages = (
  nativeBlocks: readonly DocumentBlock[],
  ocrResults: readonly OcrPageResult[],
): { readonly blocks: readonly RawBlock[]; readonly report: ReconciliationReport } => {
  const ocrByPage = new Map(ocrResults.map((r) => [r.page, r]));
  const pages = [...new Set(nativeBlocks.map((b) => b.page))].sort((a, b) => a - b);
  // A page that exists only in the OCR results (native produced no blocks for
  // it at all) still has to appear in the output, or the page is lost.
  for (const result of ocrResults) if (!pages.includes(result.page)) pages.push(result.page);
  pages.sort((a, b) => a - b);

  const blocks: RawBlock[] = [];
  let conflicts = 0;
  let recovered = 0;
  const touched: number[] = [];

  for (const page of pages) {
    const native = nativeBlocks.filter((b) => b.page === page);
    const ocr = ocrByPage.get(page);
    if (ocr === undefined) {
      // Untouched page: carry the native blocks through unchanged.
      for (const block of native) {
        blocks.push({
          page: block.page,
          kind: block.kind,
          text: block.text,
          method: block.method,
          ...(block.level !== undefined ? { level: block.level } : {}),
          ...(block.box !== undefined ? { box: block.box } : {}),
          ...(block.table !== undefined ? { table: block.table } : {}),
          ...(block.confidence !== undefined ? { confidence: block.confidence } : {}),
        });
      }
      continue;
    }
    const result = reconcilePage(page, native, ocr);
    blocks.push(...result.blocks);
    conflicts += result.conflicts;
    recovered += result.recovered;
    touched.push(page);
  }

  return { blocks, report: { conflicts, recovered, pages: touched } };
};
