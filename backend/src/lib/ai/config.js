// AI runtime configuration — the ONE place the AI feature is switched on.
//
// OFF BY DEFAULT, DELIBERATELY. `AI_ENABLED` is false unless explicitly set, so
// a deployment that has not been given a gateway behaves exactly like the ATS
// did before this feature existed. "Disabled" is a first-class configuration,
// not a degraded one — every intake path has a manual equivalent.
//
// NO HOSTED PROVIDER, NO SILENT FALLBACK. There is one gateway URL and one
// token. If the gateway is unreachable the job fails and says so; nothing
// reaches for OpenAI, nothing quietly downgrades to the legacy heuristic
// parser. A fallback that "keeps working" is how CVs end up processed by a
// system nobody chose.
//
// SECRETS NEVER LEAVE THIS MODULE AS VALUES. `describe()` reports whether a
// token is configured, never what it is, so config can be logged and exposed on
// a health endpoint without redaction discipline at every call site.

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const bool = (v) => String(v ?? '').toLowerCase() === 'true';

/** Read fresh each call: tests flip env between cases and boot order varies. */
export function aiConfig() {
  const gatewayUrl = (process.env.AI_GATEWAY_URL || '').trim();
  const token = (process.env.AI_GATEWAY_TOKEN || '').trim();
  return {
    enabled: bool(process.env.AI_ENABLED),
    gatewayUrl,
    token,
    // Per-request ceiling. The gateway does layout analysis, optional OCR and a
    // generation pass, so this is minutes, not seconds.
    timeoutMs: num(process.env.AI_TIMEOUT_MS, 180_000),
    // How many parses may be in flight in this process. A GPU serves one at a
    // time; queueing in the database is cheaper than queueing in the model.
    maxConcurrency: num(process.env.AI_MAX_CONCURRENCY, 2),
    // Attempts INCLUDING the first. 2 = one automatic retry.
    maxAttempts: num(process.env.AI_MAX_ATTEMPTS, 2),
    // Consecutive failures that open the breaker, and how long it stays open.
    breakerThreshold: num(process.env.AI_BREAKER_THRESHOLD, 3),
    breakerCooldownMs: num(process.env.AI_BREAKER_COOLDOWN_MS, 60_000),
    maxUploadBytes: num(process.env.AI_MAX_UPLOAD_BYTES, 15 * 1024 * 1024),
    maxPages: num(process.env.AI_MAX_PAGES, 30),
  };
}

/**
 * Why the AI feature cannot serve a request right now, or null when it can.
 * Returns a stable code so a route never has to compose an explanation.
 */
export function aiUnavailableReason() {
  const c = aiConfig();
  if (!c.enabled) return 'AI_DISABLED';
  if (c.gatewayUrl === '') return 'AI_NOT_CONFIGURED';
  if (c.token === '') return 'AI_NOT_CONFIGURED';
  return null;
}

/** Safe to log, safe to return from /health. Contains no secret VALUES. */
export function describeAiConfig() {
  const c = aiConfig();
  let host = null;
  try { host = c.gatewayUrl === '' ? null : new URL(c.gatewayUrl).host; } catch { host = 'invalid'; }
  return {
    enabled: c.enabled,
    configured: c.gatewayUrl !== '' && c.token !== '',
    gatewayHost: host,                 // host only — never the full URL with a path or query
    tokenConfigured: c.token !== '',   // never the token
    timeoutMs: c.timeoutMs,
    maxConcurrency: c.maxConcurrency,
    maxAttempts: c.maxAttempts,
    maxUploadBytes: c.maxUploadBytes,
    maxPages: c.maxPages,
  };
}
