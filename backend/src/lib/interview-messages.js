// Interview invitations, updates and cancellations — the words, the
// substitutions, the calendar entry and the WhatsApp hand-off.
// Audit 2026-10-06 (INTERVIEW_IMPLEMENTATION_BRIEF.md, decisions 4–9).
//
// Messages are PLAIN-TEXT templates with a bounded set of {{placeholders}}.
// Plain text is the safety boundary: whatever a recruiter types, and every
// substituted value, is escaped before it becomes email HTML, so template
// editing can never inject markup. Each audience has its own allowed set: the
// candidate's never includes the CV link, interview reference, panel-only
// notes or a cancellation's internal reason; a removed panelist's never
// includes the NEW details.
//
// Times are Africa/Cairo (the organisation default) with the offset computed
// for that instant, so daylight-saving changes are always right. The stored
// instant stays UTC; calendars get UTC with a stable UID and rising SEQUENCE.
import { SystemSettings } from './models.js';

export const ORG_TIMEZONE = process.env.INTERVIEW_TZ || 'Africa/Cairo';
export const KINDS = ['invite', 'update', 'cancel', 'reminder'];
export const TEMPLATE_SETTING = 'interview_message_templates';

// name → { label, audiences } ; audiences: c = candidate email, w = WhatsApp,
// p = panel, r = removed panelist.
export const PLACEHOLDERS = {
  candidateName: { label: 'Candidate full name', in: 'cwprk' },
  candidateFirstName: { label: 'Candidate first name', in: 'cwpk' },
  position: { label: 'Position / role', in: 'cwpk' },
  interviewType: { label: 'Interview type', in: 'cwpk' },
  date: { label: 'Date (Cairo)', in: 'cwpk' },
  time: { label: 'Start time (Cairo)', in: 'cwpk' },
  timezone: { label: 'Time zone, e.g. Cairo time (GMT+3)', in: 'cwprk' },
  duration: { label: 'Duration', in: 'cwpk' },
  mode: { label: 'Mode (on site / video / phone)', in: 'cwpk' },
  where: { label: 'Where: location, meeting link or phone, labelled', in: 'cwpk' },
  panelNames: { label: 'Panel members', in: 'cp' },
  recruiterName: { label: 'Recruiter (organiser) name', in: 'cwprk' },
  recruiterEmail: { label: 'Recruiter email', in: 'cwprk' },
  recruiterPhone: { label: 'Recruiter phone', in: 'cwprk' },
  companyName: { label: 'Company name', in: 'cwprk' },
  changes: { label: 'What changed (updates)', in: 'cwpk' },
  previousDate: { label: 'Previous date (updates)', in: 'cwprk' },
  previousTime: { label: 'Previous time (updates)', in: 'cwprk' },
  recipientName: { label: 'Panel recipient name', in: 'pr' },
  interviewNo: { label: 'Interview reference', in: 'pr' },
  requestRef: { label: 'Hiring request reference', in: 'p' },
  cvLink: { label: 'Authenticated link to the CV and interview', in: 'p' },
  cancelReason: { label: 'Cancellation reason (internal)', in: 'p' },
};
// k = phone-call script (audit A11, from PR #46): read out by a person, so it
// may use exactly what a WhatsApp message may use.
const AUDIENCE_CODE = { candidate: 'c', whatsapp: 'w', call: 'k', panel: 'p', panel_removed: 'r' };
export const AUDIENCES = { invite: ['candidate', 'panel', 'whatsapp', 'call'], update: ['candidate', 'panel', 'whatsapp', 'call', 'panel_removed'], cancel: ['candidate', 'panel', 'whatsapp', 'call'],
  // Reminder (audit A7, from PR #46): same audiences so the engine stays uniform;
  // the send dialog pre-selects only the candidate.
  reminder: ['candidate', 'panel', 'whatsapp', 'call'] };
export const HAS_SUBJECT = { candidate: true, panel: true, panel_removed: true, whatsapp: false, call: false };

