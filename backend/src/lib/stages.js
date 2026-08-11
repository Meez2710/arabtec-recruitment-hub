// ============================================================================
// Canonical workflow stages — single source of truth (Phase 0 simplification).
// Request: 6 active + 5 side. Application: 8 stages + 4 terminals/holds.
// A legacy→new alias map keeps old stored data valid on read and at migration.
// ============================================================================

/* ----------------------------- REQUEST STATES ----------------------------- */
export const REQ = {
  PENDING: 'pending_approval',
  SOURCING: 'sourcing',
  IN_PROGRESS: 'in_progress',
  PARTIAL: 'partially_filled',
  FILLED: 'filled',
  CLOSED: 'closed',
  // side states
  ON_HOLD: 'on_hold',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  REOPENED: 'reopened',
};
export const REQ_ACTIVE = [REQ.PENDING, REQ.SOURCING, REQ.IN_PROGRESS, REQ.PARTIAL, REQ.FILLED, REQ.CLOSED];
export const REQ_SIDE = [REQ.ON_HOLD, REQ.REJECTED, REQ.CANCELLED, REQ.EXPIRED, REQ.REOPENED];
export const REQ_ALL = [...REQ_ACTIVE, ...REQ_SIDE];
// states from which a request may receive candidates / be worked
export const REQ_OPEN = [REQ.SOURCING, REQ.IN_PROGRESS, REQ.PARTIAL, REQ.REOPENED];
export const REQ_TERMINAL = [REQ.CLOSED, REQ.REJECTED, REQ.CANCELLED, REQ.EXPIRED];

// Old request status → new (used to migrate existing rows and normalise reads).
export const REQ_ALIAS = {
  draft: REQ.PENDING,
  pending_approval: REQ.PENDING,
  budget_validation: REQ.PENDING,
  approved: REQ.SOURCING,
  in_sourcing: REQ.SOURCING,
  sourcing: REQ.SOURCING,
  in_progress: REQ.IN_PROGRESS,
  partially_filled: REQ.PARTIAL,
  filled: REQ.FILLED,
  closed: REQ.CLOSED,
  on_hold: REQ.ON_HOLD,
  rejected: REQ.REJECTED,
  cancelled: REQ.CANCELLED,
  expired: REQ.EXPIRED,
  reopened: REQ.REOPENED,
};
export const reqNorm = (s) => REQ_ALIAS[s] || s;

// Allowed request transitions (from → [to]). Side states reachable from any non-terminal.
export const REQ_TRANSITIONS = {
  [REQ.PENDING]: [REQ.SOURCING, REQ.REJECTED, REQ.CANCELLED, REQ.ON_HOLD],
  [REQ.SOURCING]: [REQ.IN_PROGRESS, REQ.PARTIAL, REQ.FILLED, REQ.ON_HOLD, REQ.CANCELLED, REQ.EXPIRED, REQ.CLOSED],
  [REQ.IN_PROGRESS]: [REQ.PARTIAL, REQ.FILLED, REQ.ON_HOLD, REQ.CANCELLED, REQ.EXPIRED, REQ.CLOSED, REQ.SOURCING],
  [REQ.PARTIAL]: [REQ.FILLED, REQ.IN_PROGRESS, REQ.ON_HOLD, REQ.CANCELLED, REQ.EXPIRED, REQ.CLOSED],
  [REQ.FILLED]: [REQ.CLOSED, REQ.REOPENED],
  [REQ.ON_HOLD]: [REQ.SOURCING, REQ.IN_PROGRESS, REQ.PARTIAL, REQ.CANCELLED, REQ.CLOSED],
  [REQ.EXPIRED]: [REQ.REOPENED, REQ.CLOSED],
  [REQ.REOPENED]: [REQ.SOURCING, REQ.IN_PROGRESS, REQ.ON_HOLD, REQ.CANCELLED],
  [REQ.CLOSED]: [REQ.REOPENED],
  [REQ.REJECTED]: [REQ.REOPENED],
  [REQ.CANCELLED]: [REQ.REOPENED],
};

