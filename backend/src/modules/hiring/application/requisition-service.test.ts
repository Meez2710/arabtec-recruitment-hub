import { beforeEach, describe, expect, it } from 'vitest';
import { RequisitionService, REQUISITION_PERMISSIONS, type ApprovalSettings } from './requisition-service.js';
import { PipelineService, PIPELINE_PERMISSIONS } from './pipeline-service.js';
import { AuthContext } from '../../shared/kernel/auth-context.js';
import { ForbiddenError, NotFoundError, StaleAggregateError } from '../../shared/kernel/errors.js';
import {
  HeadcountBelowFilledError, IllegalTransitionError, MissingReasonError,
  OutstandingOfferError, SelfApprovalError,
} from '../domain/errors.js';
import {
  InMemoryStore, InMemoryUnitOfWork, RecordingEventBus, StubOfferGateway,
} from './__testing__/in-memory.js';
import type { OfferGateway } from './ports/offer-gateway.js';

const ALL = [
  ...Object.values(REQUISITION_PERMISSIONS),
  ...Object.values(PIPELINE_PERMISSIONS),
];

function ctxFor(userId: number, permissions: readonly string[] = ALL): AuthContext {
  return new AuthContext({
    tenantId: 1, userId, userName: `User ${userId}`,
    permissions: [...permissions], projectScopes: [], isGlobalScope: true,
  });
}

const REQUESTER = ctxFor(10);
const APPROVER = ctxFor(20);

function settings(approvalRequired: boolean): ApprovalSettings {
  return { approvalRequired: async () => approvalRequired };
}

interface Harness {
  store: InMemoryStore;
  uow: InMemoryUnitOfWork;
  events: RecordingEventBus;
  service: RequisitionService;
  pipeline: PipelineService;
}

function harness(approvalRequired = true, offers: OfferGateway = new StubOfferGateway()): Harness {
  const store = new InMemoryStore();
  const uow = new InMemoryUnitOfWork(store);
  const events = new RecordingEventBus();
  return {
    store, uow, events,
    service: new RequisitionService({ uow, events, settings: settings(approvalRequired), offers }),
    pipeline: new PipelineService({ uow, events }),
  };
}

/** Create -> submit -> approve -> assign. Returns the requisition id. */
async function openRequisition(h: Harness, headcount = 3): Promise<number> {
  const created = await h.service.create(
    { title: 'Site Engineer', projectId: 1, departmentId: 2, headcount }, REQUESTER,
  );
  await h.service.submit(created.id, REQUESTER);
  await h.service.approve(created.id, APPROVER);
  await h.service.assignRecruiter(created.id, 30, APPROVER);
  h.events.reset();
  return created.id;
}

describe('RequisitionService — create and update', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('creates a DRAFT with a ticket number and one seat per headcount', async () => {
    const r = await h.service.create(
      { title: 'Site Engineer', projectId: 1, departmentId: 2, headcount: 3 }, REQUESTER,
    );
    expect(r.state).toBe('DRAFT');
    expect(r.headcount).toBe(3);
    expect(r.openSeats).toBe(3);
    expect(r.ticketNo).toMatch(/^REQ-2026-\d{5}$/);
    expect(h.events.typesOf()).toContain('RequisitionCreated');
  });

  it('refuses creation without the permission', async () => {
    await expect(h.service.create(
      { title: 'X', projectId: 1, departmentId: 2, headcount: 1 }, ctxFor(99, []),
    )).rejects.toThrow(ForbiddenError);
  });

  it('updates descriptive fields while in DRAFT', async () => {
    const r = await h.service.create(
      { title: 'Old', projectId: 1, departmentId: 2, headcount: 1 }, REQUESTER,
    );
    await h.service.update(r.id, { title: 'New Title', departmentId: 9 }, REQUESTER);
    expect(h.store.requisition(r.id)!.toState().title).toBe('New Title');
    expect(h.store.requisition(r.id)!.toState().departmentId).toBe(9);
  });

  it('refuses to update once approved — that is what revise is for', async () => {
    const id = await openRequisition(h);
    await expect(h.service.update(id, { title: 'Sneaky' }, REQUESTER))
      .rejects.toThrow(IllegalTransitionError);
  });
});

