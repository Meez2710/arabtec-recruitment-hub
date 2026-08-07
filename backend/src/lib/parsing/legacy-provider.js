// The legacy heuristic parser, expressed as a ParserProvider.
//
// A pure adapter: it adds no behaviour and changes no output. Both methods
// delegate to the same functions `routes/candidates.js` called directly before
// the seam existed, so selecting this provider reproduces production byte for
// byte. That is what makes it a safe default during migration.

import { parseHeuristic, parseEntitiesFromFile } from '../cv-parser.js';

/** @type {import('./registry.js').ParserProvider} */
export const legacyParserProvider = {
  name: 'legacy',
  parseLegacy: (filePath) => parseHeuristic(filePath),
  parseEntities: (filePath) => parseEntitiesFromFile(filePath),
};
