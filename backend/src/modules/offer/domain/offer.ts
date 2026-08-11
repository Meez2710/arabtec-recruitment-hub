// The Offer aggregate.
//
// Three audit findings are closed structurally:
//   BL-10  Compensation on a SENT offer cannot be edited at all. The legacy edit
//          allowed it and triggered re-approval only for PENDING/APPROVED — so
//          the one window where a candidate is holding a printed letter was the
//          one window with no control.
//   BL-11  The director threshold fails CLOSED. An unparseable setting produces
//          the STRICTER chain, never the weaker one. The legacy parseFloat
//          returned NaN, `salary > NaN` was false, and director approval was
//          silently skipped on every offer.
//   BL-12  The preparer cannot approve. The legacy code carried a comment
//          describing this control; the control itself did not exist.
//
// Compensation is manual entry over configurable components. There are no ratios
// and no derivation — the 40/30/30 pattern observed in three sample letters was
// explicitly rejected as company policy.

import {
  CompensationLockedError,
  IllegalOfferTransitionError,
  OfferReasonRequiredError,
  OfferSelfApprovalError,
  UnknownComponentError,
} from './errors.js';
import { OFFER_EVENTS } from './events.js';
import type { Actor, DomainEvent } from '../../shared/kernel/domain.js';

export const OFFER_STATUSES = [
  'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT',
  'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN', 'REJECTED_BY_APPROVER',
] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