const SIGN = '{{recruiterName}}\nArabtec Recruitment Team\n{{recruiterEmail}}';
export const DEFAULT_TEMPLATES = {
  invite: {
    candidate: {
      subject: 'Interview invitation — {{position}} — Arabtec',
      body: `Dear {{candidateName}},\n\nThank you for your interest in Arabtec. We would like to invite you to an interview for the {{position}} role.\n\nDate: {{date}}\nTime: {{time}} ({{timezone}})\nDuration: {{duration}}\n{{where}}\n\nPlease reply to confirm your attendance. If the time does not suit you, let us know and we will arrange an alternative.\n\nKind regards,\n${SIGN}`,
    },
    panel: {
      subject: 'Interview {{interviewNo}} — {{candidateName}} — {{date}} {{time}}',
      body: 'Hello {{recipientName}},\n\nYou are on the interview panel for {{candidateName}} ({{position}}).\n\nDate: {{date}}\nTime: {{time}} ({{timezone}})\nDuration: {{duration}}\n{{where}}\nPanel: {{panelNames}}\n\nThe CV and the interview details are in the Recruitment Hub (sign-in required):\n{{cvLink}}\n\nOrganised by {{recruiterName}} ({{recruiterEmail}}).',
    },
    whatsapp: { body: 'Dear {{candidateFirstName}}, Arabtec would like to invite you to an interview for the {{position}} role on {{date}} at {{time}} ({{timezone}}). {{where}}. Please reply to confirm. — {{recruiterName}}, Arabtec Recruitment' },
    call: { body: 'Hello, may I speak to {{candidateName}}? This is {{recruiterName}} from Arabtec Recruitment.\nI am calling about your application for the {{position}} role. We would like to invite you to an interview on {{date}} at {{time}} ({{timezone}}).\nIt is a {{interviewType}} interview. {{where}}.\nCan you attend at that time?\n(If not, ask which days and times suit them.)\nThank you — we will also send the details by WhatsApp or email.' },
  },
  update: {
    candidate: {
      subject: 'Updated interview details — {{position}} — Arabtec',
      body: `Dear {{candidateName}},\n\nThe details of your interview for the {{position}} role have changed.\n\n{{changes}}\n\nUpdated details:\nDate: {{date}}\nTime: {{time}} ({{timezone}})\nDuration: {{duration}}\n{{where}}\n\nPlease reply to confirm that the new details suit you.\n\nKind regards,\n${SIGN}`,
    },
    panel: {
      subject: 'Updated: interview {{interviewNo}} — {{candidateName}} — {{date}} {{time}}',
      body: 'Hello {{recipientName}},\n\nThe interview with {{candidateName}} ({{position}}) has changed.\n\n{{changes}}\n\nDate: {{date}}\nTime: {{time}} ({{timezone}})\nDuration: {{duration}}\n{{where}}\nPanel: {{panelNames}}\n\nDetails and CV: {{cvLink}}',
    },
    whatsapp: { body: 'Dear {{candidateFirstName}}, your Arabtec interview for the {{position}} role has changed. New details: {{date}} at {{time}} ({{timezone}}). {{where}}. Please reply to confirm. — {{recruiterName}}, Arabtec Recruitment' },
    call: { body: 'Hello {{candidateName}}, this is {{recruiterName}} from Arabtec Recruitment.\nI am calling about your interview for the {{position}} role. The details have changed: it is now on {{date}} at {{time}} ({{timezone}}). {{where}}.\nDoes the new time suit you?\nThank you, and sorry for the change.' },
    panel_removed: {
      subject: 'You are no longer on the panel — interview {{interviewNo}}',
      body: 'Hello {{recipientName}},\n\nYou are no longer on the panel for interview {{interviewNo}} with {{candidateName}}, previously planned for {{previousDate}} at {{previousTime}} ({{timezone}}). No action is needed.\n\n{{recruiterName}} ({{recruiterEmail}})',
    },
  },
  cancel: {
    candidate: {
      subject: 'Interview cancelled — {{position}} — Arabtec',
      body: `Dear {{candidateName}},\n\nWe are sorry to let you know that your interview for the {{position}} role on {{date}} at {{time}} ({{timezone}}) has been cancelled. We will contact you about next steps.\n\nKind regards,\n${SIGN}`,
    },
    panel: {
      subject: 'Cancelled: interview {{interviewNo}} — {{candidateName}} — {{date}} {{time}}',
      body: 'Hello {{recipientName}},\n\nThe interview with {{candidateName}} on {{date}} at {{time}} ({{timezone}}) has been cancelled.\nReason: {{cancelReason}}\n\n{{recruiterName}}',
    },
    whatsapp: { body: 'Dear {{candidateFirstName}}, your Arabtec interview for the {{position}} role on {{date}} at {{time}} ({{timezone}}) has been cancelled. We will contact you about next steps. — {{recruiterName}}, Arabtec Recruitment' },
    call: { body: 'Hello {{candidateName}}, this is {{recruiterName}} from Arabtec Recruitment.\nI am sorry to tell you that your interview for the {{position}} role on {{date}} at {{time}} has been cancelled.\nWe will contact you about next steps. Thank you for your understanding.' },
  },
  reminder: {
    candidate: {
      subject: 'Reminder: your Arabtec interview on {{date}} — {{position}}',
      body: `Dear {{candidateName}},\n\nThis is a reminder of your interview for the {{position}} role.\n\nDate: {{date}}\nTime: {{time}} ({{timezone}})\nDuration: {{duration}}\n{{where}}\n\nIf anything has changed on your side, please reply to let us know.\n\nKind regards,\n${SIGN}`,
    },
    panel: {
      subject: 'Reminder: interview {{interviewNo}} — {{candidateName}} — {{date}} {{time}}',
      body: 'Hello {{recipientName}},\n\nA reminder of your interview with {{candidateName}} for {{position}} on {{date}} at {{time}} ({{timezone}}), {{duration}}.\n{{where}}\nPanel: {{panelNames}}\n\nCV and interview: {{cvLink}}\n\n{{recruiterName}}',
    },
    whatsapp: { body: 'Dear {{candidateFirstName}}, a reminder of your Arabtec interview for the {{position}} role on {{date}} at {{time}} ({{timezone}}). {{where}}. See you then. — {{recruiterName}}, Arabtec Recruitment' },
    call: { body: 'Hello {{candidateName}}, this is {{recruiterName}} from Arabtec Recruitment.\nA quick reminder of your interview for the {{position}} role on {{date}} at {{time}} ({{timezone}}). {{where}}.\nCan you confirm you will attend?\nThank you, see you then.' },
  },
};
export const LIMITS = { subject: 200, body: 5000 };

