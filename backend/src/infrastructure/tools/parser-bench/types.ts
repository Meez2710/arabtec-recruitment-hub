// Benchmark and annotation types.
//
// PRIVACY IS STRUCTURAL HERE. Nothing in this file can hold CV text, a
// candidate's name, or a file path: the manifest carries an anonymised id and a
// hash, and ground-truth labels live in a separate file that never enters Git.
// Metrics are counts, so a report is safe to commit and safe to share.

/* ------------------------------- cohorts ---------------------------------- */

/** Script mix. Assigned by a human during annotation, never guessed. */
export type LanguageCohort = 'arabic' | 'english' | 'mixed';

/** Overlapping document characteristics. A CV carries as many as apply. */
export type DocumentTrait =
  | 'digital' | 'scanned' | 'image-heavy'
  | 'single-column' | 'multi-column'
  | 'has-tables' | 'long' | 'malformed';

export type SourceFormat = 'pdf' | 'docx' | 'doc' | 'other';

/* ------------------------------- manifest --------------------------------- */

/**
 * One corpus entry.
 *
 * `docId` is a stable pseudonym derived from the content hash — the same file
 * always yields the same id, so results are comparable across runs without ever
 * recording where the file lives or what it is called.
 */
export interface CorpusEntry {
  readonly docId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly format: SourceFormat;
  /** Assigned during annotation. `null` until a human has looked. */
  readonly language: LanguageCohort | null;
  readonly traits: readonly DocumentTrait[];
  /** Which set this belongs to. Held-out entries are never used for tuning. */
  readonly split: 'tuning' | 'held-out';
}

export interface CorpusManifest {
  readonly manifestVersion: 1;
  readonly name: string;
  /** Fixed, so a sample is reproducible. */
  readonly seed: number;
  /** ISO date, supplied by the caller — never read from the clock in a test. */
  readonly createdAt: string;
  /** SHA-256 over the ordered docIds. Detects an edited manifest. */
  readonly checksum: string;
  readonly entries: readonly CorpusEntry[];
}

/* ----------------------------- ground truth -------------------------------- */

/**
 * Why a value is absent.
 *
 * Collapsing these into "empty" makes a benchmark meaningless: a parser that
 * misses a phone number present in the CV and one that correctly reports no
 * phone number would score identically.
 */
export type AbsenceReason =
  /** The CV genuinely does not contain this. Correct answer: absent. */
  | 'not-in-document'
  /** Present but unreadable — bad scan, cropped, illegible. */
  | 'unreadable'
  /** Present and readable, but the schema has nowhere to put it. */
  | 'unsupported-field';

/** A labelled scalar: either a value, or a reason there is none. */
export type LabelledValue =
  | { readonly present: true; readonly value: string }
  | { readonly present: false; readonly reason: AbsenceReason };

export interface LabelledEmployment {
  readonly employer: string;
  readonly title: string;
  readonly from?: string;
  readonly to?: string;
  readonly current?: boolean;
}

export interface LabelledEducation {
  readonly institution: string;
  readonly qualification?: string;
  readonly field?: string;
  readonly to?: string;
}

/**
 * Human-verified ground truth for one CV.
 *
 * `annotator` and `reviewedBy` exist so double-review is auditable. A record
 * with `reviewedBy === null` has been seen once and may carry annotation error.
 */
export interface GroundTruth {
  readonly docId: string;
  readonly annotator: string;
  readonly reviewedBy: string | null;
  readonly language: LanguageCohort;
  readonly traits: readonly DocumentTrait[];

  readonly fullName: LabelledValue;
  readonly emails: readonly string[];
  readonly phones: readonly string[];
  readonly location: LabelledValue;
  readonly currentTitle: LabelledValue;
  readonly totalYearsExperience: LabelledValue;
  readonly employment: readonly LabelledEmployment[];
  readonly education: readonly LabelledEducation[];
  readonly skills: readonly string[];
  readonly certifications: readonly string[];
  readonly languages: readonly string[];

  /** Free-text note from the annotator. Must not quote CV content. */
  readonly note?: string;
}

/* ------------------------------- pipelines --------------------------------- */

/**
 * What a pipeline produced for one document.
 *
 * Both the legacy parser and the Docling/Qwen pipeline are reduced to this so
 * they are scored by identical code. `abstained` is first-class: a pipeline
 * that declines is not the same as one that returns nothing, and conflating
 * them would reward silent failure.
 */
export interface PipelineOutput {
  readonly docId: string;
  readonly abstained: boolean;
  readonly abstainReason?: string;
  readonly permanent?: boolean;
  readonly fullName?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly location?: string;
  readonly currentTitle?: string;
  readonly totalYearsExperience?: number;
  readonly employment: readonly LabelledEmployment[];
  readonly education: readonly LabelledEducation[];
  readonly skills: readonly string[];
  readonly certifications: readonly string[];
  readonly languages: readonly string[];
  /** Wall-clock for the whole document. */
  readonly latencyMs: number;
  /** Document-structure observations, when the pipeline reports them. */
  readonly structure?: DocumentStructureObservation;
}

/**
 * Document-level quality signals, scored separately from field accuracy.
 *
 * Each is a human judgement recorded against a rendered output, not something a
 * pipeline can self-report — which is why they are optional and why the
 * acceptance document defines a rubric for them.
 */
export interface DocumentStructureObservation {
  readonly readingOrderCorrect?: boolean;
  readonly columnsReconstructed?: boolean;
  readonly tablesPreserved?: boolean;
  readonly pagesLost?: number;
  readonly ocrApplied?: boolean;
}

/** One pipeline under test. Implemented for legacy and for Docling/Qwen. */
export interface PipelineRunner {
  readonly name: string;
  /** Everything needed to reproduce this run. Recorded in the report. */
  readonly pinnedConfig: Readonly<Record<string, string>>;
  run(input: { docId: string; filePath: string }): Promise<PipelineOutput>;
}
