import { beforeEach, describe, expect, it } from 'vitest';
import { PipelineService, PIPELINE_PERMISSIONS } from './pipeline-service.js';
import { RequisitionService, REQUISITION_PERMISSIONS } from './requisition-service.js';
import { AuthContext } from '../../shared/kernel/auth-context.js';
import { ForbiddenError, NotFoundError, StaleAggregateError } from '../../shared/kernel/errors.js';
import {
  IllegalTransitionError, InvalidEntryStageError,
  MissingReasonError, RequisitionNotOpenError,
} from '../domain/errors.js';
import {
  InMemoryStore, InMemoryUnitOfWork, RecordingEventBus, StubOfferGateway,
} from './__testing__/in-memory.js';

const ALL = [...Object.values(REQUISITION_PERMISSIONS), ...Object.values(PIPELINE_PERMISSIONS)];

function ctxFor(userId: number, permissions: readonly string[] = ALL): AuthContext {
  return new AuthContext({
    tenantId: 1, userId, userName: `User ${userId}`,
    permissions: [...permissions], projectScopes: [], isGlobalScope: true,
  });
}

const REQUESTER = ctxFor(10);
const RECRUITER = ctxFor(30);

interface Harness {
  store: InMemoryStore;
  events: RecordingEventBus;
  pipeline: PipelineService;
  requisitions: RequisitionService;
}

function harness(): Harness {
  const store = new InMemoryStore();
  const uow = new InMemoryUnitOfWork(store);
  const events = new RecordingEventBus();
  return {
    store, events,
    pipeline: new PipelineService({ uow, events }),
    requisitions: new RequisitionService({
      uow, events,
      settings: { approvalRequired: async () => false },
      offers: new StubOfferGateway(),
    }),
  };
}

async function openRequisition(h: Harness, headcount = 3): Promise<number> {
  const r = await h.requisitions.create(
    { title: 'Site Engineer', projectId: 1, departmentId: 2, headcount }, REQUESTER,
  );
  await h.requisitions.submit(r.id, REQUESTER);
  await h.requisitions.assignRecruiter(r.id, 30, ctxFor(20));
  h.events.reset();
  return r.id;
}

describe('PipelineService — candidate entry', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('adds a candidate at SOURCED by default', async () => {
    const id = await openRequisition(h);
    const app = await h.pipeline.addCandidate({ requisitionId: id, candidateId: 42 }, RECRUITER);
    expect(app.stage).toBe('SOURCED');
    expect(app.applicationNo).toMatch(/^APP-\d{5}$/);
    expect(h.events.typesOf()).toContain('ApplicationCreated');
  });

  it('accepts MATCHED as an entry stage', async () => {
    const id = await openRequisition(h);
    const app = await h.pipeline.addCandidate(
      { requisitionId: id, candidateId: 42, initialStage: 'MATCHED' }, RECRUITER,
    );
    expect(app.stage).toBe('MATCHED');
  });

  // BL-03 — the legacy endpoint accepted any stage from the client, including joined.
  it('rejects a non-entry stage at creation', async () => {
    const id = await openRequisition(h);
    await expect(h.pipeline.addCandidate(
      { requisitionId: id, candidateId: 42, initialStage: 'HIRED' as never }, RECRUITER,
    )).rejects.toThrow(InvalidEntryStageError);
  });

  it('inherits the requisition recruiter when none is given', async () => {
    const id = await openRequisition(h);
    const app = await h.pipeline.addCandidate({ requisitionId: id, candidateId: 42 }, RECRUITER);
    expect(h.store.application(app.id)!.toState().recruiterId).toBe(30);
  });

  it.each(['DRAFT', 'ON_HOLD', 'CLOSED'] as const)(
    'refuses to add a candidate while the requisition is %s',
    async (target) => {
      const h2 = harness();
      const id = await openRequisition(h2);
      if (target === 'ON_HOLD') await h2.requisitions.hold(id, 'freeze', ctxFor(20));
      if (target === 'CLOSED') await h2.requisitions.close(id, 'done', ctxFor(20));
      if (target === 'DRAFT') {
        const draft = await h2.requisitions.create(
          { title: 'X', projectId: 1, departmentId: 2, headcount: 1 }, REQUESTER,
        );
        await expect(h2.pipeline.addCandidate(
          { requisitionId: draft.id, candidateId: 1 }, RECRUITER,
        )).rejects.toThrow(RequisitionNotOpenError);
        return;
      }
      await expect(h2.pipeline.addCandidate({ requisitionId: id, candidateId: 1 }, RECRUITER))
        .rejects.toThrow(RequisitionNotOpenError);
    },
  );

  it('requires the link permission', async () => {
    const id = await openRequisition(h);
    await expect(h.pipeline.addCandidate({ requisitionId: id, candidateId: 1 }, ctxFor(9, [])))
      .rejects.toThrow(ForbiddenError);
  });
});

