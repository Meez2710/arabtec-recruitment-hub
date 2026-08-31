// Notification service (C2.3).
//
// TWO ENTRY POINTS, ONE RULE: nothing here throws into a request handler, and
// nothing here decides policy. Policy lives in notification_config, which an
// administrator edits in the Control Center; this file only carries it out.
//
//   notifyUser()   — direct, unconditional. For the few places that must always
//                    reach one specific person regardless of settings.
//   notifyEvent()  — the normal path. Looks the event up in notification_config,
//                    honours the enabled / in-app / email checkboxes, resolves
//                    the symbolic recipients against the entity, and renders the
//                    catalogued template.
//
// An event that is switched off sends nothing and says so in its return value,
// so a caller can log "suppressed by settings" rather than "sent".
import { Notifications, Users, NotificationConfig } from './models.js';
import { sendMail } from './mailer.js';
import * as templates from './email_templates.js';
import { EVENT_BY_KEY, APPROVER_PERMISSION, EXTERNAL_RECIPIENTS } from './notification-catalog.js';

const BRAND = '#D01827', INK = '#1A1A1A', MUT = '#6F6A64', CANVAS = '#F4F5F7', LINE = '#E4E4E4';

// Fallback body for catalogued events that have no dedicated template.
function emailShell(title, body) {
  return `<!doctype html><html dir="ltr"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title></head><body style="margin:0;background:${CANVAS};">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;background:${CANVAS};"><tr><td align="center">
    <table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;border:1px solid ${LINE};font-family:Arial,Helvetica,sans-serif;overflow:hidden;">
      <tr><td style="height:3px;background:${BRAND};font-size:0;line-height:0;">&nbsp;</td></tr>
      <tr><td style="padding:16px 24px 10px;border-bottom:1px solid ${LINE};">
        <span style="color:${INK};font-weight:bold;">ARABTEC</span><span style="color:${MUT};"> Recruitment</span></td></tr>
      <tr><td style="padding:22px 24px;"><h2 style="margin:0 0 10px;font-size:18px;color:${INK};">${title}</h2>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${INK};">${body}</p>
        <p style="margin:0;font-size:13px;color:${MUT};">Open the Recruitment Hub to take action.</p></td></tr>
    </table></td></tr></table></body></html>`;
}

/** Notify one user directly, bypassing notification_config. */
export function notifyUser(recipient, { type, title, body, linkType, linkId, email = true }) {
  if (!recipient?.id) return;
  try { Notifications.create({ userId: recipient.id, type, title, body, linkType, linkId }); } catch { /* ignore */ }
  if (email && recipient.email) {
    sendMail({ to: recipient.email, subject: title, html: emailShell(title, body || title) }).catch(() => {});
  }
}

/** Notify every active user holding a permission (e.g. all approvers). */
export function notifyByPermission(permCode, payload, { excludeUserId } = {}) {
  let recipients = [];
  try { recipients = Users.withPermission(permCode); } catch { recipients = []; }
  for (const u of recipients) { if (u.id !== excludeUserId) notifyUser(u, payload); }
  return recipients.length;
}

/* ------------------------------------------------------------------ config */

function configFor(eventKey) {
  const event = EVENT_BY_KEY[eventKey];
  if (!event) return null;
  let row = null;
  try { row = NotificationConfig.byKey(eventKey); } catch { row = null; }
  // A catalogue entry with no row yet (a release added it, the seed has not run)
  // falls back to its declared defaults rather than silently going dark.
  const d = event.defaults;
  if (!row) return { event, enabled: d.enabled, inApp: d.inApp, email: d.email, recipients: d.recipients || [] };
  let recipients = [];
  try { recipients = JSON.parse(row.recipients || '[]'); } catch { recipients = []; }
  return { event, enabled: row.enabled === 1, inApp: row.in_app === 1, email: row.email === 1, recipients };
}

/* -------------------------------------------------------------- recipients */

/**
 * Turn symbolic tokens into concrete addressees.
 *
 * Returns { staff: [userRow], external: [{ email, name }] }. Staff get an in-app
 * alert plus (optionally) mail; external addressees can only ever be mailed.
 * De-duplicated by user id and by email, because the same person is frequently
 * both the requester and the owner and should not be told twice.
 */
