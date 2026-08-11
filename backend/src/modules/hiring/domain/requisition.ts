// The Requisition aggregate — root of the headcount invariant.
//
// Seats live INSIDE this boundary. There is no SeatRepository and no way to
// mutate a seat except through a method on this class, which is what makes the
// invariant enforceable rather than aspirational.
//
// INVARIANTS (Document 2 §2)
//   H1  seats.length === headcount                     (rows, any state)
//   H2  filledCount <= headcount
//   H3  every FILLED seat references exactly one application
//   H4  every hired application occupies exactly one FILLED seat  (service side)
//   H5  a candidate holds at most one filled seat across active requisitions
//                                                      (service side — cross-aggregate)
//
// H1 is what makes headcount edits self-reconciling (closes BL-21).
// H3 is what makes an orphaned hire impossible (closes BL-03, BL-23).

import {
  HeadcountBelowFilledError,
  IllegalTransitionError,
  InvariantViolationError,
  MissingReasonError,
  NoOpenSeatError,
  OutstandingOfferError,
  SeatNotFilledError,
  SelfApprovalError,
} from './errors.js';
import type { Actor, DomainEvent } from '../../shared/kernel/domain.js';
import { HIRING_EVENTS } from './events.js';
import {
  type FillState,
  type RequisitionAction,
  type RequisitionState,
  deriveFillState,
  displayStatus,
  findRequisitionTransition,
} from './requisition-states.js';

export type SeatState = 'OPEN' | 'FILLED' | 'CANCELLED';

export interface Seat {
  seatNo: number;
  state: SeatState;
  applicationId: number | null;
  filledAt: Date | null;
  cancelReason: string | null;
}

export type { Actor, DomainEvent };

export interface RequisitionProps {
  id: number;
  tenantId: number;
  ticketNo: string;
  title: string;
  projectId: number;
  departmentId: number;
  requesterId: number;
  recruiterId: number | null;
  headcount: number;
  state: RequisitionState;
  previousState: RequisitionState | null;
  createdBy: number;
  closeReason: string | null;
  seats: Seat[];
  version: number;
}

export interface CloseOptions {
  /** Applications sitting at OFFER_SENT. A live offer blocks close (Document 2 §5). */
  readonly applicationsWithLiveOffers?: readonly number[];
}

export class Requisition {
  private readonly props: RequisitionProps;
  private readonly events: DomainEvent[] = [];

  private constructor(props: RequisitionProps) {
    this.props = props;
    this.assertInvariants();
  }

  /* ------------------------------ construction ----------------------------- */

  /** Create a new DRAFT requisition with `headcount` open seats (satisfies H1). */
  static create(input: {
    id: number;
    tenantId: number;
    ticketNo: string;
    title: string;
    projectId: number;
    departmentId: number;
    requesterId: number;
    headcount: number;
    createdBy: number;
  }): Requisition {
    if (!Number.isInteger(input.headcount) || input.headcount < 1) {
      throw new InvariantViolationError('H1', 'headcount must be an integer >= 1');
    }
    const req = new Requisition({
      ...input,
      recruiterId: null,
      state: 'DRAFT',
      previousState: null,
      closeReason: null,
      seats: Requisition.makeSeats(1, input.headcount),
      version: 0,
    });
    req.record(HIRING_EVENTS.REQUISITION_CREATED, { ticketNo: input.ticketNo, headcount: input.headcount });
    return req;
  }

  /** Rehydrate from storage. Invariants are re-checked, so corruption surfaces on load. */
  static fromState(props: RequisitionProps): Requisition {
    return new Requisition(props);
  }

  private static makeSeats(fromSeatNo: number, count: number): Seat[] {
    return Array.from({ length: count }, (_, i) => ({
      seatNo: fromSeatNo + i,
      state: 'OPEN' as const,
      applicationId: null,
      filledAt: null,
      cancelReason: null,
    }));
  }

  /* -------------------------------- readers -------------------------------- */

  get id(): number { return this.props.id; }
  get tenantId(): number { return this.props.tenantId; }
  get ticketNo(): string { return this.props.ticketNo; }
  get state(): RequisitionState { return this.props.state; }
  get headcount(): number { return this.props.headcount; }
  get recruiterId(): number | null { return this.props.recruiterId; }
  get requesterId(): number { return this.props.requesterId; }
  get version(): number { return this.props.version; }
  get seats(): readonly Seat[] { return this.props.seats; }

