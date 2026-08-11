import { describe, expect, it } from 'vitest';
import { Requisition, type Actor } from './requisition.js';
import { isRequisitionTerminal, isWorkable, requisitionCatalog } from './requisition-states.js';
import { transitionCatalog } from './stages.js';
import {
  HeadcountBelowFilledError,
  IllegalTransitionError,
  MissingReasonError,
  NoOpenSeatError,
  OutstandingOfferError,
  SeatNotFilledError,
  SelfApprovalError,
} from './errors.js';

const REQUESTER: Actor = { id: 10, name: 'Requester' };
const APPROVER: Actor = { id: 20, name: 'HR Director' };
const RECRUITER: Actor = { id: 30, name: 'Recruiter' };

function draft(headcount = 3): Requisition {
  return Requisition.create({
    id: 1,
    tenantId: 1,
    ticketNo: 'REQ-2026-00001',
    title: 'Site Engineer',
    projectId: 5,
    departmentId: 7,
    requesterId: REQUESTER.id,
    headcount,
    createdBy: REQUESTER.id,
  });
}

/** Drive a fresh requisition all the way to OPEN. */
function open(headcount = 3): Requisition {
  const r = draft(headcount);
  r.submit(REQUESTER, { approvalRequired: true });
  r.approve(APPROVER);
  r.assignRecruiter(RECRUITER.id, APPROVER);
  return r;
}

describe('Requisition — creation', () => {
  it('creates exactly `headcount` open seats (H1)', () => {
    const r = draft(4);
    expect(r.seats).toHaveLength(4);
    expect(r.openCount).toBe(4);
    expect(r.filledCount).toBe(0);
    expect(r.state).toBe('DRAFT');
  });

  it('rejects a headcount below 1', () => {
    expect(() => draft(0)).toThrow(/headcount/i);
  });
});

describe('Requisition — approval', () => {
  it('goes DRAFT -> PENDING_APPROVAL when approval is required', () => {
    const r = draft();
    r.submit(REQUESTER, { approvalRequired: true });
    expect(r.state).toBe('PENDING_APPROVAL');
  });

  it('goes DRAFT -> APPROVED directly when approval is disabled', () => {
    const r = draft();
    r.submit(REQUESTER, { approvalRequired: false });
    expect(r.state).toBe('APPROVED');
  });

  it('lets the first approver complete it — there is no chain', () => {
    const r = draft();
    r.submit(REQUESTER, { approvalRequired: true });
    r.approve(APPROVER);
    expect(r.state).toBe('APPROVED');
  });

  // BL-02: three roles held create + submit + approve and nothing checked identity.
  it('refuses approval by the requester', () => {
    const r = draft();
    r.submit(REQUESTER, { approvalRequired: true });
    expect(() => r.approve(REQUESTER)).toThrow(SelfApprovalError);
  });

  it('refuses rejection by the requester', () => {
    const r = draft();
    r.submit(REQUESTER, { approvalRequired: true });
    expect(() => r.reject(REQUESTER, 'no budget')).toThrow(SelfApprovalError);
  });

  it('requires a reason to reject', () => {
    const r = draft();
    r.submit(REQUESTER, { approvalRequired: true });
    expect(() => r.reject(APPROVER, '   ')).toThrow(MissingReasonError);
  });

  it('allows a rejected requisition to be revised back to DRAFT', () => {
    const r = draft();
    r.submit(REQUESTER, { approvalRequired: true });
    r.reject(APPROVER, 'headcount not budgeted');
    r.revise(REQUESTER);
    expect(r.state).toBe('DRAFT');
  });
});

describe('Requisition — illegal transitions (BL-01)', () => {
  it('cannot approve a DRAFT', () => {
    expect(() => draft().approve(APPROVER)).toThrow(IllegalTransitionError);
  });

  it('cannot assign a recruiter before approval', () => {
    const r = draft();
    r.submit(REQUESTER, { approvalRequired: true });
    expect(() => r.assignRecruiter(RECRUITER.id, APPROVER)).not.toThrow(); // owner change only
    expect(r.state).toBe('PENDING_APPROVAL'); // ...but it does NOT open
  });

  it('cannot close a cancelled requisition', () => {
    const r = open();
    r.cancel(APPROVER, 'project shelved');
    expect(() => r.close(APPROVER, 'too late')).toThrow(IllegalTransitionError);
  });

  it('cannot reopen a cancelled requisition', () => {
    const r = open();
    r.cancel(APPROVER, 'project shelved');
    expect(() => r.reopen(APPROVER, 'restarted', 1)).toThrow(IllegalTransitionError);
  });
});

