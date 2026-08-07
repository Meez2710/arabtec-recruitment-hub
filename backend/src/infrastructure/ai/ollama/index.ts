// Ollama adapter — public surface.
//
// Only the extractor, its options and the pinned versions escape. The client,
// its error type and every Ollama-shaped payload stay inside this folder.

export { OllamaResumeExtractor, PROMPT_VERSION } from './ollama-resume-extractor.js';
export type { OllamaExtractorOptions } from './ollama-resume-extractor.js';
export { SCHEMA_VERSION } from './resume-schema.js';
export { OLLAMA_DEFAULTS } from './ollama-client.js';
