// Evidence-first extraction support.
//
// These are the STAGES that `resume-parse-handler.ts` composes. There is no
// proposal builder here: the proposal aggregate is `CandidateProposal` in
// modules/talent, and the handler is the one place that assembles fields for it.

export { extractDeterministically } from './deterministic-extractor.js';
export type { RuleHit } from './deterministic-extractor.js';

export { locateDigits, locateValue } from './evidence-locator.js';
export type { LocateOptions } from './evidence-locator.js';

export {
  cleanValue, normalizeDate, normalizeEmailValue, normalizeList, normalizeName,
  normalizeOrganisation, normalizePhoneValue, normalizeTitle, normalizeYear,
  normalizeYearsExperience,
} from './normalize.js';

export { crossValidate, validateField } from './validate.js';
export type { CrossFieldConflict, ValidationResult, ValidationState } from './validate.js';
