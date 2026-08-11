// Requisition lifecycle — Document 2 §3.
//
// Eight explicit states. Fill state (unfilled / partially / fully) is DERIVED
// from the seat table and is never stored as a status, which is what removes the
// divergence class where `headcount_filled` disagreed with the seat rows.
//
// The legacy `REQ_TRANSITIONS` map had zero call sites — every status change was
// a raw UPDATE guarded by one of four different hardcoded arrays. This map is
// enforced inside the aggregate, so no route can bypass it. Closes BL-01.

export const REQUISITION_STATES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'OPEN',
  'ON_HOLD',
  'CLOSED',
  'CANCELLED',
  'REJECTED',
] as const;

export type RequisitionState = (typeof REQUISITION_STATES)[number];

/** States from which no further work happens without an explicit re-entry action. */
export const TERMINAL_STATES = ['CLOSED', 'CANCELLED', 'REJECTED'] as const;

/** The only state in which pipeline work is permitted. */
export const WORKABLE_STATES = ['OPEN'] as const;

export type RequisitionAction =
  | 'submit'
  | 'recall'
  | 'approve'
  | 'reject'
  | 'assignRecruiter'
  | 'hold'
  | 'resume'
  | 'close'
  | 'cancel'
  | 'reopen'
  | 'revise';

export interface RequisitionTransition {
  readonly from: RequisitionState;
  readonly to: RequisitionState | 'PREVIOUS';
  readonly action: RequisitionAction;
  readonly requiresReason: boolean;
}

/**
 * `PREVIOUS` is resolved at runtime from the stored `previousState`, so resume
 * restores exactly the state the hold interrupted.
 */
const TRANSITIONS: readonly RequisitionTransition[] = [
  { from: 'DRAFT', to: 'PENDING_APPROVAL', action: 'submit', requiresReason: false },
  { from: 'DRAFT', to: 'APPROVED', action: 'submit', requiresReason: false }, // approval disabled
  { from: 'DRAFT', to: 'CANCELLED', action: 'cancel', requiresReason: true },

  { from: 'PENDING_APPROVAL', to: 'APPROVED', action: 'approve', requiresReason: false },
  { from: 'PENDING_APPROVAL', to: 'REJECTED', action: 'reject', requiresReason: true },
  { from: 'PENDING_APPROVAL', to: 'DRAFT', action: 'recall', requiresReason: false },
  { from: 'PENDING_APPROVAL', to: 'CANCELLED', action: 'cancel', requiresReason: true },

  { from: 'APPROVED', to: 'OPEN', action: 'assignRecruiter', requiresReason: false },
  { from: 'APPROVED', to: 'ON_HOLD', action: 'hold', requiresReason: true },
  { from: 'APPROVED', to: 'CANCELLED', action: 'cancel', requiresReason: true },

  { from: 'OPEN', to: 'ON_HOLD', action: 'hold', requiresReason: true },
  { from: 'OPEN', to: 'CLOSED', action: 'close', requiresReason: true },
  { from: 'OPEN', to: 'CANCELLED', action: 'cancel', requiresReason: true },

  { from: 'ON_HOLD', to: 'PREVIOUS', action: 'resume', requiresReason: false },
  { from: 'ON_HOLD', to: 'CLOSED', action: 'close', requiresReason: true },
  { from: 'ON_HOLD', to: 'CANCELLED', action: 'cancel', requiresReason: true },

  // Reopen additionally requires additionalHeadcount >= 1 — enforced in the
  // aggregate, because without new seats a reopened requisition can never be
  // filled. That was BL-04: reopen worked, hiring afterwards did not.
  { from: 'CLOSED', to: 'OPEN', action: 'reopen', requiresReason: true },

  { from: 'REJECTED', to: 'DRAFT', action: 'revise', requiresReason: false },
];

/**
 * Resolve a transition.
 *
 * One (from, action) pair can have more than one edge — `submit` from DRAFT
 * targets PENDING_APPROVAL or APPROVED depending on whether approval is enabled.
 * The target must therefore participate in the lookup; matching on
 * (from, action) alone silently picks the wrong edge.
 */
export function findRequisitionTransition(
  from: RequisitionState,
  action: RequisitionAction,
  to?: RequisitionState,
): RequisitionTransition | undefined {
  const candidates = TRANSITIONS.filter((t) => t.from === from && t.action === action);
  if (candidates.length === 0) return undefined;
  if (to === undefined) return candidates[0];
  return candidates.find((t) => t.to === to) ?? candidates.find((t) => t.to === 'PREVIOUS');
}

export function requisitionCatalog(): readonly RequisitionTransition[] {
  return TRANSITIONS;
}

export function isRequisitionTerminal(state: RequisitionState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

export function isWorkable(state: RequisitionState): boolean {
  return (WORKABLE_STATES as readonly string[]).includes(state);
}

/* ------------------------------ derived values ----------------------------- */

export type FillState = 'UNFILLED' | 'PARTIALLY_FILLED' | 'FULLY_FILLED';

export function deriveFillState(filled: number, headcount: number): FillState {
  if (filled <= 0) return 'UNFILLED';
  if (filled >= headcount) return 'FULLY_FILLED';
  return 'PARTIALLY_FILLED';
}

export const STATE_LABELS: Record<RequisitionState, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Pending Approval',
  APPROVED: 'Approved',
  OPEN: 'Open',
  ON_HOLD: 'On Hold',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
  REJECTED: 'Rejected',
};

/**
 * Presentation label combining state and derived fill. Read-direction only —
 * the opposite of the legacy translation layer, which wrote display values back
 * into storage and produced unreachable stages.
 */
export function displayStatus(
  state: RequisitionState,
  filled: number,
  headcount: number,
): string {
  if (state !== 'OPEN') return STATE_LABELS[state];
  const fill = deriveFillState(filled, headcount);
  if (fill === 'FULLY_FILLED') return 'Filled';
  if (fill === 'PARTIALLY_FILLED') return `Open · ${filled} of ${headcount} filled`;
  return 'Open';
}

/** Legacy status -> canonical state, for the migration and read-time safety. */
export const LEGACY_STATE_ALIASES: Record<string, RequisitionState> = {
  draft: 'DRAFT',
  pending_approval: 'PENDING_APPROVAL',
  budget_validation: 'PENDING_APPROVAL',
  approved: 'APPROVED',
  sourcing: 'OPEN',
  in_sourcing: 'OPEN',
  in_progress: 'OPEN',
  partially_filled: 'OPEN',
  filled: 'OPEN',
  reopened: 'OPEN',
  on_hold: 'ON_HOLD',
  closed: 'CLOSED',
  cancelled: 'CANCELLED',
  expired: 'CANCELLED',
  rejected: 'REJECTED',
};
