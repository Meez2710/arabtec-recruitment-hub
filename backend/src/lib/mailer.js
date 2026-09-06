// Email sending — one function, two providers.
//
// THE CALL SURFACE IS UNCHANGED. Every call site in the app (notify.js,
// candidates.js, interviews.js, offers.js, settings.js) still calls
// `sendMail({ to, subject, html })` and still gets a result object back that
// never throws. Only the transport underneath it moved.
//
// PROVIDER ORDER, and why:
//   1. dry-run   — SMTP_TRANSPORT=json. Wins over everything, unconditionally,
//                  so an automated test can never post real mail from the
//                  company mailbox. run_tests.mjs pins it for the whole suite.
//   2. graph     — Microsoft Graph POST /me/sendMail on the SAME delegated
//                  connection the inbox scan uses. No SMTP password exists in
//                  this path; the mailbox consented once, in a browser.
//   3. smtp      — the original nodemailer transport. Still here, still
//                  working, and used only when SMTP_USER/SMTP_PASS are set.
//                  It is a FALLBACK, not a peer: MAIL_PROVIDER=smtp pins it,
//                  MAIL_PROVIDER=graph forbids it, and the default ("auto")
//                  prefers Graph whenever the Microsoft connection is healthy.
//
// Configuration:
//   MAIL_PROVIDER   auto (default) | graph | smtp
//   SMTP_*          unchanged, see docs/ENVIRONMENT_VARIABLES.md
//   MAIL_FROM_NAME  display name, used by both providers
import nodemailer from 'nodemailer';

import { connectionRow } from './microsoft/connection-store.js';
import { sendMailAs } from './microsoft/graph.js';
import { acquireGraphToken } from './microsoft/msal-client.js';

let transport = null;

// The default host is exported so the settings endpoint reports the host mail is
// ACTUALLY sent through. These two had drifted apart: this module defaulted to
// smtp.gmail.com while /email/status reported smtp.office365.com, so with
// SMTP_HOST unset the console would have shown a healthy-looking Microsoft host
// while every message was really being offered to Gmail, which rejects
// arabtecegy.com addresses outright. One constant, one answer.
export const DEFAULT_SMTP_HOST = 'smtp.office365.com';

function cfg() {
  return {
    host: process.env.SMTP_HOST || DEFAULT_SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || process.env.SMTP_USER || '',
    fromName: process.env.MAIL_FROM_NAME || 'Arabtec Careers',
  };
}

// Dry-run mode: SMTP_TRANSPORT=json builds messages without sending (nodemailer
// jsonTransport). Used by tests/CI and for a safe "does the wiring work" check.
function jsonMode() { return process.env.SMTP_TRANSPORT === 'json'; }

/** Which provider is pinned by configuration: 'auto' | 'graph' | 'smtp'. */
function preferredProvider() {
  const value = String(process.env.MAIL_PROVIDER || 'auto').trim().toLowerCase();
  return value === 'graph' || value === 'smtp' ? value : 'auto';
}

function smtpConfigured() {
  const c = cfg();
  return !!(c.user && c.pass);
}

/**
 * Is the Microsoft delegated connection healthy enough to send through?
 *
 * Read from the connection row, never by calling Microsoft — this is consulted
 * on every send and must stay cheap. A RECONNECT_REQUIRED connection answers
 * false, so mail falls back (when SMTP is configured) rather than failing.
 *
 * connectionRow() already tolerates the table not existing, which is what makes
 * a static import safe here: routes import this module before ensureSchema()
 * has run.
 */
function graphReady() {
  try {
    const row = connectionRow();
    return !!(row && row.status === 'CONNECTED' && row.token_cache && row.home_account_id);
  } catch { return false; }
}

/** Which provider a send would use right now. Reported by /settings/email/status. */
export function activeProvider() {
  if (jsonMode()) return 'dry-run';
  const preferred = preferredProvider();
  if (preferred === 'smtp') return smtpConfigured() ? 'smtp' : 'none';
  if (preferred === 'graph') return graphReady() ? 'graph' : 'none';
  if (graphReady()) return 'graph';
  return smtpConfigured() ? 'smtp' : 'none';
}

export function isConfigured() {
  return activeProvider() !== 'none';
}

function getTransport() {
  if (transport) return transport;
  if (jsonMode()) { transport = nodemailer.createTransport({ jsonTransport: true }); return transport; }
  const c = cfg();
  transport = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.port === 465,          // 465 = implicit TLS; 587 = STARTTLS (secure:false)
    auth: { user: c.user, pass: c.pass },
    // M365 uses STARTTLS on 587; require TLS but keep default cert validation.
    requireTLS: c.port === 587,
  });
  return transport;
}

// Verify the mail connection without sending. Returns {ok, error?, provider}.
export async function verifyConnection() {
  const provider = activeProvider();
  if (provider === 'none') {
    return { ok: false, provider, error: 'Email is not configured. Connect Microsoft 365, or set SMTP_USER / SMTP_PASS.' };
  }
  if (provider === 'graph') {
    // The delegated connection proves itself by acquiring a token silently —
    // exactly what a send would do, minus the send.
    try {
      await acquireGraphToken();
      return { ok: true, provider };
    } catch (e) {
      return { ok: false, provider, error: String((e && e.message) || e) };
    }
  }
  try { await getTransport().verify(); return { ok: true, provider }; }
  catch (e) { return { ok: false, provider, error: String((e && e.message) || e) }; }
}

// Send an email. Never throws — returns a result object the caller can log/audit.
// { to, subject, html, text?, replyTo? }
export async function sendMail({ to, subject, html, text, replyTo }) {
  const c = cfg();
  const provider = activeProvider();
  if (provider === 'none') {
    console.log(JSON.stringify({ level: 'info', msg: 'email.skipped', reason: 'not_configured', to, subject }));
    return { ok: false, skipped: true, reason: 'not_configured' };
  }
  if (!to || !subject) return { ok: false, error: 'Recipient and subject are required.' };

  if (provider === 'graph') {
    try {
      await sendMailAs({ to, subject, html, text, replyTo });
      console.log(JSON.stringify({ level: 'info', msg: 'email.sent', provider: 'graph', to, subject }));
      return { ok: true, provider: 'graph' };
    } catch (e) {
      const error = String((e && e.message) || e);
      console.log(JSON.stringify({ level: 'error', msg: 'email.failed', provider: 'graph', to, subject, error }));
      // BACKWARD COMPATIBILITY. A Graph failure falls back to SMTP only when
      // SMTP is genuinely configured and Graph was not pinned — a notification
      // that used to send must not start disappearing because the Microsoft
      // connection lapsed.
      if (preferredProvider() === 'graph' || !smtpConfigured()) return { ok: false, provider: 'graph', error };
    }
  }

  try {
    const info = await getTransport().sendMail({
      from: `"${c.fromName}" <${c.from}>`,
      to, subject, html,
      text: text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      replyTo: replyTo || c.from,
    });
    console.log(JSON.stringify({ level: 'info', msg: 'email.sent', provider: jsonMode() ? 'dry-run' : 'smtp', to, subject, messageId: info.messageId }));
    return { ok: true, messageId: info.messageId, provider: jsonMode() ? 'dry-run' : 'smtp' };
  } catch (e) {
    console.log(JSON.stringify({ level: 'error', msg: 'email.failed', provider: 'smtp', to, subject, error: String(e && e.message || e) }));
    return { ok: false, error: String(e && e.message || e) };
  }
}
