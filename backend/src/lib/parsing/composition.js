// Parsing composition root — the single explicit runtime registration point.
//
// Called once during startup. Everything that decides WHICH parser runs lives
// here; nothing else in the application may register or select a provider.
//
// The default is `legacy`, deliberately: this phase adds the seam without
// changing production behaviour. Switching to the Docling/Qwen pipeline is a
// configuration change here, made only after the benchmark gate passes.

import { registerParser, selectParser, selectedParserName } from './registry.js';
import { legacyParserProvider } from './legacy-provider.js';

export const DEFAULT_PARSER_PROVIDER = 'legacy';

/**
 * Register every known provider and select one.
 *
 * Idempotent — safe to call from a server boot and from a test harness.
 *
 * @param {{ provider?: string }} [opts]
 * @returns {string} the selected provider name
 */
export function configureParsing(opts = {}) {
  registerParser(legacyParserProvider.name, legacyParserProvider);

  // The new pipeline is NOT registered yet. Its adapters live in the
  // TypeScript tree and are not wired into this runtime until they have passed
  // the benchmark gate. Registering an unproven provider here — even unselected
  // — would invite it being switched on without evidence.

  const requested = opts.provider ?? process.env.CV_PARSER_PROVIDER ?? DEFAULT_PARSER_PROVIDER;
  selectParser(requested);
  return selectedParserName();
}
