// Safe, stable error codes for the AI intake path.
//
// THE RULE THIS FILE ENFORCES: nothing derived from a CV — no name, no email,
// no extracted text, no model output — may ever reach a log line, an audit row
// or an HTTP body. What a recruiter and an operator both need is WHICH STEP
// failed and WHETHER RETRYING COULD HELP. Neither answer requires the document.
//
// So an error here is a code plus a fixed sentence. Adapter messages (which can
// legitimately quote document content, e.g. "unexpected token at …") are
// classified into one of these and then DISCARDED.

export const AI_ERROR = {
  DISABLED: 'AI_DISABLED',
  NOT_CONFIGURED: 'AI_NOT_CONFIGURED',
  UNAVAILABLE: 'AI_UNAVAILABLE',
  CIRCUIT_OPEN: 'AI_CIRCUIT_OPEN',
  TIMEOUT: 'AI_TIMEOUT',
  CANCELLED: 'AI_CANCELLED',
  UNSUPPORTED_TYPE: 'FILE_UNSUPPORTED_TYPE',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  FILE_CORRUPT: 'FILE_CORRUPT',
  FILE_ENCRYPTED: 'FILE_ENCRYPTED',
  TOO_MANY_PAGES: 'FILE_TOO_MANY_PAGES',
  NO_TEXT: 'DOCUMENT_NO_TEXT',
  EXTRACTION_INVALID: 'EXTRACTION_SCHEMA_INVALID',
  EXTRACTION_ABSTAINED: 'EXTRACTION_ABSTAINED',
  INTERNAL: 'AI_INTERNAL_ERROR',
};

/** Fixed, document-free sentences. Indexed by code so the UI can localise later. */
const MESSAGES = {
  [AI_ERROR.DISABLED]: 'AI-assisted intake is switched off. Add the candidate manually.',
  [AI_ERROR.NOT_CONFIGURED]: 'AI-assisted intake is not configured on this environment.',
  [AI_ERROR.UNAVAILABLE]: 'The document intelligence service could not be reached.',
  [AI_ERROR.CIRCUIT_OPEN]: 'The document intelligence service is failing and has been paused. Try again shortly.',
  [AI_ERROR.TIMEOUT]: 'Parsing took longer than the configured limit.',
  [AI_ERROR.CANCELLED]: 'Parsing was cancelled.',
  [AI_ERROR.UNSUPPORTED_TYPE]: 'Only PDF and DOCX files can be parsed.',
  [AI_ERROR.FILE_TOO_LARGE]: 'The file is larger than the configured limit.',
  [AI_ERROR.FILE_CORRUPT]: 'The file is damaged and cannot be read.',
  [AI_ERROR.FILE_ENCRYPTED]: 'The file is password-protected and cannot be read.',
  [AI_ERROR.TOO_MANY_PAGES]: 'The document has more pages than the configured limit.',
  [AI_ERROR.NO_TEXT]: 'No readable text could be recovered from the document.',
  [AI_ERROR.EXTRACTION_INVALID]: 'The extraction result did not match the expected structure and was rejected.',
  [AI_ERROR.EXTRACTION_ABSTAINED]: 'The reader could not produce a reliable result for this document.',
  [AI_ERROR.INTERNAL]: 'AI-assisted intake failed unexpectedly.',
};

/** Codes for which another attempt could plausibly succeed. */
const RETRYABLE = new Set([
  AI_ERROR.UNAVAILABLE, AI_ERROR.CIRCUIT_OPEN, AI_ERROR.TIMEOUT,
  AI_ERROR.EXTRACTION_INVALID, AI_ERROR.EXTRACTION_ABSTAINED, AI_ERROR.INTERNAL,
]);

export class AiIntakeError extends Error {
  /**
   * @param {string} code one of AI_ERROR
   * @param {{permanent?: boolean, status?: number}} [opts]
   */
  constructor(code, opts = {}) {
    // The message is the FIXED sentence, never a driver or model string, so an
    // accidental `console.error(err)` still cannot leak document content.
    super(MESSAGES[code] || MESSAGES[AI_ERROR.INTERNAL]);
    this.name = 'AiIntakeError';
    this.code = AI_ERROR[code] ? code : (MESSAGES[code] ? code : AI_ERROR.INTERNAL);
    this.permanent = opts.permanent ?? !RETRYABLE.has(code);
    this.status = opts.status ?? 502;
  }

  toBody() { return { error: this.message, code: this.code, retryable: !this.permanent }; }
}

export const aiErrorMessage = (code) => MESSAGES[code] || MESSAGES[AI_ERROR.INTERNAL];
export const isRetryableCode = (code) => RETRYABLE.has(code);
