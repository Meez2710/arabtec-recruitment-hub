// Sending interview invitations, updates and cancellations — explicitly,
// per recipient, with the outcome kept (audit 2026-10-06, decisions 4, 7–9).
//
//   • Each recipient gets their OWN email: the candidate's text, or the panel
//     text addressed to that panelist. No shared recipient lists, no CC, and
//     an attachment (the CV) only on the panel emails it was ticked for.
//   • Each recipient × channel × send action is one interview_dispatch row,
//     unique on the client's one-time batch key: a double click or a retry of
//     the same action finds the rows already there and sends nothing again.
//   • Outcomes are truthful: provider accepted, dry run (test transport — not
//     delivered), not sent (with the reason), failed (with the error). Nothing
//     here can confirm delivery, so nothing claims it.
//   • A WhatsApp hand-off is recorded as exactly that: opened by a person,
//     not sent by the system.
import { all, get, run } from './db.js';
import {
  Interviews, InterviewPanel, Candidates, Requests, Users, Notifications, CandidateActivity, InterviewActivity,
} from './models.js';
import { sendMail, isConfigured, activeProvider } from './mailer.js';
import { configFor } from './notify.js';
import { readBlob } from './upload.js';
import { canSeeCandidate } from './candidate-scope.js';
import {
  globalTemplates, messageValues, fill, textToHtml, interviewIcs, EMAIL_OK, intlPhone, whatsappLink, detailsProblem, AUDIENCES,
} from './interview-messages.js';

export const EVENT_FOR = { invite: 'interview.scheduled', update: 'interview.updated', cancel: 'interview.cancelled' };
const nowISO = () => new Date().toISOString();

