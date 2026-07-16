// Email sending (C2.2) — Microsoft 365 SMTP via nodemailer.
//
// Design goals:
//   • Zero-config safe: with no SMTP_USER / SMTP_PASS set, everything no-ops
//     cleanly (sendMail returns {ok:false, skipped:true}) — the app runs exactly
//     as before. Nothing crashes because email isn't wired yet.
//   • One place that knows how to talk to the mailbox. Everything else calls sendMail().
//   • Best-effort: a mail failure never throws into a request handler.
//
// Configuration (set in the server environment / Render, never in code):
//   SMTP_HOST       default smtp-relay.brevo.com
//   SMTP_PORT       default 587  (STARTTLS)
//   SMTP_USER       your Brevo account email / API key login       (REQUIRED to send)
//   SMTP_PASS       your Brevo SMTP master password / API key      (REQUIRED to send)
//   MAIL_FROM       default = SMTP_USER
//   MAIL_FROM_NAME  default "Arabtec Careers"
import nodemailer from 'nodemailer';

let transport = null;

function cfg() {
  return {
    host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
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

export function isConfigured() {
  if (jsonMode()) return true;
  const c = cfg();
  return !!(c.user && c.pass);
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

// Verify the SMTP connection/credentials without sending. Returns {ok, error?}.
export async function verifyConnection() {
  if (!isConfigured()) return { ok: false, error: 'Email not configured (SMTP_USER / SMTP_PASS missing).' };
  try { await getTransport().verify(); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

// Send an email. Never throws — returns a result object the caller can log/audit.
// { to, subject, html, text?, replyTo? }
export async function sendMail({ to, subject, html, text, replyTo }) {
  const c = cfg();
  if (!isConfigured()) {
    console.log(JSON.stringify({ level: 'info', msg: 'email.skipped', reason: 'not_configured', to, subject }));
    return { ok: false, skipped: true, reason: 'not_configured' };
  }
  if (!to || !subject) return { ok: false, error: 'Recipient and subject are required.' };
  try {
    const info = await getTransport().sendMail({
      from: `"${c.fromName}" <${c.from}>`,
      to, subject, html,
      text: text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      replyTo: replyTo || c.from,
    });
    console.log(JSON.stringify({ level: 'info', msg: 'email.sent', to, subject, messageId: info.messageId }));
    return { ok: true, messageId: info.messageId };
  } catch (e) {
    console.log(JSON.stringify({ level: 'error', msg: 'email.failed', to, subject, error: String(e && e.message || e) }));
    return { ok: false, error: String(e && e.message || e) };
  }
}
