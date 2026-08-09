// The ONLY outbound AI call in the ATS.
//
// Everything about the private AI runtime stops here: the URL, the token, the
// wire format, the timeout. Above this file the application knows only
// "capability succeeded / abstained / the environment failed".
//
// WHY A GATEWAY AND NOT TWO DIRECT CLIENTS. Docling and Ollama both speak
// unauthenticated HTTP and are designed to be reached over loopback — the
// Ollama adapter enforces that with `assertLocalHost`, which is a real privacy
// guarantee about candidates' CVs. Reaching them across the internet would mean
// weakening exactly that check. So they stay loopback-internal to the pod and a
// single authenticated gateway fronts them. Port 11434 is never published.
//
// WHY THE BROWSER CAN NEVER REACH IT. The token lives in server environment
// only, and no route proxies an arbitrary path through to the gateway. The UI
// talks to /api/ai/intake/*, which accepts a file and returns a task id — there
// is no endpoint whose parameters can be steered at the AI service.
//
// NO SILENT FALLBACK. One gateway. If it is unreachable the task fails with
// AI_UNAVAILABLE and the recruiter is told to enter the candidate manually.
// Nothing reaches for a hosted provider and nothing quietly downgrades to the
// legacy heuristic parser.

import { aiConfig } from './config.js';
import { AI_ERROR, AiIntakeError } from './errors.js';

/** Injected in tests. Never used to reach a second provider. */
let fetchImpl = null;
export function __setGatewayFetchForTest(fn) { fetchImpl = fn; }
const doFetch = (...args) => (fetchImpl || globalThis.fetch)(...args);

/**
 * Map a transport outcome onto a domain error.
 *
 * The distinction that matters is DOCUMENT vs ENVIRONMENT, because it decides
 * whether a CV is lost or merely delayed. A 4xx is the gateway rejecting this
 * request; a 5xx, a refused connection or an abort is the environment.
 */
function classify(status) {
  if (status === 408 || status === 504) return new AiIntakeError(AI_ERROR.TIMEOUT, { permanent: false });
  if (status === 413) return new AiIntakeError(AI_ERROR.FILE_TOO_LARGE, { permanent: true });
  if (status === 415) return new AiIntakeError(AI_ERROR.UNSUPPORTED_TYPE, { permanent: true });
  if (status === 401 || status === 403) return new AiIntakeError(AI_ERROR.NOT_CONFIGURED, { permanent: true });
  if (status >= 500) return new AiIntakeError(AI_ERROR.UNAVAILABLE, { permanent: false });
  return new AiIntakeError(AI_ERROR.INTERNAL, { permanent: false });
}

async function call(path, { method = 'POST', body, signal, timeoutMs }) {
  const cfg = aiConfig();
  if (cfg.gatewayUrl === '' || cfg.token === '') {
    throw new AiIntakeError(AI_ERROR.NOT_CONFIGURED, { permanent: true });
  }

  // Own deadline, chained to the caller's signal. The runner also races the
  // whole handler; this is the one that actually releases the socket.
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? cfg.timeoutMs);

  let res;
  try {
    res = await doFetch(cfg.gatewayUrl.replace(/\/+$/, '') + path, {
      method,
      headers: {
        // Backend-only credential. Never sent to, or readable by, a browser.
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    // An abort is either our timeout or the caller cancelling. Both are
    // environment outcomes, never a verdict on the document.
    if (err?.name === 'AbortError') {
      throw new AiIntakeError(signal?.aborted ? AI_ERROR.CANCELLED : AI_ERROR.TIMEOUT, { permanent: false });
    }
    throw new AiIntakeError(AI_ERROR.UNAVAILABLE, { permanent: false });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  if (!res.ok) throw classify(res.status);

  try {
    return await res.json();
  } catch {
    // A gateway that answers 200 with something other than JSON is broken, not
    // a document problem.
    throw new AiIntakeError(AI_ERROR.UNAVAILABLE, { permanent: false });
  }
}

/**
 * Readiness and version report. Cheap, unauthenticated-safe to expose upward
 * as a summary — the route strips anything that is not a version string.
 */
export function gatewayHealth({ signal, timeoutMs = 5000 } = {}) {
  return call('/health', { method: 'GET', signal, timeoutMs });
}

/**
 * The one capability this MVP uses: bytes in, structured proposal out.
 *
 * The gateway runs Docling (with an OCR rescue when native text is poor) and
 * then the local model, and returns both the document quality report and the
 * validated extraction. Doing it in ONE call keeps the CV bytes on the wire
 * once rather than twice, and means the pod never has to hold document state
 * between requests.
 *
 * @param {{bytes: Buffer, filename: string, mimeType: string, maxPages: number}} doc
 */
export function gatewayParseResume(doc, { signal, timeoutMs } = {}) {
  return call('/v1/resume/parse', {
    body: {
      filename: doc.filename,
      mimeType: doc.mimeType,
      maxPages: doc.maxPages,
      // base64 rather than multipart: one content type on the wire, and no
      // multipart parser inside the gateway to harden.
      contentBase64: Buffer.from(doc.bytes).toString('base64'),
    },
    signal,
    timeoutMs,
  });
}
