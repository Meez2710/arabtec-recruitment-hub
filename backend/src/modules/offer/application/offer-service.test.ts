import { beforeEach, describe, expect, it } from 'vitest';
import { OfferService, OFFER_PERMISSIONS, type OfferSettings } from './offer-service.js';
import { AuthContext, ForbiddenError, NotFoundError } from '../../hiring/index.js';
import { RecordingEventBus } from '../../hiring/application/__testing__/in-memory.js';
import {
  InMemoryOfferStore, InMemoryOfferUnitOfWork, RecordingPipelineGateway,
} from './__testing__/in-memory.js';
import {
  CompensationLockedError, IllegalOfferTransitionError,
  OfferReasonRequiredError, OfferSelfApprovalError, UnknownComponentError,
} from '../domain/errors.js';

const NOW = new Date('2026-08-03T09:00:00Z');
const clock = { now: () => NOW };

const COMPONENTS = ['BASIC_SALARY', 'ACCOMMODATION', 'TRANSPORTATION', 'OTHERS', 'AREA_ALLOWANCE'];

const ALL = Object.values(OFFER_PERMISSIONS);
function ctxFor(userId: number, permissions: readonly string[] = ALL): AuthContext {
  return new AuthContext({
    tenantId: 1, userId, userName: `User ${userId}`,
    permissions: [...permissions], projectScopes: [], isGlobalScope: true,
  });
}

const PREPARER = ctxFor(10);
const APPROVER = ctxFor(20);
const DIRECTOR = ctxFor(21);
/** Approver without director authority. */
const MANAGER = ctxFor(22, [
  OFFER_PERMISSIONS.APPROVE, OFFER_PERMISSIONS.SEND, OFFER_PERMISSIONS.RESULT_UPDATE,
]);

function settings(overrides: Partial<{
  threshold: number | null; validityDays: number; components: readonly string[];
}> = {}): OfferSettings {
  return {
    approvalRequirement: async () => ({
      directorThreshold: overrides.threshold === undefined ? 50_000 : overrides.threshold,
      thresholdCurrency: 'EGP',
    }),
    validityDays: async () => overrides.validityDays ?? 5,
    compensationComponents: async () => overrides.components ?? COMPONENTS,
  };
}

interface Harness {
  store: InMemoryOfferStore;
  events: RecordingEventBus;
  pipeline: RecordingPipelineGateway;
  service: OfferService;
}

function harness(s: OfferSettings = settings()): Harness {
  const store = new InMemoryOfferStore();
  const uow = new InMemoryOfferUnitOfWork(store);
  const events = new RecordingEventBus();
  const pipeline = new RecordingPipelineGateway();
  return {
    store, events, pipeline,
    service: new OfferService({ uow, events, settings: s, pipeline, clock }),
  };
}

/** Sample from the real Arabtec letters: 9,000 basic + allowances = 25,200 net. */
const LINES = [
  { componentCode: 'BASIC_SALARY', amount: 9_000 },
  { componentCode: 'ACCOMMODATION', amount: 3_600 },
  { componentCode: 'TRANSPORTATION', amount: 2_700 },
  { componentCode: 'OTHERS', amount: 2_700 },
  { componentCode: 'AREA_ALLOWANCE', amount: 7_200 },
];

async function draft(h: Harness, lines = LINES) {
  return h.service.draft({
    applicationId: 100, candidateId: 42, requisitionId: 7,
    positionTitle: 'Quantity Surveyor Engineer', currency: 'EGP', lines,
  }, PREPARER);
}

describe('OfferService — draft and compensation', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('drafts an offer and totals the entered lines', async () => {
    const offer = await draft(h);
    expect(offer.status).toBe('DRAFT');
    expect(offer.totalNet).toBe(25_200);
    expect(offer.offerNo).toMatch(/^OFR-\d{5}$/);
  });

  // Compensation is manual entry over configurable components — no ratios.
  it('sums lines without deriving any of them', async () => {
    const offer = await draft(h, [
      { componentCode: 'BASIC_SALARY', amount: 16_500 },
      { componentCode: 'ACCOMMODATION', amount: 6_600 },
      { componentCode: 'TRANSPORTATION', amount: 4_950 },
      { componentCode: 'OTHERS', amount: 4_950 },
    ]);
    expect(offer.totalNet).toBe(33_000); // no area allowance line at all
  });

  it('rejects an unconfigured component code', async () => {
    await expect(draft(h, [{ componentCode: 'BONUS', amount: 1 }]))
      .rejects.toThrow(UnknownComponentError);
  });

  it('moves the application to OFFER_PREPARATION through the Hiring door', async () => {
    await draft(h);
    expect(h.pipeline.stages()).toEqual(['OFFER_PREPARATION']);
  });

  it('requires the create permission', async () => {
    await expect(h.service.draft({
      applicationId: 1, candidateId: 1, requisitionId: 1,
      positionTitle: 'X', currency: 'EGP', lines: LINES,
    }, ctxFor(99, []))).rejects.toThrow(ForbiddenError);
  });
});