/* --------------------------- APPLICATION STAGES --------------------------- */
export const APP = {
  SOURCED: 'sourced',
  MATCHED: 'matched',
  UNMATCHED: 'unmatched',
  INTERVIEWING: 'interviewing',
  WAITING_FEEDBACK: 'waiting_feedback',
  ISSUING_OFFER: 'issuing_offer',
  OFFER_SENT: 'offer_sent',
  JOINED: 'joined',
  // terminals / holds
  REJECTED: 'rejected',
  OFFER_DECLINED: 'offer_declined',
  ON_HOLD: 'on_hold',
  SHORTLISTED: 'shortlisted',
};
export const APP_PIPELINE = [
  APP.SOURCED, APP.MATCHED, APP.UNMATCHED, APP.INTERVIEWING,
  APP.WAITING_FEEDBACK, APP.ISSUING_OFFER, APP.OFFER_SENT, APP.JOINED,
];
export const APP_TERMINALS = [APP.REJECTED, APP.OFFER_DECLINED, APP.ON_HOLD, APP.SHORTLISTED];
export const APP_STATUSES = [...APP_PIPELINE, ...APP_TERMINALS];

/**
 * BL-03 — the ONLY statuses an application may be CREATED at.
 *
 * `APP_STATUSES` is the set of statuses an application may ever HOLD, which is a
 * different question and must never be used to validate creation: it contains
 * `joined`, `offer_sent` and `rejected`, so validating against it let a caller
 * create an application already at a terminal stage — bypassing the interview
 * record, the offer flow and seat accounting in one request.
 *
 * Entry stages are the early, pre-interview, non-terminal ones. A candidate can
 * legitimately be linked as already sourced, matched, screened out, or
 * shortlisted; everything later must be REACHED through `appCanMove`, which is
 * what records how it was reached.
 *
 * Deliberately excluded, and why:
 *   interviewing, waiting_feedback  — imply an interview that does not exist
 *   issuing_offer, offer_sent       — imply an offer that does not exist
 *   joined                          — consumes a seat; must come from offer_sent
 *   rejected, offer_declined        — terminal; nothing to reject yet
 *   on_hold                         — resumes to a prior stage; there is none
 */
export const APP_ENTRY = [APP.SOURCED, APP.MATCHED, APP.UNMATCHED, APP.SHORTLISTED];

/** Default when a caller supplies no initial status at all. */
export const APP_ENTRY_DEFAULT = APP.SOURCED;

/** True when `status` is a legal creation stage. Aliases are resolved first. */
export const appIsEntry = (status) => APP_ENTRY.includes(appNorm(status));
// Truly terminal (cannot be moved out of): joined + the two rejections.
export const APP_TERMINAL = [APP.JOINED, APP.REJECTED, APP.OFFER_DECLINED];
// Stages that require a reason when set.
export const APP_REASON_REQUIRED = {
  [APP.REJECTED]: 'rejection_reason',
  [APP.OFFER_DECLINED]: 'rejection_reason',
  [APP.ON_HOLD]: 'on_hold_reason',
  [APP.UNMATCHED]: 'unmatched_reason',
};

// Old application stage → new (migrate existing rows + normalise on read).
export const APP_ALIAS = {
  new: APP.SOURCED,
  applied: APP.SOURCED,
  sourced: APP.SOURCED,
  screened: APP.MATCHED,
  cv_screening: APP.MATCHED,
  matched: APP.MATCHED,
  unmatched: APP.UNMATCHED,
  shortlisted: APP.SHORTLISTED,
  interview_1: APP.INTERVIEWING,
  interview_2: APP.INTERVIEWING,
  final_interview: APP.INTERVIEWING,
  phone_interview: APP.INTERVIEWING,
  technical_interview: APP.INTERVIEWING,
  client_interview: APP.INTERVIEWING,
  interviewing: APP.INTERVIEWING,
  reference_check: APP.WAITING_FEEDBACK,
  waiting_feedback: APP.WAITING_FEEDBACK,
  offer_preparation: APP.ISSUING_OFFER,
  issuing_offer: APP.ISSUING_OFFER,
  offer_sent: APP.OFFER_SENT,
  offer_accepted: APP.OFFER_SENT, // accepted folds into offer_sent then proceeds to joined
  joined: APP.JOINED,
  rejected: APP.REJECTED,
  offer_rejected: APP.OFFER_DECLINED,
  offer_declined: APP.OFFER_DECLINED,
  withdrawn: APP.REJECTED, // withdrawn consolidated into rejected
  on_hold: APP.ON_HOLD,
};
export const appNorm = (s) => APP_ALIAS[s] || s;