export function appUrl() {
  const list = String(process.env.CORS_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
  return list.find((x) => /^https?:\/\//.test(x) && !/localhost|127\.0\.0\.1/.test(x)) || null;
}
const notice = (iv) => { try { return iv.notice_state ? JSON.parse(iv.notice_state) : null; } catch { return null; } };

/* -------------------------------------------------------------- messages */

/** Per-interview edits over the global templates, for one kind. */
export function effectiveMessages(iv, kind) {
  const base = globalTemplates()[kind];
  const rows = all('SELECT audience, subject, body FROM interview_message WHERE interview_id=? AND kind=?', [iv.id, kind]);
  const out = {};
  for (const aud of AUDIENCES[kind]) {
    const own = rows.find((r) => r.audience === aud);
    out[aud] = own ? { subject: own.subject ?? base[aud].subject, body: own.body, custom: true } : { ...base[aud], custom: false };
  }
  return out;
}
export function saveMessages(iv, kind, messages, user) {
  for (const [aud, m] of Object.entries(messages)) {
    run(`INSERT INTO interview_message (interview_id,kind,audience,subject,body,updated_by,updated_at) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(interview_id,kind,audience) DO UPDATE SET subject=excluded.subject, body=excluded.body, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      [iv.id, kind, aud, m.subject ?? null, m.body, user.id, nowISO()]);
  }
}

function context(iv) {
  const candidate = Candidates.byId(iv.candidate_id);
  const request = iv.request_id ? Requests.byId(iv.request_id) : null;
  const organizer = iv.organizer_id ? Users.byId(iv.organizer_id) : null;
  const panel = InterviewPanel.forInterview(iv.id).map((m) => ({ id: m.interviewer_id, ...(Users.byId(m.interviewer_id) || {}), full_name: m.full_name }));
  return { candidate, request, organizer, panel };
}

/** Rendered messages for every audience (panel/removed per person). */
export function renderAll(iv, kind, { messages = null } = {}) {
  const msgs = messages || effectiveMessages(iv, kind);
  const { candidate, request, organizer, panel } = context(iv);
  const n = notice(iv);
  const base = { iv, candidate, request, organizer, panel, notice: n, appUrl: appUrl() };
  const one = (aud, recipient) => {
    const v = messageValues({ ...base, recipient });
    return { subject: msgs[aud]?.subject != null ? fill(msgs[aud].subject, v) : null, body: fill(msgs[aud]?.body, v) };
  };
  const out = { candidate: one('candidate', null), whatsapp: one('whatsapp', null), panel: {} };
  // On an update, panelists added since the last message get the invitation.
  const added = new Set(kind === 'update' ? (n?.addedPanel || []).map(Number) : []);
  const invite = added.size ? effectiveMessages(iv, 'invite') : null;
  for (const m of panel) {
    if (added.has(Number(m.id))) {
      const v = messageValues({ ...base, recipient: m });
      out.panel[m.id] = { subject: fill(invite.panel.subject, v), body: fill(invite.panel.body, v), asInvite: true };
    } else out.panel[m.id] = one('panel', m);
  }
  if (kind === 'update') {
    out.panelRemoved = {};
    for (const uid of (n?.removedPanel || []).map(Number)) {
      const u = Users.byId(uid);
      if (u) out.panelRemoved[uid] = one('panel_removed', u);
    }
  }
  return { rendered: out, messages: msgs, candidate, panel, organizer };
}

/* ------------------------------------------------------------- channels */

/** Can this kind of message go out by email at all, and if not, why. */
export function channelStatus(kind) {
  const cfg = configFor(EVENT_FOR[kind]);
  const provider = activeProvider();
  let blocked = null;
  if (!cfg || !cfg.enabled) blocked = { reason: 'notification_disabled', message: 'This message is switched off in Notifications.' };
  else if (!cfg.email) blocked = { reason: 'email_channel_off', message: 'Email is switched off for this message in Notifications.' };
  else if (!isConfigured()) blocked = { reason: 'mail_not_configured', message: 'Email is not configured, so nothing can be sent.' };
  return { email: !blocked, blocked, inApp: !!(cfg && cfg.enabled && cfg.inApp), dryRun: provider === 'dry-run', provider };
}

/** Recipients for a kind, with their addresses and whether they can be reached. */
export function recipients(iv, kind) {
  const { candidate, panel } = context(iv);
  const n = notice(iv);
  const list = [];
  const email = candidate?.email || null;
  list.push({ key: 'candidate', audience: 'candidate', name: candidate?.full_name || 'Candidate', address: email,
    reachable: EMAIL_OK(email), problem: email ? (EMAIL_OK(email) ? null : 'The candidate email address is not valid.') : 'The candidate has no email address on file.' });
  for (const m of panel) {
    list.push({ key: `user:${m.id}`, audience: 'panel', userId: m.id, name: m.full_name, address: m.email || null,
      reachable: EMAIL_OK(m.email), problem: EMAIL_OK(m.email) ? null : 'No valid email address for this panel member.',
      canAttachCv: !!candidate?.resume_path && !!Users.byId(m.id) && canSeeCandidate(userWithPerms(m.id), candidate.id),
      added: kind === 'update' && (n?.addedPanel || []).map(Number).includes(Number(m.id)) });
  }
  if (kind === 'update') {
    for (const uid of (n?.removedPanel || []).map(Number)) {
      const u = Users.byId(uid);
      if (u) list.push({ key: `user:${u.id}`, audience: 'panel_removed', userId: u.id, name: u.full_name, address: u.email || null, reachable: EMAIL_OK(u.email), problem: EMAIL_OK(u.email) ? null : 'No valid email address.' });
    }
  }
  const phone = intlPhone(candidate?.phone);
  return { list, whatsapp: { phone: candidate?.phone || null, valid: !!phone, problem: phone ? null : (candidate?.phone ? 'The phone number is not in international format (e.g. +201001234567).' : 'The candidate has no phone number on file.') } };
}

// Permissions of a stored user, for the CV-scope check of a panel recipient.
function userWithPerms(userId) {
  const rows = all(`SELECT DISTINCT p.code FROM user_role ur JOIN role_permission rp ON rp.role_id = ur.role_id
                    JOIN permission p ON p.id = rp.permission_id WHERE ur.user_id = ?`, [userId]);
  return { id: Number(userId), permissions: rows.map((r) => r.code) };
}

/* ----------------------------------------------------------------- send */

const STATUS_DONE = new Set(['accepted', 'dry_run']);
export function dispatchesFor(interviewId) {
  return all('SELECT * FROM interview_dispatch WHERE interview_id=? ORDER BY created_at DESC, id DESC', [interviewId])
    .map((r) => ({ id: r.id, batchKey: r.batch_key, kind: r.kind, revision: r.revision, audience: r.audience, recipientKey: r.recipient_key,
      recipientUserId: r.recipient_user_id, recipientName: r.recipient_name, recipientAddress: r.recipient_address, channel: r.channel,
      status: r.status, reason: r.reason, attachCv: r.attach_cv === 1, subject: r.subject, provider: r.provider, retryOf: r.retry_of,
      createdAt: r.created_at, updatedAt: r.updated_at }));
}

/**
 * Send one action. Returns { replayed, rows, summary } or throws {status, error}.
 * @param opts { kind, batchKey, candidate:boolean, panel:number[], attachCv:number[], retryFailed:boolean, actor, req }
 */
export async function sendAction(iv, opts) {
  const { kind, batchKey, actor } = opts;
  const existing = all('SELECT id FROM interview_dispatch WHERE interview_id=? AND batch_key=?', [iv.id, batchKey]);
  if (existing.length) return { replayed: true, rows: dispatchesFor(iv.id).filter((r) => r.batchKey === batchKey) };

  const { rendered, candidate } = renderAll(iv, kind);
  const reach = recipients(iv, kind);
  const chan = channelStatus(kind);
  const revision = Number(iv.calendar_seq || 0);

  // Who this action is for.
  let wanted = [];
  if (opts.retryFailed) {
    // Only recipients whose LATEST attempt for this kind and revision failed.
    const latest = new Map();
    for (const r of dispatchesFor(iv.id)) {
      if (r.kind !== kind || r.revision !== revision || r.channel !== 'email') continue;
      if (!latest.has(r.recipientKey)) latest.set(r.recipientKey, r);
    }
    wanted = [...latest.values()].filter((r) => r.status === 'failed')
      .map((r) => ({ ...reach.list.find((x) => x.key === r.recipientKey && x.audience === r.audience), retryOf: r.id, attachCv: r.attachCv }))
      .filter((x) => x.key);
    if (!wanted.length) return { replayed: false, rows: [], summary: { requested: 0 }, nothingToRetry: true };
  } else {
    const panelSet = new Set((opts.panel || []).map(Number));
    const cvSet = new Set((opts.attachCv || []).map(Number));
    wanted = reach.list.filter((x) => (x.audience === 'candidate' ? !!opts.candidate : panelSet.has(Number(x.userId))))
      .map((x) => ({ ...x, attachCv: x.audience === 'panel' && cvSet.has(Number(x.userId)) && !!x.canAttachCv }));
  }

  // Reserve every row first (unique per batch): a concurrent duplicate stops here.
  const reserved = [];
  for (const r of wanted) {
    const ins = run(`INSERT OR IGNORE INTO interview_dispatch (interview_id,batch_key,kind,revision,audience,recipient_key,recipient_user_id,recipient_name,recipient_address,channel,status,attach_cv,retry_of,created_by,created_at,updated_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [iv.id, batchKey, kind, revision, r.audience, r.key, r.userId || null, r.name, r.address, 'email', 'queued', r.attachCv ? 1 : 0, r.retryOf || null, actor.id, nowISO(), nowISO()]);
    if (!ins.changes) return { replayed: true, rows: dispatchesFor(iv.id).filter((x) => x.batchKey === batchKey) };
    reserved.push({ ...r, row: get('SELECT id FROM interview_dispatch WHERE batch_key=? AND recipient_key=? AND channel=?', [batchKey, r.key, 'email']).id });
  }

  const set = (id, status, extra = {}) => run('UPDATE interview_dispatch SET status=?, reason=?, subject=?, provider=?, updated_at=? WHERE id=?',
    [status, extra.reason || null, extra.subject || null, extra.provider || null, nowISO(), id]);
  const cvFile = candidate?.resume_path ? (() => { try { return readBlob(candidate.resume_path); } catch { return null; } })() : null;
  // Each person's calendar entry carries their own message, nobody else's.
  const icsFor = (audience, body) => interviewIcs({
    iv, cancelled: kind === 'cancel',
    summary: audience === 'candidate' ? 'Interview — Arabtec' : `Interview — ${candidate?.full_name || iv.interview_no}`,
    description: String(body || '').slice(0, 1500),
  });

  await Promise.all(reserved.map(async (r) => {
    const msg = r.audience === 'candidate' ? rendered.candidate
      : r.audience === 'panel_removed' ? rendered.panelRemoved?.[r.userId] : rendered.panel[r.userId];
    if (!msg) { set(r.row, 'not_sent', { reason: 'No message for this recipient.' }); return; }
    if (!chan.email) { set(r.row, 'not_sent', { reason: chan.blocked.message, subject: msg.subject }); return; }
    if (!r.reachable) { set(r.row, 'not_sent', { reason: r.problem, subject: msg.subject }); return; }
    const attachments = [];
    // The calendar entry goes to people who attend; a removed panelist gets none.
    if (r.audience !== 'panel_removed') {
      const ics = icsFor(r.audience, msg.body);
      if (ics) attachments.push({ filename: `${iv.interview_no}.ics`, contentType: 'text/calendar; charset=utf-8; method=PUBLISH', content: ics });
    }
    if (r.attachCv && r.audience === 'panel' && cvFile) {
      attachments.push({ filename: candidate.resume_name || 'cv', content: cvFile.data, ...(cvFile.mime ? { contentType: cvFile.mime } : {}) });
    }
    try {
      const res = await sendMail({ to: r.address, subject: msg.subject, html: textToHtml(msg.body), text: msg.body, attachments, replyTo: actor.email || undefined });
      if (res?.ok) set(r.row, res.provider === 'dry-run' ? 'dry_run' : 'accepted', { subject: msg.subject, provider: res.provider || null });
      else if (res?.skipped) set(r.row, 'not_sent', { reason: 'Email is not configured, so nothing was sent.', subject: msg.subject });
      else set(r.row, 'failed', { reason: res?.error || 'The mail provider refused the message.', subject: msg.subject, provider: res?.provider || null });
    } catch (e) {
      set(r.row, 'failed', { reason: String((e && e.message) || e), subject: msg.subject });
    }
  }));

  const rows = dispatchesFor(iv.id).filter((x) => x.batchKey === batchKey);
  const summary = { requested: rows.length, done: rows.filter((x) => STATUS_DONE.has(x.status)).length,
    failed: rows.filter((x) => x.status === 'failed').length, notSent: rows.filter((x) => x.status === 'not_sent').length,
    dryRun: rows.some((x) => x.status === 'dry_run') };

  // In-app alerts for panel recipients (the existing Notifications switch).
  if (chan.inApp) {
    for (const r of reserved.filter((x) => x.audience !== 'candidate')) {
      try { Notifications.create({ userId: r.userId, type: EVENT_FOR[kind], title: rendered.panel[r.userId]?.subject || rendered.panelRemoved?.[r.userId]?.subject || `Interview ${iv.interview_no}`, body: '', linkType: 'interview', linkId: iv.id }); } catch { /* never fail a send on an alert */ }
    }
  }
  // Candidate activity: only what actually happened.
  const cRow = rows.find((x) => x.audience === 'candidate');
  if (cRow && candidate) {
    const type = cRow.status === 'accepted' ? 'email_sent' : cRow.status === 'dry_run' ? 'email_not_sent' : cRow.status === 'failed' ? 'email_failed' : 'email_not_sent';
    const what = kind === 'invite' ? 'Interview invitation' : kind === 'update' ? 'Interview update' : 'Interview cancellation';
    const note = cRow.status === 'accepted' ? `${what} accepted by the mail provider for ${cRow.recipientAddress}`
      : cRow.status === 'dry_run' ? `${what} — test transport, not delivered`
        : `${what} not sent: ${cRow.reason || cRow.status}`;
    try { CandidateActivity.add({ candidateId: candidate.id, applicationId: iv.application_id, actorId: actor.id, actorName: 'System', type, note }); } catch { /* never fail */ }
  }
  InterviewActivity.add(iv.id, actor, kind === 'invite' ? 'invitations_sent' : kind === 'update' ? 'update_sent' : 'cancellation_sent',
    `${summary.done} sent${summary.dryRun ? ' (test transport, not delivered)' : ''}, ${summary.failed} failed, ${summary.notSent} not sent`);

  // A pending change or cancellation counts as communicated once anyone was reached.
  const n = notice(iv);
  if (n && n.kind === kind && summary.done > 0) {
    Interviews.setNotice(iv.id, { ...n, communicated: true, communicatedAt: nowISO(), batchKey, summary });
  }
  return { replayed: false, rows, summary };
}

/** Record a manual WhatsApp hand-off: opened by a person, never "sent". */
export function recordWhatsappHandoff(iv, { kind, batchKey, actor }) {
  const { rendered, candidate } = renderAll(iv, kind);
  const link = whatsappLink(candidate?.phone, rendered.whatsapp.body);
  if (!link) return { error: 'The candidate has no phone number in international format (e.g. +201001234567).' };
  run(`INSERT OR IGNORE INTO interview_dispatch (interview_id,batch_key,kind,revision,audience,recipient_key,recipient_name,recipient_address,channel,status,reason,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [iv.id, batchKey, kind, Number(iv.calendar_seq || 0), 'candidate', 'candidate', candidate?.full_name || 'Candidate', intlPhone(candidate?.phone), 'whatsapp', 'manual_handoff',
      'Opened in WhatsApp for a person to send. Not confirmed as sent.', actor.id, nowISO(), nowISO()]);
  return { link, text: rendered.whatsapp.body };
}

export { detailsProblem };
