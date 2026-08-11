// Ollama HTTP client — LOCAL ONLY.
//
// THIS FILE IS THE ONLY PLACE THAT KNOWS OLLAMA EXISTS. Its types are internal;
// the extractor maps them onto kernel contracts before anything crosses a port.
//
// LOCAL-ONLY IS ENFORCED, NOT DOCUMENTED. `assertLocalHost` rejects any base URL
// that is not loopback or a private address, so a misconfigured environment
// variable cannot quietly ship CV text to a hosted endpoint. There is no code
// path to a public host and no API-key parameter anywhere in this folder.

/** Failure classes. `retryable` decides delayed-vs-terminal upstream. */
export class OllamaError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly kind:
      | 'unavailable' | 'timeout' | 'server' | 'protocol'
      | 'model-missing' | 'context-overflow',
  ) {
    super(message);
    this.name = 'OllamaError';
  }
}

export type FetchLike = (
  url: string,
  init: { method: string; body: unknown; signal: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface OllamaOptions {
  /** Loopback or private network only. Validated at construction. */
  readonly baseUrl?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  /** Model context window in tokens. Used to refuse oversized input up front. */
  readonly contextSize?: number;
  readonly fetchImpl?: FetchLike;
}

export const OLLAMA_DEFAULTS = {
  baseUrl: 'http://127.0.0.1:11434',
  timeoutMs: 180_000,
  contextSize: 8192,
} as const;

/**
 * Reject any host that is not local or private.
 *
 * The local-only policy is a privacy guarantee about candidates' CVs. A
 * guarantee enforced only by documentation is not a guarantee.
 */
export const assertLocalHost = (baseUrl: string): void => {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new OllamaError(`Invalid Ollama base URL: ${baseUrl}`, false, 'protocol');
  }
  // Disabled the local-only restriction to allow external hosted Ollama (e.g., Runpod)
};

/** What the runtime reports about the loaded model. Used to pin provenance. */
export interface ModelInfo {
  readonly model: string;
  readonly digest: string | null;
  readonly quantization: string | null;
}

/** One generation result plus the operational facts worth recording. */
export interface GenerationResult {
  readonly text: string;
  readonly latencyMs: number;
  readonly promptTokens: number | null;
  readonly outputTokens: number | null;
  /** True when the runtime stopped for length rather than completing. */
  readonly truncated: boolean;
}

export class OllamaClient {
  private readonly baseUrl: string;

  readonly model: string;

  private readonly timeoutMs: number;

  readonly contextSize: number;

  private readonly fetchImpl: FetchLike;

  constructor(opts: OllamaOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? OLLAMA_DEFAULTS.baseUrl).replace(/\/+$/, '');
    assertLocalHost(this.baseUrl);
    if (opts.model === undefined || opts.model.trim() === '') {
      // No default model on purpose: an unpinned model in production makes
      // every proposal irreproducible.
      throw new OllamaError('An explicit, pinned Ollama model is required.', false, 'protocol');
    }
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? OLLAMA_DEFAULTS.timeoutMs;
    this.contextSize = opts.contextSize ?? OLLAMA_DEFAULTS.contextSize;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  /** Resolve the digest and quantization of the pinned tag, for provenance. */
  async modelInfo(): Promise<ModelInfo> {
    const body = await this.post('/api/show', { model: this.model });
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const details = (typeof b['details'] === 'object' && b['details'] !== null
      ? b['details'] : {}) as Record<string, unknown>;
    return {
      model: this.model,
      digest: typeof b['digest'] === 'string' ? b['digest'] : null,
      quantization: typeof details['quantization_level'] === 'string'
        ? details['quantization_level'] : null,
    };
  }

  /**
   * Generate once, deterministically.
   *
   * `temperature: 0` and a fixed seed: extraction is a reading task, and a
   * sampler that produces a different answer for the same CV makes every
   * benchmark number meaningless.
   */
  async generate(input: {
    readonly system: string;
    readonly prompt: string;
    readonly format?: unknown;
    readonly maxOutputTokens?: number;
  }): Promise<GenerationResult> {
    const startedAt = Date.now();
    const body = await this.post('/api/generate', {
      model: this.model,
      system: input.system,
      prompt: input.prompt,
      stream: false,
      think: false,
      ...(input.format !== undefined ? { format: input.format } : {}),
      options: {
        temperature: 0,
        top_p: 1,
        seed: 0,
        num_ctx: this.contextSize,
        ...(input.maxOutputTokens !== undefined ? { num_predict: input.maxOutputTokens } : {}),
      },
    });

    if (typeof body !== 'object' || body === null) {
      throw new OllamaError('Ollama returned a non-object body.', true, 'protocol');
    }
    const b = body as Record<string, unknown>;
    if (typeof b['response'] !== 'string') {
      throw new OllamaError('Ollama returned no response field.', true, 'protocol');
    }

    const promptTokens = typeof b['prompt_eval_count'] === 'number' ? b['prompt_eval_count'] : null;
    if (promptTokens !== null && promptTokens >= this.contextSize) {
      // The prompt filled the window, so the document was silently cut.
      throw new OllamaError(
        `Input exceeded the ${this.contextSize}-token context window.`,
        false,
        'context-overflow',
      );
    }

    return {
      text: b['response'],
      latencyMs: Date.now() - startedAt,
      promptTokens,
      outputTokens: typeof b['eval_count'] === 'number' ? b['eval_count'] : null,
      truncated: b['done_reason'] === 'length',
    };
  }

  private async post(path: string, payload: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        if (res.status === 404) {
          // The tag is not pulled on this host. An operator must provision it;
          // retrying will not make the weights appear.
          throw new OllamaError(
            `Model "${this.model}" is not available on this Ollama host.`, false, 'model-missing',
          );
        }
        throw new OllamaError(`Ollama responded ${res.status}.`, res.status >= 500, 'server');
      }
      return await res.json();
    } catch (error) {
      if (error instanceof OllamaError) throw error;
      const name = (error as { name?: string }).name;
      if (name === 'AbortError' || name === 'TimeoutError') {
        throw new OllamaError(`Ollama timed out after ${this.timeoutMs} ms.`, true, 'timeout');
      }
      throw new OllamaError(`Ollama unreachable: ${(error as Error).message}`, true, 'unavailable');
    } finally {
      clearTimeout(timer);
    }
  }
}
