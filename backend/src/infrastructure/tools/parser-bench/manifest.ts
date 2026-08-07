// Corpus manifest — fixed-seed sampling, anonymised ids, integrity checksum.
//
// The manifest is the thing that makes a benchmark repeatable and the thing
// that keeps candidates' CVs out of Git. It records WHICH documents were used
// without recording what or where they are.

import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  CorpusEntry, CorpusManifest, DocumentTrait, LanguageCohort, SourceFormat,
} from './types.js';

/* ------------------------------ identity ---------------------------------- */

export const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/**
 * A stable pseudonym for a document.
 *
 * Derived from the content hash, so the same file always maps to the same id
 * and the id reveals nothing. Truncated to 16 hex characters: collision-safe
 * far beyond any corpus size, short enough to read in a report.
 */
export const docIdFor = (hash: string): string => `cv-${hash.slice(0, 16)}`;

export const formatOf = (filePath: string): SourceFormat => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (ext === '.doc') return 'doc';
  return 'other';
};

/* ----------------------------- deterministic RNG --------------------------- */

/**
 * mulberry32 — a small, fast, fully deterministic PRNG.
 *
 * `Math.random()` would make a sample unreproducible, which defeats the purpose
 * of recording a seed.
 */
export const rng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Fisher-Yates against a seeded RNG. Does not mutate the input. */
export const shuffle = <T>(items: readonly T[], seed: number): T[] => {
  const next = rng(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
};

/* ------------------------------- checksum --------------------------------- */

/** Over the ordered docIds — detects reordering, addition and removal. */
export const checksumOf = (entries: readonly CorpusEntry[]): string =>
  createHash('sha256').update(entries.map((e) => e.docId).join('\n')).digest('hex');

export const verifyManifest = (manifest: CorpusManifest): boolean =>
  checksumOf(manifest.entries) === manifest.checksum;

/* ------------------------------- sampling --------------------------------- */

export interface CandidateFile {
  readonly filePath: string;
  readonly bytes: number;
  readonly sha256: string;
  /**
   * Traits known without opening the file (format, size).
   *
   * Language and layout traits are NOT guessed here — a human assigns them
   * during annotation. A machine-assigned cohort label would make cohort
   * reporting a measurement of the guesser.
   */
  readonly traits?: readonly DocumentTrait[];
  readonly language?: LanguageCohort | null;
}

export interface SampleOptions {
  readonly name: string;
  readonly seed: number;
  readonly size: number;
  /** Fraction reserved for the held-out set. The rest is for tuning. */
  readonly heldOutFraction?: number;
  /** ISO timestamp. Injected so a manifest is reproducible under test. */
  readonly createdAt: string;
}

/**
 * Draw a reproducible sample and split it into tuning and held-out sets.
 *
 * Deduplicates by content hash first: the corpus contains the same CV under
 * several filenames, and counting it twice would inflate whichever pipeline
 * happens to handle it well.
 *
 * The split is applied AFTER shuffling and is never re-drawn — the held-out set
 * must not move once results have been seen.
 */
export const sampleCorpus = (
  files: readonly CandidateFile[],
  opts: SampleOptions,
): CorpusManifest => {
  const unique = new Map<string, CandidateFile>();
  for (const f of files) if (!unique.has(f.sha256)) unique.set(f.sha256, f);

  // Sort before shuffling so the input order (a filesystem's whim) cannot
  // influence the result. Seed alone then determines the sample.
  const ordered = [...unique.values()].sort((a, b) => a.sha256.localeCompare(b.sha256));
  const drawn = shuffle(ordered, opts.seed).slice(0, opts.size);

  const heldOutCount = Math.round(drawn.length * (opts.heldOutFraction ?? 0.5));
  const entries: CorpusEntry[] = drawn.map((f, i) => ({
    docId: docIdFor(f.sha256),
    sha256: f.sha256,
    bytes: f.bytes,
    format: formatOf(f.filePath),
    language: f.language ?? null,
    traits: f.traits ?? [],
    split: i < heldOutCount ? 'held-out' : 'tuning',
  }));

  return {
    manifestVersion: 1,
    name: opts.name,
    seed: opts.seed,
    createdAt: opts.createdAt,
    checksum: checksumOf(entries),
    entries,
  };
};

/**
 * Map docId → absolute path.
 *
 * Kept OUT of the manifest deliberately. This index is written beside the raw
 * corpus, outside Git; the manifest alone is safe to share.
 */
export const buildPathIndex = (
  files: readonly CandidateFile[],
): Record<string, string> => Object.fromEntries(
  files.map((f) => [docIdFor(f.sha256), f.filePath]),
);