/* ------------------------------------------------------------ templates */

// GitHub PR #46 kept its own templates under this same settings key, as
// { kind: { subject, email, whatsapp, call } } with {snake_case} tokens and a
// "reschedule" kind. A database that ran it is read through this conversion,
// never spread as-is (a string spread into an object becomes one field per
// character). A converted part that fails our placeholder rules is dropped, so
// the default is used rather than an unchecked text.
const LEGACY_KIND = { invite: 'invite', reschedule: 'update', cancel: 'cancel', reminder: 'reminder' };
const LEGACY_FIELD = { email: ['candidate', 'body'], subject: ['candidate', 'subject'], whatsapp: ['whatsapp', 'body'], call: ['call', 'body'] };
const LEGACY_TOKEN = { candidate_name: 'candidateName', position: 'position', date: 'date', time: 'time', duration: 'duration',
  interview_type: 'interviewType', where: 'where', interviewers: 'panelNames', recruiter_name: 'recruiterName',
  reference: 'interviewNo', reason: 'cancelReason' };
const isLegacyEntry = (v) => !!v && typeof v === 'object' && ['subject', 'email', 'whatsapp', 'call'].some((f) => typeof v[f] === 'string');

function fromLegacy(entry) {
  const out = {};
  for (const [field, [aud, part]] of Object.entries(LEGACY_FIELD)) {
    if (typeof entry[field] !== 'string') continue;
    let unknown = false;
    const text = entry[field].replace(/\{([a-z_]+)\}/gi, (m, name) => {
      if (!LEGACY_TOKEN[name]) { unknown = true; return m; }
      return `{{${LEGACY_TOKEN[name]}}}`;
    });
    if (unknown || validateText(part === 'subject' ? text.replace(/\s*\n\s*/g, ' ') : text, aud, part)) continue;
    (out[aud] ||= {})[part] = text;
  }
  return out;
}

