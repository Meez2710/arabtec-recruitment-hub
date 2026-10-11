// Messages to interview candidates: the wording HR controls, and the one place
// that fills it in for a given interview.
//
// Four messages, each with an email subject, an email text, a WhatsApp text
// and a call script (what to say when phoning the candidate). HR edits them under Interviews → Message templates; what they save is
// stored as overrides in system_setting, so an untouched message keeps
// following the defaults below.
//
// WhatsApp goes out through the recruiter's own WhatsApp (a wa.me link opens
// the chat with the text filled in); a call dials from the recruiter's phone
// (a tel: link) with the script on screen. Nothing is sent by the server on
// WhatsApp: that needs a WhatsApp Business account, which the company does not
// have yet. Email goes out through the configured mailbox.
import { SystemSettings } from './models.js';

export const MESSAGE_KINDS = ['invite', 'reschedule', 'cancel', 'reminder'];
export const MESSAGE_LABELS = {
  invite: 'Interview invitation',
  reschedule: 'New interview time',
  cancel: 'Interview cancelled',
  reminder: 'Reminder',
};

// What a template may contain. Each is replaced with the interview's value.
export const PLACEHOLDERS = {
  candidate_name: 'Candidate’s name',
  position: 'Position',
  date: 'Interview date',
  time: 'Interview time',
  duration: 'Length, e.g. 60 minutes',
  interview_type: 'Type, e.g. Technical interview',
  where: 'Place, video link or phone number',
  interviewers: 'Interviewer names',
  recruiter_name: 'Your name',
  reference: 'Interview reference',
  reason: 'Reason (cancellation only)',
};

export const DEFAULT_TEMPLATES = {
  invite: {
    subject: 'Interview invitation — {position}',
    email: 'Dear {candidate_name},\n\nThank you for your interest in Arabtec. We are pleased to invite you to an interview for the {position} role.\n\nDate: {date}\nTime: {time} ({duration})\nInterview: {interview_type}\nWhere: {where}\n\nPlease reply to confirm that you can attend. If the time does not suit you, let us know and we will arrange another.\n\nKind regards,\n{recruiter_name}\nArabtec Recruitment',
    whatsapp: 'Hello {candidate_name}, this is {recruiter_name} from Arabtec Recruitment. You are invited to an interview for the {position} role on {date} at {time}. Where: {where}. Please reply to confirm. Thank you.',
    call: 'Hello, may I speak to {candidate_name}? This is {recruiter_name} from Arabtec Recruitment.\nI am calling about your application for the {position} role. We would like to invite you to an interview on {date} at {time}.\nIt is a {interview_type}, {where}.\nCan you attend at that time?\n(If not, ask which days and times suit them.)\nThank you, we will also send the details on WhatsApp or email.',
  },
  reschedule: {
    subject: 'New interview time — {position}',
    email: 'Dear {candidate_name},\n\nYour interview for the {position} role has moved to a new time.\n\nDate: {date}\nTime: {time} ({duration})\nWhere: {where}\n\nPlease reply to confirm that the new time suits you.\n\nKind regards,\n{recruiter_name}\nArabtec Recruitment',
    whatsapp: 'Hello {candidate_name}, this is {recruiter_name} from Arabtec Recruitment. Your interview for the {position} role has moved to {date} at {time}. Where: {where}. Please reply to confirm. Thank you.',
    call: 'Hello {candidate_name}, this is {recruiter_name} from Arabtec Recruitment.\nI am calling about your interview for the {position} role. We need to move it to {date} at {time}, {where}.\nDoes the new time suit you?\nThank you, and sorry for the change.',
  },
  cancel: {
    subject: 'Interview cancelled — {position}',
    email: 'Dear {candidate_name},\n\nWe are sorry to let you know that your interview for the {position} role on {date} at {time} has been cancelled.\n\nWe will contact you if a new time is arranged.\n\nKind regards,\n{recruiter_name}\nArabtec Recruitment',
    whatsapp: 'Hello {candidate_name}, this is {recruiter_name} from Arabtec Recruitment. We are sorry, your interview for the {position} role on {date} at {time} has been cancelled. We will contact you if a new time is arranged.',
    call: 'Hello {candidate_name}, this is {recruiter_name} from Arabtec Recruitment.\nI am sorry to tell you that your interview for the {position} role on {date} at {time} has been cancelled.\nWe will contact you if a new time is arranged. Thank you for your understanding.',
  },
  reminder: {
    subject: 'Reminder: your interview on {date}',
    email: 'Dear {candidate_name},\n\nThis is a reminder of your interview for the {position} role.\n\nDate: {date}\nTime: {time}\nWhere: {where}\n\nWe look forward to meeting you.\n\nKind regards,\n{recruiter_name}\nArabtec Recruitment',
    whatsapp: 'Hello {candidate_name}, a reminder of your interview with Arabtec for the {position} role on {date} at {time}. Where: {where}. See you then.',
    call: 'Hello {candidate_name}, this is {recruiter_name} from Arabtec Recruitment.\nA quick reminder of your interview for the {position} role on {date} at {time}, {where}.\nCan you confirm you will attend?\nThank you, see you then.',
  },
};

const SETTING_KEY = 'interview_message_templates';
const FIELDS = ['subject', 'email', 'whatsapp', 'call'];
const MAX_LEN = { subject: 200, email: 5000, whatsapp: 1500, call: 3000 };
const FIELD_NAME = { subject: 'subject', email: 'email text', whatsapp: 'WhatsApp text', call: 'call script' };

