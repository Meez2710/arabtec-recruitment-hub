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

/* ------------------------------- effort ---------------------------------- */

export type Effort = 'low' | 'medium' | 'high';

/**
 * Does this model accept `output_config.effort`?
 *
 * EFFORT IS NOT UNIVERSAL, and getting this wrong is total rather than partial.
 * Haiku 4.5 and Sonnet 4.5 reject it outright:
 *
 *   400 invalid_request_error — This model does not support the effort parameter.
 *
 * `ANTHROPIC_MODEL` is operator-set, and `deploy/on-prem/ats.env.template`
 * recommends `claude-haiku-4-5-20251001` for bulk inbox scans — so the
 * documented cheap configuration failed on EVERY call. Because the adapters
 * classify a transport failure as temporary, each CV was recorded retryable and
 * retried forever, and nothing ever reached the review queue. Verified against
 * the live host on 10 Sep 2026: three fixtures, three identical 400s, zero
 * fields extracted.
 *
 * EXCLUDING KNOWN-UNSUPPORTED FAMILIES, not allow-listing supported ones. A
 * model released after this line is written should get effort by default; if it
 * turns out not to accept it, `retryWithoutEffort` below recovers on the spot
 * rather than failing every document until someone edits this list.
 */
export const supportsEffort = (model: string): boolean => {
  const m = String(model || '').toLowerCase();
  if (m.includes('haiku')) return false;
  if (/sonnet-4-5|sonnet-3|opus-3|claude-2/.test(m)) return false;
  return true;
};

/**
 * `output_config` for a model, carrying `effort` only where it is accepted.
 *
 * Returns `undefined` when there would be nothing in it — an empty
 * `output_config` is noise on the wire and in a request log.
 */
export const outputConfigFor = (
  model: string,
  effort: Effort,
  extra?: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  const config: Record<string, unknown> = { ...(extra ?? {}) };
  if (supportsEffort(model)) config['effort'] = effort;
  return Object.keys(config).length > 0 ? config : undefined;
};

/** Exactly the 400 that says this model will not take `effort`. */
const isEffortRejection = (error: unknown): boolean => {
  const status = (error as { status?: number } | null)?.status;
  const text = error instanceof Error ? error.message : String(error);
  return status === 400 && /does not support the effort parameter/i.test(text);
};

/**
 * Send a request; if the model turns out to reject `effort`, drop it and send
 * once more.
 *
 * The safety net behind `supportsEffort`. A model Anthropic ships next year that
 * happens not to take effort would otherwise break every parse until this file
 * is edited — and the failure mode there is silent accumulation of retryable
 * CVs, not a loud crash, which is the worst kind. One retry, same request minus
 * one field, and the deployment keeps working.
 */
export async function createWithEffortFallback(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message> {
  try {
    return await client.messages.create(params);
  } catch (error) {
    if (!isEffortRejection(error)) throw error;
    const outputConfig = { ...(params as { output_config?: Record<string, unknown> }).output_config };
    delete outputConfig['effort'];
    const retry = { ...params } as Record<string, unknown>;
    if (Object.keys(outputConfig).length > 0) retry['output_config'] = outputConfig;
    else delete retry['output_config'];
    console.log(JSON.stringify({
      level: 'warn', msg: 'anthropic.effort_unsupported',
      model: params.model, detail: 'retried without output_config.effort',
    }));
    return client.messages.create(retry as unknown as Anthropic.MessageCreateParamsNonStreaming);
  }
}

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
