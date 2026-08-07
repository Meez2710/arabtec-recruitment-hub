// Parser provider registry — the ONE place a CV parsing provider is chosen.
//
// Before this existed, `routes/candidates.js` imported the heuristic parser
// statically, so the live endpoint was welded to one implementation and there
// was no seam to swap it. Provider selection now happens in exactly one place
// (see ./composition.js) and the route resolves through `getParser()`.
//
// DELIBERATE NON-FEATURES:
//   - No fallback chain. Exactly one provider serves a request. A silent
//     fallback would keep two production systems alive and hide failures.
//   - No fan-out. The route calls the selected provider and nothing else.
//   - No auto-registration. An unconfigured registry throws rather than
//     guessing, because guessing is how a deployment quietly runs the wrong
//     parser.

/**
 * A parsing provider.
 *
 * Both methods take an absolute path and are expected to be pure with respect
 * to the file: the same bytes produce the same result. Shapes are the ones the
 * existing endpoint already returns — this interface documents the current
 * contract, it does not redesign it.
 *
 * @typedef {object} ParserProvider
 * @property {string} name
 * @property {(filePath: string) => Promise<object>} parseLegacy
 *   Legacy flat shape: { full_name, email, phone, years_experience,
 *   role_applied, raw_text, extraction_status }.
 * @property {(filePath: string) => Promise<object>} parseEntities
 *   Rich grouped shape: { personal, employment, education, metadata }.
 */

/** @type {Map<string, ParserProvider>} */
const providers = new Map();

/** @type {string | null} */
let selected = null;

/**
 * @param {string} name
 * @param {ParserProvider} provider
 */
export function registerParser(name, provider) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('registerParser: name is required.');
  }
  if (!provider || typeof provider.parseLegacy !== 'function'
      || typeof provider.parseEntities !== 'function') {
    throw new Error(`registerParser: provider "${name}" must implement parseLegacy and parseEntities.`);
  }
  providers.set(name, provider);
}

/**
 * Select the provider that serves every request from now on.
 * @param {string} name
 */
export function selectParser(name) {
  if (!providers.has(name)) {
    const known = [...providers.keys()].join(', ') || '(none registered)';
    throw new Error(`selectParser: unknown provider "${name}". Registered: ${known}.`);
  }
  selected = name;
}

/**
 * Resolve the active provider.
 *
 * Throws when unconfigured. That is intentional: a missing registration is a
 * deployment defect and should surface at the first parse, not degrade into
 * whichever implementation happened to be imported.
 *
 * @returns {ParserProvider}
 */
export function getParser() {
  if (selected === null) {
    throw new Error(
      'No CV parser provider selected. Call configureParsing() during startup '
      + '(see src/lib/parsing/composition.js).',
    );
  }
  const provider = providers.get(selected);
  if (!provider) throw new Error(`Selected provider "${selected}" is no longer registered.`);
  return provider;
}

/** Name of the active provider, or null. For health/diagnostics only. */
export function selectedParserName() {
  return selected;
}

/** Test-only. Restores the registry to its initial empty state. */
export function resetParserRegistry() {
  providers.clear();
  selected = null;
}
