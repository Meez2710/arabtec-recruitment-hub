// Observability: error tracking (Sentry) + structured request logging.
//
// Design goals:
//   • Zero-config safe: with no SENTRY_DSN set, everything no-ops cleanly — the
//     app runs identically to before. Sentry is an OPTIONAL dependency, imported
//     dynamically, so `npm install` and boot never fail if it isn't present.
//   • One JSON log line per request (method, path, status, ms, requestId, userId)
//     so logs are greppable/queryable in Render and any log aggregator.
//   • Errors are captured to Sentry (when configured) with request context.
import { randomUUID } from 'node:crypto';

let Sentry = null;
let sentryReady = false;

// Initialise Sentry only when a DSN is provided. Dynamic import keeps it optional.
export async function initObservability() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log(JSON.stringify({ level: 'info', msg: 'observability: Sentry disabled (no SENTRY_DSN)' }));
    return;
  }
  try {
    Sentry = await import('@sentry/node');
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
      release: process.env.RENDER_GIT_COMMIT || undefined,
    });
    sentryReady = true;
    console.log(JSON.stringify({ level: 'info', msg: 'observability: Sentry initialised', env: process.env.NODE_ENV }));
  } catch (e) {
    // Missing package or bad DSN must never crash the app.
    console.log(JSON.stringify({ level: 'warn', msg: 'observability: Sentry init skipped', error: String(e && e.message || e) }));
  }
}

// Structured request logger. Assigns a request id, logs one JSON line on finish.
export function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  req.requestId = req.headers['x-request-id'] || randomUUID();
  res.setHeader('x-request-id', req.requestId);
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const line = {
      level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      msg: 'request',
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl ? req.originalUrl.split('?')[0] : req.path, // no query (avoid leaking PII)
      status: res.statusCode,
      ms: Math.round(ms),
      userId: req.user?.id,                  // present after auth middleware
      ip: req.ip,
    };
    console.log(JSON.stringify(line));
  });
  next();
}

// Capture an error to Sentry (if ready) with request context; always safe to call.
export function captureError(err, req) {
  if (!sentryReady || !Sentry) return;
  try {
    Sentry.withScope((scope) => {
      if (req) {
        scope.setTag('requestId', req.requestId);
        scope.setTag('path', req.path);
        if (req.user?.id) scope.setUser({ id: String(req.user.id) });
      }
      Sentry.captureException(err);
    });
  } catch { /* never let telemetry break the request */ }
}
