// Docling Serve transport — the official `docling-serve` container.
//
// SAME ROLE AS `sidecar-client.ts`, DIFFERENT WIRE. It implements
// `DoclingTransport` and returns the identical internal `SidecarDocument`, so
// `DoclingDocumentParser` — the mapping boundary — is unchanged. Everything
// Docling-Serve-shaped stops in this file.
//
// The verified contract is in docs/DOCLING_SERVE_API.md, taken from the running
// image's own /openapi.json. Four things differ from our own sidecar and all
// four are handled here:
//
//   1. Auth is `X-Api-Key`, not `Authorization: Bearer`.
//   2. Upload is multipart, not base64-in-JSON.
//   3. `status` is success/partial_success/failure/skipped plus `errors[]`,
//      not our five-value document vocabulary. §classifyStatus maps it, and
//      that mapping decides DELAYED vs TERMINAL for a CV — see below.
//   4. THERE IS NO `ocrApplied`. Nothing in the response or in the returned
//      DoclingDocument reports whether OCR ran (verified: no key anywhere
//      matches /ocr|confid|recogni|source|method|engine/). So the flag is made
//      correct BY CONSTRUCTION, exactly as the sidecar does it — see
//      `nativeProbe` below.

import type {
  DoclingTransport, FetchLike, SidecarBlock, SidecarDocument, SidecarHealth, SidecarStatus,
} from './sidecar-client.js';
import { SidecarError } from './sidecar-client.js';

/** Live defaults, chosen from measured behaviour rather than the image's own. */
export const SERVE_DEFAULTS = {
  baseUrl: 'http://127.0.0.1:5001',
  timeoutMs: 120_000,
  maxBytes: 25 * 1024 * 1024,
  /** Tesseract: same engine as the local sidecar, so quality is reproduced, not approximated. */
  ocrEngine: 'tesseract',
  ocrLanguages: ['eng'] as readonly string[],
  /**
   * The image's own default is 2.0. Measured: 2.0 and 4.0 recover identical
   * text from our scanned fixture, but 4.0 is what the local sidecar is
   * validated at, and matching it removes a variable from the migration.
   */
  imagesScale: 4,
  /**
   * Native characters below which a PDF is treated as a scan. Same threshold
   * the sidecar uses, so both backends make the same routing decision.
   */
  minNativeChars: 30,
} as const;

/**
 * How many characters of NATIVE text a document already has, or null when that
 * cannot be established locally.
 *
 * This is what keeps `ocrApplied` honest without paying for a second remote
 * conversion. The ATS already has a local text extractor (pdfjs + mammoth); it
 * answers this question from bytes we have in hand, and the answer decides
 * whether the single Docling Serve call asks for OCR. Returning null means
 * "unknown", and the client then behaves conservatively (see `decideOcr`).
 */
export type NativeTextProbe = (input: {
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}) => Promise<number | null>;

export interface ServeOptions {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly ocrEngine?: string;
  readonly ocrLanguages?: readonly string[];
  readonly imagesScale?: number;
  readonly minNativeChars?: number;
  /** Omit and every non-image document is sent with selective OCR enabled. */
  readonly nativeProbe?: NativeTextProbe;
  readonly fetchImpl?: FetchLike;
  /** Pinned image tag, recorded on every proposal. */
  readonly pipelineVersion?: string;
}

/* --------------------------- Docling Serve shapes -------------------------- */
/* Internal. Named after the live OpenAPI so the mapping is checkable by eye.  */

interface ServeProvenance {
  readonly page_no?: number;
  readonly bbox?: {
    readonly l?: number; readonly t?: number; readonly r?: number; readonly b?: number;
    readonly coord_origin?: string;
  };
  readonly charspan?: readonly number[];
}

interface ServeTextItem {
  readonly label?: string;
  readonly text?: string;
  readonly orig?: string;
  readonly level?: number;
  readonly prov?: readonly ServeProvenance[];
}

interface ServeDoclingDocument {
  readonly texts?: readonly ServeTextItem[];
  readonly tables?: readonly ServeTextItem[];
  readonly pages?: Record<string, { readonly size?: { readonly width?: number; readonly height?: number } }>;
}

