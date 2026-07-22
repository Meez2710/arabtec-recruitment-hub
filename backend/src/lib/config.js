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

  // AI CV parsing
  const hasAiKey = present('DEEPSEEK_API_KEY') || present('ANTHROPIC_API_KEY');
  if (!hasAiKey && isProd) {
    warnings.push('AI CV parsing is OFF (no DEEPSEEK_API_KEY / ANTHROPIC_API_KEY) — falling back to the heuristic parser.');
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
