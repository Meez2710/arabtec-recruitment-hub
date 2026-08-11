// The module boundary is a contract: other modules import from index.ts and
// nowhere else. This pins the public surface so an export cannot be dropped or
// renamed during a refactor without a failing test.

import { describe, expect, it } from 'vitest';
import * as hiring from './index.js';

describe('Hiring module public surface', () => {
  it('exports the service and its identity/scope types', () => {
    expect(typeof hiring.HiringService).toBe('function');
    expect(typeof hiring.AuthContext).toBe('function');
    expect(hiring.HIRING_PERMISSIONS.RECORD_HIRE).toBe('hiring.record');
    expect(hiring.HIRING_PERMISSIONS.REVERSE_HIRE).toBe('hiring.reverse');
  });

  it('exports every error class the HTTP layer maps', () => {
    for (const name of [
      'ApplicationError', 'ForbiddenError', 'NotFoundError', 'StaleAggregateError',
      'DomainError', 'IllegalTransitionError', 'MissingReasonError', 'NoOpenSeatError',
      'CandidateAlreadyHiredError', 'RequisitionNotOpenError', 'SelfApprovalError',
      'HeadcountBelowFilledError', 'OutstandingOfferError', 'InvalidEntryStageError',
      'SeatNotFilledError', 'InvariantViolationError',
    ]) {
      expect(typeof hiring[name as keyof typeof hiring], name).toBe('function');
    }
  });

  it('exports the vocabulary the board renders', () => {
    expect(hiring.PIPELINE_STAGES).toEqual([
      'SOURCED', 'MATCHED', 'INTERVIEWING', 'OFFER_PREPARATION', 'OFFER_SENT', 'HIRED',
    ]);
    expect(hiring.ENTRY_STAGES).toEqual(['SOURCED', 'MATCHED']);
    expect(hiring.TERMINAL_STAGES).toContain('HIRED');
    expect(hiring.STAGE_LABELS.OFFER_PREPARATION).toBe('Offer Preparation');
    expect(hiring.REQUISITION_STATES).toHaveLength(8);
    expect(hiring.STATE_LABELS.ON_HOLD).toBe('On Hold');
  });

  it('exports the transition catalogs the board needs for drop targets', () => {
    expect(hiring.transitionCatalog().length).toBeGreaterThan(0);
    expect(hiring.requisitionCatalog().length).toBeGreaterThan(0);
  });

  it('exports the derived-status helpers', () => {
    expect(hiring.deriveFillState(0, 3)).toBe('UNFILLED');
    expect(hiring.deriveFillState(1, 3)).toBe('PARTIALLY_FILLED');
    expect(hiring.deriveFillState(3, 3)).toBe('FULLY_FILLED');
    expect(hiring.displayStatus('OPEN', 1, 3)).toBe('Open · 1 of 3 filled');
    expect(hiring.displayStatus('CLOSED', 3, 3)).toBe('Closed');
  });

  it('exports the legacy alias maps used once by the migration', () => {
    expect(hiring.LEGACY_STAGE_ALIASES['shortlisted']).toBe('MATCHED');
    expect(hiring.LEGACY_STAGE_ALIASES['joined']).toBe('HIRED');
    expect(hiring.LEGACY_STATE_ALIASES['partially_filled']).toBe('OPEN');
  });

  it('exports systemClock but no infrastructure implementation', () => {
    expect(hiring.systemClock.now()).toBeInstanceOf(Date);
    // Ports are types only — no concrete repository, UoW, bus or AI provider.
    for (const name of ['UnitOfWork', 'RequisitionRepository', 'EventBus', 'AIService']) {
      expect(hiring[name as keyof typeof hiring]).toBeUndefined();
    }
  });

  it('does not leak the aggregate classes', () => {
    // Repository adapters live inside this module precisely so these stay in.
    expect((hiring as Record<string, unknown>)['Requisition']).toBeUndefined();
    expect((hiring as Record<string, unknown>)['Application']).toBeUndefined();
  });
});
