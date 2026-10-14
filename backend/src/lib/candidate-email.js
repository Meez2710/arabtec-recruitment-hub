// Candidate emails: keep "we issued it" apart from "the email went".
//
// notifyEvent() only QUEUES mail. Before this helper, the offer, rejection and
// interview-invite routes wrote "… email sent" on the candidate's activity as
// soon as notifyEvent reported `sent`, which is true even when the only thing
// that happened was an in-app alert to staff, the candidate has no address,
// the email channel is off, or mail is not configured at all.
//
// Two pieces:
//   deliveryPlan()            — what the caller can truthfully say right now
//                               (queued, or not sent and why), for the response
//   candidateEmailReporter()  — records the real outcome on the candidate's
//                               activity once the mailer has finished
import { CandidateActivity } from './models.js';
import { isConfigured } from './mailer.js';

const REASONS = {
  no_candidate_email: 'The candidate has no email address on file.',
  notification_disabled: 'The candidate email for this event is switched off in Notifications.',
  candidate_not_a_recipient: 'This event is not set to email the candidate (Notifications).',
  mail_not_configured: 'Email is not configured, so nothing was sent.',
};

/**
 * @param {{external:number, externalTo:string[], reason?:string}} result  notifyEvent() result
 * @param {{email?:string}|null} candidate
 * @returns {{state:'queued'|'not_sent', to:string|null, reason:string|null, message:string}}
 */
export function deliveryPlan(result, candidate) {
  const r = result || {};
  if (r.external > 0) {
    const to = (r.externalTo || [])[0] || null;
    if (!isConfigured()) return { state: 'not_sent', to, reason: 'mail_not_configured', message: REASONS.mail_not_configured };
    return { state: 'queued', to, reason: null, message: `Email queued to ${to}. The result is recorded on the candidate's activity.` };
  }
  let reason = 'candidate_not_a_recipient';
  if (!candidate || !candidate.email) reason = 'no_candidate_email';
  else if (r.reason === 'disabled') reason = 'notification_disabled';
  return { state: 'not_sent', to: null, reason, message: REASONS[reason] };
}

/** Callback for notifyEvent's ctx.onExternalResult: one activity row per real outcome. */
export function candidateEmailReporter({ candidateId, applicationId = null, actorId = null, what }) {
  return (email, r) => {
    let type; let note;
    if (r && r.ok) { type = 'email_sent'; note = `${what} sent to ${email}`; }
    else if (r && r.skipped) { type = 'email_not_sent'; note = `${what} not sent to ${email}: email is not configured`; }
    else { type = 'email_failed'; note = `${what} to ${email} failed${r && r.error ? `: ${r.error}` : ''}`; }
    try {
      CandidateActivity.add({ candidateId, applicationId, actorId, actorName: 'System', type, note });
    } catch { /* an activity note must never break the action that caused it */ }
  };
}