  get filledCount(): number {
    return this.props.seats.filter((s) => s.state === 'FILLED').length;
  }

  get openCount(): number {
    return this.props.seats.filter((s) => s.state === 'OPEN').length;
  }

  get fillState(): FillState {
    return deriveFillState(this.filledCount, this.props.headcount);
  }

  get displayStatus(): string {
    return displayStatus(this.props.state, this.filledCount, this.props.headcount);
  }

  hasOpenSeat(): boolean {
    return this.openCount > 0;
  }

  seatForApplication(applicationId: number): Seat | undefined {
    return this.props.seats.find(
      (s) => s.state === 'FILLED' && s.applicationId === applicationId,
    );
  }

  /** Snapshot for persistence. Returns copies so callers cannot mutate internals. */
  toState(): RequisitionProps {
    return { ...this.props, seats: this.props.seats.map((s) => ({ ...s })) };
  }

  pullEvents(): DomainEvent[] {
    return this.events.splice(0, this.events.length);
  }

  /* ------------------------------- lifecycle ------------------------------- */

  /**
   * Submit for approval. When approval is disabled the requisition goes straight
   * to APPROVED — the two modes agreed in Document 2 §2, with no chain between.
   */
  submit(actor: Actor, opts: { approvalRequired: boolean }): void {
    const target: RequisitionState = opts.approvalRequired ? 'PENDING_APPROVAL' : 'APPROVED';
    this.applyTransition('submit', target, actor, null);
  }

  recall(actor: Actor): void {
    this.applyTransition('recall', 'DRAFT', actor, null);
  }

  /**
   * Edit the descriptive fields.
   *
   * Permitted only in DRAFT and REJECTED — the two states where nothing has been
   * approved yet. Once a requisition is approved, changing what was approved
   * requires going back through approval, which is `revise()`, not a silent edit.
   *
   * Headcount is deliberately NOT editable here: it owns seats, so it moves only
   * through adjustHeadcount(), which reconciles them (H1).
   */
  updateDetails(patch: {
    title?: string;
    projectId?: number;
    departmentId?: number;
  }, actor: Actor): void {
    if (this.props.state !== 'DRAFT' && this.props.state !== 'REJECTED') {
      throw new IllegalTransitionError(this.props.state, this.props.state, 'requisition (edit)');
    }
    const before = {
      title: this.props.title,
      projectId: this.props.projectId,
      departmentId: this.props.departmentId,
    };
    if (patch.title !== undefined) {
      if (!patch.title.trim()) throw new MissingReasonError('title', 'title');
      this.props.title = patch.title.trim();
    }
    if (patch.projectId !== undefined) this.props.projectId = patch.projectId;
    if (patch.departmentId !== undefined) this.props.departmentId = patch.departmentId;

    this.props.version += 1;
    this.record(HIRING_EVENTS.REQUISITION_UPDATED, {
      before,
      after: {
        title: this.props.title,
        projectId: this.props.projectId,
        departmentId: this.props.departmentId,
      },
      by: actor.id,
    });
  }

  /**
   * Approve. First approver to act completes it — there is no chain.
   * The approver may not be the requester or the creator (closes BL-02, where
   * three roles held create + submit + approve and nothing checked identity).
   */
  approve(actor: Actor): void {
    this.assertNotSelfApproval(actor);
    this.applyTransition('approve', 'APPROVED', actor, null);
  }

  reject(actor: Actor, reason: string): void {
    this.assertNotSelfApproval(actor);
    this.applyTransition('reject', 'REJECTED', actor, reason);
  }

  revise(actor: Actor): void {
    this.applyTransition('revise', 'DRAFT', actor, null);
  }

  assignRecruiter(recruiterId: number, actor: Actor): void {
    this.props.recruiterId = recruiterId;
    // Assignment from APPROVED opens the requisition. Re-assignment while already
    // OPEN is an owner change, not a state change.
    if (this.props.state === 'APPROVED') {
      this.applyTransition('assignRecruiter', 'OPEN', actor, null);
    } else {
      this.props.version += 1;
    }
    this.record(HIRING_EVENTS.RECRUITER_ASSIGNED, { recruiterId, by: actor.id });
  }

  hold(actor: Actor, reason: string): void {
    const from = this.props.state;
    this.applyTransition('hold', 'ON_HOLD', actor, reason);
    this.props.previousState = from;
  }