interface ServeResponse {
  readonly document?: {
    readonly filename?: string;
    readonly md_content?: string | null;
    readonly text_content?: string | null;
    readonly json_content?: ServeDoclingDocument | null;
  };
  readonly status?: string;
  readonly errors?: ReadonlyArray<{
    readonly component_type?: string;
    readonly module_name?: string;
    readonly error_message?: string;
  }>;
  readonly processing_time?: number;
}

/**
 * Docling's own element labels mapped onto the neutral block vocabulary the
 * adapter already understands. Unlisted labels fall through to 'unknown' in the
 * adapter rather than being guessed at here.
 */
const SERVE_LABELS: Record<string, string> = {
  title: 'title',
  section_header: 'section_header',
  paragraph: 'text',
  text: 'text',
  list_item: 'list_item',
  table: 'table',
  caption: 'caption',
  picture: 'picture',
  page_header: 'page_header',
  page_footer: 'page_footer',
};

/**
 * Convert one Docling bounding box into the adapter's `bbox` contract:
 * `[x, y, width, height]` as FRACTIONS of the page, origin TOP-LEFT.
 *
 * Docling reports absolute points with `coord_origin: "BOTTOMLEFT"`, where `t`
 * is the top edge measured up from the bottom. Flipping is therefore
 * `y = (pageHeight - t) / pageHeight`, not `t / pageHeight` — getting this
 * backwards puts every citation on the wrong half of the page.
 */
const toFractionalBox = (
  bbox: ServeProvenance['bbox'],
  page: { width?: number; height?: number } | undefined,
): readonly number[] | undefined => {
  if (bbox === undefined) return undefined;
  const { l, t, r, b } = bbox;
  const w = page?.width;
  const h = page?.height;
  if (l === undefined || t === undefined || r === undefined || b === undefined) return undefined;
  if (w === undefined || h === undefined || w <= 0 || h <= 0) return undefined;

  const top = String(bbox.coord_origin ?? 'BOTTOMLEFT').toUpperCase() === 'TOPLEFT'
    ? Math.min(t, b)
    : h - Math.max(t, b);
  const height = Math.abs(t - b);
  return [l / w, top / h, Math.abs(r - l) / w, height / h];
};

export class DoclingServeClient implements DoclingTransport {
  private readonly baseUrl: string;

  private readonly apiKey: string | undefined;

  private readonly timeoutMs: number;

  private readonly maxBytes: number;

  private readonly ocrEngine: string;

  private readonly ocrLanguages: readonly string[];

  private readonly imagesScale: number;

  private readonly minNativeChars: number;

  private readonly nativeProbe: NativeTextProbe | undefined;

  private readonly pipelineVersion: string | undefined;

  private readonly fetchImpl: FetchLike;

  constructor(opts: ServeOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? SERVE_DEFAULTS.baseUrl).replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? SERVE_DEFAULTS.timeoutMs;
    this.maxBytes = opts.maxBytes ?? SERVE_DEFAULTS.maxBytes;
    this.ocrEngine = opts.ocrEngine ?? SERVE_DEFAULTS.ocrEngine;
    this.ocrLanguages = opts.ocrLanguages ?? SERVE_DEFAULTS.ocrLanguages;
    this.imagesScale = opts.imagesScale ?? SERVE_DEFAULTS.imagesScale;
    this.minNativeChars = opts.minNativeChars ?? SERVE_DEFAULTS.minNativeChars;
    this.nativeProbe = opts.nativeProbe;
    this.pipelineVersion = opts.pipelineVersion;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  /**
   * `GET /health` — unauthenticated on this image, and it answers only
   * `{"status":"ok"}`. It reports no Docling version and no OCR engine, so the
   * fields the sidecar fills in are reported honestly as unknown rather than
   * invented. `GET /version` exists but is not on the readiness path.
   */
  async health(): Promise<SidecarHealth> {
    const body = await this.request('/health', { method: 'GET' });
    const h = body as { status?: string };
    return {
      ok: h.status === 'ok',
      doclingVersion: 'unknown',
      modelsPresent: h.status === 'ok',
      ocrEngine: this.ocrEngine,
    };
  }