/** Stored overrides in our format, whatever format the setting was saved in. */
export function storedTemplates(raw = SystemSettings.all()[TEMPLATE_SETTING]) {
  let parsed = {};
  try { parsed = JSON.parse(raw || '{}') || {}; } catch { parsed = {}; }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  for (const [kind, val] of Object.entries(parsed)) {
    if (isLegacyEntry(val)) {
      const ours = LEGACY_KIND[kind];
      if (!ours) continue; // e.g. "reminder" — not a kind we send (yet)
      const conv = fromLegacy(val);
      for (const [aud, parts] of Object.entries(conv)) out[ours] = { ...(out[ours] || {}), [aud]: { ...(out[ours]?.[aud] || {}), ...parts } };
      continue;
    }
    if (!KINDS.includes(kind) || !val || typeof val !== 'object') continue;
    for (const [aud, parts] of Object.entries(val)) {
      if (!AUDIENCES[kind].includes(aud) || !parts || typeof parts !== 'object' || Array.isArray(parts)) continue;
      const clean = {};
      for (const p of ['subject', 'body']) if (typeof parts[p] === 'string') clean[p] = parts[p];
      // An entry written in our format wins over one converted from the old format.
      out[kind] = { ...(out[kind] || {}), [aud]: { ...(out[kind]?.[aud] || {}), ...clean } };
    }
  }
  return out;
}

/** The organisation's templates: stored overrides on top of the defaults. */
export function globalTemplates() {
  const stored = storedTemplates();
  const out = {};
  for (const kind of KINDS) {
    out[kind] = {};
    for (const aud of AUDIENCES[kind]) out[kind][aud] = { ...DEFAULT_TEMPLATES[kind][aud], ...(stored?.[kind]?.[aud] || {}) };
  }
  return out;
}

/**
 * Validate one message part. Returns null or an error string. Rejects tokens
 * that do not exist, tokens not allowed for this audience, and stray braces —
 * nothing unresolved can reach a recipient.
 */
export function validateText(text, audience, part = 'body') {
  if (typeof text !== 'string') return `The ${part} must be text.`;
  if (part === 'body' && !text.trim()) return 'The message cannot be empty.';
  if (text.length > LIMITS[part]) return `The ${part} is too long (${LIMITS[part]} characters at most).`;
  const code = AUDIENCE_CODE[audience];
  const bad = [];
  const stripped = text.replace(/\{\{\s*([A-Za-z]+)\s*\}\}/g, (m, name) => {
    const ph = PLACEHOLDERS[name];
    if (!ph) bad.push(`{{${name}}} is not a known placeholder`);
    else if (!ph.in.includes(code)) bad.push(`{{${name}}} cannot be used in this message`);
    return '';
  });
  if (/\{\{|\}\}/.test(stripped)) bad.push('there is an unmatched {{ or }}');
  return bad.length ? `Fix the placeholders: ${bad.join('; ')}.` : null;
}

/** Validate a full template set (or a partial patch of one). */
export function validateTemplateSet(set) {
  if (!set || typeof set !== 'object' || Array.isArray(set)) return 'Templates must be an object.';
  for (const [kind, auds] of Object.entries(set)) {
    if (!KINDS.includes(kind)) return `Unknown message kind "${kind}".`;
    if (!auds || typeof auds !== 'object') return `Messages for "${kind}" must be an object.`;
    for (const [aud, parts] of Object.entries(auds)) {
      if (!AUDIENCES[kind].includes(aud)) return `Unknown recipient "${aud}" for ${kind}.`;
      for (const [part, text] of Object.entries(parts || {})) {
        if (part !== 'body' && !(part === 'subject' && HAS_SUBJECT[aud])) return `Unknown field "${part}" for ${kind} ${aud}.`;
        const err = validateText(text, aud, part);
        if (err) return `${kind} — ${aud} ${part}: ${err}`;
      }
    }
  }
  return null;
}