const TRANSITIONS: Readonly<Record<OfferStatus, readonly OfferStatus[]>> = {
  DRAFT: ['PENDING_APPROVAL', 'WITHDRAWN'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED_BY_APPROVER', 'DRAFT', 'WITHDRAWN'],
  APPROVED: ['SENT', 'DRAFT', 'WITHDRAWN'],
  SENT: ['ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN'],
  ACCEPTED: ['WITHDRAWN'],
  DECLINED: [],
  EXPIRED: [],
  WITHDRAWN: [],
  REJECTED_BY_APPROVER: [],
};

/** Compensation is frozen once the candidate has the letter. */
const COMPENSATION_LOCKED_IN: readonly OfferStatus[] =
  ['SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN'];

export type { Actor, DomainEvent };

/** One line of the offer letter's salary table. Amount is entered, never derived. */
export interface CompensationLine {
  readonly componentCode: string;
  readonly amount: number;
}

/**
 * Approval requirement, resolved from configuration by the service and passed in.
 *
 * `directorThreshold` is `null` when the configured value could not be parsed.
 * The aggregate then requires director approval REGARDLESS of amount — failing
 * closed is the whole point of BL-11.
 */
export interface ApprovalRequirement {
  readonly directorThreshold: number | null;
  readonly thresholdCurrency: string;
}

export interface OfferProps {
  id: number;
  tenantId: number;
  offerNo: string;
  applicationId: number;
  candidateId: number;
  requisitionId: number;
  positionTitle: string;
  currency: string;
  lines: CompensationLine[];
  joiningDate: Date | null;
  status: OfferStatus;
  preparedBy: number;
  approvedBy: number | null;
  requiresDirectorApproval: boolean;
  sentAt: Date | null;
  /** Derived from sentAt + validity days; the letters state "valid for 5 days". */
  expiresAt: Date | null;
  decidedAt: Date | null;
  reason: string | null;
  /** Pinned at issue so a reprint years later reproduces the original document. */
  templateCode: string | null;
  templateVersion: number | null;
  variableSnapshot: Readonly<Record<string, unknown>> | null;
  version: number;
}

export class Offer {
  private readonly props: OfferProps;
  private readonly events: DomainEvent[] = [];

  private constructor(props: OfferProps) { this.props = props; }

  static draft(input: {
    id: number; tenantId: number; offerNo: string;
    applicationId: number; candidateId: number; requisitionId: number;
    positionTitle: string; currency: string;
    lines: readonly CompensationLine[];
    joiningDate?: Date | null;
    knownComponents: readonly string[];
    actor: Actor;
  }): Offer {
    assertKnownComponents(input.lines, input.knownComponents);
    const offer = new Offer({
      id: input.id,
      tenantId: input.tenantId,
      offerNo: input.offerNo,
      applicationId: input.applicationId,
      candidateId: input.candidateId,
      requisitionId: input.requisitionId,
      positionTitle: input.positionTitle,
      currency: input.currency,
      lines: input.lines.map((l) => ({ ...l })),
      joiningDate: input.joiningDate ?? null,
      status: 'DRAFT',
      preparedBy: input.actor.id,
      approvedBy: null,
      requiresDirectorApproval: false,
      sentAt: null,
      expiresAt: null,
      decidedAt: null,
      reason: null,
      templateCode: null,
      templateVersion: null,
      variableSnapshot: null,
      version: 0,
    });
    offer.record(OFFER_EVENTS.OFFER_DRAFTED, {
      offerNo: input.offerNo, applicationId: input.applicationId, total: offer.totalNet,
    });
    return offer;
  }

  static fromState(props: OfferProps): Offer { return new Offer(props); }

  /* -------------------------------- readers -------------------------------- */

  get id(): number { return this.props.id; }
  get tenantId(): number { return this.props.tenantId; }
  get offerNo(): string { return this.props.offerNo; }
  get applicationId(): number { return this.props.applicationId; }
  get candidateId(): number { return this.props.candidateId; }
  get requisitionId(): number { return this.props.requisitionId; }
  get status(): OfferStatus { return this.props.status; }
  get currency(): string { return this.props.currency; }
  get lines(): readonly CompensationLine[] { return this.props.lines; }
  get preparedBy(): number { return this.props.preparedBy; }
  get approvedBy(): number | null { return this.props.approvedBy; }
  get requiresDirectorApproval(): boolean { return this.props.requiresDirectorApproval; }
  get expiresAt(): Date | null { return this.props.expiresAt; }
  get version(): number { return this.props.version; }

  /** Sum of the entered lines. Arithmetic only — no ratios, no derivation. */
  get totalNet(): number {
    return this.props.lines.reduce((sum, l) => sum + l.amount, 0);
  }

  get isLive(): boolean {
    return this.props.status === 'SENT' || this.props.status === 'ACCEPTED';
  }

  toState(): OfferProps {
    return { ...this.props, lines: this.props.lines.map((l) => ({ ...l })) };
  }

  pullEvents(): DomainEvent[] { return this.events.splice(0, this.events.length); }

  /* ------------------------------ compensation ------------------------------ */

  /**
   * Replace the compensation lines.
   *
   * Refused outright once the offer has been sent. A candidate holding a letter
   * for one number while the system records another is a contractual problem —
   * the correct path is withdraw and re-issue, which produces a new document and
   * a new approval.
   *
   * Editing an offer already submitted or approved returns it to DRAFT, so the
   * approval it previously earned cannot carry over to different money.
   */
  setCompensation(
    lines: readonly CompensationLine[], knownComponents: readonly string[], actor: Actor,
  ): void {
    if (COMPENSATION_LOCKED_IN.includes(this.props.status)) {
      throw new CompensationLockedError(this.props.status);
    }
    assertKnownComponents(lines, knownComponents);

    const before = this.totalNet;
    this.props.lines = lines.map((l) => ({ ...l }));
    this.props.version += 1;

    const reApprovalNeeded =
      this.props.status === 'PENDING_APPROVAL' || this.props.status === 'APPROVED';
    if (reApprovalNeeded) {
      this.props.status = 'DRAFT';
      this.props.approvedBy = null;
      this.props.requiresDirectorApproval = false;
    }

    this.record(OFFER_EVENTS.COMPENSATION_CHANGED, {
      from: before, to: this.totalNet, reApprovalRequired: reApprovalNeeded, by: actor.id,
    });
  }

  /* -------------------------------- approval -------------------------------- */

  /**
   * Submit for approval, computing whether a director is required.
   *
   * Fails closed: a null threshold means the configured value was missing or
   * unparseable, and the aggregate then demands director approval rather than
   * quietly waiving it.
   */
  submit(requirement: ApprovalRequirement, actor: Actor): void {
    this.transition('PENDING_APPROVAL', actor, null);
    this.props.requiresDirectorApproval =
      requirement.directorThreshold === null
        ? true
        : this.totalNet > requirement.directorThreshold;

    this.record(OFFER_EVENTS.OFFER_SUBMITTED, {
      total: this.totalNet,
      requiresDirectorApproval: this.props.requiresDirectorApproval,
      thresholdApplied: requirement.directorThreshold,
      thresholdCurrency: requirement.thresholdCurrency,
      failedClosed: requirement.directorThreshold === null,
    });
  }

  /** Withdraw a submission back to DRAFT. */
  recall(actor: Actor): void {
    this.transition('DRAFT', actor, null);
    this.props.requiresDirectorApproval = false;
  }

  /**
   * Approve. The preparer may never approve their own offer (BL-12), and a
   * director-level offer needs a caller holding director authority — checked by
   * the service, which owns permissions, and asserted here via `hasDirectorAuthority`.
   */
  approve(actor: Actor, opts: { hasDirectorAuthority: boolean }): void {
    if (actor.id === this.props.preparedBy) throw new OfferSelfApprovalError();
    if (this.props.requiresDirectorApproval && !opts.hasDirectorAuthority) {
      throw new OfferSelfApprovalError('This offer requires HR Director authority to approve.');
    }
    this.transition('APPROVED', actor, null);
    this.props.approvedBy = actor.id;
    this.record(OFFER_EVENTS.OFFER_APPROVED, {
      approvedBy: actor.id, total: this.totalNet,
      requiredDirector: this.props.requiresDirectorApproval,
    });
  }

  rejectApproval(reason: string, actor: Actor): void {
    if (actor.id === this.props.preparedBy) throw new OfferSelfApprovalError();
    if (!reason.trim()) throw new OfferReasonRequiredError('reject');
    this.transition('REJECTED_BY_APPROVER', actor, reason);
  }

  /* ---------------------------------- issue --------------------------------- */

  /**
   * Send an approved offer, pinning the template version and snapshotting every
   * variable. Reprinting in 2028 must reproduce the 2026 document exactly, which
   * is impossible if variables are re-resolved at render time.
   */
  send(input: {
    templateCode: string;
    templateVersion: number;
    variableSnapshot: Readonly<Record<string, unknown>>;
    validityDays: number;
    now: Date;
    actor: Actor;
  }): void {
    this.transition('SENT', input.actor, null);
    this.props.sentAt = input.now;
    this.props.expiresAt = new Date(input.now.getTime() + input.validityDays * 86_400_000);
    this.props.templateCode = input.templateCode;
    this.props.templateVersion = input.templateVersion;
    this.props.variableSnapshot = { ...input.variableSnapshot };

    this.record(OFFER_EVENTS.OFFER_SENT, {
      offerNo: this.props.offerNo,
      candidateId: this.props.candidateId,
      expiresAt: this.props.expiresAt.toISOString(),
      templateCode: input.templateCode,
      templateVersion: input.templateVersion,
    });
  }

  /* --------------------------------- outcome -------------------------------- */

  accept(now: Date, actor: Actor): void {
    this.transition('ACCEPTED', actor, null);
    this.props.decidedAt = now;
    this.record(OFFER_EVENTS.OFFER_ACCEPTED, { candidateId: this.props.candidateId });
  }

  decline(reason: string, now: Date, actor: Actor): void {
    if (!reason.trim()) throw new OfferReasonRequiredError('decline');
    this.transition('DECLINED', actor, reason);
    this.props.decidedAt = now;
    this.record(OFFER_EVENTS.OFFER_DECLINED, {
      candidateId: this.props.candidateId, reason,
    });
  }

  /**
   * Expire a sent offer past its validity window.
   *
   * Refuses while still valid, so a scheduled sweep cannot expire an offer early
   * because of a clock or query mistake.
   */
  expire(now: Date, actor: Actor): void {
    if (this.props.status !== 'SENT') {
      throw new IllegalOfferTransitionError(this.props.status, 'EXPIRED');
    }
    if (this.props.expiresAt && now.getTime() < this.props.expiresAt.getTime()) {
      throw new IllegalOfferTransitionError(this.props.status, 'EXPIRED');
    }
    this.transition('EXPIRED', actor, null);
    this.props.decidedAt = now;
    this.record(OFFER_EVENTS.OFFER_EXPIRED, {
      candidateId: this.props.candidateId,
      expiredAt: now.toISOString(),
    });
  }

  withdraw(reason: string, now: Date, actor: Actor): void {
    if (!reason.trim()) throw new OfferReasonRequiredError('withdraw');
    this.transition('WITHDRAWN', actor, reason);
    this.props.decidedAt = now;
    this.record(OFFER_EVENTS.OFFER_WITHDRAWN, {
      candidateId: this.props.candidateId, reason,
    });
  }

  /* -------------------------------- internals ------------------------------- */

  private transition(to: OfferStatus, actor: Actor, reason: string | null): void {
    const from = this.props.status;
    if (!TRANSITIONS[from].includes(to)) throw new IllegalOfferTransitionError(from, to);
    this.props.status = to;
    if (reason) this.props.reason = reason;
    this.props.version += 1;
    this.record(OFFER_EVENTS.OFFER_STATUS_CHANGED, { from, to, reason, by: actor.id });
  }

  private record(type: string, payload: Record<string, unknown>): void {
    this.events.push({
      type,
      at: new Date(),
      payload: {
        offerId: this.props.id,
        applicationId: this.props.applicationId,
        requisitionId: this.props.requisitionId,
        ...payload,
      },
    });
  }
}

function assertKnownComponents(
  lines: readonly CompensationLine[], known: readonly string[],
): void {
  const allowed = new Set(known);
  for (const line of lines) {
    if (!allowed.has(line.componentCode)) throw new UnknownComponentError(line.componentCode);
  }
}
