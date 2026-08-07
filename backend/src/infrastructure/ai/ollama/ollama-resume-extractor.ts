// ResumeExtractor backed by a local Ollama runtime.
//
// The mapping boundary for inference. Ollama-shaped types stop here; what
// leaves is `AIOutcome<ExtractedResume>`, so nothing above this file knows which
// model read the CV — which is what makes Qwen → Granite → Llama a
// composition-root change.
//
// WHAT THIS DOES NOT DO
//   - It does not fall back to another extractor. A silent fallback would hide
//     an outage and keep a second extraction system alive.
//   - It does not repair prose into JSON beyond locating the outermost object.
//     Coaxing a malformed answer into a valid one is how invented values reach
//     a candidate record.
//   - It does not fill a field the CV did not support. Absent stays absent;
//     `resume-schema.ts` collapses filler to undefined for exactly that reason.

import type {
  AIOutcome, ExtractedResume, ParsedDocument, ResumeExtractor,
} from '../../../modules/shared/kernel/ai/index.js';
import { AI_CAPABILITIES } from '../../../modules/shared/kernel/ai/index.js';
import type { ModelInfo, OllamaOptions } from './ollama-client.js';
import { OllamaClient, OllamaError } from './ollama-client.js';
import { RESUME_JSON_SCHEMA, SCHEMA_VERSION, validateResume } from './resume-schema.js';

export const PROMPT_VERSION = 'resume-extract-prompt/1.0.0';

const SYSTEM_PROMPT = [
  'You extract structured data from a candidate CV. You are a reader, not an author.',
  '',
  'RULES',
  '1. Return ONLY a JSON object matching the provided schema. No prose, no markdown fence.',
  '2. Copy values from the CV. Never infer, complete, translate, or correct them.',
  '3. If the CV does not state a value, omit the field or use null. Never guess.',
  '4. Preserve the original script. Arabic names stay in Arabic.',
  '5. Copy phone numbers and emails exactly as written, including their digits.',
  '6. List every field you were unsure about by name in "uncertainFields".',
  '',
  'Inventing a plausible value is the worst possible outcome. Omission is correct.',
].join('\n');

/**
 * Rough token estimate for the pre-flight size check.
 *
 * Deliberately pessimistic: Arabic and mixed scripts tokenize far less
 * efficiently than English, and an optimistic estimate here means discovering
 * the overflow after paying for the inference.
 */
const estimateTokens = (text: string): number => Math.ceil(text.length / 2.5);

/** Locate the outermost JSON object. Nothing more forgiving than that. */
const extractJsonObject = (raw: string): unknown => {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
};

export interface OllamaExtractorOptions extends OllamaOptions {
  /** Reserved for the answer. The rest of the window is the document budget. */
  readonly maxOutputTokens?: number;
}

export class OllamaResumeExtractor implements ResumeExtractor {
  /** Adapter revision + the pinned prompt and schema. See ResumeExtractor.version. */
  readonly version = `ollama-extractor/1.0.0+${PROMPT_VERSION}+${SCHEMA_VERSION}`;

  private readonly client: OllamaClient;

  private readonly maxOutputTokens: number;

  /** Resolved once and cached; the pinned tag does not change at runtime. */
  private cachedModel: ModelInfo | null = null;

  constructor(opts: OllamaExtractorOptions) {
    this.client = new OllamaClient(opts);
    this.maxOutputTokens = opts.maxOutputTokens ?? 1536;
  }

  async extract(document: ParsedDocument): Promise<AIOutcome<ExtractedResume>> {
    const model = await this.resolveModel();
    const provenance = {
      capability: AI_CAPABILITIES.RESUME_EXTRACT,
      modelId: model.model,
      promptVersionId: PROMPT_VERSION,
      producedAt: new Date(),
      ...(model.digest !== null ? { modelDigest: model.digest } : {}),
    };

    // Markdown when the parser recovered structure, plain text otherwise. A
    // model reading real headings does not have to guess where sections begin.
    const body = document.markdown ?? document.text;
    if (body.trim() === '') {
      return {
        abstained: true, reason: 'The parsed document contained no text.',
        permanent: true, provenance,
      };
    }

    const budget = this.client.contextSize - this.maxOutputTokens;
    if (estimateTokens(body) > budget) {
      // PERMANENT: the same document will not fit next time either. Truncating
      // would silently drop the end of a career history.
      return {
        abstained: true,
        reason: `The document is too long for the ${this.client.contextSize}-token context window.`,
        permanent: true,
        provenance,
      };
    }

    let result;
    try {
      result = await this.client.generate({
        system: SYSTEM_PROMPT,
        prompt: body,
        format: RESUME_JSON_SCHEMA,
        maxOutputTokens: this.maxOutputTokens,
      });
    } catch (error) {
      if (error instanceof OllamaError) {
        return {
          abstained: true, reason: error.message, permanent: !error.retryable, provenance,
        };
      }
      return {
        abstained: true,
        reason: `Extraction failed unexpectedly: ${(error as Error).message}`,
        permanent: false,
        provenance,
      };
    }

    const withTiming = { ...provenance, latencyMs: result.latencyMs };

    if (result.truncated) {
      // A cut-off object is not partially correct; it is unparseable or, worse,
      // parseable and missing entries with no marker saying so.
      return {
        abstained: true,
        reason: 'The model response was cut off before it completed.',
        permanent: false,
        provenance: withTiming,
      };
    }

    const json = extractJsonObject(result.text);
    if (json === undefined) {
      return {
        abstained: true,
        reason: 'The model did not return parseable JSON.',
        permanent: false,
        provenance: withTiming,
      };
    }

    const validated = validateResume(json);
    if (!validated.ok) {
      return {
        abstained: true, reason: validated.reason, permanent: false, provenance: withTiming,
      };
    }

    return {
      content: validated.value,
      // A fixed, honest prior. This is NOT a calibrated probability and must
      // never gate a rule — per-field review is what decides what is kept.
      // `uncertainFields` is where real per-field doubt is expressed.
      confidence: 0.7,
      reasoningSummary: `Extracted ${validated.value.employment.length} employment and `
        + `${validated.value.education.length} education entries from `
        + `${document.markdown !== undefined ? 'structured markdown' : 'plain text'}.`,
      sourcesUsed: ['parsed-document'],
      provenance: withTiming,
    };
  }

  private async resolveModel(): Promise<ModelInfo> {
    if (this.cachedModel !== null) return this.cachedModel;
    try {
      this.cachedModel = await this.client.modelInfo();
    } catch {
      // Provenance must never be the reason an extraction fails. A missing
      // digest is recorded as missing; the real failure surfaces on generate().
      this.cachedModel = { model: this.client.model, digest: null, quantization: null };
    }
    return this.cachedModel;
  }
}