  /**
   * Decide, before spending a request, whether this document needs OCR.
   *
   * Images are pixels by definition. Everything else is asked of the local
   * probe: enough native text means no OCR pass, and the flag is false with
   * the same confidence the sidecar's native-first routing gives it. With no
   * probe, or an inconclusive one, selective OCR is requested and the flag is
   * reported as unknown rather than guessed — `undefined` travels up as "not
   * asserted", which the pipeline treats as no OCR claim.
   */
  private async decideOcr(input: {
    readonly filename: string; readonly mimeType: string; readonly bytes: Uint8Array;
  }): Promise<{ force: boolean; ocrApplied: boolean | undefined }> {
    if (input.mimeType.startsWith('image/')) return { force: true, ocrApplied: true };
    if (this.nativeProbe === undefined) return { force: false, ocrApplied: undefined };
    let native: number | null;
    try {
      native = await this.nativeProbe(input);
    } catch {
      // A probe failure must never cost a conversion.
      return { force: false, ocrApplied: undefined };
    }
    if (native === null) return { force: false, ocrApplied: undefined };
    return native >= this.minNativeChars
      ? { force: false, ocrApplied: false }
      : { force: true, ocrApplied: true };
  }

  async convert(input: {
    readonly filename: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }): Promise<SidecarDocument> {
    if (input.bytes.byteLength > this.maxBytes) {
      throw new SidecarError(
        `Document exceeds the ${this.maxBytes}-byte limit.`, false, 'too-large',
      );
    }

    const { force, ocrApplied } = await this.decideOcr(input);

    const form = new FormData();
    form.append('files', new Blob([input.bytes], { type: input.mimeType }), input.filename);
    // json is not optional for us: `texts[].prov[].page_no` is the only source
    // of real page attribution, and md alone would put every block on page 1.
    form.append('to_formats', 'md');
    form.append('to_formats', 'json');
    form.append('ocr_engine', this.ocrEngine);
    for (const lang of this.ocrLanguages) form.append('ocr_lang', lang);
    form.append('do_ocr', 'true');
    form.append('force_ocr', String(force));
    form.append('images_scale', String(this.imagesScale));
    // The image defaults this to true and embeds a base64 raster of every page:
    // a 1 KB PDF came back as 91 KB of images the ATS never reads.
    form.append('include_images', 'false');
    // The image's own default is 7 days. An explicit ceiling means a stuck
    // document fails while someone is still waiting for it.
    form.append('document_timeout', String(Math.floor(this.timeoutMs / 1000)));

    const body = await this.request('/v1/convert/file', { method: 'POST', form });
    return this.toSidecarDocument(body, ocrApplied);
  }

  /**
   * Map Docling Serve's vocabulary onto ours.
   *
   * THE LOAD-BEARING PART. `permanent` upstream is derived from this status, so
   * a misclassification either discards a recoverable CV or retries a hopeless
   * one forever. The rule: anything the SERVICE failed at is a protocol/server
   * fault (thrown, retryable); anything the DOCUMENT failed at is a rejection
   * (returned, terminal).
   */
  private classifyStatus(res: ServeResponse): SidecarStatus {
    const status = String(res.status ?? '').toLowerCase();
    const text = (res.document?.md_content ?? res.document?.text_content ?? '').trim();
    const messages = (res.errors ?? [])
      .map((e) => `${e.component_type ?? ''} ${e.error_message ?? ''}`.toLowerCase())
      .join(' | ');

    if (status === 'failure' || status === 'skipped') {
      if (/password|encrypt/.test(messages)) return 'encrypted';
      if (/unsupported|not supported|format/.test(messages)) return 'unsupported';
      return 'corrupt';
    }
    // success / partial_success with nothing in it is an empty document, not a
    // service failure — retrying re-reads the same bytes.
    if (text === '') return 'empty';
    return 'ok';
  }