// Allowed application transitions (from → [to]).
export const APP_TRANSITIONS = {
  [APP.SOURCED]: [APP.MATCHED, APP.UNMATCHED, APP.SHORTLISTED, APP.REJECTED, APP.ON_HOLD],
  [APP.MATCHED]: [APP.SHORTLISTED, APP.INTERVIEWING, APP.UNMATCHED, APP.REJECTED, APP.ON_HOLD],
  [APP.SHORTLISTED]: [APP.INTERVIEWING, APP.MATCHED, APP.REJECTED, APP.ON_HOLD],
  [APP.UNMATCHED]: [APP.MATCHED, APP.SHORTLISTED, APP.REJECTED, APP.ON_HOLD],
  [APP.INTERVIEWING]: [APP.WAITING_FEEDBACK, APP.ISSUING_OFFER, APP.REJECTED, APP.ON_HOLD, APP.SHORTLISTED],
  [APP.WAITING_FEEDBACK]: [APP.ISSUING_OFFER, APP.INTERVIEWING, APP.REJECTED, APP.ON_HOLD, APP.SHORTLISTED],
  [APP.ISSUING_OFFER]: [APP.OFFER_SENT, APP.REJECTED, APP.OFFER_DECLINED, APP.ON_HOLD],
  [APP.OFFER_SENT]: [APP.JOINED, APP.OFFER_DECLINED, APP.REJECTED, APP.ON_HOLD],
  [APP.ON_HOLD]: [APP.SOURCED, APP.MATCHED, APP.SHORTLISTED, APP.INTERVIEWING, APP.WAITING_FEEDBACK, APP.ISSUING_OFFER, APP.REJECTED],
  [APP.JOINED]: [],
  [APP.REJECTED]: [],
  [APP.OFFER_DECLINED]: [],
};

// Can this stage move to that stage? (terminals can't move; on_hold can resume.)
export function appCanMove(from, to) {
  const f = appNorm(from), t = appNorm(to);
  if (f === t) return false;
  const allowed = APP_TRANSITIONS[f];
  return Array.isArray(allowed) && allowed.includes(t);
}
export function reqCanMove(from, to) {
  const f = reqNorm(from), t = reqNorm(to);
  if (f === t) return false;
  const allowed = REQ_TRANSITIONS[f];
  return Array.isArray(allowed) && allowed.includes(t);
}

// Human-friendly labels for UI/audit.
export const APP_LABELS = {
  sourced: 'Sourced', matched: 'Matched', unmatched: 'Unmatched', interviewing: 'Interviewing',
  waiting_feedback: 'Waiting Feedback', issuing_offer: 'Issuing Offer', offer_sent: 'Offer Sent',
  joined: 'Joined', rejected: 'Rejected', offer_declined: 'Offer Declined', on_hold: 'On Hold', shortlisted: 'Shortlisted',
};
export const REQ_LABELS = {
  pending_approval: 'Pending Approval', sourcing: 'Sourcing', in_progress: 'In Progress',
  partially_filled: 'Partially Filled', filled: 'Filled', closed: 'Closed',
  on_hold: 'On Hold', rejected: 'Rejected', cancelled: 'Cancelled', expired: 'Expired', reopened: 'Reopened',
};
