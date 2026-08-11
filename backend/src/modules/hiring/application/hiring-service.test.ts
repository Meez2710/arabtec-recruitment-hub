import { beforeEach, describe, expect, it } from 'vitest';
import { HiringService } from './hiring-service.js';
import { AuthContext } from '../../shared/kernel/auth-context.js';
import { HIRING_PERMISSIONS } from './auth-context.js';
import { ForbiddenError, NotFoundError, StaleAggregateError } from '../../shared/kernel/errors.js';
import {
  CandidateAlreadyHiredError,
  IllegalTransitionError,
  NoOpenSeatError,
  SeatNotFilledError,
} from '../domain/errors.js';
import { Application } from '../domain/application.js';
import { Requisition } from '../domain/requisition.js';
import {
  InMemoryStore,
  InMemoryUnitOfWork,
  RecordingEventBus,
} from './__testing__/in-memory.js';

const PROJECT = 1;

function ctxWith(permissions: string[], opts: Partial<{ projectScopes: number[]; global: boolean }> = {}) {
  return new AuthContext({
    tenantId: 1,
    userId: 30,
    userName: 'Recruiter',
    permissions,
    projectScopes: opts.projectScopes ?? [PROJECT],
    isGlobalScope: opts.global ?? true,
  });
}

const HIRER = ctxWith([HIRING_PERMISSIONS.RECORD_HIRE, HIRING_PERMISSIONS.REVERSE_HIRE]);

/** An OPEN requisition with `headcount` seats. */
function seedRequisition(store: InMemoryStore, id: number, headcount: number): Requisition {
  const r = Requisition.create({
    id, tenantId: 1, ticketNo: `REQ-2026-0000${id}`, title: 'Site Engineer',
    projectId: PROJECT, departmentId: 2, requesterId: 10, headcount, createdBy: 10,
  });
  // Approval disabled lands directly on APPROVED; assignment then opens it.
  r.submit({ id: 10, name: 'Requester' }, { approvalRequired: false });
  r.assignRecruiter(30, { id: 20, name: 'Director' });
  r.pullEvents();
  store.putRequisition(r, PROJECT);
  return r;
}

/** An application walked forward to OFFER_SENT — the only stage HIRED follows. */
function seedApplication(
  store: InMemoryStore,
  id: number,
  candidateId: number,
  requisitionId: number,
  stopAt: 'MATCHED' | 'OFFER_SENT' = 'OFFER_SENT',
): Application {
  const actor = { id: 30, name: 'Recruiter' };
  const a = Application.create({
    id, tenantId: 1, applicationNo: `APP-0000${id}`, candidateId,
    requisitionId, recruiterId: 30, stage: 'SOURCED', actor,
  });
  a.transitionTo('MATCHED', actor);
  if (stopAt === 'OFFER_SENT') {
    a.transitionTo('INTERVIEWING', actor);
    a.transitionTo('OFFER_PREPARATION', actor);
    a.transitionTo('OFFER_SENT', actor, { trigger: 'SYSTEM' });
  }
  a.pullEvents();
  store.putApplication(a, PROJECT);
  return a;
}

