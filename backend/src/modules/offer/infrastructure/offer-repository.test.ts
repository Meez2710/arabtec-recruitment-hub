// Offer repository integration tests — against a REAL PostgreSQL.
//
// The money tests here matter more than they look. `numeric` returns a STRING
// over the wire; if the mapper did not convert, `totalNet` would concatenate
// instead of adding and every offer letter would carry a nonsense figure with
// nothing throwing. These assert the value AND the type.

import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '../../../infrastructure/db/testing/database.js';
import type { TestDatabase } from '../../../infrastructure/db/testing/database.js';
import {
  anApplication, anOffer, anOpenRequisition, globalCtx, scopedCtx,
} from '../../../infrastructure/db/testing/fixtures.js';
import { offerCompensationLine } from '../../../infrastructure/db/schema/index.js';
import { DrizzleHiringUnitOfWork } from '../../hiring/infrastructure/unit-of-work.js';
import { DrizzleOfferUnitOfWork } from './unit-of-work.js';
import { ConstraintViolationError } from '../../../infrastructure/db/errors.js';

const COMPONENTS = ['BASIC_SALARY', 'ACCOMMODATION', 'TRANSPORTATION', 'OTHERS', 'AREA_ALLOWANCE'];

let harness: TestDatabase;
let hiring: DrizzleHiringUnitOfWork;
let uow: DrizzleOfferUnitOfWork;
const ctx = globalCtx();

const seedApplication = async (projectId = 3, n = 1): Promise<{ reqId: number; appId: number }> =>
  hiring.transaction(async (tx) => {
    const r = anOpenRequisition({
      id: await tx.requisitions.nextId(ctx), ticketNo: `REQ-2026-0000${n}`, ctx, projectId,
    });
    await tx.requisitions.save(r);
    const a = anApplication({
      id: await tx.applications.nextId(ctx),
      applicationNo: `APP-0000${n}`, candidateId: 500 + n, requisitionId: r.id, ctx,
    });
    await tx.applications.save(a);
    return { reqId: r.id, appId: a.id };
  });

beforeAll(async () => {
  harness = await createTestDatabase();
  hiring = new DrizzleHiringUnitOfWork(harness.db, { year: () => 2026 });
  uow = new DrizzleOfferUnitOfWork(harness.db, { year: () => 2026 });
});

afterAll(async () => { await harness.close(); });
beforeEach(async () => { await harness.reset(); });

const draft = async (projectId = 3, n = 1): Promise<number> => {
  const { reqId, appId } = await seedApplication(projectId, n);
  return uow.transaction(async (tx) => {
    const o = anOffer({
      id: await tx.offers.nextId(ctx), offerNo: `OFR-2026-0000${n}`,
      applicationId: appId, candidateId: 500 + n, requisitionId: reqId, ctx,
    });
    await tx.offers.save(o);
    return o.id;
  });
};