/* --------------------------------------------------------------- values */

function parts(instant, tz = ORG_TIMEZONE) {
  const d = new Date(instant);
  const fmt = (o) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...o }).format(d);
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value || 'GMT';
  return {
    date: fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    time: fmt({ hour: '2-digit', minute: '2-digit', hour12: false }),
    timezone: `Cairo time (${offset})`,
  };
}
/** Cairo date/time/zone for an instant — shared by messages and the UI. */
export const cairoParts = (instant) => parts(instant);

const MODE_LABEL = { onsite: 'On site', video: 'Video call', phone: 'Phone call' };
const TYPE_LABEL = { phone: 'Phone screen', technical: 'Technical', client: 'Client', final: 'Final', hr: 'HR', reference: 'Reference' };
const CHANGE_LABEL = { date_time: 'date and time', duration: 'duration', location_or_link: 'location or meeting link', mode: 'interview mode', panel: 'interview panel' };
export const duration = (min) => { const m = Number(min) || 60; return m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : m > 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} minutes`; };
export function whereLine(mode, locationOrLink) {
  const v = String(locationOrLink || '').trim();
  if (mode === 'video') return v ? `Meeting link: ${v}` : 'Meeting link: to follow';
  if (mode === 'phone') return v ? `Phone: ${v}` : 'Phone: we will call you';
  return v ? `Location: ${v}` : 'Location: to follow';
}

/**
 * Every placeholder value for one interview and one recipient.
 * @param ctx { iv, candidate, request, organizer, panel:[{full_name}], recipient, notice, appUrl }
 */
export function messageValues({ iv, candidate, request, organizer, panel = [], recipient = null, notice = null, appUrl = null }) {
  const now = parts(iv.scheduled_at);
  const prev = notice?.previous?.scheduledAt ? parts(notice.previous.scheduledAt) : now;
  const full = String(candidate?.full_name || '').trim();
  return {
    candidateName: full, candidateFirstName: full.split(/\s+/)[0] || full,
    // Empty when unknown: fill() then tidies "the  role", "— —" and "()".
    position: String(request?.title || candidate?.current_position || '').trim(),
    interviewType: TYPE_LABEL[iv.interview_type] || iv.interview_type || 'Interview',
    date: now.date, time: now.time, timezone: now.timezone,
    duration: duration(iv.duration_min),
    mode: MODE_LABEL[iv.mode] || iv.mode,
    where: whereLine(iv.mode, iv.location_or_link),
    panelNames: panel.map((m) => m.full_name).filter(Boolean).join(', ') || '—',
    recruiterName: organizer?.full_name || 'Arabtec Recruitment',
    recruiterEmail: organizer?.email || '',
    recruiterPhone: organizer?.phone || '',
    companyName: 'Arabtec',
    changes: (notice?.changes || []).length ? `What changed: ${notice.changes.map((c) => CHANGE_LABEL[c] || c).join(', ')}.` : '',
    previousDate: prev.date, previousTime: prev.time,
    recipientName: recipient?.full_name || '',
    interviewNo: iv.interview_no || '',
    requestRef: request?.ticket_no || '—',
    cvLink: appUrl ? `${appUrl.replace(/\/$/, '')}/#interviews/${iv.id}` : 'Open interview ' + (iv.interview_no || '') + ' in the Recruitment Hub.',
    cancelReason: iv.cancel_reason || '—',
  };
}

/** Substitute placeholders in plain text (values are plain text too). */
export function fill(text, values) {
  return String(text || '').replace(/\{\{\s*([A-Za-z]+)\s*\}\}/g, (m, name) => (values[name] ?? ''))
    // An empty value must not leave a gap: "the  role" → "the role",
    // "invitation —  — Arabtec" → "invitation — Arabtec", "Name ()" → "Name".
    .replace(/(\S)[ \t]{2,}/g, '$1 ')
    .replace(/ — (?:— )+/g, ' — ')
    .replace(/[ \t]*\([ \t]*\)/g, '')
    .replace(/(\S) +([,.])/g, '$1$2');
}

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/**
 * Plain text → email HTML: everything escaped first, then http(s) links made
 * clickable and line breaks kept. No other markup can appear.
 */
