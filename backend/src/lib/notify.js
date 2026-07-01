// Notification service (C2.3). One call creates the in-app alert AND sends an
// email (best-effort; email no-ops until the mailbox is configured). Never throws
// into a request handler.
import { Notifications, Users } from './models.js';
import { sendMail } from './mailer.js';

const BRAND = '#d2232a', INK = '#1a1a1a';
function emailShell(title, body) {
  return `<!doctype html><html><body style="margin:0;background:#f6f3ec;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;"><tr><td align="center">
    <table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;font-family:Arial,sans-serif;overflow:hidden;">
      <tr><td style="background:${INK};padding:16px 24px;"><span style="color:${BRAND};font-weight:bold;">ARABTEC</span><span style="color:#fff;"> Recruitment</span></td></tr>
      <tr><td style="padding:24px;"><h2 style="margin:0 0 10px;font-size:18px;color:${INK};">${title}</h2>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${INK};">${body}</p>
        <p style="margin:0;font-size:13px;color:#5b6166;">Open the Recruitment Hub to take action.</p></td></tr>
    </table></td></tr></table></body></html>`;
}

// Notify a single user (in-app + email). recipient = a user row (needs id, email).
export function notifyUser(recipient, { type, title, body, linkType, linkId }) {
  if (!recipient?.id) return;
  try { Notifications.create({ userId: recipient.id, type, title, body, linkType, linkId }); } catch { /* ignore */ }
  if (recipient.email) {
    sendMail({ to: recipient.email, subject: title, html: emailShell(title, body || title) }).catch(() => {});
  }
}

// Notify every active user holding a permission (e.g. all approvers).
export function notifyByPermission(permCode, payload, { excludeUserId } = {}) {
  let recipients = [];
  try { recipients = Users.withPermission(permCode); } catch { recipients = []; }
  for (const u of recipients) { if (u.id !== excludeUserId) notifyUser(u, payload); }
  return recipients.length;
}
