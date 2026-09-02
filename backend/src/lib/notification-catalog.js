// Central catalog of notification events, mirroring how permissions.js holds the
// button catalog: this file is the source of truth for WHAT can be notified, and
// notification_config rows hold the tenant's choices about WHETHER and TO WHOM.
//
// Editing this catalog only affects fresh seeds and newly-added keys. Existing
// rows are never overwritten by a redeploy — an administrator's decision to
// switch an email off must survive the next release.
//
// RECIPIENTS ARE SYMBOLIC, not user ids. They are resolved against the entity at
// send time (see notify.js), so "requester" means "whoever raised THIS request".
// That keeps the console honest: an administrator ticks a role, not a person, and
// the same setting keeps working after staff change.

/** Every recipient token the console can offer, with the copy shown beside it. */
export const RECIPIENTS = {
  requester:      'Requester — whoever raised the request',
  owner:          'Assigned recruiter',
  hiring_manager: 'Hiring manager named on the request',
  approvers:      'Everyone who can approve (by permission)',
  panel:          'Interview panel members',
  candidate:      'The candidate (external email)',
  actor:          'The person who performed the action',
};

/** Recipients that reach someone OUTSIDE the company. Held to a higher bar in the
 *  console, because an accidental tick here emails a real candidate. */
export const EXTERNAL_RECIPIENTS = new Set(['candidate']);

/**
 * key            stable id, also the notification_config primary key
 * notifyType     the value written to notification.type. The schema documents
 *                that column's vocabulary (approval_needed | recruiter_assigned |
 *                offer_approval | sla_breach | info) and the in-app list and its
 *                tests read it, so it is a contract: the three events that
 *                predate this catalog keep their original strings rather than
 *                silently switching to the new event key.
 * label          what the console shows
 * category       console grouping
 * description    what actually triggers it, in plain language
 * template       email template name in email_templates.js (null = generic shell)
 * defaults       { enabled, inApp, email, recipients[] }
 *
 * `email:false` with `enabled:true` means "in-app only" — the two channels are
 * independent so an administrator can keep an alert without the mail volume.
 */