export function textToHtml(text) {
  const safe = esc(text).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`);
  return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1a1f27;font-size:14px;line-height:1.6;">
<div style="max-width:620px;margin:0 auto;background:#fff;border:1px solid #e3e6ea;border-radius:8px;padding:24px 28px;white-space:normal;">${safe.replace(/\r?\n/g, '<br>')}</div>
</body></html>`;
}

/* ------------------------------------------------------------ calendar */
const icsText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsDate = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
/**
 * A calendar entry. UID never changes for an interview; SEQUENCE is its
 * revision. PUBLISH = an entry to add (the ATS does not track replies, so no
 * acceptance is promised); a cancellation is the same entry, STATUS:CANCELLED.
 */
export function interviewIcs({ iv, summary, description, cancelled = false }) {
  const start = new Date(iv.scheduled_at);
  if (isNaN(start)) return null;
  const end = new Date(start.getTime() + (Number(iv.duration_min) || 60) * 60000);
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Arabtec Recruitment Hub//EN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${iv.interview_no || iv.id}@arabtec-recruitment-hub`, `SEQUENCE:${Number(iv.calendar_seq || 0)}`, `DTSTAMP:${icsDate(Date.now())}`,
    `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`, `SUMMARY:${icsText(summary)}`,
    ...(iv.location_or_link ? [`LOCATION:${icsText(iv.location_or_link)}`] : []),
    `DESCRIPTION:${icsText(description)}`, `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}

/* ------------------------------------------------------- contact checks */
export const EMAIL_OK = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
/** International phone (E.164): + then 8–15 digits; spaces, dashes, brackets ignored. */
/**
 * A phone number in international (E.164) form, or null. Accepts what people
 * actually type and what CVs contain (audit A11, from PR #46):
 *   • the FIRST number when several are listed ("010… / 012…", "010…, 011…");
 *   • Arabic-Indic and Persian digits;
 *   • 00-prefixed international numbers (0020… → +20…);
 *   • Egyptian mobiles in local form (010/011/012/015 + 8 digits → +20…), with
 *     or without the leading 0 after 20 (201… → +201…).
 * Anything else — e.g. a local landline without its country code — stays null,
 * so the UI asks for the international form instead of guessing.
 */
export function intlPhone(v) {
  const first = String(v || '').split(/\s*(?:[,;|\/]|\bor\b|\s{2,})\s*/i).find((x) => /[0-9\u0660-\u0669\u06F0-\u06F9]/.test(x)) || '';
  let d = first.trim()
    .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 0x06F0))
    .replace(/[\s\-().\u200e\u200f]/g, '');
  if (/^00[1-9]/.test(d)) d = '+' + d.slice(2);
  else if (/^01[0125]\d{8}$/.test(d)) d = '+20' + d.slice(1);
  else if (/^201[0125]\d{8}$/.test(d)) d = '+' + d;
  return /^\+[1-9]\d{7,14}$/.test(d) ? d : null;
}
/** tel: link for a phone call, or null. Opening it is a person calling. */
export function telLink(phone) { const p = intlPhone(phone); return p ? `tel:${p}` : null; }
export function validHttpsLink(v) { try { const u = new URL(String(v || '').trim()); return u.protocol === 'https:' ? u.href : null; } catch { return null; } }

/** What must be true of the interview details before anything is sent. */
export function detailsProblem(iv) {
  const v = String(iv.location_or_link || '').trim();
  if (iv.mode === 'video' && !validHttpsLink(v)) return 'A video interview needs a valid https meeting link before invitations can be sent.';
  if (iv.mode === 'onsite' && !v) return 'An on-site interview needs a location before invitations can be sent.';
  if (iv.mode === 'phone' && !v) return 'A phone interview needs the phone number or call arrangement before invitations can be sent.';
  return null;
}

/** wa.me link: opens WhatsApp with the text; the person sends it. */
export function whatsappLink(phone, text) {
  const p = intlPhone(phone);
  return p ? `https://wa.me/${p.slice(1)}?text=${encodeURIComponent(text)}` : null;
}
