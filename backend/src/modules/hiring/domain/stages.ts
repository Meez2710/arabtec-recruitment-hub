// Application pipeline stages — the 1:1 model approved in Document 2 §5.
//
// There is no display/write translation layer. The stage the board shows is the
// stage stored and the stage posted. The APP_STATUS / APP_WRITE / pipelineStage()
// mapping in the legacy frontend is deleted, along with the defect class it
// produced (a stage filter that never matched, and a column that could never be
// reached).

/** The six pipeline stages, in order. */
export const PIPELINE_STAGES = [
  'SOURCED',
  'MATCHED',
  'INTERVIEWING',
  'OFFER_PREPARATION',
  'OFFER_SENT',
  'HIRED',
] as const;

/** States that sit outside the forward pipeline. */
export const NON_PIPELINE_STAGES = [
  'NOT_SUITABLE',
  'ON_HOLD',
  'REJECTED',
  'WITHDRAWN',
  'OFFER_DECLINED',
] as const;

export const ALL_STAGES = [...PIPELINE_STAGES, ...NON_PIPELINE_STAGES] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export type NonPipelineStage = (typeof NON_PIPELINE_STAGES)[number];
export type ApplicationStage = (typeof ALL_STAGES)[number];

/** Stages an application can never leave. */
export const TERMINAL_STAGES = ['HIRED', 'REJECTED', 'WITHDRAWN', 'OFFER_DECLINED'] as const;
export type TerminalStage = (typeof TERMINAL_STAGES)[number];

/**
 * Stages an application may be CREATED at. Everything else is reachable only via
 * a transition. Closes BL-03, where `initialStatus` accepted any stage including
 * `joined` — bypassing the pipeline, seat filling and overfill protection.
 */
export const ENTRY_STAGES = ['SOURCED', 'MATCHED'] as const;
export type EntryStage = (typeof ENTRY_STAGES)[number];

/**
 * Who may perform a transition.
 *   MANUAL — a user, through the board, list or bulk action.
 *   SYSTEM — another module's service (offers), via applySystemTransition().
 * Closes BL-14: the offer routes force-moved applications past the transition
 * map through four separate call sites. There is now one enforcement point.
 */
export type TransitionTrigger = 'MANUAL' | 'SYSTEM';

export interface TransitionDescriptor {
  readonly from: ApplicationStage;
  readonly to: ApplicationStage;
  readonly trigger: TransitionTrigger;
  readonly requiresReason: boolean;
  readonly isIrreversible: boolean;
}

/** Stages that demand a reason, and the field the reason is stored in. */
export const REASON_FIELD: Partial<Record<ApplicationStage, string>> = {
  REJECTED: 'rejectionReason',
  NOT_SUITABLE: 'notSuitableReason',
  WITHDRAWN: 'withdrawalReason',
  OFFER_DECLINED: 'declineReason',
  ON_HOLD: 'onHoldReason',
};

const requiresReason = (to: ApplicationStage): boolean => to in REASON_FIELD;
const isIrreversible = (to: ApplicationStage): boolean =>
  (TERMINAL_STAGES as readonly string[]).includes(to);

/** Exits available from any active (non-terminal) stage. */
const COMMON_EXITS: ReadonlyArray<[ApplicationStage, TransitionTrigger]> = [
  ['REJECTED', 'MANUAL'],
  ['WITHDRAWN', 'MANUAL'],
  ['ON_HOLD', 'MANUAL'],
];

/**
 * The transition map. Forward moves, permitted backward moves, and exits.
 *
 * Backward moves are legal where the business allows them (a candidate can be
 * returned from INTERVIEWING to MATCHED). The legacy board only ever offered
 * forward moves while the table view offered all of them — two affordances with
 * contradictory rules for the same action. There is now one rule.
 */
const RAW_TRANSITIONS: Partial<
  Record<ApplicationStage, ReadonlyArray<[ApplicationStage, TransitionTrigger]>>