describe('Requisition — hold and resume', () => {
  it('restores exactly the state the hold interrupted', () => {
    const r = open();
    expect(r.state).toBe('OPEN');
    r.hold(APPROVER, 'budget freeze');
    expect(r.state).toBe('ON_HOLD');
    r.resume(APPROVER);
    expect(r.state).toBe('OPEN');
  });

  it('requires a reason to hold', () => {
    const r = open();
    expect(() => r.hold(APPROVER, '')).toThrow(MissingReasonError);
  });

  // BL-13: hiring into an on-hold requisition silently overwrote the hold.
  it('refuses to fill a seat while on hold', () => {
    const r = open();
    r.hold(APPROVER, 'budget freeze');
    expect(() => r.fillSeat(100, RECRUITER)).toThrow(IllegalTransitionError);
    expect(r.state).toBe('ON_HOLD');
  });
});

describe('Requisition — headcount reconciliation (BL-21)', () => {
  it('creates seats when headcount increases', () => {
    const r = open(2);
    r.adjustHeadcount(5, APPROVER);
    expect(r.headcount).toBe(5);
    expect(r.seats).toHaveLength(5);
    expect(r.openCount).toBe(5);
  });

  it('removes open seats when headcount decreases', () => {
    const r = open(5);
    r.adjustHeadcount(2, APPROVER);
    expect(r.headcount).toBe(2);
    expect(r.seats).toHaveLength(2);
  });

  it('refuses to drop headcount below the number of filled seats', () => {
    const r = open(3);
    r.fillSeat(101, RECRUITER);
    r.fillSeat(102, RECRUITER);
    expect(() => r.adjustHeadcount(1, APPROVER)).toThrow(HeadcountBelowFilledError);
    expect(r.headcount).toBe(3);
  });

  it('preserves filled seats when shrinking', () => {
    const r = open(4);
    r.fillSeat(101, RECRUITER);
    r.adjustHeadcount(2, APPROVER);
    expect(r.filledCount).toBe(1);
    expect(r.seats).toHaveLength(2);
  });
});

describe('Requisition — seats and fill state', () => {
  it('derives fill state rather than storing it', () => {
    const r = open(2);
    expect(r.fillState).toBe('UNFILLED');
    expect(r.displayStatus).toBe('Open');

    r.fillSeat(101, RECRUITER);
    expect(r.fillState).toBe('PARTIALLY_FILLED');
    expect(r.displayStatus).toBe('Open · 1 of 2 filled');

    r.fillSeat(102, RECRUITER);
    expect(r.fillState).toBe('FULLY_FILLED');
    expect(r.displayStatus).toBe('Filled');
  });

  it('refuses to fill beyond headcount (H2, overfill protection)', () => {
    const r = open(1);
    r.fillSeat(101, RECRUITER);
    expect(() => r.fillSeat(102, RECRUITER)).toThrow(NoOpenSeatError);
    expect(r.filledCount).toBe(1);
  });

  it('refuses to give one application two seats (H3)', () => {
    const r = open(3);
    r.fillSeat(101, RECRUITER);
    expect(() => r.fillSeat(101, RECRUITER)).toThrow(/already occupies/i);
  });

  // BL-23: there was no release path at all.
  it('releases a filled seat back to open', () => {
    const r = open(2);
    r.fillSeat(101, RECRUITER);
    expect(r.openCount).toBe(1);
    r.releaseSeat(101, 'offer rescinded', APPROVER);
    expect(r.filledCount).toBe(0);
    expect(r.openCount).toBe(2);
  });

  it('refuses to release a seat that is not filled', () => {
    const r = open(2);
    expect(() => r.releaseSeat(999, 'x', APPROVER)).toThrow(SeatNotFilledError);
  });
});

describe('Requisition — close, cancel, reopen', () => {
  it('cancels open seats on close but keeps the rows (H1)', () => {
    const r = open(3);
    r.fillSeat(101, RECRUITER);
    r.close(APPROVER, 'filled enough');
    expect(r.state).toBe('CLOSED');
    expect(r.seats).toHaveLength(3);
    expect(r.filledCount).toBe(1);
    expect(r.openCount).toBe(0);
  });

  // Document 2 §5 — closing under a live offer is a business error.
  it('refuses to close while a candidate holds a sent offer', () => {
    const r = open(2);
    expect(() => r.close(APPROVER, 'done', { applicationsWithLiveOffers: [77] }))
      .toThrow(OutstandingOfferError);
    expect(r.state).toBe('OPEN');
  });

  // BL-04: reopen worked, but every seat stayed filled or cancelled, so the
  // requisition could never be filled again.
  it('reopen creates new open seats so hiring can actually resume', () => {
    const r = open(2);
    r.fillSeat(101, RECRUITER);
    r.fillSeat(102, RECRUITER);
    expect(r.hasOpenSeat()).toBe(false);

    r.close(APPROVER, 'all filled');
    r.reopen(APPROVER, 'one resigned', 1);

    expect(r.state).toBe('OPEN');
    expect(r.headcount).toBe(3);
    expect(r.hasOpenSeat()).toBe(true);
    expect(() => r.fillSeat(103, RECRUITER)).not.toThrow();
  });

  it('refuses to reopen without additional headcount', () => {
    const r = open(1);
    r.close(APPROVER, 'done');
    expect(() => r.reopen(APPROVER, 'restarting', 0)).toThrow(/additionalHeadcount/);
  });

  it('requires a reason to reopen', () => {
    const r = open(1);
    r.close(APPROVER, 'done');
    expect(() => r.reopen(APPROVER, '  ', 1)).toThrow(MissingReasonError);
  });
});

