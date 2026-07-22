// Security headers middleware (dependency-free equivalent of Helmet).
//
// WHY NOT helmet? The npm dependency is the usual choice, but this codebase is
// deliberately zero-dependency in its infrastructure (see upload.js, db.js), and
// these headers are a small, well-understood set. This module sets the same
// headers Helmet would; it can be swapped for `helmet` later with no behavioural
// change (see docs/SECURITY_HARDENING.md).
//
// Configuration (env vars only — never hard-code):
//   NODE_ENV=production        → enables HSTS + upgrade-insecure-requests
//   HSTS_MAX_AGE               → HSTS max-age seconds (default 15552000 = 180d)
//   CSP_REPORT_ONLY=true       → send CSP as report-only (observe, don't block)
//   SECURITY_HEADERS_DISABLED=true → escape hatch for debugging only (NOT for prod)
//
// IMPORTANT — Content Security Policy and the current frontend:
//   The production frontend (frontend/public) compiles JSX in the browser with
//   Babel (<script type="text/babel">). Babel needs 'unsafe-eval', and the
//   inline font-loader handler needs 'unsafe-inline'. Both are included below so
//   the existing app keeps working. This WEAKENS XSS protection. The correct fix
//   is to ship a pre-built (compiled) frontend and then drop 'unsafe-eval' /
//   'unsafe-inline'. Tracked in docs/PRODUCTION_BLOCKERS.md and SECURITY_HARDENING.md.

const isProd = process.env.NODE_ENV === 'production';

function buildCSP() {
  // NOTE: 'unsafe-eval' + 'unsafe-inline' on script-src are ONLY required by the
  // Babel-in-browser frontend. Remove them once a compiled frontend is served.
  const directives = {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'unsafe-eval'", "'unsafe-inline'"],
    'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
    'img-src': ["'self'", 'data:', 'blob:'],
    'connect-src': ["'self'"],
    'object-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
  };
  // Only ask browsers to upgrade sub-resource requests to HTTPS in production
  // (behind the TLS-terminating proxy). In local http dev this would break assets.
  if (isProd) directives['upgrade-insecure-requests'] = [];

  return Object.entries(directives)
    .map(([k, v]) => (v.length ? `${k} ${v.join(' ')}` : k))
    .join('; ');
}

const CSP_VALUE = buildCSP();
const HSTS_MAX_AGE = Number(process.env.HSTS_MAX_AGE || 15552000); // 180 days

export function securityHeaders(req, res, next) {
  if (process.env.SECURITY_HEADERS_DISABLED === 'true') return next();

  // Content Security Policy (report-only optionally, to roll out safely).
  const cspHeader = process.env.CSP_REPORT_ONLY === 'true'
    ? 'Content-Security-Policy-Report-Only'
    : 'Content-Security-Policy';
  res.setHeader(cspHeader, CSP_VALUE);

  // Clickjacking protection (Helmet frameguard).
  res.setHeader('X-Frame-Options', 'DENY');

  // MIME-sniffing protection (Helmet noSniff) — global, not just downloads.
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Referrer privacy (Helmet referrerPolicy).
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Limit powerful browser features by default (Helmet permittedCrossDomain/Permissions).
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');

  // Do not leak the framework.
  res.removeHeader('X-Powered-By');

  // HSTS only in production (TLS terminated at the proxy). Never in http dev.
  if (isProd) {
    res.setHeader('Strict-Transport-Security', `max-age=${HSTS_MAX_AGE}; includeSubDomains`);
  }

  next();
}

export function securityConfigSummary() {
  return {
    hsts: isProd,
    hstsMaxAge: HSTS_MAX_AGE,
    cspReportOnly: process.env.CSP_REPORT_ONLY === 'true',
    cspAllowsUnsafeEval: true, // because of Babel-in-browser frontend
    disabled: process.env.SECURITY_HEADERS_DISABLED === 'true',
  };
}
