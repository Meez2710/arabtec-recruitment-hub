// Structured document contract. INTERFACES AND TYPES ONLY.
//
// This is the stable representation the extraction layer consumes. It exists
// because flattening a CV to a string at the parser boundary throws away exactly
// what a layout-aware parser was run to recover — reading order, headings,
// tables, and WHERE on the page a value came from.
//
// PROVIDER-NEUTRAL. Nothing here names Docling, PaddleOCR, OpenOCR, pdfjs or
// mammoth, and nothing here may. Those are implementations behind
// `DocumentParser` and `OcrEngine`; swapping one is a composition-root change.
//
// TWO RESPONSIBILITIES, KEPT APART
//
//   Layout analysis  — what the document IS: pages, blocks, order, sections,
//                      tables. Recovered by the parser.
//   OCR              — what the PIXELS SAY, when no native text exists. A
//                      reading, not a structure.
//
// They meet at `DocumentBlock.method`, which records which one produced a given
// piece of text, so a downstream reader can always tell a decoded value from a
// recognised one.

/* -------------------------------- geometry -------------------------------- */

/**
 * Where a block sits on its page.
 *
 * Coordinates are FRACTIONS of the page (0..1, origin top-left), not points or
 * pixels. A fraction survives a DPI change, a rescan at another resolution and
 * a parser that reports a different unit, so two runs of the same document stay
 * comparable. Absent when the parser reports no geometry.
 */
export interface LayoutBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A citable position in the source document.
 *
 * The unit of provenance. Every extracted value carries one of these so a
 * reviewer can be shown the exact place the value was read from, and so a
 * disputed value can be re-checked against the file rather than against a
 * model's memory.
 */
export interface SourceLocation {
  /** 1-based. Matches what a human sees in a PDF viewer. */
  readonly page: number;
  readonly blockId: string;
  readonly sectionId?: string;
  /** Character offsets WITHIN the block's text. */
  readonly charStart?: number;
  readonly charEnd?: number;
}

/** How closely an extracted value matches the text it was located in. */
export type EvidenceMatch = 'exact' | 'normalized' | 'partial';

/**
 * One place in the document that supports a value.
 *
 * `snippet` is the source text AS WRITTEN — not the extracted value — so a
 * reviewer sees what the CV actually said, including its spelling and script.
 *
 * This is the document-side citation. The persisted, reviewable form of it is
 * `ProposedField.evidence` + `evidenceRef` on the CandidateProposal aggregate;
 * this type is what the extraction stage produces before that boundary.
 */
export interface FieldEvidence {
  readonly snippet: string;
  readonly location: SourceLocation;
  readonly match: EvidenceMatch;
}

/* ------------------------------- provenance ------------------------------- */

/**
 * How a piece of text came to exist.
 *
 *   native      — decoded from the document's own text layer. Exact.
 *   ocr         — recognised from pixels. A reading, and therefore fallible.
 *   reconciled  — a native and an OCR reading of the same region were compared
 *                 and one was chosen. `DocumentBlock.alternative` keeps the
 *                 one that lost, because a discarded reading is evidence too.
 */
export type ExtractionMethod = 'native' | 'ocr' | 'reconciled';

/**
 * Whether OCR ran on a page, and why.
 *
 * `not-needed` and `unavailable` are deliberately different: the first says the
 * native text was good enough, the second says the page needed OCR and no
 * engine could be reached. Collapsing them would make a degraded parse look
 * like a clean one.
 */
export type OcrStatus = 'not-needed' | 'applied' | 'unavailable' | 'failed';

/** Which implementations produced this document. Recorded, never parsed. */
export interface DocumentProvenance {
  /** Opaque parser identifier, e.g. a sidecar name. */
  readonly parser: string;
  readonly parserVersion: string;
  /** Absent when no OCR ran anywhere in the document. */
  readonly ocrEngine?: string;
  readonly ocrEngineVersion?: string;
  readonly convertedAt: Date;
  /** Pinned pipeline/image tag when the implementation reports one. */
  readonly pipelineVersion?: string;
}

/* --------------------------------- tables --------------------------------- */

export interface TableCell {
  readonly row: number;
  readonly column: number;
  readonly rowSpan?: number;
  readonly columnSpan?: number;
  readonly text: string;
  readonly header?: boolean;
}

/**
 * A table's grid, kept as a grid.
 *
 * Linearising a table into prose is lossy in a way that matters for CVs: a
 * skills matrix or a dated employment table loses which value belonged to which
 * column, and an extractor then attributes a date to the wrong role.
 */
export interface DocumentTable {
  readonly rowCount: number;
  readonly columnCount: number;
  readonly cells: readonly TableCell[];
}

/* --------------------------------- blocks --------------------------------- */

export type BlockKind =
  | 'title' | 'heading' | 'paragraph' | 'list-item'
  | 'table' | 'caption' | 'figure' | 'header' | 'footer' | 'unknown';

/**
 * The atom of the structured document.
 *
 * `readingOrder` is document-global, not per-page, so a multi-column CV read in
 * the correct order stays in the correct order after pages are concatenated.
 */