describe('OfferService — approval (BL-11, BL-12)', () => {
  it('requires a director above the configured threshold', async () => {
    const h = harness(settings({ threshold: 20_000 }));
    const o = await draft(h); // 25,200 > 20,000
    const submitted = await h.service.submit(o.id, PREPARER);
    expect(submitted.requiresDirectorApproval).toBe(true);

    await expect(h.service.approve(o.id, MANAGER)).rejects.toThrow(OfferSelfApprovalError);
    expect((await h.service.approve(o.id, DIRECTOR)).status).toBe('APPROVED');
  });

  it('does not require a director below the threshold', async () => {
    const h = harness(settings({ threshold: 100_000 }));
    const o = await draft(h);
    const submitted = await h.service.submit(o.id, PREPARER);
    expect(submitted.requiresDirectorApproval).toBe(false);
    expect((await h.service.approve(o.id, MANAGER)).status).toBe('APPROVED');
  });

  // BL-11 — parseFloat returned NaN and director approval was silently skipped.
  it('FAILS CLOSED when the threshold cannot be resolved', async () => {
    const h = harness(settings({ threshold: null }));
    const o = await draft(h);
    const submitted = await h.service.submit(o.id, PREPARER);

    expect(submitted.requiresDirectorApproval).toBe(true);
    await expect(h.service.approve(o.id, MANAGER)).rejects.toThrow(OfferSelfApprovalError);
    expect((await h.service.approve(o.id, DIRECTOR)).status).toBe('APPROVED');

    const event = h.events.published.find((e) => e.type === 'OfferSubmitted');
    expect(event?.payload).toMatchObject({ failedClosed: true });
  });

  // BL-12 — the legacy code had a comment describing this control, and no control.
  it('refuses approval by the preparer', async () => {
    const h = harness();
    const o = await draft(h);
    await h.service.submit(o.id, PREPARER);
    await expect(h.service.approve(o.id, PREPARER)).rejects.toThrow(OfferSelfApprovalError);
    await expect(h.service.rejectApproval(o.id, 'no', PREPARER)).rejects.toThrow(OfferSelfApprovalError);
  });

  it('requires a reason to reject approval', async () => {
    const h = harness();
    const o = await draft(h);
    await h.service.submit(o.id, PREPARER);
    await expect(h.service.rejectApproval(o.id, '  ', APPROVER))
      .rejects.toThrow(OfferReasonRequiredError);
    expect((await h.service.rejectApproval(o.id, 'over budget', APPROVER)).status)
      .toBe('REJECTED_BY_APPROVER');
  });

  it('recalls a submission back to DRAFT', async () => {
    const h = harness();
    const o = await draft(h);
    await h.service.submit(o.id, PREPARER);
    expect((await h.service.recall(o.id, PREPARER)).status).toBe('DRAFT');
  });
});

describe('OfferService — compensation change control (BL-10)', () => {
  it('returns an approved offer to DRAFT when the money changes', async () => {
    const h = harness();
    const o = await draft(h);
    await h.service.submit(o.id, PREPARER);
    await h.service.approve(o.id, DIRECTOR);

    const edited = await h.service.setCompensation(
      o.id, [{ componentCode: 'BASIC_SALARY', amount: 12_000 }], PREPARER,
    );
    expect(edited.status).toBe('DRAFT');
    expect(edited.totalNet).toBe(12_000);
    expect(h.store.get(o.id)!.approvedBy).toBeNull();
  });

  // The one window the legacy code left uncontrolled.
  it('refuses to change compensation once the offer has been sent', async () => {
    const h = harness();
    const o = await draft(h);
    await h.service.submit(o.id, PREPARER);
    await h.service.approve(o.id, DIRECTOR);
    await h.service.send(o.id, APPROVER);

    await expect(h.service.setCompensation(
      o.id, [{ componentCode: 'BASIC_SALARY', amount: 99_000 }], PREPARER,
    )).rejects.toThrow(CompensationLockedError);
    expect(h.store.get(o.id)!.totalNet).toBe(25_200);
  });
});