describe('HiringService.recordHire', () => {
  let store: InMemoryStore;
  let uow: InMemoryUnitOfWork;
  let events: RecordingEventBus;
  let service: HiringService;

  beforeEach(() => {
    store = new InMemoryStore();
    uow = new InMemoryUnitOfWork(store);
    events = new RecordingEventBus();
    service = new HiringService({ uow, events });
  });

  it('moves the application to HIRED and fills exactly one seat', async () => {
    seedRequisition(store, 1, 3);
    seedApplication(store, 100, 42, 1);

    const result = await service.recordHire({ applicationId: 100 }, HIRER);

    expect(result.stage).toBe('HIRED');
    expect(result.filledSeats).toBe(1);
    expect(result.headcount).toBe(3);
    expect(result.fillState).toBe('PARTIALLY_FILLED');

    expect(store.application(100)!.stage).toBe('HIRED');
    expect(store.requisition(1)!.filledCount).toBe(1);
    expect(store.requisition(1)!.seatForApplication(100)).toBeDefined();
  });

  it('reports FULLY_FILLED when the last seat is taken', async () => {
    seedRequisition(store, 1, 1);
    seedApplication(store, 100, 42, 1);
    const result = await service.recordHire({ applicationId: 100 }, HIRER);
    expect(result.fillState).toBe('FULLY_FILLED');
  });

  it('refuses without the hiring.record permission', async () => {
    seedRequisition(store, 1, 1);
    seedApplication(store, 100, 42, 1);
    const noPerm = ctxWith([]);
    await expect(service.recordHire({ applicationId: 100 }, noPerm)).rejects.toThrow(ForbiddenError);
    expect(store.application(100)!.stage).toBe('OFFER_SENT');
  });

  it('reports NOT_FOUND for a missing application', async () => {
    await expect(service.recordHire({ applicationId: 999 }, HIRER)).rejects.toThrow(NotFoundError);
  });

  // ADR-0005 — out of scope is indistinguishable from missing.
  it('reports NOT_FOUND rather than FORBIDDEN for an out-of-scope application', async () => {
    seedRequisition(store, 1, 1);
    seedApplication(store, 100, 42, 1);
    const otherProject = ctxWith(
      [HIRING_PERMISSIONS.RECORD_HIRE],
      { projectScopes: [999], global: false },
    );
    await expect(service.recordHire({ applicationId: 100 }, otherProject))
      .rejects.toThrow(NotFoundError);
  });

  // Invariant H5.
  it('refuses when the candidate already holds an active hire elsewhere', async () => {
    seedRequisition(store, 1, 2);
    seedRequisition(store, 2, 2);
    seedApplication(store, 100, 42, 1);
    seedApplication(store, 200, 42, 2);

    await service.recordHire({ applicationId: 100 }, HIRER);
    await expect(service.recordHire({ applicationId: 200 }, HIRER))
      .rejects.toThrow(CandidateAlreadyHiredError);

    expect(store.application(200)!.stage).toBe('OFFER_SENT');
    expect(store.requisition(2)!.filledCount).toBe(0);
  });

  it('refuses when no seat remains, and consumes nothing', async () => {
    seedRequisition(store, 1, 1);
    seedApplication(store, 100, 42, 1);
    seedApplication(store, 101, 43, 1);

    await service.recordHire({ applicationId: 100 }, HIRER);
    await expect(service.recordHire({ applicationId: 101 }, HIRER)).rejects.toThrow(NoOpenSeatError);

    expect(store.application(101)!.stage).toBe('OFFER_SENT');
    expect(store.requisition(1)!.filledCount).toBe(1);
  });

  it('refuses to hire from a stage other than OFFER_SENT', async () => {
    seedRequisition(store, 1, 2);
    seedApplication(store, 100, 42, 1, 'MATCHED');
    await expect(service.recordHire({ applicationId: 100 }, HIRER))
      .rejects.toThrow(IllegalTransitionError);
    expect(store.requisition(1)!.filledCount).toBe(0);
  });

  // BL-13 — hiring used to silently overwrite a hold.
  it('refuses to hire into an on-hold requisition and leaves the hold intact', async () => {
    const r = seedRequisition(store, 1, 2);
    r.hold({ id: 20, name: 'Director' }, 'budget freeze');
    r.pullEvents();
    store.putRequisition(r, PROJECT);
    seedApplication(store, 100, 42, 1);

    await expect(service.recordHire({ applicationId: 100 }, HIRER))
      .rejects.toThrow(IllegalTransitionError);

    expect(store.requisition(1)!.state).toBe('ON_HOLD');
    expect(store.requisition(1)!.filledCount).toBe(0);
    expect(store.application(100)!.stage).toBe('OFFER_SENT');
  });

  // An application whose requisition is missing or out of scope must not be
  // hireable — the seat it would consume belongs to a record we cannot see.
  it('reports NOT_FOUND when the requisition is unreachable', async () => {
    seedApplication(store, 100, 42, 404); // no requisition 404 seeded
    await expect(service.recordHire({ applicationId: 100 }, HIRER)).rejects.toThrow(NotFoundError);
    expect(store.application(100)!.stage).toBe('OFFER_SENT');
  });

  it('rejects a stale application version', async () => {
    seedRequisition(store, 1, 2);
    const a = seedApplication(store, 100, 42, 1);
    await expect(
      service.recordHire({ applicationId: 100, expectedApplicationVersion: a.version - 1 }, HIRER),
    ).rejects.toThrow(StaleAggregateError);
  });

  it('accepts a matching application version', async () => {
    seedRequisition(store, 1, 2);
    const a = seedApplication(store, 100, 42, 1);
    await expect(
      service.recordHire({ applicationId: 100, expectedApplicationVersion: a.version }, HIRER),
    ).resolves.toMatchObject({ stage: 'HIRED' });
  });
});

