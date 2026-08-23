// Docling sidecar HTTP client.
//
// THIS FILE IS THE ONLY PLACE THAT KNOWS DOCLING EXISTS. Every type below is
// internal; nothing here is exported past ../docling/index.ts, and the adapter
// maps it onto the neutral `ParsedDocument` before it crosses the port.
//
// Talks to a LOCAL sidecar only. The default base URL is loopback and there is
// no code path that reaches a public host.
//
// The contract it speaks is defined in docs/DOCLING_SIDECAR_API.md and is
// versioned independently of Docling itself, so a Docling upgrade that changes
// its internal document model does not change this contract.

/** How a conversion ended. Mirrors the sidecar's documented status values. */
export type SidecarStatus = 'ok' | 'unsupported' | 'encrypted' | 'corrupt' | 'empty';

/**
 * One layout element, as the sidecar reports it. Internal shape.
 *
 * OPTIONAL in the contract: a sidecar build that predates layout reporting
 * returns only markdown and text, and the adapter recovers structure from the
 * markdown instead. That keeps a sidecar upgrade from being a breaking change
 * in both directions.
 *
 * `bbox` is [x, y, width, height] as FRACTIONS of the page, origin top-left, so
 * it survives a DPI change and stays comparable between runs.
 */
export interface SidecarBlock {
  readonly page?: number;
  readonly kind?: string;
  readonly text?: string;
  readonly level?: number;
  readonly bbox?: readonly number[];
  readonly table?: {
    readonly rowCount?: number;
    readonly columnCount?: number;
    readonly cells?: ReadonlyArray<{
      readonly row?: number;
      readonly column?: number;
      readonly rowSpan?: number;
      readonly columnSpan?: number;
      readonly text?: string;
      readonly header?: boolean;
    }>;
  };
  /** True when this element's text came from the sidecar's own OCR pass. */
  readonly ocr?: boolean;
  readonly confidence?: number;
}

/** A converted document, as the sidecar returns it. Internal shape. */
export interface SidecarDocument {
  readonly status: SidecarStatus;
  /** Structured Markdown. Present only when status is 'ok'. */
  readonly markdown?: string;
  /** Plain text fallback, always present when status is 'ok'. */
  readonly text?: string;
  readonly pages?: readonly string[];
  /** Layout elements in reading order. Absent on older sidecar builds. */
  readonly blocks?: readonly SidecarBlock[];
  /** Which engine recognised the pixels, when the sidecar performed OCR. */
  readonly ocrEngine?: string;
  readonly pageCount?: number;
  readonly detectedLanguages?: readonly string[];
  /** True when an OCR pass ran. Operational signal only. */
  readonly ocrApplied?: boolean;
  /** Human-readable reason when status is not 'ok'. Never contains document text. */
  readonly reason?: string;
  readonly doclingVersion?: string;
  readonly pipelineVersion?: string;
}

export interface SidecarHealth {
  readonly ok: boolean;
  readonly doclingVersion: string;
  readonly modelsPresent: boolean;
  readonly ocrEngine: string | null;
}

/**
 * Failure classes the adapter must distinguish.
 *
 * `retryable` decides whether a CV is DELAYED or the task is terminal, so it is
 * required rather than inferred. Network faults and 5xx are the environment
 * failing; a rejected document is the document failing.
 */
export class SidecarError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly kind: 'unavailable' | 'timeout' | 'server' | 'protocol' | 'too-large',
  ) {
    super(message);
    this.name = 'SidecarError';
  }
}

