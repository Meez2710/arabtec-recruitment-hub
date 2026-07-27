// CV Parser — public facade.
//
// The implementation now lives in ./cv/ as focused modules:
//   cv/extractor.js          file bytes -> text (pdf-parse, mammoth)
//   cv/section-detector.js   text -> labelled sections
//   cv/entity-parser.js      per-field detection rules
//   cv/normalizer.js         value shaping
//   cv/validator.js          plausibility checks
//   cv/confidence-engine.js  deterministic scoring + parse status
//   cv/ai-parser.js          the ONLY module that can send CV text off-server
//   cv/index.js              orchestration
//
// This file is a thin re-export so existing importers keep working unchanged.
// Behaviour of every export below is identical to the pre-refactor version, with
// one deliberate exception documented on parse().
import path from 'node:path';
import { extractText, extractTextAsync } from './cv/extractor.js';
import { heuristicParse, parseEntities, parseEntitiesFromFile } from './cv/index.js';
import { detectPhone } from './cv/entity-parser.js';
import { aiExtract, isAiEnabled, aiGateStatus } from './cv/ai-parser.js';

export { extractText, extractTextAsync, heuristicParse };
export { parseEntities, parseEntitiesFromFile, isAiEnabled, aiGateStatus };

// Unchanged: returns the raw matched string, not the compacted form.
export function extractPhone(text) {
  return detectPhone(text).value;
}

/**
 * BEHAVIOUR CHANGE (intentional, approved):
 * previously this called Claude whenever ANTHROPIC_API_KEY was set. AI is now
 * off unless CV_AI_PARSING_ENABLED=true AND feature.ai_parsing is enabled AND a
 * key exists AND the caller passes { allowAi: true }. Otherwise heuristic only.
 * No route currently calls this function.
 */
export async function claudeParse(text, filename, opts = {}) {
  const ai = await aiExtract(text, filename, opts);
  if (!ai) return heuristicParse(text, filename);
  return {
    full_name: ai.full_name || heuristicParse(text, filename).full_name,
    email: ai.email || null,
    phone: ai.phone || null,
    years_experience: ai.years_experience || null,
    role_applied: ai.role_applied || null,
    raw_text: text,
    extraction_status: 'done',
  };
}

export async function parse(filePath, opts = {}) {
  const filename = path.basename(filePath);
  const text = await extractTextAsync(filePath);
  if (isAiEnabled(opts)) return claudeParse(text, filename, opts);
  return heuristicParse(text, filename);
}

// Heuristic-only async (used by the CV upload route).
export async function parseHeuristic(filePath) {
  const filename = path.basename(filePath);
  const text = await extractTextAsync(filePath);
  return heuristicParse(text, filename);
}
