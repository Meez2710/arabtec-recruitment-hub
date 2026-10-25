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
//   DIRECT_HTTP=true           → this production deployment is served over plain
//                                HTTP with no TLS in front of it (the on-prem LAN
//                                install at http://10.20.0.9:4001). Drops
//                                upgrade-insecure-requests, which browsers DO
//                                honour over http and which would otherwise
//                                rewrite every asset URL to https on a host that
//                                answers nothing there — a blank app. HSTS is
//                                unaffected: browsers ignore it over http.
//   HSTS_MAX_AGE               → HSTS max-age seconds (default 15552000 = 180d)
//   CSP_REPORT_ONLY=true       → send CSP as report-only (observe, don't block)
//   SECURITY_HEADERS_DISABLED=true → escape hatch for debugging only (NOT for prod)
//
// Content Security Policy and the frontend:
//   The screens are compiled once on the server (lib/frontend-build.js) and
//   served as plain JavaScript, so the browser no longer runs the Babel
//   compiler and 'unsafe-eval' is no longer allowed. Since 25 Oct 2026 (audit
//   F7) there are no inline scripts either: the font loader and the pdf.js
//   bootstrap live in /boot.js and /pdfjs-boot.js, so script-src is 'self' only.

const isProd = process.env.NODE_ENV === 'production';
// Set on a production deployment that is reached over plain HTTP. Read at call
// time in the CSP builder rather than baked in here so tests can exercise both.
const isDirectHttp = () => process.env.DIRECT_HTTP === 'true';

function buildCSP() {
  // No 'unsafe-eval' (nothing compiles code at run time) and no
  // 'unsafe-inline' for scripts (none are inline): an injected <script> or
  // onclick= cannot run even if markup were ever reflected.
  const directives = {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
    'img-src': ["'self'", 'data:', 'blob:'],
    // The CV preview panel shows the picked file via an iframe pointed at a
    // blob: URL (URL.createObjectURL on the File object). Without this,
    // frame-src falls back to default-src 'self', which does not match
    // blob: — the iframe loads nothing, silently, no console error a user
    // would notice.
    'frame-src': ["'self'", 'blob:'],
    // blob: lets the bundled pdf.js read the CV object URL the page itself
    // created (phones draw PDFs on canvases; an iframe cannot show them).
    'connect-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
  };
  // Only ask browsers to upgrade sub-resource requests to HTTPS in production
  // (behind the TLS-terminating proxy). In local http dev this would break
  // assets — and so would it on a production install that has no TLS at all,
  // which is why DIRECT_HTTP opts out.
  if (isProd && !isDirectHttp()) directives['upgrade-insecure-requests'] = [];

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
    directHttp: isDirectHttp(),
    hstsMaxAge: HSTS_MAX_AGE,
    cspReportOnly: process.env.CSP_REPORT_ONLY === 'true',
    cspAllowsUnsafeEval: false, // the frontend is compiled on the server
    disabled: process.env.SECURITY_HEADERS_DISABLED === 'true',
  };
}