export const NOTIFICATION_EVENTS = [
  // ---------------------------------------------------------------- requests
  {
    key: 'request.submitted', label: 'Hiring request submitted', notifyType: 'approval_needed', category: 'Hiring requests',
    description: 'A request has been sent for approval.',
    template: 'requestSubmitted',
    defaults: { enabled: true, inApp: true, email: true, recipients: ['approvers'] },
  },
  {
    key: 'request.approved', label: 'Hiring request approved', category: 'Hiring requests',
    description: 'A request was approved and sourcing can begin.',
    template: 'requestApproved',
    defaults: { enabled: true, inApp: true, email: true, recipients: ['requester', 'owner', 'hiring_manager'] },
  },
  {
    key: 'request.rejected', label: 'Hiring request rejected', category: 'Hiring requests',
    description: 'A request was rejected. The reason is included.',
    template: 'requestRejected',
    defaults: { enabled: true, inApp: true, email: true, recipients: ['requester'] },
  },
  {
    key: 'request.assigned', label: 'Recruiter assigned', notifyType: 'recruiter_assigned', category: 'Hiring requests',
    description: 'A recruiter was made owner of a request.',
    template: 'requestAssigned',
    defaults: { enabled: true, inApp: true, email: true, recipients: ['owner'] },
  },
  {
    key: 'request.on_hold', label: 'Hiring request put on hold', category: 'Hiring requests',
    description: 'Sourcing was paused on a request.',
    template: 'requestStatusChanged',
    defaults: { enabled: true, inApp: true, email: false, recipients: ['requester', 'owner', 'hiring_manager'] },
  },
  {
    key: 'request.resumed', label: 'Hiring request resumed', category: 'Hiring requests',
    description: 'A request came off hold.',
    template: 'requestStatusChanged',
    defaults: { enabled: true, inApp: true, email: false, recipients: ['requester', 'owner', 'hiring_manager'] },
  },
  {
    key: 'request.cancelled', label: 'Hiring request cancelled', category: 'Hiring requests',
    description: 'A request was cancelled before it was filled.',
    template: 'requestStatusChanged',
    defaults: { enabled: true, inApp: true, email: true, recipients: ['requester', 'owner', 'hiring_manager'] },
  },
  {
    key: 'request.closed', label: 'Hiring request closed', category: 'Hiring requests',
    description: 'A request was closed — filled or otherwise finished.',
    template: 'requestStatusChanged',
    defaults: { enabled: true, inApp: true, email: false, recipients: ['requester', 'owner', 'hiring_manager'] },
  },
  {
    key: 'request.reopened', label: 'Hiring request reopened', category: 'Hiring requests',
    description: 'A closed request was reopened.',
    template: 'requestStatusChanged',
    defaults: { enabled: true, inApp: true, email: false, recipients: ['requester', 'owner', 'hiring_manager'] },
  },

  // ------------------------------------------------------------- candidates
  {
    key: 'candidate.rejected', label: 'Rejection sent to candidate', category: 'Candidates',
    description: 'A respectful decline, sent when an application moves to Rejected. '
      + 'Stage moves can be applied in bulk, so one action can email several people — '
      + 'untick this to record rejections without contacting anyone.',
    template: 'rejection',
    // Ships OFF, and it is the only candidate-facing event that does.
    // offer.sent and interview.scheduled are one deliberate act aimed at one
    // named person — a recruiter pressing "send offer" knows an offer is going
    // out. Rejection is reached through a STAGE MOVE, which is bulk-actionable,
    // so the same click that tidies a pipeline of forty people can post forty
    // rejection letters. Mail to an external candidate cannot be recalled, so
    // the first deploy must not be the moment anyone discovers that. One tick
    // in the console turns it on, deliberately.
    defaults: { enabled: true, inApp: false, email: false, recipients: ['candidate'] },
  },
  {
    key: 'candidate.application_received', label: 'Application acknowledgement', category: 'Candidates',
    description: 'Confirms to a candidate that their application arrived.',
    template: 'applicationReceived',
    defaults: { enabled: false, inApp: false, email: true, recipients: ['candidate'] },
  },

  // ------------------------------------------------------------- interviews
  {
    key: 'interview.scheduled', label: 'Interview scheduled', category: 'Interviews',
    description: 'Sends the invitation to the candidate and tells the panel.',
    template: 'interviewInvite',
    defaults: { enabled: true, inApp: true, email: true, recipients: ['candidate', 'panel'] },
  },
  // NOTE: an "interview feedback outstanding" reminder belongs here, but it is a
  // DERIVED state (completed interview + no scorecard), not an event any route
  // fires. It needs a scheduled sweep, which this product does not have yet.
  // Deliberately absent rather than shipped as a checkbox that can never fire.

  // ----------------------------------------------------------------- offers
  {
    key: 'offer.pending_approval', label: 'Offer awaiting approval', notifyType: 'offer_approval', category: 'Offers',
    description: 'An offer needs a decision before it can be sent.',
    template: 'offerPendingApproval',
    defaults: { enabled: true, inApp: true, email: true, recipients: ['approvers'] },
  },
  {
    key: 'offer.approved', label: 'Offer approved', category: 'Offers',
    description: 'An offer cleared approval and can now be sent.',
    template: 'offerApproved',
    defaults: { enabled: true, inApp: true, email: true, recipients: ['owner'] },
  },
  {
    key: 'offer.sent', label: 'Offer sent to candidate', category: 'Offers',
    description: 'The offer letter goes to the candidate.',
    template: 'offerSent',
    defaults: { enabled: true, inApp: true, email: true, recipients: ['candidate'] },
  },
  {
    key: 'offer.accepted', label: 'Offer accepted', category: 'Offers',
    description: 'The candidate accepted. Joining formalities follow.',
    template: 'offerOutcome',
    defaults: { enabled: true, inApp: true, email: true, recipients: ['owner', 'hiring_manager', 'requester'] },
  },
  {
    key: 'offer.declined', label: 'Offer declined', category: 'Offers',
    description: 'The candidate declined. The seat is still open.',
    template: 'offerOutcome',
    defaults: { enabled: true, inApp: true, email: true, recipients: ['owner', 'hiring_manager', 'requester'] },
  },
];

export const EVENT_BY_KEY = Object.fromEntries(NOTIFICATION_EVENTS.map((e) => [e.key, e]));

/** Which permission stands in for "approvers" on a given event. */
export const APPROVER_PERMISSION = {
  'request.submitted': 'request.approve',
  'offer.pending_approval': 'offer.approve',
};