describe('OfferRepository', () => {
  it('emits offer numbers in the legacy format', async () => {
    const no = await uow.transaction(async (tx) => tx.offers.nextOfferNo(ctx));
    expect(no).toBe('OFR-2026-00001');
  });

  it('round-trips compensation lines as NUMBERS, not strings', async () => {
    const id = await draft();
    const loaded = await uow.transaction(async (tx) => tx.offers.findById(id, ctx));

    const lines = loaded!.toState().lines;
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(typeof line.amount).toBe('number');

    const basic = lines.find((l) => l.componentCode === 'BASIC_SALARY');
    expect(basic?.amount).toBe(12_500.5);
    // The sum is arithmetic, not concatenation. Without the mapper's conversion
    // this reads "12500.501250.25".
    expect(loaded?.totalNet).toBeCloseTo(13_750.75, 2);
  });

  it('stores money as exact numeric, not float', async () => {
    const id = await draft();
    const rows = await harness.db
      .select().from(offerCompensationLine).where(eq(offerCompensationLine.offerId, id));
    // Canonical two-decimal text — a float column would show 12500.5 or worse.
    expect(rows.map((r) => r.amount).sort()).toEqual(['1250.25', '12500.50']);
  });

  it('replaces compensation lines rather than accumulating them', async () => {
    const id = await draft();
    await uow.transaction(async (tx) => {
      const o = await tx.offers.findByIdForUpdate(id, ctx);
      o?.setCompensation([
        { componentCode: 'BASIC_SALARY', amount: 14_000 },
        { componentCode: 'ACCOMMODATION', amount: 2_000 },
        { componentCode: 'AREA_ALLOWANCE', amount: 500 },
      ], COMPONENTS, ctx.actor);
      if (o) await tx.offers.save(o);
    });

    const rows = await harness.db
      .select().from(offerCompensationLine).where(eq(offerCompensationLine.offerId, id));
    expect(rows.map((r) => r.componentCode).sort())
      .toEqual(['ACCOMMODATION', 'AREA_ALLOWANCE', 'BASIC_SALARY']);
    // TRANSPORTATION is gone; nothing was left behind to inflate the total.
    expect(rows).toHaveLength(3);
  });

  it('persists the pinned template all-or-nothing', async () => {
    const id = await draft();
    await uow.transaction(async (tx) => {
      const o = await tx.offers.findByIdForUpdate(id, ctx);
      o?.submit({ directorThreshold: null, thresholdCurrency: 'EGP' }, ctx.actor);
      o?.approve({ id: 42, name: 'Director' }, { hasDirectorAuthority: true });
      o?.send({
        templateCode: 'OFFER_LETTER_EN', templateVersion: 3,
        variableSnapshot: { candidateName: 'Ahmed', basic: 12_500.5 },
        validityDays: 5, now: new Date('2026-03-10T09:00:00.000Z'), actor: ctx.actor,
      });
      if (o) await tx.offers.save(o);
    });

    const loaded = (await uow.transaction(async (tx) => tx.offers.findById(id, ctx)))!.toState();
    expect(loaded.templateCode).toBe('OFFER_LETTER_EN');
    expect(loaded.templateVersion).toBe(3);
    // The snapshot is what makes a 2026 letter reprintable in 2028.
    expect(loaded.variableSnapshot).toMatchObject({ candidateName: 'Ahmed' });
    expect(loaded.expiresAt?.toISOString()).toBe('2026-03-15T09:00:00.000Z');
  });

  const issue = async (id: number, sentAt: string): Promise<void> => {
    await uow.transaction(async (tx) => {
      const o = await tx.offers.findByIdForUpdate(id, ctx);
      o?.submit({ directorThreshold: null, thresholdCurrency: 'EGP' }, ctx.actor);
      o?.approve({ id: 42, name: 'Director' }, { hasDirectorAuthority: true });
      o?.send({
        templateCode: 'OFFER_LETTER_EN', templateVersion: 3, variableSnapshot: {},
        validityDays: 5, now: new Date(sentAt), actor: ctx.actor,
      });
      if (o) await tx.offers.save(o);
    });
  };

  it('finds only sent offers that are actually past expiry', async () => {
    const id = await draft();
    await issue(id, '2026-03-10T09:00:00.000Z');

    const notYet = await uow.transaction(async (tx) =>
      tx.offers.findExpirable(new Date('2026-03-14T09:00:00.000Z'), ctx));
    expect(notYet).toEqual([]);

    const due = await uow.transaction(async (tx) =>
      tx.offers.findExpirable(new Date('2026-03-16T09:00:00.000Z'), ctx));
    expect(due.map((o) => o.id)).toEqual([id]);
    // Loaded with lines attached, so the sweep can act on a complete aggregate.
    expect(due[0]?.toState().lines).toHaveLength(2);
  });

  it('lets the expiry sweep save the offers it loaded', async () => {
    // Regression guard: `findExpirable` must register baselines, or every save
    // in the sweep would attempt an INSERT on an existing id.
    const id = await draft();
    await issue(id, '2026-03-10T09:00:00.000Z');

    await uow.transaction(async (tx) => {
      const due = await tx.offers.findExpirable(new Date('2026-03-16T09:00:00.000Z'), ctx);
      for (const o of due) {
        o.expire(new Date('2026-03-16T09:00:00.000Z'), ctx.actor);
        await tx.offers.save(o);
      }
    });

    const after = await uow.transaction(async (tx) => tx.offers.findById(id, ctx));
    expect(after?.status).toBe('EXPIRED');
  });

  it('finds the live offer for an application and nothing once it is withdrawn', async () => {
    const id = await draft();
    await issue(id, '2026-03-10T09:00:00.000Z');
    const appId = (await uow.transaction(async (tx) => tx.offers.findById(id, ctx)))!.applicationId;

    expect((await uow.transaction(async (tx) =>
      tx.offers.findLiveForApplication(appId, ctx)))?.id).toBe(id);

    await uow.transaction(async (tx) => {
      const o = await tx.offers.findByIdForUpdate(id, ctx);
      o?.withdraw('role cancelled', new Date('2026-03-12T09:00:00.000Z'), ctx.actor);
      if (o) await tx.offers.save(o);
    });

    expect(await uow.transaction(async (tx) =>
      tx.offers.findLiveForApplication(appId, ctx))).toBeNull();
  });

  it('refuses a second live offer on the same application', async () => {
    const id = await draft();
    await issue(id, '2026-03-10T09:00:00.000Z');
    const first = (await uow.transaction(async (tx) => tx.offers.findById(id, ctx)))!.toState();

    await expect(uow.transaction(async (tx) => {
      const second = anOffer({
        id: await tx.offers.nextId(ctx), offerNo: 'OFR-2026-00002',
        applicationId: first.applicationId, candidateId: first.candidateId,
        requisitionId: first.requisitionId, ctx,
      });
      await tx.offers.save(second);
      const loaded = await tx.offers.findByIdForUpdate(second.id, ctx);
      loaded?.submit({ directorThreshold: null, thresholdCurrency: 'EGP' }, ctx.actor);
      loaded?.approve({ id: 42, name: 'Director' }, { hasDirectorAuthority: true });
      loaded?.send({
        templateCode: 'OFFER_LETTER_EN', templateVersion: 3, variableSnapshot: {},
        validityDays: 5, now: new Date('2026-03-11T09:00:00.000Z'), actor: ctx.actor,
      });
      if (loaded) await tx.offers.save(loaded);
    })).rejects.toBeInstanceOf(ConstraintViolationError);
  });

  it('scopes through the requisition', async () => {
    const id = await draft(99, 1);
    expect(await uow.transaction(async (tx) => tx.offers.findById(id, scopedCtx([3])))).toBeNull();
    expect(await uow.transaction(async (tx) => tx.offers.findById(id, ctx))).not.toBeNull();
    expect(await uow.transaction(async (tx) =>
      tx.offers.findExpirable(new Date('2030-01-01T00:00:00.000Z'), scopedCtx([3])))).toEqual([]);
  });
});