  /** Restore exactly the state the hold interrupted. */
  resume(actor: Actor): void {
    const target = this.props.previousState;
    if (!target) {
      throw new IllegalTransitionError('ON_HOLD', 'PREVIOUS', 'requisition');
    }
    this.applyTransition('resume', target, actor, null);
    this.props.previousState = null;
  }

  /**
   * Close. Open seats are cancelled; H1 still holds because the rows remain.
   * Refuses while any candidate holds a live offer — closing under a candidate
   * who is holding a signed letter is a business error, not a cleanup problem.
   */
  close(actor: Actor, reason: string, opts: CloseOptions = {}): void {
    const live = opts.applicationsWithLiveOffers ?? [];
    if (live.length > 0) throw new OutstandingOfferError([...live]);

    this.applyTransition('close', 'CLOSED', actor, reason);
    this.cancelOpenSeats(reason);
    this.props.closeReason =
      this.filledCount >= this.props.headcount ? 'FILLED'
      : this.filledCount > 0 ? 'PARTIALLY_FILLED'
      : 'UNFILLED';
  }

  cancel(actor: Actor, reason: string): void {
    this.applyTransition('cancel', 'CANCELLED', actor, reason);
    this.cancelOpenSeats(reason);
    this.props.closeReason = 'CANCELLED';
  }

  /**
   * Reopen a closed requisition with additional headcount.
   *
   * `additionalHeadcount` is mandatory and >= 1. Without new seats every seat is
   * FILLED or CANCELLED, `hasOpenSeat()` is false forever, and the requisition
   * can be reopened but never filled — which is exactly what BL-04 was.
   */
  reopen(actor: Actor, reason: string, additionalHeadcount: number): void {
    if (!Number.isInteger(additionalHeadcount) || additionalHeadcount < 1) {
      throw new InvariantViolationError('H1', 'reopen requires additionalHeadcount >= 1');
    }
    this.applyTransition('reopen', 'OPEN', actor, reason);
    const nextSeatNo = Math.max(0, ...this.props.seats.map((s) => s.seatNo)) + 1;
    this.props.seats.push(...Requisition.makeSeats(nextSeatNo, additionalHeadcount));
    this.props.headcount += additionalHeadcount;
    this.props.closeReason = null;
    this.record(HIRING_EVENTS.REQUISITION_REOPENED, { additionalHeadcount, headcount: this.props.headcount });
    this.assertInvariants();
  }

  /* -------------------------------- headcount ------------------------------- */

  /**
   * Change headcount and reconcile seats in the same operation, so H1 can never
   * be violated. The legacy edit route changed `headcount` and never touched the
   * seat table — raising 2 to 5 left three hires impossible (BL-21).
   */
  adjustHeadcount(newCount: number, actor: Actor): void {
    if (!Number.isInteger(newCount) || newCount < 1) {
      throw new InvariantViolationError('H1', 'headcount must be an integer >= 1');
    }

    // Only OPEN seats can be removed: FILLED seats are people, and CANCELLED
    // seats are the record of a closed cycle. Both are permanent, so they form
    // the floor. Validate the floor BEFORE mutating anything — a partially
    // applied shrink would leave seats.length < headcount and break H1.
    const filled = this.filledCount;
    const cancelled = this.props.seats.filter((s) => s.state === 'CANCELLED').length;
    const floor = filled + cancelled;
    if (newCount < floor) throw new HeadcountBelowFilledError(newCount, floor);

    const previous = this.props.headcount;
    if (newCount === previous) return;

    if (newCount > previous) {
      const nextSeatNo = Math.max(0, ...this.props.seats.map((s) => s.seatNo)) + 1;
      this.props.seats.push(...Requisition.makeSeats(nextSeatNo, newCount - previous));
    } else {
      // openCount === previous - floor, and newCount >= floor, so there are
      // always enough OPEN seats to remove. Highest seat number first.
      let toRemove = previous - newCount;
      for (let i = this.props.seats.length - 1; i >= 0 && toRemove > 0; i -= 1) {
        if (this.props.seats[i]!.state === 'OPEN') {
          this.props.seats.splice(i, 1);
          toRemove -= 1;
        }
      }
    }

    this.props.headcount = newCount;
    this.props.version += 1;
    this.record(HIRING_EVENTS.HEADCOUNT_ADJUSTED, { from: previous, to: newCount, by: actor.id });
    this.assertInvariants();
  }

