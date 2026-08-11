// The error taxonomy is a contract: the HTTP layer maps `code` to a status, and
// the frontend switches on `code` rather than parsing prose. These tests pin the
// codes so a rename cannot silently break clients.

import { describe, expect, it } from 'vitest';
import {
  CandidateAlreadyHiredError,
  DomainError,
  HeadcountBelowFilledError,
  IllegalTransitionError,
  InvalidEntryStageError,
  InvariantViolationError,
  MissingReasonError,
  NoOpenSeatError,
  OutstandingOfferError,
  RequisitionNotOpenError,
  SeatNotFilledError,
  SelfApprovalError,
} from './errors.js';

describe('Domain error taxonomy', () => {
  const cases: Array<[DomainError, string]> = [
    [new IllegalTransitionError('SOURCED', 'HIRED', 'application'), 'ILLEGAL_TRANSITION'],
    [new MissingReasonError('REJECTED', 'rejectionReason'), 'REASON_REQUIRED'],
    [new NoOpenSeatError(1), 'NO_OPEN_SEAT'],
    [new CandidateAlreadyHiredError(42), 'CANDIDATE_ALREADY_HIRED'],
    [new RequisitionNotOpenError('ON_HOLD', 'hire'), 'REQUISITION_NOT_OPEN'],
    [new SelfApprovalError(), 'SELF_APPROVAL_FORBIDDEN'],
    [new HeadcountBelowFilledError(1, 3), 'HEADCOUNT_BELOW_FILLED'],
    [new OutstandingOfferError([7, 8]), 'OUTSTANDING_OFFER'],
    [new InvalidEntryStageError('HIRED', ['SOURCED']), 'INVALID_ENTRY_STAGE'],
    [new SeatNotFilledError(5), 'SEAT_NOT_FILLED'],
    [new InvariantViolationError('H1', 'seats != headcount'), 'INVARIANT_VIOLATION'],
  ];

  it.each(cases)('%s carries a stable machine code', (err, code) => {
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(code);
    expect(err.message.length).toBeGreaterThan(0);
    expect(err.name).toBe(err.constructor.name);
  });

  it('carries structured details for the API envelope', () => {
    expect(new HeadcountBelowFilledError(1, 3).details).toEqual({ requested: 1, committed: 3 });
    expect(new OutstandingOfferError([7, 8]).details).toEqual({ applicationIds: [7, 8] });
    expect(new IllegalTransitionError('A', 'B', 'application').details)
      .toEqual({ from: 'A', to: 'B', subject: 'application' });
  });

  it('never leaks a code outside the declared union', () => {
    const declared = new Set(cases.map(([, code]) => code));
    for (const [err] of cases) expect(declared.has(err.code)).toBe(true);
  });
});
