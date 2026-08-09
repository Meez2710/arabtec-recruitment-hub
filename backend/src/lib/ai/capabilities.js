// Runtime capability names for the JavaScript backend.
//
// The canonical list lives in the TypeScript kernel
// (src/modules/shared/kernel/ai/contracts.ts) and stays the source of truth for
// the domain contracts. This file exists because the Express runtime is plain
// JS and cannot import a .ts module — it mirrors only the names it actually
// dispatches on, so a typo becomes a missing handler rather than a silent
// no-op.
//
// `resume.parse` is the composite the intake flow submits: document conversion
// AND extraction, resolved by one gateway call. The kernel's finer-grained
// `document.parse` / `resume.extract` remain the ports the gateway implements
// internally — a caller of this runtime asks for the OUTCOME, not the steps.

export const AI_CAPABILITIES = Object.freeze({
  RESUME_PARSE: 'resume.parse',
});

export const AI_CAPABILITY_LIST = Object.freeze(Object.values(AI_CAPABILITIES));
