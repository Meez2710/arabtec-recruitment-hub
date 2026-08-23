// The one place an Anthropic client is constructed.
//
// WHY A SHARED MODULE. Two capabilities call Claude — reading the document and
// extracting the resume — and both must agree on the model, the key and the
// timeout. Constructing a client per adapter is how a deployment ends up
// running two different models and cannot explain which one produced a value.
//
// THE KEY IS READ FROM THE ENVIRONMENT AND NEVER LOGGED. `describe()` returns
// the model id only, because the model id is provenance and the key is not.

import Anthropic from '@anthropic-ai/sdk';

/** Default model. Override per deployment with ANTHROPIC_MODEL. */
export const DEFAULT_MODEL = 'claude-opus-5';

/** Bumped whenever a prompt below changes. Recorded on every proposal. */
export const PROMPT_VERSION = 'arabtec-cv-2026-08-23';

export interface ClaudeConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
}

const int = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Read the configuration, or `undefined` when this deployment has no key.
 *
 * Absent is a COMPLETE configuration, not a broken one: the composition root
 * simply wires no parser, and the intake route reports that plainly instead of
 * pretending to have read a CV.
 */
export const claudeConfigFrom = (env: NodeJS.ProcessEnv): ClaudeConfig | undefined => {
  const apiKey = String(env['ANTHROPIC_API_KEY'] ?? '').trim();
  if (apiKey === '') return undefined;
  return {
    apiKey,
    model: String(env['ANTHROPIC_MODEL'] ?? '').trim() || DEFAULT_MODEL,
    // A scanned multi-page CV is a vision read; 30s is not generous enough.
    timeoutMs: int(env['ANTHROPIC_TIMEOUT_MS'], 120_000),
    maxRetries: int(env['ANTHROPIC_MAX_RETRIES'], 2),
  };
};

export const clientFor = (config: ClaudeConfig): Anthropic => new Anthropic({
  apiKey: config.apiKey,
  timeout: config.timeoutMs,
  maxRetries: config.maxRetries,
});

/**
 * Join every text block of a response.
 *
 * Thinking blocks are skipped deliberately: reasoning is not the answer, and
 * concatenating it into a transcription corrupts the document.
 */
export const textOf = (message: Anthropic.Message): string => message.content
  .filter((block): block is Anthropic.TextBlock => block.type === 'text')
  .map((block) => block.text)
  .join('')
  .trim();