/** Minimal fetch shape, so tests inject a stub without a network or a library. */
export type FetchLike = (
  url: string,
  init: { method: string; body: unknown; signal: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface SidecarOptions {
  /** Loopback or a private container network. Never a public host. */
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /**
   * Bearer token for a sidecar that is not on loopback.
   *
   * Absent means no Authorization header, which is only safe when the network
   * boundary is doing the work — see docs/DOCLING_SIDECAR_API.md. The moment
   * the sidecar is reachable through a tunnel this must be set.
   */
  readonly bearerToken?: string;
  /** Refuse oversized uploads before spending a request. */
  readonly maxBytes?: number;
  readonly fetchImpl?: FetchLike;
}

export const SIDECAR_DEFAULTS = {
  baseUrl: 'http://127.0.0.1:8089',
  timeoutMs: 120_000,
  maxBytes: 25 * 1024 * 1024,
} as const;

/** The API contract version this client speaks. Bumped with the sidecar. */
export const SIDECAR_API_VERSION = 'v1';

export class DoclingSidecarClient {
  private readonly baseUrl: string;

  private readonly timeoutMs: number;

  private readonly bearerToken: string | undefined;

  private readonly maxBytes: number;

  private readonly fetchImpl: FetchLike;

  constructor(opts: SidecarOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? SIDECAR_DEFAULTS.baseUrl).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? SIDECAR_DEFAULTS.timeoutMs;
    this.bearerToken = opts.bearerToken;
    this.maxBytes = opts.maxBytes ?? SIDECAR_DEFAULTS.maxBytes;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  async health(): Promise<SidecarHealth> {
    const body = await this.request(`/${SIDECAR_API_VERSION}/health`, {});
    const h = body as Partial<SidecarHealth>;
    return {
      ok: h.ok === true,
      doclingVersion: typeof h.doclingVersion === 'string' ? h.doclingVersion : 'unknown',
      modelsPresent: h.modelsPresent === true,
      ocrEngine: typeof h.ocrEngine === 'string' ? h.ocrEngine : null,
    };
  }

  /**
   * Convert one document.
   *
   * The sidecar owns temporary-file creation and cleanup; this client sends
   * bytes and receives a document, so no temporary file exists on the Node side.
   */
  async convert(input: {
    readonly filename: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }): Promise<SidecarDocument> {
    if (input.bytes.byteLength > this.maxBytes) {
      throw new SidecarError(
        `Document exceeds the ${this.maxBytes}-byte limit.`,
        // NOT retryable: the same bytes will be too large next time.
        false,
        'too-large',
      );
    }

    const body = await this.request(`/${SIDECAR_API_VERSION}/convert`, {
      filename: input.filename,
      mimeType: input.mimeType,
      // Base64 rather than multipart: one JSON contract, trivially stubbable,
      // and the size ceiling above bounds the encoding cost.
      contentBase64: Buffer.from(input.bytes).toString('base64'),
    });

    return this.parseDocument(body);
  }

  /** Validates the envelope. A malformed body is a protocol fault, not a document fault. */
  private parseDocument(body: unknown): SidecarDocument {
    if (typeof body !== 'object' || body === null) {
      throw new SidecarError('Sidecar returned a non-object body.', true, 'protocol');
    }
    const d = body as Record<string, unknown>;
    const status = d['status'];
    const valid: readonly SidecarStatus[] = ['ok', 'unsupported', 'encrypted', 'corrupt', 'empty'];
    if (typeof status !== 'string' || !valid.includes(status as SidecarStatus)) {
      throw new SidecarError(`Sidecar returned an unknown status: ${String(status)}`, true, 'protocol');
    }
    if (status === 'ok' && typeof d['text'] !== 'string') {
      throw new SidecarError('Sidecar reported ok without returning text.', true, 'protocol');
    }
    return d as unknown as SidecarDocument;
  }

  private async request(path: string, payload: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Never logged: the client logs status codes and durations, never headers.
          ...(this.bearerToken !== undefined && this.bearerToken !== ''
            ? { authorization: `Bearer ${this.bearerToken}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        // 5xx is the sidecar failing; 4xx means it refused this request and a
        // retry sends the identical bytes to the identical refusal.
        const retryable = res.status >= 500;
        throw new SidecarError(`Sidecar responded ${res.status}.`, retryable, 'server');
      }
      return await res.json();
    } catch (error) {
      if (error instanceof SidecarError) throw error;
      const name = (error as { name?: string }).name;
      if (name === 'AbortError' || name === 'TimeoutError') {
        throw new SidecarError(`Sidecar timed out after ${this.timeoutMs} ms.`, true, 'timeout');
      }
      // Connection refused, DNS, socket reset — the environment, not the file.
      throw new SidecarError(
        `Sidecar unreachable: ${(error as Error).message}`, true, 'unavailable',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
