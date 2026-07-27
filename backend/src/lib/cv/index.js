// Orchestrator — the only module that knows the pipeline order:
//   Extractor -> SectionDetector -> EntityParser -> Normalizer -> Validator
//   -> ConfidenceEngine -> structured output
//
// Two result shapes:
//   heuristicParse()  LEGACY, byte-identical to the pre-refactor parser.
//   parseEntities()   RICH, grouped personal/employment/education + metadata.
//                     Not consumed by any route yet.
//
// Parser modules return generic entities. Mapping to ATS/database columns happens
// outside this directory.
import path from 'node:path';
import { extractText, extractTextAsync, isSupported, SUPPORTED_EXTENSIONS } from './extractor.js';
import { detectSections } from './section-detector.js';
import * as E from './entity-parser.js';
import { validate } from './validator.js';
import { fieldConfidence, summarise, deriveStatus, statusReason } from './confidence-engine.js';
import { aiExtract, aiGateStatus, isAiEnabled } from './ai-parser.js';
import { compactPhone } from './normalizer.js';

const GROUPS = {
  personal: ['full_name', 'email', 'phone', 'location'],
  employment: ['current_company', 'current_position', 'years_experience', 'role_applied'],
  education: ['university', 'major', 'graduation_year', 'degree'],
};

function runDetectors(text, filename, detected) {
  return {
    full_name: E.detectName(text, filename, detected),
    email: E.detectEmail(text),
    phone: E.detectPhone(text),
    location: E.detectLocation(text, detected),
    current_company: E.detectCurrentCompany(text, detected),
    current_position: E.detectCurrentPosition(text, detected),
    years_experience: E.detectYearsExperience(text),
    role_applied: E.detectRoleApplied(text, detected),
    university: E.detectUniversity(text, detected),
    major: E.detectMajor(text, detected),
    graduation_year: E.detectGraduationYear(text, detected),
    degree: E.detectDegree(text, detected),
  };
}

/**
 * LEGACY SHAPE — unchanged. routes/candidates.js depends on exactly these keys.
 */
export function heuristicParse(text, filename) {
  const detected = detectSections(text);
  const name = E.detectName(text, filename || '', detected);
  const email = E.detectEmail(text);
  const phone = E.detectPhone(text);
  const years = E.detectYearsExperience(text);
  return {
    full_name: name.value,
    email: email.value ? String(email.value) : null,
    phone: compactPhone(phone.value),
    years_experience: years.value,
    role_applied: null,
    raw_text: text,
    extraction_status: text ? 'partial' : 'failed',
  };
}

/**
 * RICH SHAPE — grouped entities with per-field method, confidence and validation.
 * @param {string} text
 * @param {string} filename
 * @returns {{personal:object, employment:object, education:object, metadata:object}}
 */
export function parseEntities(text, filename) {
  const detected = detectSections(text);
  const raw = runDetectors(text, filename || '', detected);

  // Validate + score each field.
  const flat = {};
  for (const [field, det] of Object.entries(raw)) {
    let value = det.value;
    if (field === 'phone') value = compactPhone(value);
    // Whitespace tidy applies to the RICH path only. The legacy heuristicParse
    // output is left byte-identical to pre-refactor, including its double spaces.
    if (field === 'full_name' && typeof value === 'string') value = value.replace(/\s+/g, ' ').trim();
    // Email is lower-cased in the RICH path only; legacy heuristicParse keeps the
    // original casing so its output stays byte-identical to pre-refactor.
    if (field === 'email' && typeof value === 'string') value = value.toLowerCase();
    const { value: checked, validation } = validate(field, value, det.method);
    flat[field] = {
      value: checked,
      method: checked == null ? null : det.method,
      confidence: checked == null ? 0 : fieldConfidence(det.method, validation),
      validation,
    };
  }

  const stats = summarise(flat);
  const out = { personal: {}, employment: {}, education: {}, metadata: {} };
  for (const [group, fields] of Object.entries(GROUPS)) {
    for (const f of fields) out[group][f] = flat[f];
  }
  out.metadata = {
    parse_status: deriveStatus({ hasText: !!text, fields: flat }),
    parse_status_reason: statusReason({ hasText: !!text, fields: flat }),
    overall_confidence: stats.overall_confidence,
    fields_found: stats.found,
    fields_missing: stats.missing,
    core_fields_found: stats.core_found,
    sections_detected: detected.order,
    parsed_by: 'heuristic',
    engine_version: 2,
  };
  return out;
}

/** File-level convenience wrappers. */
export async function parseEntitiesFromFile(filePath) {
  const text = await extractTextAsync(filePath);
  return parseEntities(text, path.basename(filePath));
}

export {
  extractText, extractTextAsync, isSupported, SUPPORTED_EXTENSIONS,
  detectSections, aiExtract, aiGateStatus, isAiEnabled,
};