> = {
  SOURCED: [['MATCHED', 'MANUAL'], ['NOT_SUITABLE', 'MANUAL'], ...COMMON_EXITS],

  MATCHED: [
    ['INTERVIEWING', 'MANUAL'],
    ['SOURCED', 'MANUAL'],
    ['NOT_SUITABLE', 'MANUAL'],
    ...COMMON_EXITS,
  ],

  INTERVIEWING: [
    ['OFFER_PREPARATION', 'MANUAL'],
    ['MATCHED', 'MANUAL'],
    ...COMMON_EXITS,
  ],

  // OFFER_SENT is reached only by the offer module sending the offer.
  OFFER_PREPARATION: [
    ['OFFER_SENT', 'SYSTEM'],
    ['INTERVIEWING', 'MANUAL'],
    ...COMMON_EXITS,
  ],

  // Everything out of OFFER_SENT is driven by the offer's own outcome.
  OFFER_SENT: [
    ['HIRED', 'SYSTEM'],
    ['OFFER_DECLINED', 'SYSTEM'],
    ['WITHDRAWN', 'SYSTEM'],
    ['REJECTED', 'MANUAL'],
  ],

  // Screened out but retained in the talent pool — may be revisited.
  NOT_SUITABLE: [['MATCHED', 'MANUAL'], ['REJECTED', 'MANUAL']],

  // ON_HOLD resumes to its remembered stage; see Application.resume().
  ON_HOLD: [['REJECTED', 'MANUAL'], ['WITHDRAWN', 'MANUAL']],

  HIRED: [],
  REJECTED: [],
  WITHDRAWN: [],
  OFFER_DECLINED: [],
};

/** Fully expanded transition descriptors, keyed by origin stage. */
export const TRANSITIONS: ReadonlyMap<ApplicationStage, readonly TransitionDescriptor[]> =
  new Map(
    ALL_STAGES.map((from) => [
      from,
      (RAW_TRANSITIONS[from] ?? []).map(([to, trigger]) => ({
        from,
        to,
        trigger,
        requiresReason: requiresReason(to),
        isIrreversible: isIrreversible(to),
      })),
    ]),
  );

/** Every descriptor, flattened. Served to the board so it can grey out invalid drops. */
export function transitionCatalog(): readonly TransitionDescriptor[] {
  return [...TRANSITIONS.values()].flat();
}

export function findTransition(
  from: ApplicationStage,
  to: ApplicationStage,
): TransitionDescriptor | undefined {
  return TRANSITIONS.get(from)?.find((t) => t.to === to);
}

export function isTerminal(stage: ApplicationStage): stage is TerminalStage {
  return (TERMINAL_STAGES as readonly string[]).includes(stage);
}

export function isEntryStage(stage: string): stage is EntryStage {
  return (ENTRY_STAGES as readonly string[]).includes(stage);
}

/** Human-facing labels. Presentation only — never used as a stored value. */
export const STAGE_LABELS: Record<ApplicationStage, string> = {
  SOURCED: 'Sourced',
  MATCHED: 'Matched',
  INTERVIEWING: 'Interviewing',
  OFFER_PREPARATION: 'Offer Preparation',
  OFFER_SENT: 'Offer Sent',
  HIRED: 'Hired',
  NOT_SUITABLE: 'Not Suitable',
  ON_HOLD: 'On Hold',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
  OFFER_DECLINED: 'Offer Declined',
};

/**
 * Legacy vocabulary -> canonical stage. Used ONCE by the migration, and on read
 * as a safety net for any row written before the migration ran. Not consulted
 * by application code.
 */
export const LEGACY_STAGE_ALIASES: Record<string, ApplicationStage> = {
  new: 'SOURCED',
  applied: 'SOURCED',
  sourced: 'SOURCED',
  matched: 'MATCHED',
  screened: 'MATCHED',
  cv_screening: 'MATCHED',
  shortlisted: 'MATCHED',
  interviewing: 'INTERVIEWING',
  interview_1: 'INTERVIEWING',
  interview_2: 'INTERVIEWING',
  phone_interview: 'INTERVIEWING',
  technical_interview: 'INTERVIEWING',
  client_interview: 'INTERVIEWING',
  final_interview: 'INTERVIEWING',
  waiting_feedback: 'INTERVIEWING',
  reference_check: 'INTERVIEWING',
  issuing_offer: 'OFFER_PREPARATION',
  offer_preparation: 'OFFER_PREPARATION',
  offer_sent: 'OFFER_SENT',
  offer_accepted: 'OFFER_SENT',
  joined: 'HIRED',
  unmatched: 'NOT_SUITABLE',
  on_hold: 'ON_HOLD',
  rejected: 'REJECTED',
  withdrawn: 'WITHDRAWN',
  offer_declined: 'OFFER_DECLINED',
  offer_rejected: 'OFFER_DECLINED',
};