describe('RequisitionService — approval (Document 2 §2)', () => {
  it('goes straight to APPROVED when approval is disabled', async () => {
    const h = harness(false);
    const r = await h.service.create(
      { title: 'X', projectId: 1, departmentId: 2, headcount: 1 }, REQUESTER,
    );
    const submitted = await h.service.submit(r.id, REQUESTER);
    expect(submitted.state).toBe('APPROVED');
  });

  it('waits for an approver when approval is enabled', async () => {
    const h = harness(true);
    const r = await h.service.create(
      { title: 'X', projectId: 1, departmentId: 2, headcount: 1 }, REQUESTER,
    );
    const submitted = await h.service.submit(r.id, REQUESTER);
    expect(submitted.state).toBe('PENDING_APPROVAL');
    expect((await h.service.approve(r.id, APPROVER)).state).toBe('APPROVED');
  });

  // BL-02 — three roles held create + submit + approve and nothing checked identity.
  it('refuses self-approval by the requester', async () => {
    const h = harness(true);
    const r = await h.service.create(
      { title: 'X', projectId: 1, departmentId: 2, headcount: 1 }, REQUESTER,
    );
    await h.service.submit(r.id, REQUESTER);
    await expect(h.service.approve(r.id, REQUESTER)).rejects.toThrow(SelfApprovalError);
    await expect(h.service.reject(r.id, 'no', REQUESTER)).rejects.toThrow(SelfApprovalError);
  });

  it('requires a reason to reject, and allows revise afterwards', async () => {
    const h = harness(true);
    const r = await h.service.create(
      { title: 'X', projectId: 1, departmentId: 2, headcount: 1 }, REQUESTER,
    );
    await h.service.submit(r.id, REQUESTER);
    await expect(h.service.reject(r.id, '  ', APPROVER)).rejects.toThrow(MissingReasonError);

    await h.service.reject(r.id, 'not budgeted', APPROVER);
    expect((await h.service.revise(r.id, REQUESTER)).state).toBe('DRAFT');
  });

  it('lets only the requester recall their own submission', async () => {
    const h = harness(true);
    const r = await h.service.create(
      { title: 'X', projectId: 1, departmentId: 2, headcount: 1 }, REQUESTER,
    );
    await h.service.submit(r.id, REQUESTER);
    await expect(h.service.recall(r.id, APPROVER)).rejects.toThrow(ForbiddenError);
    expect((await h.service.recall(r.id, REQUESTER)).state).toBe('DRAFT');
  });
});

describe('RequisitionService — open, hold, headcount', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('assigning a recruiter is what opens the requisition', async () => {
    const r = await h.service.create(
      { title: 'X', projectId: 1, departmentId: 2, headcount: 1 }, REQUESTER,
    );
    await h.service.submit(r.id, REQUESTER);
    const approved = await h.service.approve(r.id, APPROVER);
    expect(approved.state).toBe('APPROVED');

    const opened = await h.service.assignRecruiter(r.id, 30, APPROVER);
    expect(opened.state).toBe('OPEN');
    expect(opened.recruiterId).toBe(30);
  });

  it('holds and resumes to exactly the prior state', async () => {
    const id = await openRequisition(h);
    expect((await h.service.hold(id, 'budget freeze', APPROVER)).state).toBe('ON_HOLD');
    expect((await h.service.resume(id, APPROVER)).state).toBe('OPEN');
  });

  // BL-21 — the legacy edit changed headcount and never touched the seat table.
  it('reconciles seats when headcount changes', async () => {
    const id = await openRequisition(h, 2);
    const grown = await h.service.adjustHeadcount(id, 5, APPROVER);
    expect(grown.headcount).toBe(5);
    expect(grown.openSeats).toBe(5);

    const shrunk = await h.service.adjustHeadcount(id, 2, APPROVER);
    expect(shrunk.openSeats).toBe(2);
  });

  it('refuses to drop headcount below committed seats', async () => {
    const id = await openRequisition(h, 3);
    // Fill two seats through the aggregate path HiringService uses.
    const req = h.store.requisition(id)!;
    req.fillSeat(999, APPROVER.actor);
    req.fillSeat(1000, APPROVER.actor);
    h.store.putRequisition(req);

    await expect(h.service.adjustHeadcount(id, 0, APPROVER)).rejects.toThrow();
    await expect(h.service.adjustHeadcount(id, 1, APPROVER))
      .rejects.toThrow(HeadcountBelowFilledError);

    // Shrinking to exactly the committed count is allowed.
    const ok = await h.service.adjustHeadcount(id, 2, APPROVER);
    expect(ok.headcount).toBe(2);
    expect(ok.filledSeats).toBe(2);
    expect(ok.openSeats).toBe(0);
  });
});

