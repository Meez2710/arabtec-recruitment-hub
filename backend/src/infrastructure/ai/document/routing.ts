// Ingestion and routing. Pure, deterministic, no I/O.
//
// Decides WHAT a document is and WHICH kind of parser should read it, before
// any parser runs. Separated from the pipeline because format classification is
// where the cheap, total failures live — an .exe renamed to .pdf, a zero-byte
// upload, a DOCX served as application/octet-stream — and each of them should
// be a clear refusal rather than a parser exception three layers down.
//
// MAGIC BYTES BEAT THE DECLARED TYPE. `mimeType` arrives from an HTTP client and
// a filename extension is chosen by whoever named the file; neither is evidence.
// The first bytes of the file are.

/** Formats the document layer distinguishes. */
export type DocumentFormat = 'pdf' | 'docx' | 'doc' | 'image' | 'text' | 'unknown';

/**
 * Which capability the format needs.
 *
 *   layout — a layout-aware parser. PDF, Office formats and images: the value
 *            is in the geometry, and reading them as bytes yields nothing.
 *   text   — a decoder. Plain text has no layout to recover.
 */
export type ParserKind = 'layout' | 'text';

export interface DocumentRoute {
  readonly format: DocumentFormat;
  readonly parserKind: ParserKind;
  readonly supported: boolean;
  /** Canonical media type, corrected from the bytes where possible. */
  readonly mimeType: string;
  /** True when the bytes ARE a single page image, so OCR needs no renderer. */
  readonly singlePageImage: boolean;
  /** Why an unsupported document was refused. Absent when supported. */
  readonly reason?: string;
}

export interface RoutingInput {
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean => {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
};

const IMAGE_SIGNATURES: ReadonlyArray<readonly [readonly number[], string]> = [
  [[0x89, 0x50, 0x4e, 0x47], 'image/png'],
  [[0xff, 0xd8, 0xff], 'image/jpeg'],
  [[0x47, 0x49, 0x46, 0x38], 'image/gif'],
  [[0x42, 0x4d], 'image/bmp'],
  [[0x49, 0x49, 0x2a, 0x00], 'image/tiff'],
  [[0x4d, 0x4d, 0x00, 0x2a], 'image/tiff'],
];

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const extensionOf = (filename: string): string => {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
};

/**
 * Does this look like text rather than a binary container?
 *
 * Trailing NUL padding is ignored: several export tools pad a text file out to
 * a block boundary, and treating that as "binary" would refuse a perfectly
 * readable CV. A NUL *inside* the content is still the reliable binary marker.
 */
const looksTextual = (bytes: Uint8Array): boolean => {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  if (end === 0) return false; // nothing but padding

  const sample = bytes.subarray(0, Math.min(end, 4096));
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    // Tab, newline and carriage return are text; the rest of C0 is not.
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control += 1;
  }
  return control / sample.length < 0.05;
};

/**
 * Classify one uploaded document.
 *
 * Never throws and never reads the whole file: only the first bytes decide, so
 * routing a 25 MB scan costs the same as routing a 2 kB note.
 */
export const classifyDocument = (input: RoutingInput): DocumentRoute => {
  const { bytes } = input;
  const extension = extensionOf(input.filename);
  const declared = input.mimeType.toLowerCase();

  if (bytes.length === 0) {
    return {
      format: 'unknown',
      parserKind: 'text',
      supported: false,
      mimeType: declared,
      singlePageImage: false,
      reason: 'The document is empty.',
    };
  }

  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) {
    return {
      format: 'pdf', parserKind: 'layout', supported: true,
      mimeType: 'application/pdf', singlePageImage: false,
    };
  }

  for (const [signature, mimeType] of IMAGE_SIGNATURES) {
    if (startsWith(bytes, signature)) {
      return {
        format: 'image', parserKind: 'layout', supported: true,
        mimeType, singlePageImage: true,
      };
    }
  }

  // A DOCX is a ZIP. So are XLSX, PPTX and an ordinary archive, and the bytes
  // alone cannot tell them apart without reading the container — so the
  // extension and the declared type are allowed to break the tie here, and only
  // here.
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    if (extension === '.docx' || declared === DOCX_MIME) {
      return {
        format: 'docx', parserKind: 'layout', supported: true,
        mimeType: DOCX_MIME, singlePageImage: false,
      };
    }
    return {
      format: 'unknown', parserKind: 'layout', supported: false,
      mimeType: declared, singlePageImage: false,
      reason: 'The document is a ZIP archive that is not a Word document.',
    };
  }

  // Legacy .doc — an OLE2 compound file.
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return {
      format: 'doc', parserKind: 'layout', supported: true,
      mimeType: 'application/msword', singlePageImage: false,
    };
  }

  if (looksTextual(bytes)) {
    const mimeType = declared.startsWith('text/') || declared === 'application/json'
      || declared === 'application/xml'
      ? declared
      : 'text/plain';
    return {
      format: 'text', parserKind: 'text', supported: true,
      mimeType, singlePageImage: false,
    };
  }

  return {
    format: 'unknown', parserKind: 'layout', supported: false,
    mimeType: declared, singlePageImage: false,
    reason: 'The document format could not be identified.',
  };
};

/* ------------------------------ page images -------------------------------- */

export interface PageImage {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

/**
 * Supplies the pixels of one page, so OCR can be asked about it.
 *
 * A PORT, not an implementation, because rendering a PDF page needs a rasteriser
 * and this deployment deliberately avoids one. An image document needs no
 * rendering at all — its bytes ARE page one — which is the case
 * `SourceBytesPageImages` below covers, and the case that matters most for
 * scanned CVs.
 *
 * When no source can supply a page, the pipeline records `ocrStatus:
 * 'unavailable'` rather than silently treating the page as empty.
 */
export interface PageImageSource {
  pageImage(input: {
    readonly documentId: string;
    readonly bytes: Uint8Array;
    readonly mimeType: string;
    readonly page: number;
  }): Promise<PageImage | null>;
}

/** The bytes are the page. Valid for single-page image documents only. */
export class SourceBytesPageImages implements PageImageSource {
  async pageImage(input: {
    readonly documentId: string;
    readonly bytes: Uint8Array;
    readonly mimeType: string;
    readonly page: number;
  }): Promise<PageImage | null> {
    if (input.page !== 1) return null;
    if (!input.mimeType.startsWith('image/')) return null;
    return { bytes: input.bytes, mimeType: input.mimeType };
  }
}