describe('OfferService — send, outcome and expiry', () => {
  let h: Harness;
  let offerId: number;

  beforeEach(async () => {
    h = harness();
    const o = await draft(h);
    offerId = o.id;
    await h.service.submit(offerId, PREPARER);
    await h.service.approve(offerId, DIRECTOR);
    h.events.reset();
  });

  it('sends an approved offer, pins the template and starts the validity clock', async () => {
    const sent = await h.service.send(offerId, APPROVER);
    expect(sent.status).toBe('SENT');
    // "This Offer of Employment is valid for 5 days from the document date."
    expect(sent.expiresAt).toEqual(new Date('2026-08-08T09:00:00Z'));

    const stored = h.store.get(offerId)!.toState();
    expect(stored.templateVersion).toBe(1);
    expect(stored.variableSnapshot).not.toBeNull();
    expect(h.pipeline.stages()).toContain('OFFER_SENT');
  });

  it('refuses to send an offer that is not approved', async () => {
    const h2 = harness();
    const o = await draft(h2);
    await expect(h2.service.send(o.id, APPROVER)).rejects.toThrow(IllegalOfferTransitionError);
  });

  it('accepts without moving the pipeline — the hire consumes the seat', async () => {
    await h.service.send(offerId, APPROVER);
    h.pipeline.moves.length = 0;

    const accepted = await h.service.accept(offerId, APPROVER);
    expect(accepted.status).toBe('ACCEPTED');
    expect(h.pipeline.moves).toHaveLength(0);
  });

  it('declines with a reason and moves the pipeline', async () => {
    await h.service.send(offerId, APPROVER);
    await expect(h.service.decline(offerId, '  ', APPROVER))
      .rejects.toThrow(OfferReasonRequiredError);

    const declined = await h.service.decline(offerId, 'accepted elsewhere', APPROVER);
    expect(declined.status).toBe('DECLINED');
    expect(h.pipeline.stages()).toContain('OFFER_DECLINED');
  });

  it('withdraws with a reason', async () => {
    await h.service.send(offerId, APPROVER);
    expect((await h.service.withdraw(offerId, 'role cancelled', APPROVER)).status)
      .toBe('WITHDRAWN');
  });

  it('refuses to expire an offer that is still valid', async () => {
    await h.service.send(offerId, APPROVER);
    await expect(h.service.expire(offerId, APPROVER)).rejects.toThrow(IllegalOfferTransitionError);
  });

  it('expires a sent offer once the window has passed', async () => {
    await h.service.send(offerId, APPROVER);
    const late = new Date('2026-08-10T09:00:00Z');
    const h2 = new OfferService({
      uow: new InMemoryOfferUnitOfWork(h.store), events: h.events,
      settings: settings(), pipeline: h.pipeline, clock: { now: () => late },
    });

    const expired = await h2.expire(offerId, APPROVER);
    expect(expired.status).toBe('EXPIRED');
    expect(h.pipeline.stages()).toContain('OFFER_DECLINED');
  });

  it('sweeps every due offer and reports outcomes', async () => {
    await h.service.send(offerId, APPROVER);
    const late = new Date('2026-08-10T09:00:00Z');
    const h2 = new OfferService({
      uow: new InMemoryOfferUnitOfWork(h.store), events: h.events,
      settings: settings(), pipeline: h.pipeline, clock: { now: () => late },
    });

    const result = await h2.expireDue(APPROVER);
    expect(result.expired).toEqual([offerId]);
    expect(result.failed).toEqual([]);
  });

  it('reports NOT_FOUND for a missing offer', async () => {
    await expect(h.service.send(999, APPROVER)).rejects.toThrow(NotFoundError);
  });
});

describe('OfferService — one live offer per application', () => {
  it('refuses a second draft while one is live', async () => {
    const h = harness();
    const o = await draft(h);
    await h.service.submit(o.id, PREPARER);
    await h.service.approve(o.id, DIRECTOR);
    await h.service.send(o.id, APPROVER);

    await expect(draft(h)).rejects.toThrow();
  });

  it('allows a new draft once the previous offer is terminal', async () => {
    const h = harness();
    const o = await draft(h);
    await h.service.submit(o.id, PREPARER);
    await h.service.approve(o.id, DIRECTOR);
    await h.service.send(o.id, APPROVER);
    await h.service.decline(o.id, 'accepted elsewhere', APPROVER);

    await expect(draft(h)).resolves.toMatchObject({ status: 'DRAFT' });
  });
});