describe('PipelineService — stage transitions', () => {
  let h: Harness;
  let reqId: number;
  let appId: number;

  beforeEach(async () => {
    h = harness();
    reqId = await openRequisition(h);
    appId = (await h.pipeline.addCandidate({ requisitionId: reqId, candidateId: 42 }, RECRUITER)).id;
    h.events.reset();
  });

  it('advances through the pipeline', async () => {
    expect((await h.pipeline.transition({ applicationId: appId, toStage: 'MATCHED' }, RECRUITER)).stage)
      .toBe('MATCHED');
    expect((await h.pipeline.transition({ applicationId: appId, toStage: 'INTERVIEWING' }, RECRUITER)).stage)
      .toBe('INTERVIEWING');
  });

  it('permits a backward move where the business allows it', async () => {
    await h.pipeline.transition({ applicationId: appId, toStage: 'MATCHED' }, RECRUITER);
    await h.pipeline.transition({ applicationId: appId, toStage: 'INTERVIEWING' }, RECRUITER);
    expect((await h.pipeline.transition({ applicationId: appId, toStage: 'MATCHED' }, RECRUITER)).stage)
      .toBe('MATCHED');
  });

  it('rejects a skipped stage', async () => {
    await expect(h.pipeline.transition({ applicationId: appId, toStage: 'OFFER_PREPARATION' }, RECRUITER))
      .rejects.toThrow(IllegalTransitionError);
  });

  it('requires a reason where the stage demands one', async () => {
    await expect(h.pipeline.transition({ applicationId: appId, toStage: 'REJECTED' }, RECRUITER))
      .rejects.toThrow(MissingReasonError);
    const done = await h.pipeline.transition(
      { applicationId: appId, toStage: 'REJECTED', reason: 'not a fit' }, RECRUITER,
    );
    expect(done.stage).toBe('REJECTED');
  });

  // BL-14 — SYSTEM stages are unreachable by a user action.
  it('refuses a manual move to a system-driven stage', async () => {
    await h.pipeline.transition({ applicationId: appId, toStage: 'MATCHED' }, RECRUITER);
    await h.pipeline.transition({ applicationId: appId, toStage: 'INTERVIEWING' }, RECRUITER);
    await h.pipeline.transition({ applicationId: appId, toStage: 'OFFER_PREPARATION' }, RECRUITER);
    await expect(h.pipeline.transition({ applicationId: appId, toStage: 'OFFER_SENT' }, RECRUITER))
      .rejects.toThrow(IllegalTransitionError);
  });

  it('allows another context to drive a system stage through the published door', async () => {
    await h.pipeline.transition({ applicationId: appId, toStage: 'MATCHED' }, RECRUITER);
    await h.pipeline.transition({ applicationId: appId, toStage: 'INTERVIEWING' }, RECRUITER);
    await h.pipeline.transition({ applicationId: appId, toStage: 'OFFER_PREPARATION' }, RECRUITER);
    const sent = await h.pipeline.applySystemTransition(
      { applicationId: appId, toStage: 'OFFER_SENT', reason: 'Offer sent' }, RECRUITER,
    );
    expect(sent.stage).toBe('OFFER_SENT');
  });

  it('holds and resumes to the interrupted stage', async () => {
    await h.pipeline.transition({ applicationId: appId, toStage: 'MATCHED' }, RECRUITER);
    await h.pipeline.transition(
      { applicationId: appId, toStage: 'ON_HOLD', reason: 'travelling' }, RECRUITER,
    );
    expect((await h.pipeline.resume(appId, RECRUITER)).stage).toBe('MATCHED');
  });

  it('rejects a stale version', async () => {
    await expect(h.pipeline.transition(
      { applicationId: appId, toStage: 'MATCHED', expectedVersion: 99 }, RECRUITER,
    )).rejects.toThrow(StaleAggregateError);
  });

  it('reports NOT_FOUND for a missing application', async () => {
    await expect(h.pipeline.transition({ applicationId: 999, toStage: 'MATCHED' }, RECRUITER))
      .rejects.toThrow(NotFoundError);
  });
});

