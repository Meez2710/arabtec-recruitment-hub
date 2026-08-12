// OcrEngine over HTTP. PROVIDER-NEUTRAL BY CONSTRUCTION.
//
// PaddleOCR, OpenOCR and most self-hosted engines are wrapped in a small HTTP
// service. This client speaks a minimal request shape and accepts the two
// response shapes those services actually return, so switching engine is a base
// URL and a name in the composition root — no change anywhere else in the
// document pipeline.
//
// WHAT IT DOES NOT DO
//   - It does not name a vendor in any type that leaves this file.
//   - It does not throw. A failed page becomes an outcome with `permanent`,
//     because losing one page's pixels must not lose the other nine pages.
//   - It does not retry internally. Retry policy belongs to the task worker
//     that owns the CV, not to a per-page client.

import type {
  OcrEngine, OcrLine, OcrPageOutcome, OcrPageRequest, LayoutBox,
} from '../../../modules/shared/kernel/ai/index.js';

/** Minimal fetch shape, so tests inject a stub without a network. */
export type OcrFetch = (
  url: string,
  init: {
    method: string;
    body: string;
    signal: AbortSignal;
    headers?: Record<string, string>;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface HttpOcrOptions {
  /** Loopback or a private network. Never a public host. */
  readonly baseUrl: string;
  /** Recorded in provenance, e.g. 'paddleocr' or 'openocr'. */
  readonly engineName: string;
  readonly engineVersion?: string;
  /** Path appended to `baseUrl`. Defaults to the common `/ocr`. */
  readonly path?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: OcrFetch;
}

const DEFAULT_TIMEOUT_MS = 60_000;

const asNumber = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
);

/** Accept a box as either an object or a 4-number array. Absent is fine. */
const readBox = (value: unknown): LayoutBox | undefined => {
  if (Array.isArray(value) && value.length >= 4) {
    const [x, y, width, height] = value.map((v) => asNumber(v));
    if (x === undefined || y === undefined || width === undefined || height === undefined) {
      return undefined;
    }
    return { x, y, width, height };
  }
  if (typeof value === 'object' && value !== null) {
    const box = value as Record<string, unknown>;
    const x = asNumber(box['x']);
    const y = asNumber(box['y']);
    const width = asNumber(box['width']);
    const height = asNumber(box['height']);
    if (x === undefined || y === undefined || width === undefined || height === undefined) {
      return undefined;
    }
    return { x, y, width, height };
  }
  return undefined;
};

/**
 * Read the lines out of whichever response shape the engine returned.
 *
 * Two shapes are supported deliberately, not open-endedly: `lines` (the shape
 * this contract asks for) and `results` (what several Paddle-derived servers
 * emit). Anything else yields no lines and the caller falls back to `text`.
 */
const readLines = (body: Record<string, unknown>): OcrLine[] => {
  const source = Array.isArray(body['lines']) ? body['lines']
    : Array.isArray(body['results']) ? body['results']
      : [];

  const lines: OcrLine[] = [];
  for (const entry of source) {
    if (typeof entry === 'string') {
      if (entry.trim() !== '') lines.push({ text: entry });
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const text = typeof row['text'] === 'string' ? row['text'] : '';
    if (text.trim() === '') continue;
    const box = readBox(row['box'] ?? row['bbox']);
    const confidence = asNumber(row['confidence'] ?? row['score']);
    lines.push({
      text,
      ...(box !== undefined ? { box } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
    });
  }
  return lines;
};

export class HttpOcrEngine implements OcrEngine {
  readonly name: string;

  readonly version: string | undefined;

  private readonly baseUrl: string;

  private readonly path: string;

  private readonly timeoutMs: number;

  private readonly fetchImpl: OcrFetch;

  constructor(opts: HttpOcrOptions) {
    this.name = opts.engineName;
    this.version = opts.engineVersion;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.path = opts.path ?? '/ocr';
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as OcrFetch);
  }

  async recognize(request: OcrPageRequest): Promise<OcrPageOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${this.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          imageBase64: Buffer.from(request.imageBytes).toString('base64'),
          mimeType: request.mimeType,
          languages: request.languageHints ?? [],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // 5xx is the engine failing and worth retrying; 4xx means it refused
        // this image and a retry sends the identical bytes to the identical
        // refusal.
        return {
          ok: false,
          reason: `OCR engine responded ${response.status}.`,
          permanent: response.status < 500,
        };
      }

      const body = await response.json();
      if (typeof body !== 'object' || body === null) {
        return { ok: false, reason: 'OCR engine returned a non-object body.', permanent: false };
      }
      const payload = body as Record<string, unknown>;
      const lines = readLines(payload);
      const text = typeof payload['text'] === 'string' && payload['text'].trim() !== ''
        ? payload['text']
        : lines.map((l) => l.text).join('\n');

      if (text.trim() === '') {
        // PERMANENT: the engine read the pixels and found no text. Retrying
        // re-reads the same pixels.
        return { ok: false, reason: 'The OCR engine found no text on this page.', permanent: true };
      }

      const scored = lines.filter((l) => l.confidence !== undefined);
      const confidence = scored.length > 0
        ? scored.reduce((sum, l) => sum + (l.confidence ?? 0), 0) / scored.length
        : asNumber(payload['confidence']);

      return {
        ok: true,
        result: {
          page: request.page,
          text,
          lines,
          engine: this.name,
          ...(confidence !== undefined ? { confidence } : {}),
        },
      };
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'AbortError' || name === 'TimeoutError') {
        return { ok: false, reason: `OCR engine timed out after ${this.timeoutMs} ms.`, permanent: false };
      }
      return {
        ok: false,
        reason: `OCR engine unreachable: ${(error as Error).message}`,
        permanent: false,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