  /** Docling `texts[]` → the adapter's block shape, with real page numbers. */
  private toBlocks(doc: ServeDoclingDocument | null | undefined, ocr: boolean): SidecarBlock[] | undefined {
    const texts = doc?.texts;
    if (texts === undefined || texts.length === 0) return undefined;
    const blocks: SidecarBlock[] = [];
    for (const item of texts) {
      const text = (item.text ?? item.orig ?? '').trim();
      if (text === '') continue;
      const prov = item.prov?.[0];
      const page = prov?.page_no ?? 1;
      const size = doc?.pages?.[String(page)]?.size;
      const bbox = toFractionalBox(prov?.bbox, size);
      blocks.push({
        page,
        kind: SERVE_LABELS[String(item.label ?? '').toLowerCase()] ?? String(item.label ?? ''),
        text,
        ocr,
        ...(item.level !== undefined ? { level: item.level } : {}),
        ...(bbox !== undefined ? { bbox } : {}),
      });
    }
    return blocks.length === 0 ? undefined : blocks;
  }

  private toSidecarDocument(body: unknown, ocrApplied: boolean | undefined): SidecarDocument {
    if (typeof body !== 'object' || body === null) {
      throw new SidecarError('Docling Serve returned a non-object body.', true, 'protocol');
    }
    const res = body as ServeResponse;
    if (res.status === undefined) {
      throw new SidecarError('Docling Serve returned no status.', true, 'protocol');
    }

    const status = this.classifyStatus(res);
    if (status !== 'ok') {
      const reason = (res.errors ?? [])[0]?.error_message;
      return {
        status,
        ...(reason !== undefined ? { reason } : {}),
        ...(this.pipelineVersion !== undefined ? { pipelineVersion: this.pipelineVersion } : {}),
      };
    }

    const markdown = res.document?.md_content ?? undefined;
    const text = (res.document?.text_content ?? markdown ?? '');
    const json = res.document?.json_content ?? null;
    const blocks = this.toBlocks(json, ocrApplied === true);
    const pageCount = json?.pages === undefined ? undefined : Object.keys(json.pages).length;

    return {
      status: 'ok',
      ...(markdown !== undefined ? { markdown } : {}),
      text,
      ...(blocks !== undefined ? { blocks } : {}),
      ...(pageCount !== undefined && pageCount > 0 ? { pageCount } : {}),
      // Only asserted when the routing decision established it. Absent means
      // "not asserted" — never a silent false, which would make a scanned CV
      // indistinguishable from a digital one.
      ...(ocrApplied !== undefined ? { ocrApplied } : {}),
      ...(ocrApplied === true ? { ocrEngine: this.ocrEngine } : {}),
      ...(this.pipelineVersion !== undefined ? { pipelineVersion: this.pipelineVersion } : {}),
    };
  }

  private async request(
    path: string, opts: { method: string; form?: FormData },
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: opts.method,
        headers: {
          // Never logged: this client records status codes and durations only.
          ...(this.apiKey !== undefined && this.apiKey !== '' ? { 'X-Api-Key': this.apiKey } : {}),
        },
        // FormData sets its own multipart boundary; a manual content-type breaks it.
        body: opts.form,
        signal: controller.signal,
      });
      if (!res.ok) {
        // 401/403 is a configuration fault, and retrying an unauthenticated
        // request forever helps nobody — but it is the environment, not the
        // document, so it must not discard the CV.
        const retryable = res.status >= 500 || res.status === 401 || res.status === 403
          || res.status === 404 || res.status === 429;
        throw new SidecarError(`Docling Serve responded ${res.status}.`, retryable, 'server');
      }
      return await res.json();
    } catch (error) {
      if (error instanceof SidecarError) throw error;
      const name = (error as { name?: string }).name;
      if (name === 'AbortError' || name === 'TimeoutError') {
        throw new SidecarError(`Docling Serve timed out after ${this.timeoutMs} ms.`, true, 'timeout');
      }
      throw new SidecarError(
        `Docling Serve unreachable: ${(error as Error).message}`, true, 'unavailable',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