  /* ---------------------------------- seats --------------------------------- */

  /**
   * Fill one open seat for an application. Called only by HiringService.recordHire
   * inside the transaction that also moves the application to HIRED — the two
   * halves of the H3/H4 bijection are written together or not at all.
   *
   * H5 (one filled seat per candidate across active requisitions) spans
   * aggregates and is checked by the service before this is called.
   */
  fillSeat(applicationId: number, actor: Actor): Seat {
    if (this.props.state !== 'OPEN') {
      throw new IllegalTransitionError(this.props.state, 'OPEN', 'requisition (hire)');
    }
    if (this.seatForApplication(applicationId)) {
      throw new InvariantViolationError('H3', 'application already occupies a seat');
    }
    const seat = this.props.seats.find((s) => s.state === 'OPEN');
    if (!seat) throw new NoOpenSeatError(this.props.id);

    seat.state = 'FILLED';
    seat.applicationId = applicationId;
    seat.filledAt = new Date();
    this.props.version += 1;

    this.record(HIRING_EVENTS.SEAT_FILLED, {
      seatNo: seat.seatNo,
      applicationId,
      filled: this.filledCount,
      headcount: this.props.headcount,
      fillState: this.fillState,
      by: actor.id,
    });
    this.assertInvariants();
    return seat;
  }

  /**
   * Release a filled seat — reversing a hire, or a hired candidate exercising
   * erasure. The legacy model had no release path at all, so a reversed hire
   * left the seat filled forever (BL-23).
   */
  releaseSeat(applicationId: number, reason: string, actor: Actor): Seat {
    const seat = this.seatForApplication(applicationId);
    if (!seat) throw new SeatNotFilledError(applicationId);

    seat.state = 'OPEN';
    seat.applicationId = null;
    seat.filledAt = null;
    this.props.version += 1;

    this.record(HIRING_EVENTS.SEAT_RELEASED, {
      seatNo: seat.seatNo,
      applicationId,
      reason,
      filled: this.filledCount,
      fillState: this.fillState,
      by: actor.id,
    });
    this.assertInvariants();
    return seat;
  }

  private cancelOpenSeats(reason: string): void {
    for (const seat of this.props.seats) {
      if (seat.state === 'OPEN') {
        seat.state = 'CANCELLED';
        seat.cancelReason = reason;
      }
    }
    this.assertInvariants();
  }

  /* -------------------------------- internals ------------------------------- */

  private applyTransition(
    action: RequisitionAction,
    target: RequisitionState,
    actor: Actor,
    reason: string | null,
  ): void {
    const from = this.props.state;
    const t = findRequisitionTransition(from, action, target);
    if (!t) throw new IllegalTransitionError(from, target, 'requisition');
    if (t.requiresReason && (!reason || !reason.trim())) {
      throw new MissingReasonError(target, 'reason');
    }

    this.props.state = target;
    this.props.version += 1;
    this.record(HIRING_EVENTS.REQUISITION_STATE_CHANGED, {
      from, to: target, action, reason: reason ?? null, by: actor.id,
    });
  }

  private assertNotSelfApproval(actor: Actor): void {
    if (actor.id === this.props.requesterId || actor.id === this.props.createdBy) {
      throw new SelfApprovalError();
    }
  }

  private record(type: string, payload: Record<string, unknown>): void {
    this.events.push({ type, at: new Date(), payload: { requisitionId: this.props.id, ...payload } });
  }

  /** H1–H3. Runs after every mutation and on rehydration. */
  private assertInvariants(): void {
    const { seats, headcount } = this.props;

    if (seats.length !== headcount) {
      throw new InvariantViolationError('H1', `${seats.length} seats for headcount ${headcount}`);
    }
    const filled = seats.filter((s) => s.state === 'FILLED');
    if (filled.length > headcount) {
      throw new InvariantViolationError('H2', `${filled.length} filled exceeds headcount ${headcount}`);
    }
    for (const seat of filled) {
      if (seat.applicationId == null) {
        throw new InvariantViolationError('H3', `seat ${seat.seatNo} is FILLED with no application`);
      }
    }
    const appIds = filled.map((s) => s.applicationId);
    if (new Set(appIds).size !== appIds.length) {
      throw new InvariantViolationError('H3', 'one application occupies more than one seat');
    }
  }
}