describe('HiringService — atomicity across both aggregates', () => {
  let store: InMemoryStore;
  let uow: InMemoryUnitOfWork;
  let service: HiringService;
  let events: RecordingEventBus;

  beforeEach(() => {
    store = new InMemoryStore();
    uow = new InMemoryUnitOfWork(store);
    events = new RecordingEventBus();
    service = new HiringService({ uow, events });
  });

  // The two halves of the H3/H4 bijection must be written together or not at all.
  it('leaves neither aggregate changed when the commit fails', async () => {
    seedRequisition(store, 1, 2);
    seedApplication(store, 100, 42, 1);
    const before = store.snapshot();

    uow.failCommit = true;
    await expect(service.recordHire({ applicationId: 100 }, HIRER)).rejects.toThrow('commit failed');

    expect(store.snapshot()).toBe(before);
    expect(store.application(100)!.stage).toBe('OFFER_SENT');
    expect(store.requisition(1)!.filledCount).toBe(0);
  });

  it('publishes no events when the transaction fails', async () => {
    seedRequisition(store, 1, 2);
    seedApplication(store, 100, 42, 1);

    uow.failCommit = true;
    await expect(service.recordHire({ applicationId: 100 }, HIRER)).rejects.toThrow();

    expect(events.calls).toBe(0);
    expect(events.published).toHaveLength(0);
  });

  it('never records a hire without filling a seat', async () => {
    seedRequisition(store, 1, 1);
    seedApplication(store, 100, 42, 1);
    seedApplication(store, 101, 43, 1);
    await service.recordHire({ applicationId: 100 }, HIRER);
    await expect(service.recordHire({ applicationId: 101 }, HIRER)).rejects.toThrow();

    const hired = [...store.applications.values()].filter((r) => r.props.stage === 'HIRED');
    expect(hired).toHaveLength(store.requisition(1)!.filledCount);
  });
});

describe('HiringService — domain events (Phase 1 rule 7)', () => {
  let store: InMemoryStore;
  let events: RecordingEventBus;
  let service: HiringService;

  beforeEach(() => {
    store = new InMemoryStore();
    events = new RecordingEventBus();
    service = new HiringService({ uow: new InMemoryUnitOfWork(store), events });
  });

  it('publishes both aggregates’ events in one batch, after commit', async () => {
    seedRequisition(store, 1, 2);
    seedApplication(store, 100, 42, 1);

    await service.recordHire({ applicationId: 100 }, HIRER);

    expect(events.calls).toBe(1);
    expect(events.typesOf()).toContain('ApplicationStageChanged');
    expect(events.typesOf()).toContain('SeatFilled');
  });

  it('carries the identifiers a subscriber needs without a lookup', async () => {
    seedRequisition(store, 1, 2);
    seedApplication(store, 100, 42, 1);
    await service.recordHire({ applicationId: 100 }, HIRER);

    const seatFilled = events.published.find((e) => e.type === 'SeatFilled');
    expect(seatFilled?.payload).toMatchObject({
      requisitionId: 1, applicationId: 100, filled: 1, headcount: 2, fillState: 'PARTIALLY_FILLED',
    });

    const staged = events.published.find((e) => e.type === 'ApplicationStageChanged');
    expect(staged?.payload).toMatchObject({
      applicationId: 100, candidateId: 42, requisitionId: 1,
      from: 'OFFER_SENT', to: 'HIRED', trigger: 'SYSTEM', isIrreversible: true,
    });
  });
});