describe('RequisitionService — close cascade (BL-22)', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('withdraws every non-terminal application when the requisition closes', async () => {
    const id = await openRequisition(h, 3);
    const a1 = await h.pipeline.addCandidate({ requisitionId: id, candidateId: 41 }, APPROVER);
    const a2 = await h.pipeline.addCandidate({ requisitionId: id, candidateId: 42 }, APPROVER);
    await h.pipeline.transition({ applicationId: a2.id, toStage: 'MATCHED' }, APPROVER);

    const result = await h.service.close(id, 'project cancelled', APPROVER);

    expect(result.state).toBe('CLOSED');
    expect(result.withdrawnApplicationIds).toHaveLength(2);
    expect(h.store.application(a1.id)!.stage).toBe('WITHDRAWN');
    expect(h.store.application(a2.id)!.stage).toBe('WITHDRAWN');
  });

  it('resumes an on-hold application before withdrawing it, keeping history honest', async () => {
    const id = await openRequisition(h, 2);
    const a = await h.pipeline.addCandidate({ requisitionId: id, candidateId: 41 }, APPROVER);
    await h.pipeline.transition({ applicationId: a.id, toStage: 'MATCHED' }, APPROVER);
    await h.pipeline.transition(
      { applicationId: a.id, toStage: 'ON_HOLD', reason: 'candidate travelling' }, APPROVER,
    );

    await h.service.close(id, 'closing', APPROVER);

    const history = h.store.application(a.id)!.history.map((x) => x.toStage);
    expect(history).toEqual(['SOURCED', 'MATCHED', 'ON_HOLD', 'MATCHED', 'WITHDRAWN']);
  });

  // Document 2 §5 — closing under a live offer is a business error.
  it('refuses to close while a candidate holds a live offer, changing nothing', async () => {
    const h2 = harness(true, new StubOfferGateway([77]));
    const id = await openRequisition(h2, 2);
    const a = await h2.pipeline.addCandidate({ requisitionId: id, candidateId: 41 }, APPROVER);

    await expect(h2.service.close(id, 'closing', APPROVER)).rejects.toThrow(OutstandingOfferError);
    expect(h2.store.requisition(id)!.state).toBe('OPEN');
    expect(h2.store.application(a.id)!.stage).toBe('SOURCED');
  });

  it('cancel cascades too, and does not consult the offer gateway', async () => {
    const h2 = harness(true, new StubOfferGateway([77]));
    const id = await openRequisition(h2, 2);
    const a = await h2.pipeline.addCandidate({ requisitionId: id, candidateId: 41 }, APPROVER);

    const result = await h2.service.cancel(id, 'project shelved', APPROVER);
    expect(result.state).toBe('CANCELLED');
    expect(h2.store.application(a.id)!.stage).toBe('WITHDRAWN');
  });
});

describe('RequisitionService — reopen (BL-04)', () => {
  it('creates new seats so hiring can actually resume', async () => {
    const h = harness();
    const id = await openRequisition(h, 1);
    const req = h.store.requisition(id)!;
    req.fillSeat(500, APPROVER.actor);
    h.store.putRequisition(req);

    await h.service.close(id, 'filled', APPROVER);
    const reopened = await h.service.reopen(id, 'one resigned', 2, APPROVER);

    expect(reopened.state).toBe('OPEN');
    expect(reopened.headcount).toBe(3);
    expect(reopened.openSeats).toBe(2);
  });
});

describe('RequisitionService — concurrency and errors', () => {
  it('rejects a stale version', async () => {
    const h = harness();
    const r = await h.service.create(
      { title: 'X', projectId: 1, departmentId: 2, headcount: 1 }, REQUESTER,
    );
    await expect(h.service.submit(r.id, REQUESTER, r.version - 1))
      .rejects.toThrow(StaleAggregateError);
  });

  it('reports NOT_FOUND for a missing requisition', async () => {
    const h = harness();
    await expect(h.service.submit(999, REQUESTER)).rejects.toThrow(NotFoundError);
  });

  it('enforces a distinct permission per operation', async () => {
    const h = harness();
    const id = await openRequisition(h);
    const noPerms = ctxFor(77, []);
    await expect(h.service.hold(id, 'x', noPerms)).rejects.toThrow(ForbiddenError);
    await expect(h.service.close(id, 'x', noPerms)).rejects.toThrow(ForbiddenError);
    await expect(h.service.cancel(id, 'x', noPerms)).rejects.toThrow(ForbiddenError);
    await expect(h.service.reopen(id, 'x', 1, noPerms)).rejects.toThrow(ForbiddenError);
  });
});
