// Parsing composition root — the single explicit runtime registration point.
//
// Called once during startup. Everything that decides WHICH parser runs lives
// here; nothing else in the application may register or select a provider.
//
// The default is `document-pipeline`: ingestion and routing, layout-aware
// parsing, a conditional OCR pass, native/OCR reconciliation, a structured
// document, evidence-bound extraction, deterministic validation, and a résumé
// proposal. It is the ONLY production path — the heuristic parser it replaced
// has been removed rather than left registered, because a second registered
// provider is a second production system that nobody is watching.

import { registerParser, selectParser, selectedParserName } from './registry.js';
import { pipelineParserProvider } from './pipeline-provider.js';

export const DEFAULT_PARSER_PROVIDER = 'document-pipeline';

/**
 * Register every known provider and select one.
 *
 * Idempotent — safe to call from a server boot and from a test harness.
 *
 * @param {{ provider?: string }} [opts]
 * @returns {string} the selected provider name
 */
export function configureParsing(opts = {}) {
  registerParser(pipelineParserProvider.name, pipelineParserProvider);

  const requested = opts.provider ?? process.env.CV_PARSER_PROVIDER ?? DEFAULT_PARSER_PROVIDER;
  selectParser(requested);
  return selectedParserName();
}
