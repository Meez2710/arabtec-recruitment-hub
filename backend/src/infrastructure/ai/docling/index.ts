// Docling adapter — public surface.
//
// Only the adapter and its options escape. `SidecarDocument`, `SidecarStatus`
// and every other Docling-shaped type stay inside this folder, which is what
// keeps the engine swappable.

export { DoclingDocumentParser } from './docling-document-parser.js';
export type { DoclingParserOptions } from './docling-document-parser.js';
export { SIDECAR_API_VERSION, SIDECAR_DEFAULTS } from './sidecar-client.js';