// Document 2 §5 — the requisition-state guard matrix.
describe('PipelineService — requisition-state guards (BL-13)', () => {
  let h: Harness;
  let reqId: number;
  let appId: number;

  beforeEach(async () => {
    h = harness();
    reqId = await openRequisition(h);
    appId = (await h.pipeline.addCandidate({ requisitionId: reqId, candidateId: 42 }, RECRUITER)).id;
  });

  it('blocks advancing on an on-hold requisition', async () => {
    await h.requisitions.hold(reqId, 'budget freeze', ctxFor(20));
    await expect(h.pipeline.transition({ applicationId: appId, toStage: 'MATCHED' }, RECRUITER))
      .rejects.toThrow(RequisitionNotOpenError);
    expect(h.store.application(appId)!.stage).toBe('SOURCED');
  });

  it('still permits rejection on an on-hold requisition', async () => {
    await h.requisitions.hold(reqId, 'budget freeze', ctxFor(20));
    const rejected = await h.pipeline.transition(
      { applicationId: appId, toStage: 'REJECTED', reason: 'withdrew' }, RECRUITER,
    );
    expect(rejected.stage).toBe('REJECTED');
  });

  it('blocks any move once the requisition is closed', async () => {
    await h.requisitions.close(reqId, 'done', ctxFor(20));
    // The cascade already withdrew it; a further move is refused outright.
    await expect(h.pipeline.transition(
      { applicationId: appId, toStage: 'MATCHED' }, RECRUITER,
    )).rejects.toThrow();
  });
});

describe('PipelineService — bulk transitions', () => {
  it('reports per-item outcomes rather than failing the batch', async () => {
    const h = harness();
    const reqId = await openRequisition(h, 5);
    const a = await h.pipeline.addCandidate({ requisitionId: reqId, candidateId: 1 }, RECRUITER);
    const b = await h.pipeline.addCandidate({ requisitionId: reqId, candidateId: 2 }, RECRUITER);
    // c is already terminal, so it must be skipped, not crash the batch.
    const c = await h.pipeline.addCandidate({ requisitionId: reqId, candidateId: 3 }, RECRUITER);
    await h.pipeline.transition(
      { applicationId: c.id, toStage: 'REJECTED', reason: 'no' }, RECRUITER,
    );

    const result = await h.pipeline.bulkTransition([a.id, b.id, c.id, 999], 'MATCHED', RECRUITER);

    expect(result.affected).toBe(2);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.map((s) => s.errorCode).sort())
      .toEqual(['ILLEGAL_TRANSITION', 'NOT_FOUND']);
    expect(h.store.application(a.id)!.stage).toBe('MATCHED');
    expect(h.store.application(c.id)!.stage).toBe('REJECTED');
  });

  it('requires the bulk permission specifically', async () => {
    const h = harness();
    const reqId = await openRequisition(h);
    const a = await h.pipeline.addCandidate({ requisitionId: reqId, candidateId: 1 }, RECRUITER);
    const moveOnly = ctxFor(31, [PIPELINE_PERMISSIONS.MOVE_STAGE]);
    await expect(h.pipeline.bulkTransition([a.id], 'MATCHED', moveOnly))
      .rejects.toThrow(ForbiddenError);
  });
});

describe('PipelineService — recruiter workspace', () => {
  it('sets and clears the next action', async () => {
    const h = harness();
    const reqId = await openRequisition(h);
    const a = await h.pipeline.addCandidate({ requisitionId: reqId, candidateId: 1 }, RECRUITER);
    const due = new Date('2026-09-01T09:00:00Z');

    await h.pipeline.setNextAction(a.id, 'Schedule technical interview', due, RECRUITER);
    expect(h.store.application(a.id)!.toState().nextAction).toBe('Schedule technical interview');

    await h.pipeline.setNextAction(a.id, null, null, RECRUITER);
    expect(h.store.application(a.id)!.toState().nextAction).toBeNull();
  });

  it('reassigns the recruiter', async () => {
    const h = harness();
    const reqId = await openRequisition(h);
    const a = await h.pipeline.addCandidate({ requisitionId: reqId, candidateId: 1 }, RECRUITER);
    await h.pipeline.assignRecruiter(a.id, 77, RECRUITER);
    expect(h.store.application(a.id)!.toState().recruiterId).toBe(77);
  });
});