function savedOverrides() {
  try {
    const parsed = JSON.parse(SystemSettings.get(SETTING_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

/** Every message as it currently reads, with whether HR has changed it. */
export function currentTemplates() {
  const saved = savedOverrides();
  const out = {};
  for (const kind of MESSAGE_KINDS) {
    const t = { ...DEFAULT_TEMPLATES[kind] };
    for (const f of FIELDS) if (typeof saved[kind]?.[f] === 'string') t[f] = saved[kind][f];
    out[kind] = { ...t, label: MESSAGE_LABELS[kind], customised: FIELDS.some((f) => t[f] !== DEFAULT_TEMPLATES[kind][f]) };
  }
  return out;
}

/** Placeholder names a text uses that do not exist. */
export function unknownPlaceholders(text) {
  const found = [...String(text || '').matchAll(/\{([a-z_]+)\}/gi)].map((m) => m[1]);
  return [...new Set(found.filter((name) => !Object.hasOwn(PLACEHOLDERS, name)))];
}

/**
 * Validate and store one message. Returns { error } or { templates }.
 * `reset: true` puts the message back to the default wording.
 */
export function saveTemplate(kind, body = {}) {
  if (!MESSAGE_KINDS.includes(kind)) return { error: 'Unknown message.' };
  const saved = savedOverrides();
  if (body.reset) {
    delete saved[kind];
  } else {
    const next = {};
    for (const f of FIELDS) {
      const v = body[f];
      if (typeof v !== 'string' || !v.trim()) return { error: `The ${FIELD_NAME[f]} cannot be empty.` };
      if (v.length > MAX_LEN[f]) return { error: `The ${FIELD_NAME[f]} is too long (${MAX_LEN[f]} characters at most).` };
      const bad = unknownPlaceholders(v);
      if (bad.length) return { error: `Unknown placeholder {${bad[0]}}. Use one of the listed placeholders.` };
      next[f] = f === 'subject' ? v.replace(/\s*\n\s*/g, ' ').trim() : v.replace(/\r\n/g, '\n');
    }
    saved[kind] = next;
  }
  SystemSettings.upsert(SETTING_KEY, JSON.stringify(saved));
  return { templates: currentTemplates() };
}

/** Replace {placeholders}; one that has no value becomes an empty string. */
export function fill(text, vars) {
  return String(text || '').replace(/\{([a-z_]+)\}/gi, (whole, name) => (
    Object.hasOwn(PLACEHOLDERS, name) ? String(vars[name] ?? '') : whole
  ));
}

const TYPE_LABEL = { phone: 'Phone screen', technical: 'Technical interview', client: 'Client interview', final: 'Final interview', hr: 'HR interview', reference: 'Reference check' };
const MODE_WORD = { onsite: 'On site', video: 'Video call', phone: 'Phone call' };

// Dates read the same for every recipient: the company's own clock (Cairo),
// not whatever time zone the server happens to run in.
const TZ = process.env.APP_TIME_ZONE || 'Africa/Cairo';
function dateText(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ });
}
function timeText(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
}

/** The values for one interview. `iv` is a database row; the rest are rows too. */
export function interviewVars({ iv, candidate, request, panel = [], sender, reason }) {
  const where = iv.location_or_link
    ? (iv.mode === 'onsite' ? iv.location_or_link : `${MODE_WORD[iv.mode] || 'Online'} — ${iv.location_or_link}`)
    : (MODE_WORD[iv.mode] ? `${MODE_WORD[iv.mode]} (details to follow)` : 'Details to follow');
  return {
    candidate_name: candidate?.full_name || 'Candidate',
    position: request?.title || candidate?.current_position || 'advertised',
    date: dateText(iv.scheduled_at),
    time: timeText(iv.scheduled_at),
    duration: `${Number(iv.duration_min) || 60} minutes`,
    interview_type: TYPE_LABEL[iv.interview_type] || 'Interview',
    where,
    interviewers: panel.map((p) => p.full_name || p.name).filter(Boolean).join(', '),
    recruiter_name: sender?.full_name || sender?.fullName || 'Arabtec Recruitment',
    reference: iv.interview_no || '',
    reason: reason || iv.cancel_reason || '',
  };
}

/**
 * A phone number as WhatsApp wants it: digits only, with the country code.
 * Egyptian local numbers (01xxxxxxxxx) get +20. Returns null when the number
 * cannot be a real mobile number.
 */
export function whatsappNumber(raw) {
  if (!raw) return null;
  // A CV often lists two numbers ("010… / 012…"): use the first.
  const first = String(raw).split(/[\/,;|]| or /i)[0];
  let digits = first.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  else if (/^01\d{9}$/.test(digits)) digits = '20' + digits.slice(1);
  digits = digits.replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

export function whatsappLink(number, text) {
  return number ? `https://wa.me/${number}?text=${encodeURIComponent(text)}` : null;
}

/** One message filled in for one interview, ready to show, edit and send. */
export function composeMessage(kind, ctx) {
  const t = currentTemplates()[kind];
  const vars = interviewVars(ctx);
  const number = whatsappNumber(ctx.candidate?.phone);
  const whatsapp = fill(t.whatsapp, vars);
  return {
    kind, label: MESSAGE_LABELS[kind],
    subject: fill(t.subject, vars),
    email: fill(t.email, vars),
    whatsapp,
    call: fill(t.call, vars),
    to: { email: ctx.candidate?.email || null, phone: ctx.candidate?.phone || null, whatsapp: number },
    whatsappLink: whatsappLink(number, whatsapp),
    callLink: number ? `tel:+${number}` : null,
  };
}
