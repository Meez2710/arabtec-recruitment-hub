// Bind a value to the place in the document that supports it. Pure, no I/O.
//
// THIS IS THE HALLUCINATION GATE. An extractor — rules or a model — proposes a
// string. This module answers one question about it: IS IT ACTUALLY IN THE
// DOCUMENT? A value that cannot be located is marked `unsupported`, and the
// persistence boundary refuses unsupported values.
//
// That is why the check lives here and not in the extractor: an extractor that
// certifies its own output certifies nothing. The search runs against the
// structured document, which the extractor did not produce.
//
// Matching is graded rather than boolean, because a real CV rarely contains the
// normalized form of its own values — "+20 100 123 4567" in print becomes
// "201001234567" after normalization, and demanding a byte-exact match would
// reject every correctly extracted phone number.

import type {
  DocumentBlock, EvidenceMatch, FieldEvidence, StructuredDocument,
} from '../../../modules/shared/kernel/ai/index.js';
import { comparisonKey, normalizeText } from '../../../modules/shared/kernel/text.js';

/** Below this token overlap a "partial" match is not a match at all. */
const PARTIAL_THRESHOLD = 0.5;

/** Longer snippets are truncated: evidence is a citation, not a copy of the CV. */
const MAX_SNIPPET = 240;

const snippetAround = (text: string, start: number, length: number): string => {
  const context = 40;
  const from = Math.max(0, start - context);
  const to = Math.min(text.length, start + length + context);
  const slice = text.slice(from, to).trim();
  return slice.length > MAX_SNIPPET ? `${slice.slice(0, MAX_SNIPPET)}…` : slice;
};

const tokens = (value: string): string[] => comparisonKey(value)
  .split(' ')
  .filter((token) => token.length > 1);

/** Share of the VALUE's tokens present in the block. Asymmetric on purpose. */
const coverage = (value: string, blockText: string): number => {
  const wanted = tokens(value);
  if (wanted.length === 0) return 0;
  const available = new Set(tokens(blockText));
  const found = wanted.filter((token) => available.has(token)).length;
  return found / wanted.length;
};

const evidenceFor = (
  block: DocumentBlock,
  match: EvidenceMatch,
  snippet: string,
  offsets?: { readonly start: number; readonly end: number },
): FieldEvidence => ({
  snippet,
  match,
  location: {
    page: block.page,
    blockId: block.id,
    ...(block.sectionId !== undefined ? { sectionId: block.sectionId } : {}),
    ...(offsets !== undefined ? { charStart: offsets.start, charEnd: offsets.end } : {}),
  },
});

export interface LocateOptions {
  /** Search only these blocks. Used to scope a field to its own section. */
  readonly blocks?: readonly DocumentBlock[];
  /** Stop after this many. One citation is usually enough for review. */
  readonly limit?: number;
}

/**
 * Find where a value is supported in the document.
 *
 * Returns strongest matches first and an empty array when the value is
 * nowhere — which is the answer that matters most.
 */
export const locateValue = (
  structure: StructuredDocument,
  value: string,
  options: LocateOptions = {},
): readonly FieldEvidence[] => {
  const needle = normalizeText(value);
  if (needle === '') return [];
  const blocks = options.blocks ?? structure.blocks;
  const limit = options.limit ?? 2;

  const exact: FieldEvidence[] = [];
  const normalized: FieldEvidence[] = [];
  const partial: FieldEvidence[] = [];

  for (const block of blocks) {
    const text = normalizeText(block.text);
    if (text === '') continue;

    // 1. Verbatim, case-insensitively. The strongest form of support.
    const index = text.toLowerCase().indexOf(needle.toLowerCase());
    if (index !== -1) {
      exact.push(evidenceFor(
        block, 'exact', snippetAround(text, index, needle.length),
        { start: index, end: index + needle.length },
      ));
      if (exact.length >= limit) return exact;
      continue;
    }

    // 2. Present after safe normalization — the phone/email/spelling case.
    const key = comparisonKey(needle);
    if (key !== '' && comparisonKey(text).includes(key)) {
      normalized.push(evidenceFor(block, 'normalized', snippetAround(text, 0, MAX_SNIPPET)));
      continue;
    }

    // 3. Most of the value's words are here, in some other arrangement.
    if (coverage(needle, text) >= PARTIAL_THRESHOLD) {
      partial.push(evidenceFor(block, 'partial', snippetAround(text, 0, MAX_SNIPPET)));
    }
  }

  return [...exact, ...normalized, ...partial].slice(0, limit);
};

/**
 * Locate a value whose digits matter more than its punctuation.
 *
 * A phone number is written a dozen ways and normalized to one. Comparing digit
 * runs finds it wherever it appears; comparing strings does not.
 */
export const locateDigits = (
  structure: StructuredDocument,
  digits: string,
  options: LocateOptions = {},
): readonly FieldEvidence[] => {
  const wanted = digits.replace(/\D/g, '');
  if (wanted.length < 6) return [];
  const blocks = options.blocks ?? structure.blocks;
  const limit = options.limit ?? 2;
  const found: FieldEvidence[] = [];

  for (const block of blocks) {
    const text = normalizeText(block.text);
    // normalizeText has already folded Arabic-Indic digits to ASCII, so a
    // number written "٠١٠٠١٢٣٤٥٦٧" is findable here.
    const stripped = text.replace(/\D/g, '');
    // Compare on the last 9 significant digits, the same unit `normalizePhone`
    // uses for matching, so "+20 100…" and "0100…" are one number.
    const tail = wanted.slice(-9);
    if (!stripped.includes(tail)) continue;

    const match = /[+\d][\d\s()\-.]{6,}/.exec(text);
    const start = match?.index ?? 0;
    found.push(evidenceFor(
      block, 'normalized', snippetAround(text, start, match?.[0].length ?? 0),
    ));
    if (found.length >= limit) break;
  }
  return found;
};
