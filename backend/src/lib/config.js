// Boot-time configuration validation.
//
// Goal: fail fast with a clear message when a REQUIRED production variable is
// missing, and warn (non-fatal) when an OPTIONAL feature is left unconfigured so
// operators aren't surprised that email / AI parsing / monitoring are silently off.
//
// This never prints secret VALUES — only variable NAMES and booleans.

const isProd = process.env.NODE_ENV === 'production';

function present(name) {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() !== '';
}

// A 32-byte key, written as 64 hex characters or base64 — the two things
// `openssl rand -hex 32` and `openssl rand -base64 32` actually produce.
// Checked here, at boot, so a bad key is a startup error and not a failed sync
// six hours later. The VALUE is never logged; only whether it parsed.
function validEncryptionKey(raw) {
  const value = String(raw || '').trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return true;
  try { return Buffer.from(value, 'base64').length === 32; } catch { return false; }
}

// Returns { ok, errors[], warnings[], summary{} }. Callers decide whether to throw.
export function validateConfig() {
  const errors = [];
  const warnings = [];

  // --- Required in production ---
  if (isProd) {
    if (!present('DATABASE_URL')) {
      errors.push('DATABASE_URL is required in production (postgres://…).');
    } else if (!/^postgres(ql)?:\/\//.test(process.env.DATABASE_URL) && process.env.PG_ENGINE !== 'pglite') {
      warnings.push('DATABASE_URL is not a postgres:// URL — production is expected to use PostgreSQL.');
    }
    if (!present('JWT_SECRET')) {
      errors.push('JWT_SECRET is required in production (the app refuses to sign tokens without it).');
    } else if (process.env.JWT_SECRET.length < 32) {
      warnings.push('JWT_SECRET is shorter than 32 characters — use a long random string.');
    }
    if (!present('CORS_ORIGINS')) {
      warnings.push('CORS_ORIGINS is not set — cross-origin browser clients will be denied (fine if same-origin only).');
    }
  }

  // --- Optional features: warn if half-configured or off ---
  // Email
  const smtpUser = present('SMTP_USER');
  const smtpPass = present('SMTP_PASS');
  if (smtpUser !== smtpPass) {
    warnings.push('Email is half-configured: set BOTH SMTP_USER and SMTP_PASS, or neither.');
  } else if (!smtpUser && isProd) {
    warnings.push('Email is OFF (SMTP_USER / SMTP_PASS unset) — notification emails will not be sent.');
  }

  // CV reading. There is no heuristic parser to fall back to any more, so an
  // unset key does not degrade parsing — it means no CV is read at all. That is
  // a much louder condition and the warning has to say so.
  const hasAiKey = present('ANTHROPIC_API_KEY');
  if (!hasAiKey && isProd) {
    warnings.push('ANTHROPIC_API_KEY is unset — no CV reader is wired. Uploads will be kept but nothing will be parsed.');
  }

  // Microsoft 365 delegated mailbox (career@arabtecegy.com).
  //
  // WARNINGS, NEVER ERRORS. These were errors, on the reasoning that a
  // half-configured integration looks wired in the admin panel and then fails
  // at the first token write. That reasoning was right about the SIGNAL and
  // badly wrong about the SEVERITY: an OPTIONAL feature must not stop the whole
  // ATS from serving. Listing the MS_* keys in render.yaml is enough for the
  // platform to create the entries, so a blank-but-present variable took a
  // working production deploy down at boot — which is exactly what happened on
  // Render.
  //
  // Refusing to start buys nothing here, because nothing is at risk: the
  // integration reports itself not-configured, /status lists precisely which
  // variables are missing, and every route refuses with that list rather than
  // half-working. The app serves; the mailbox feature stays off until it is
  // configured properly.
  // WHICH VARIABLES ARE REQUIRED DEPENDS ON THE SIGN-IN MODE, and getting this
  // wrong is not cosmetic: a correctly configured device-code host was reported
  // as "half-configured, missing MS_CLIENT_SECRET" and the integration was
  // switched off — for lacking a credential that a public client must not have.
  const msDeviceCode = ((process.env.MS_AUTH_MODE || '').trim().toLowerCase() === 'device-code')
    || (!present('MS_CLIENT_SECRET') && (process.env.MS_AUTH_MODE || '').trim() === '');
  const msVars = msDeviceCode
    ? ['MS_TENANT_ID', 'MS_CLIENT_ID']
    : ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET'];
  const msSet = msVars.filter(present);
  // A device code needs no callback at all — nothing listens for one.
  const msRedirect = msDeviceCode || present('MS_REDIRECT_URI') || present('CORS_ORIGINS');
  const msEnabled = msSet.length > 0;
  const msKeyOk = present('MICROSOFT_TOKEN_ENCRYPTION_KEY')
    && validEncryptionKey(process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY);
  if (msEnabled) {
    const msMissing = msVars.filter((v) => !present(v));
    if (msMissing.length) {
      warnings.push(`Microsoft 365 integration is OFF — half-configured, missing ${msMissing.join(', ')}. `
        + `Set all of ${msVars.join(', ')}, or none.`);
    }
    // A secret left behind on a public client is not harmless. MSAL would
    // attach it to the device-code token request and Entra rejects a
    // client_secret from an app registered as public — with an error about the
    // credential rather than the flow, which is a miserable thing to debug.
    if (msDeviceCode && present('MS_CLIENT_SECRET')) {
      warnings.push('MS_AUTH_MODE is device-code but MS_CLIENT_SECRET is set. A public client must not hold '
        + 'a secret — remove it, or set MS_AUTH_MODE=auth-code to use the browser redirect flow.');
    }
    if (!present('MICROSOFT_TOKEN_ENCRYPTION_KEY')) {
      warnings.push('Microsoft 365 integration is OFF — MICROSOFT_TOKEN_ENCRYPTION_KEY is unset, and the '
        + 'MSAL token cache is encrypted at rest. Generate one with `openssl rand -hex 32`.');
    } else if (!msKeyOk) {
      warnings.push('Microsoft 365 integration is OFF — MICROSOFT_TOKEN_ENCRYPTION_KEY must be 32 bytes '
        + '(64 hex characters or base64).');
    }
    if (!msRedirect) {
      warnings.push('Microsoft 365 integration is OFF — MS_REDIRECT_URI is unset (or set CORS_ORIGINS to '
        + 'the ATS public URL, which it is derived from).');
    } else if (isProd && !msDeviceCode) {
      const uri = process.env.MS_REDIRECT_URI
        || `${(process.env.CORS_ORIGINS || '').split(',')[0].trim().replace(/\/+$/, '')}/api/integrations/microsoft/callback`;
      // Entra accepts only https:// for a Web redirect URI — with the single
      // exception of http://localhost, which is documented and is what makes an
      // internal-only host connectable over an SSH tunnel without a certificate.
      if (!/^https:\/\//i.test(uri) && !/^http:\/\/localhost(:|\/|$)/i.test(uri)) {
        warnings.push('The Microsoft redirect URI is neither https:// nor http://localhost. Entra accepts only '
          + 'those two, so the connect flow will fail. Use MS_AUTH_MODE=device-code to avoid needing a '
          + 'redirect URI at all.');
      }
    }
  } else if (isProd) {
    warnings.push(`Microsoft 365 mailbox integration is OFF (${msVars.join(' / ')} unset) `
      + '— the careers mailbox will not be scanned.');
  }

  // Monitoring
  if (!present('SENTRY_DSN') && isProd) {
    warnings.push('SENTRY_DSN is unset — error tracking is disabled in production.');
  }

  // File storage durability hint
  if (!present('UPLOAD_DIR') && isProd) {
    warnings.push('UPLOAD_DIR is unset — uploads rely on the DB blob store; set a persistent path on VPS/Coolify.');
  }

  const summary = {
    env: process.env.NODE_ENV || 'development',
    db: process.env.PG_ENGINE === 'pglite' ? 'pglite'
      : /^postgres/.test(process.env.DATABASE_URL || '') ? 'postgres'
      : 'sqlite',
    email: smtpUser && smtpPass,
    aiParsing: hasAiKey,
    sentry: present('SENTRY_DSN'),
    watcher: present('CV_INBOX') || present('CV_WATCH_INTERVAL_MIN'),
    microsoftMailbox: msEnabled && msKeyOk && !!msRedirect,
    mailProvider: process.env.MAIL_PROVIDER || 'auto',
    trustProxy: process.env.TRUST_PROXY ?? (isProd ? '1 (default)' : 'false (default)'),
  };

  return { ok: errors.length === 0, errors, warnings, summary };
}

// Convenience: validate and log a structured summary. Throws in production if a
// required variable is missing, so a misconfigured deploy fails loudly at boot.
export function validateConfigOrThrow() {
  const r = validateConfig();
  console.log(JSON.stringify({ level: 'info', msg: 'config.summary', ...r.summary }));
  for (const w of r.warnings) {
    console.log(JSON.stringify({ level: 'warn', msg: 'config.warning', detail: w }));
  }
  if (!r.ok) {
    for (const e of r.errors) {
      console.error(JSON.stringify({ level: 'error', msg: 'config.error', detail: e }));
    }
    if (isProd) {
      throw new Error('Invalid production configuration: ' + r.errors.join(' '));
    }
  }
  return r;
}
