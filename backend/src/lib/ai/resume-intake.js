// The `resume.parse` capability: one CV, one proposal, no side effects.
//
// THE FLOW
//   stored bytes → quality check → (OCR rescue) → structured extraction
//   → strict schema validation → editable draft
//
// WHAT THIS DELIBERATELY DOES NOT DO
//   - It does not create a candidate. Not on success, not on high confidence,
//     not ever. The output is a PROPOSAL; a named human turns it into a record
//     through the ordinary candidate service, under the ordinary rules.
//   - It does not move an application, stamp a stage or touch a requisition.
//     An AI has no workflow authority in this system.
//   - It does not repair a malformed extraction. A model answer that fails the
//     schema is rejected, because coaxing prose into valid JSON is exactly how
//     an invented phone number reaches a candidate record.
//   - It does not fall back to the legacy heuristic parser. That would hide an
//     outage and quietly process CVs with a system nobody selected.
//
// OCR IS A RESCUE, NOT A DEFAULT. Running OCR on a text-native PDF costs time
// and LOSES fidelity — it re-reads glyphs that were already exact. So the
// gateway reports what it found and OCR is requested only when native text is
// too sparse to be a real CV.

import { AI_CAPABILITIES } from './capabilities.js';
import { aiConfig } from './config.js';
import { AI_ERROR, AiIntakeError } from './errors.js';
import { gatewayParseResume } from './gateway-client.js';
import { AiTasks, AiDrafts } from './jobs.js';
import { readBlob } from '../upload.js';
import { validateResumeProposal } from './resume-proposal.js';

/** Below this, native text is not a CV — it is a scan with a few stray glyphs. */
export const MIN_NATIVE_CHARS_PER_PAGE = 120;

/**
 * Map a gateway document verdict onto a domain error.
 * All of these are properties of the BYTES, so all are permanent.
 */
const DOCUMENT_REJECTIONS = {
  unsupported: AI_ERROR.UNSUPPORTED_TYPE,
  encrypted: AI_ERROR.FILE_ENCRYPTED,
  corrupt: AI_ERROR.FILE_CORRUPT,
  empty: AI_ERROR.NO_TEXT,
  too_many_pages: AI_ERROR.TOO_MANY_PAGES,
};

/**
 * Run one resume.parse task.
 *
 * Registered with the runner, which owns the timeout, the concurrency slot and
 * the task's terminal state. This function's only job is: produce a draft, or
 * throw an AiIntakeError that says whether retrying could help.
 */
export async function handleResumeParse(task, { signal } = {}) {
  const cfg = aiConfig();

  const stored = readBlob(task.file_stored_name);
  if (!stored || !stored.data || stored.data.length === 0) {
    // The original upload is gone. Retrying re-reads the same absence.
    throw new AiIntakeError(AI_ERROR.FILE_CORRUPT, { permanent: true });
  }

  const result = await gatewayParseResume({
    bytes: stored.data,
    filename: task.file_original_name,
    mimeType: task.file_mime,
    maxPages: cfg.maxPages,
  }, { signal, timeoutMs: Number(task.timeout_ms) || cfg.timeoutMs });

  // Provenance is recorded BEFORE the outcome is judged, so a rejected
  // extraction is still attributable to the exact model and prompt that
  // produced it. An unexplainable failure is not reviewable.
  AiTasks.recordProvenance(task.id, {
    modelId: str(result?.provenance?.modelId),
    modelDigest: str(result?.provenance?.modelDigest),
    promptVersion: str(result?.provenance?.promptVersion),
    schemaVersion: str(result?.provenance?.schemaVersion),
    parserVersion: str(result?.provenance?.parserVersion),
    gatewayVersion: str(result?.gatewayVersion),
  });

  const doc = result?.document || {};

  // 1. DOCUMENT QUALITY. A verdict about the bytes ends the task here.
  if (doc.status && doc.status !== 'ok') {
    const code = DOCUMENT_REJECTIONS[doc.status] || AI_ERROR.FILE_CORRUPT;
    throw new AiIntakeError(code, { permanent: true });
  }

  const pageCount = Number(doc.pageCount) || 0;
  if (pageCount > cfg.maxPages) {
    throw new AiIntakeError(AI_ERROR.TOO_MANY_PAGES, { permanent: true });
  }

  // 2. TEXT SUFFICIENCY. The gateway performs the OCR rescue itself when native
  //    text is thin — this check is what proves the rescue actually produced
  //    something, whether it ran or not. Both paths converge here.
  const charCount = Number(doc.charCount) || 0;
  const perPage = pageCount > 0 ? charCount / pageCount : charCount;
  if (charCount === 0 || perPage < MIN_NATIVE_CHARS_PER_PAGE) {
    // Not retryable: the same scan will be just as unreadable next time, and a
    // recruiter is better served by being told to type it in.
    throw new AiIntakeError(AI_ERROR.NO_TEXT, { permanent: true });
  }

  // 3. EXTRACTION OUTCOME. Abstention is a normal result, not an error — the
  //    reader declining to guess is the behaviour we want.
  if (result?.extraction?.abstained === true) {
    throw new AiIntakeError(AI_ERROR.EXTRACTION_ABSTAINED, {
      permanent: result.extraction.permanent === true,
    });
  }

  // 4. STRICT SCHEMA VALIDATION. Nothing the model returned is trusted until it
  //    matches the contract; anything unexpected is dropped, not coerced.
  const validated = validateResumeProposal(result?.extraction?.content);
  if (!validated.ok) {
    throw new AiIntakeError(AI_ERROR.EXTRACTION_INVALID, { permanent: false });
  }

  // A cancellation that arrived while the model was thinking must not produce
  // a draft the recruiter never asked to keep.
  if (AiTasks.isCancelled(task.id)) throw new AiIntakeError(AI_ERROR.CANCELLED, { permanent: true });

  // 5. THE DRAFT. A proposal, pending review. No candidate exists yet.
  AiDrafts.upsert(task.id, {
    proposal: {
      fields: validated.value,
      // Evidence, when the gateway supplied it: which page each field came
      // from. A recruiter comparing "original vs proposed" needs somewhere to
      // look, and a field with no evidence should feel less trustworthy.
      evidence: sanitizeEvidence(result?.extraction?.evidence),
      document: {
        pageCount,
        charCount,
        ocrApplied: doc.ocrApplied === true,
        detectedLanguage: str(doc.detectedLanguage),
      },
    },
    confidence: num(result?.extraction?.confidence),
    uncertainFields: Array.isArray(validated.value.uncertainFields) ? validated.value.uncertainFields : [],
  });
}

/**
 * Evidence is a map of field → short locator. Values are bounded and stripped
 * of newlines so a snippet cannot become a multi-line log injection, and the
 * map is capped so a hostile gateway cannot inflate a draft row.
 */
function sanitizeEvidence(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (n >= 40) break;
    if (typeof k !== 'string' || k.length > 60) continue;
    if (typeof v === 'number' && Number.isFinite(v)) { out[k] = { page: v }; n += 1; continue; }
    if (v && typeof v === 'object') {
      const page = Number(v.page);
      const snippet = typeof v.snippet === 'string'
        ? v.snippet.replace(/\s+/g, ' ').slice(0, 200) : undefined;
      out[k] = { ...(Number.isFinite(page) ? { page } : {}), ...(snippet ? { snippet } : {}) };
      n += 1;
    }
  }
  return out;
}

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

export const RESUME_PARSE_CAPABILITY = AI_CAPABILITIES.RESUME_PARSE;