describe('HiringService.reverseHire', () => {
  let store: InMemoryStore;
  let events: RecordingEventBus;
  let service: HiringService;

  beforeEach(() => {
    store = new InMemoryStore();
    events = new RecordingEventBus();
    service = new HiringService({ uow: new InMemoryUnitOfWork(store), events });
  });

  async function hired() {
    seedRequisition(store, 1, 2);
    seedApplication(store, 100, 42, 1);
    await service.recordHire({ applicationId: 100 }, HIRER);
    events.reset();
  }

  // BL-23 — there was no release path at all.
  it('releases the seat and returns the application to OFFER_SENT', async () => {
    await hired();
    const result = await service.reverseHire({ applicationId: 100, reason: 'did not start' }, HIRER);

    expect(result.stage).toBe('OFFER_SENT');
    expect(result.filledSeats).toBe(0);
    expect(result.fillState).toBe('UNFILLED');
    expect(store.requisition(1)!.openCount).toBe(2);
  });

  it('frees the candidate to be hired elsewhere (H5 released)', async () => {
    await hired();
    seedRequisition(store, 2, 1);
    seedApplication(store, 200, 42, 2);

    await expect(service.recordHire({ applicationId: 200 }, HIRER))
      .rejects.toThrow(CandidateAlreadyHiredError);

    await service.reverseHire({ applicationId: 100, reason: 'did not start' }, HIRER);
    await expect(service.recordHire({ applicationId: 200 }, HIRER))
      .resolves.toMatchObject({ stage: 'HIRED' });
  });

  it('requires the hiring.reverse permission specifically', async () => {
    await hired();
    const recordOnly = ctxWith([HIRING_PERMISSIONS.RECORD_HIRE]);
    await expect(service.reverseHire({ applicationId: 100, reason: 'x' }, recordOnly))
      .rejects.toThrow(ForbiddenError);
  });

  it('reports NOT_FOUND for a missing application', async () => {
    await expect(service.reverseHire({ applicationId: 999, reason: 'x' }, HIRER))
      .rejects.toThrow(NotFoundError);
  });

  it('reports NOT_FOUND when the requisition is unreachable', async () => {
    seedApplication(store, 100, 42, 404);
    await expect(service.reverseHire({ applicationId: 100, reason: 'x' }, HIRER))
      .rejects.toThrow(NotFoundError);
  });

  it('rejects a stale application version', async () => {
    await hired();
    const current = store.application(100)!.version;
    await expect(
      service.reverseHire(
        { applicationId: 100, reason: 'x', expectedApplicationVersion: current - 1 },
        HIRER,
      ),
    ).rejects.toThrow(StaleAggregateError);
    expect(store.application(100)!.stage).toBe('HIRED');
  });

  it('refuses when the application holds no seat', async () => {
    seedRequisition(store, 1, 2);
    seedApplication(store, 100, 42, 1);
    await expect(service.reverseHire({ applicationId: 100, reason: 'x' }, HIRER))
      .rejects.toThrow(SeatNotFilledError);
  });

  it('publishes SeatReleased and HireReversed', async () => {
    await hired();
    await service.reverseHire({ applicationId: 100, reason: 'did not start' }, HIRER);
    expect(events.typesOf()).toContain('SeatReleased');
    expect(events.typesOf()).toContain('HireReversed');
  });

  it('round-trips hire -> reverse -> hire without breaking the invariant', async () => {
    await hired();
    await service.reverseHire({ applicationId: 100, reason: 'deferred start' }, HIRER);
    await service.recordHire({ applicationId: 100 }, HIRER);

    const r = store.requisition(1)!;
    expect(r.filledCount).toBe(1);
    expect(r.seats).toHaveLength(2);
    expect(store.application(100)!.stage).toBe('HIRED');
  });
});