function resolveRecipients(tokens, ctx, eventKey) {
  const staff = new Map();
  const external = new Map();
  const addStaff = (u) => { if (u && u.id && !staff.has(u.id)) staff.set(u.id, u); };
  const addExternal = (email, name) => {
    const k = String(email || '').trim().toLowerCase();
    if (k && !external.has(k)) external.set(k, { email, name });
  };

  for (const token of tokens) {
    switch (token) {
      case 'requester':      addStaff(ctx.requester); break;
      case 'owner':          addStaff(ctx.owner); break;
      case 'hiring_manager': addStaff(ctx.hiringManager); break;
      case 'actor':          addStaff(ctx.actor); break;
      case 'panel':          for (const m of ctx.panel || []) addStaff(m); break;
      case 'candidate':
        if (ctx.candidate?.email) addExternal(ctx.candidate.email, ctx.candidate.full_name || ctx.candidate.fullName);
        break;
      case 'approvers': {
        const perm = APPROVER_PERMISSION[eventKey];
        if (!perm) break;
        let holders = [];
        try { holders = Users.withPermission(perm); } catch { holders = []; }
        for (const u of holders) addStaff(u);
        break;
      }
      default: break;
    }
  }

  // The person who just performed the action does not need telling they did it,
  // unless the event explicitly asks for 'actor'.
  if (ctx.actor?.id && !tokens.includes('actor')) staff.delete(ctx.actor.id);

  return { staff: [...staff.values()], external: [...external.values()] };
}

/* ------------------------------------------------------------------ render */

function render(event, vars) {
  const fn = event.template && templates[event.template];
  if (typeof fn === 'function') {
    try { return fn(vars); } catch { /* fall through to the generic shell */ }
  }
  const title = vars.title || event.label;
  return { subject: title, html: emailShell(title, vars.body || title) };
}

/* ---------------------------------------------------------------- dispatch */

/**
 * Fire a catalogued notification.
 *
 * @param {string} eventKey  a key from notification-catalog.js
 * @param {object} ctx
 *   actor, requester, owner, hiringManager  — user rows
 *   panel                                    — array of user rows
 *   candidate                                — candidate row (external)
 *   vars                                     — template variables
 *   title/body                               — fallback copy for templateless events
 *   linkType/linkId                          — what the in-app alert points at
 * @returns {{sent:boolean, reason?:string, inApp:number, emails:number}}
 */
export function notifyEvent(eventKey, ctx = {}) {
  const cfg = configFor(eventKey);
  if (!cfg) return { sent: false, reason: 'unknown-event', inApp: 0, emails: 0 };
  if (!cfg.enabled) return { sent: false, reason: 'disabled', inApp: 0, emails: 0 };
  if (!cfg.inApp && !cfg.email) return { sent: false, reason: 'no-channel', inApp: 0, emails: 0 };
  if (!cfg.recipients.length) return { sent: false, reason: 'no-recipients', inApp: 0, emails: 0 };

  const { staff, external } = resolveRecipients(cfg.recipients, ctx, eventKey);
  const vars = { ...(ctx.vars || {}), title: ctx.title, body: ctx.body };
  const { subject, html } = render(cfg.event, vars);

  let inApp = 0, emails = 0;
  for (const u of staff) {
    if (cfg.inApp) {
      try {
        Notifications.create({
          // Legacy events keep their documented type string; new ones use the key.
          userId: u.id, type: cfg.event.notifyType || eventKey,
          title: ctx.title || subject, body: ctx.body || '',
          linkType: ctx.linkType, linkId: ctx.linkId,
        });
        inApp += 1;
      } catch { /* an alert must never break the action that caused it */ }
    }
    if (cfg.email && u.email) { sendMail({ to: u.email, subject, html }).catch(() => {}); emails += 1; }
  }

  // External addressees are mail-only, and only when the email channel is on.
  if (cfg.email) {
    for (const r of external) { sendMail({ to: r.email, subject, html }).catch(() => {}); emails += 1; }
  }

  return { sent: inApp > 0 || emails > 0, inApp, emails };
}

/** Does this event reach anyone outside the company? Used by the console to
 *  mark external sends, and by callers that want an explicit confirm first. */
export function isExternalEvent(eventKey) {
  const cfg = configFor(eventKey);
  if (!cfg || !cfg.enabled || !cfg.email) return false;
  return cfg.recipients.some((r) => EXTERNAL_RECIPIENTS.has(r));
}