export interface DocumentBlock {
  readonly id: string;
  /** 1-based page number. */
  readonly page: number;
  /** Document-global sequence. Ascending = the order a human reads. */
  readonly readingOrder: number;
  readonly kind: BlockKind;
  readonly text: string;
  /** Heading depth, 1-based. Present on `heading`/`title` blocks. */
  readonly level?: number;
  readonly box?: LayoutBox;
  readonly method: ExtractionMethod;
  readonly sectionId?: string;
  readonly table?: DocumentTable;
  /**
   * Recognition confidence, 0..1, when the producer reports one.
   *
   * Meaningful for `ocr` blocks. A native block is decoded, not guessed, so it
   * carries no confidence rather than a fabricated 1.0.
   */
  readonly confidence?: number;
  /**
   * The reading that was NOT chosen, when native and OCR disagreed.
   *
   * Kept because "the two sources conflict here" is information a reviewer
   * needs and a downstream extractor can use to lower its own confidence.
   */
  readonly alternative?: {
    readonly text: string;
    readonly method: ExtractionMethod;
    readonly confidence?: number;
  };
}

/* -------------------------------- sections -------------------------------- */

/**
 * A heading and everything under it.
 *
 * Sections are how an extractor asks "what does the EXPERIENCE section say?"
 * instead of keyword-searching the whole document — which is how "no education
 * section" becomes a major called "Education".
 */
export interface DocumentSection {
  readonly id: string;
  readonly title: string;
  /** 1-based nesting depth. */
  readonly level: number;
  /** Canonical name when the heading matched a known CV section. */
  readonly canonical?: CanonicalSection;
  readonly blockIds: readonly string[];
  readonly parentId?: string;
}

/** Section names the extraction layer reasons about. Language-independent. */
export type CanonicalSection =
  | 'contact' | 'summary' | 'experience' | 'education' | 'skills'
  | 'certifications' | 'languages' | 'projects' | 'links' | 'other';

/* ---------------------------------- pages --------------------------------- */

export interface DocumentPage {
  /** 1-based. */
  readonly number: number;
  readonly blockIds: readonly string[];
  /** The page's text in reading order. Derived from its blocks. */
  readonly text: string;
  readonly method: ExtractionMethod;
  readonly ocrStatus: OcrStatus;
  /**
   * Why OCR was or was not run on this page. Present whenever the quality gate
   * made a decision, so an operator can explain a slow or a degraded parse.
   */
  readonly ocrReason?: string;
}

/* --------------------------- the structured document ---------------------- */

/**
 * The stable contract between document understanding and extraction.
 *
 * Everything downstream — extraction, evidence, proposal, evaluation — reads
 * THIS. That is what lets Docling, the OCR engine, the chunking strategy and
 * the model change without touching the competency-evaluation architecture.
 */
export interface StructuredDocument {
  readonly blocks: readonly DocumentBlock[];
  readonly sections: readonly DocumentSection[];
  readonly pages: readonly DocumentPage[];
  readonly provenance: DocumentProvenance;
  /** True when any page was read by OCR. Operational signal. */
  readonly ocrApplied: boolean;
  /** Pages whose native text the quality gate judged insufficient. */
  readonly degradedPages: readonly number[];
}

/* ------------------------------- the OCR port ----------------------------- */

/**
 * One page of pixels to recognise.
 *
 * A PAGE, not a document: OCR is conditional per page, so the engine is asked
 * only about the regions that need it. Passing a whole document would force an
 * all-or-nothing decision and re-recognise text that was already exact.
 */
export interface OcrPageRequest {
  readonly documentId: string;
  /** 1-based page number this image represents. */
  readonly page: number;
  readonly imageBytes: Uint8Array;
  readonly mimeType: string;
  /** BCP-47 hints, e.g. ['ar', 'en']. Advisory; an engine may ignore them. */
  readonly languageHints?: readonly string[];
}

export interface OcrLine {
  readonly text: string;
  readonly box?: LayoutBox;
  /** 0..1 when the engine reports one. */
  readonly confidence?: number;
}

export interface OcrPageResult {
  readonly page: number;
  readonly text: string;
  readonly lines: readonly OcrLine[];
  /** Mean line confidence, 0..1, when the engine reports one. */
  readonly confidence?: number;
  readonly engine: string;
}

/**
 * Provider-neutral OCR.
 *
 * PaddleOCR, OpenOCR or anything else sits behind this. The pipeline never
 * learns which — an engine is selected in the composition root and the rest of
 * the document layer only knows it can ask a page to be read.
 *
 * Returns an outcome rather than throwing: "no engine could read this page" is
 * a normal result that leaves the page marked degraded, not an exception that
 * loses the rest of the document.
 */
export interface OcrEngine {
  readonly name: string;
  readonly version?: string;
  recognize(request: OcrPageRequest): Promise<OcrPageOutcome>;
}

/** Narrow local outcome, so this file does not depend on the proposal envelope. */
export type OcrPageOutcome =
  | { readonly ok: true; readonly result: OcrPageResult }
  | { readonly ok: false; readonly reason: string; readonly permanent: boolean };