describe('Requisition — events and rehydration', () => {
  it('emits an event per state change and drains once', () => {
    const r = draft();
    r.submit(REQUESTER, { approvalRequired: true });
    const events = r.pullEvents();
    expect(events.map((e) => e.type)).toContain('RequisitionStateChanged');
    expect(r.pullEvents()).toHaveLength(0);
  });

  it('re-checks invariants on rehydration so corruption surfaces at load', () => {
    const r = open(2);
    const state = r.toState();
    state.seats.pop(); // simulate a corrupted row set
    expect(() => Requisition.fromState(state)).toThrow(/H1/);
  });

  it('round-trips through toState/fromState', () => {
    const r = open(3);
    r.fillSeat(101, RECRUITER);
    const revived = Requisition.fromState(r.toState());
    expect(revived.filledCount).toBe(1);
    expect(revived.state).toBe('OPEN');
    expect(revived.ticketNo).toBe('REQ-2026-00001');
    expect(revived.tenantId).toBe(1);
    expect(revived.requesterId).toBe(REQUESTER.id);
    expect(revived.recruiterId).toBe(RECRUITER.id);
    expect(revived.seatForApplication(101)?.seatNo).toBe(1);
    expect(revived.version).toBeGreaterThan(0);
  });

  // The defensive guards inside assertInvariants should be unreachable through
  // the public API. These prove they fire if storage is ever corrupted directly.
  it('detects a filled seat with no application on load (H3)', () => {
    const r = open(2);
    r.fillSeat(101, RECRUITER);
    const state = r.toState();
    state.seats[0]!.applicationId = null;
    expect(() => Requisition.fromState(state)).toThrow(/H3/);
  });

  it('detects one application holding two seats on load (H3)', () => {
    const r = open(2);
    r.fillSeat(101, RECRUITER);
    const state = r.toState();
    state.seats[1]!.state = 'FILLED';
    state.seats[1]!.applicationId = 101;
    expect(() => Requisition.fromState(state)).toThrow(/H3/);
  });

  it('detects more filled seats than headcount on load (H2)', () => {
    const r = open(2);
    const state = r.toState();
    state.seats[0]!.state = 'FILLED';
    state.seats[0]!.applicationId = 101;
    state.seats[1]!.state = 'FILLED';
    state.seats[1]!.applicationId = 102;
    state.headcount = 1;
    expect(() => Requisition.fromState(state)).toThrow(/H1|H2/);
  });
});

describe('Requisition state predicates', () => {
  it('identifies terminal states', () => {
    expect(isRequisitionTerminal('CLOSED')).toBe(true);
    expect(isRequisitionTerminal('CANCELLED')).toBe(true);
    expect(isRequisitionTerminal('REJECTED')).toBe(true);
    expect(isRequisitionTerminal('OPEN')).toBe(false);
    expect(isRequisitionTerminal('DRAFT')).toBe(false);
  });

  // Only OPEN permits pipeline work — the guard behind BL-13.
  it('identifies the single workable state', () => {
    expect(isWorkable('OPEN')).toBe(true);
    for (const s of ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ON_HOLD', 'CLOSED'] as const) {
      expect(isWorkable(s)).toBe(false);
    }
  });
});

describe('Transition catalogs (served to the board)', () => {
  it('exposes every requisition transition with its reason requirement', () => {
    const catalog = requisitionCatalog();
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.every((t) => typeof t.requiresReason === 'boolean')).toBe(true);
    expect(catalog.some((t) => t.action === 'reopen' && t.requiresReason)).toBe(true);
  });

  it('exposes every application transition, flagging irreversible targets', () => {
    const catalog = transitionCatalog();
    expect(catalog.length).toBeGreaterThan(0);
    // The board uses isIrreversible to decide when to demand confirmation.
    expect(catalog.filter((t) => t.isIrreversible).every((t) =>
      ['HIRED', 'REJECTED', 'WITHDRAWN', 'OFFER_DECLINED'].includes(t.to))).toBe(true);
    // System-only edges must never be offered as a manual drop target.
    expect(catalog.some((t) => t.to === 'HIRED' && t.trigger === 'SYSTEM')).toBe(true);
    expect(catalog.some((t) => t.to === 'HIRED' && t.trigger === 'MANUAL')).toBe(false);
  });
});
