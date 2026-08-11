// Interview repository integration tests — against a REAL PostgreSQL.

import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '../../../infrastructure/db/testing/database.js';
import type { TestDatabase } from '../../../infrastructure/db/testing/database.js';
import {
  anApplication, anInterview, anOpenRequisition, globalCtx, scopedCtx,
} from '../../../infrastructure/db/testing/fixtures.js';
import { interviewAssessment, interviewPanel } from '../../../infrastructure/db/schema/index.js';
import { DrizzleHiringUnitOfWork } from '../../hiring/infrastructure/unit-of-work.js';
import { DrizzleInterviewUnitOfWork } from './unit-of-work.js';
import { ConstraintViolationError } from '../../../infrastructure/db/errors.js';

let harness: TestDatabase;
let hiring: DrizzleHiringUnitOfWork;
let uow: DrizzleInterviewUnitOfWork;
const ctx = globalCtx();

/** Interviews reference a real application; the FK is RESTRICT, not decorative. */
const seedApplication = async (projectId = 3): Promise<{ reqId: number; appId: number }> =>
  hiring.transaction(async (tx) => {
    const r = anOpenRequisition({
      id: await tx.requisitions.nextId(ctx), ticketNo: `REQ-2026-0000${projectId}`, ctx, projectId,
    });
    await tx.requisitions.save(r);
    const a = anApplication({
      id: await tx.applications.nextId(ctx),
      applicationNo: `APP-0000${projectId}`, candidateId: 501, requisitionId: r.id, ctx,
    });
    await tx.applications.save(a);
    return { reqId: r.id, appId: a.id };
  });

beforeAll(async () => {
  harness = await createTestDatabase();
  hiring = new DrizzleHiringUnitOfWork(harness.db, { year: () => 2026 });
  uow = new DrizzleInterviewUnitOfWork(harness.db);
});

afterAll(async () => { await harness.close(); });
beforeEach(async () => { await harness.reset(); });

describe('InterviewRepository', () => {
  const schedule = async (over: { startsAt?: Date; round?: number } = {}): Promise<number> => {
    const { reqId, appId } = await seedApplication();
    return uow.transaction(async (tx) => {
      const iv = anInterview({
        id: await tx.interviews.nextId(ctx),
        interviewNo: 'INT-00001',
        applicationId: appId, candidateId: 501, requisitionId: reqId, ctx,
        ...over,
      });
      await tx.interviews.save(iv);
      return iv.id;
    });
  };

  it('round-trips an interview with its panel', async () => {
    const id = await schedule();
    const loaded = await uow.transaction(async (tx) => tx.interviews.findById(id, ctx));

    expect(loaded?.status).toBe('SCHEDULED');
    expect(loaded?.panel).toHaveLength(2);
    // Lead first — the mapper's stable ordering.
    expect(loaded?.panel[0]?.isLead).toBe(true);
    expect(loaded?.panel[0]?.userId).toBe(11);
  });

  it('emits interview numbers in the legacy format', async () => {
    const no = await uow.transaction(async (tx) => tx.interviews.nextInterviewNo(ctx));
    expect(no).toBe('INT-00001');
  });

  it('moves the lead without tripping the one-lead index', async () => {
    // `ux_panel_one_lead` is partial and checked per statement, so the previous
    // lead must be demoted before the new one is promoted.
    const id = await schedule();
    await uow.transaction(async (tx) => {
      const iv = await tx.interviews.findByIdForUpdate(id, ctx);
      iv?.setPanel([
        { userId: 11, role: 'RECRUITER', isLead: false },
        { userId: 12, role: 'HIRING_MANAGER', isLead: true },
      ], ctx.actor);
      if (iv) await tx.interviews.save(iv);
    });

    const rows = await harness.db
      .select().from(interviewPanel).where(eq(interviewPanel.interviewId, id));
    expect(rows.filter((m) => m.isLead).map((m) => m.userId)).toEqual([12]);
  });

  it('removes panel members dropped by the aggregate', async () => {
    const id = await schedule();
    await uow.transaction(async (tx) => {
      const iv = await tx.interviews.findByIdForUpdate(id, ctx);
      iv?.setPanel([{ userId: 11, role: 'RECRUITER', isLead: true }], ctx.actor);
      if (iv) await tx.interviews.save(iv);
    });

    const rows = await harness.db
      .select().from(interviewPanel).where(eq(interviewPanel.interviewId, id));
    expect(rows.map((m) => m.userId)).toEqual([11]);
  });

  it('upserts an assessment rather than appending a second row', async () => {
    const id = await schedule();
    const scores = {
      openness: 4, conscientiousness: 5, extraversion: 3,
      agreeableness: 4, emotional_stability: 4,
    } as const;

    await uow.transaction(async (tx) => {
      const iv = await tx.interviews.findByIdForUpdate(id, ctx);
      iv?.recordAssessment({
        evaluatorUserId: 11, evaluatorName: 'Mona Adel',
        scores, justification: 'first pass', now: new Date('2026-04-01T10:30:00.000Z'),
      });
      if (iv) await tx.interviews.save(iv);
    });

    await uow.transaction(async (tx) => {
      const iv = await tx.interviews.findByIdForUpdate(id, ctx);
      iv?.recordAssessment({
        evaluatorUserId: 11, evaluatorName: 'Mona Adel',
        scores, justification: 'revised after reference check', allowUpdate: true,
        now: new Date('2026-04-01T11:00:00.000Z'),
      });
      if (iv) await tx.interviews.save(iv);
    });

    const rows = await harness.db
      .select().from(interviewAssessment).where(eq(interviewAssessment.interviewId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.justification).toBe('revised after reference check');
    // jsonb survives the round-trip with its shape intact.
    expect(rows[0]?.scores).toMatchObject({ openness: 4, conscientiousness: 5 });
  });

  it('preserves reschedule as a counter, never a status (BL-16)', async () => {
    const id = await schedule();
    await uow.transaction(async (tx) => {
      const iv = await tx.interviews.findByIdForUpdate(id, ctx);
      iv?.reschedule(new Date('2026-04-03T09:00:00.000Z'), ctx.actor, new Date('2026-03-05T09:00:00.000Z'));
      if (iv) await tx.interviews.save(iv);
    });

    const loaded = await uow.transaction(async (tx) => tx.interviews.findById(id, ctx));
    expect(loaded?.status).toBe('SCHEDULED');
    expect(loaded?.toState().rescheduleCount).toBe(1);
    expect(loaded?.startsAt.toISOString()).toBe('2026-04-03T09:00:00.000Z');
  });

  it('counts rounds for an application', async () => {
    const id = await schedule();
    const loaded = await uow.transaction(async (tx) => tx.interviews.findById(id, ctx));
    const count = await uow.transaction(async (tx) =>
      tx.interviews.countForApplication(loaded!.applicationId, ctx));
    expect(count).toBe(1);
  });

  it('finds booked panellists inside the window and ignores those outside it', async () => {
    const id = await schedule({ startsAt: new Date('2026-04-01T09:00:00.000Z') });
    expect(id).toBeGreaterThan(0);

    const inside = await uow.transaction(async (tx) => tx.interviews.findBookedFor(
      [11], { startsAt: new Date('2026-04-01T08:00:00.000Z'), endsAt: new Date('2026-04-01T10:00:00.000Z') }, ctx,
    ));
    expect(inside).toHaveLength(1);
    // The FULL panel is loaded, not only the member that matched the join —
    // conflict reporting reads every member.
    expect(inside[0]?.panel).toHaveLength(2);

    const outside = await uow.transaction(async (tx) => tx.interviews.findBookedFor(
      [11], { startsAt: new Date('2026-04-02T08:00:00.000Z'), endsAt: new Date('2026-04-02T10:00:00.000Z') }, ctx,
    ));
    expect(outside).toEqual([]);

    const otherUser = await uow.transaction(async (tx) => tx.interviews.findBookedFor(
      [99], { startsAt: new Date('2026-04-01T08:00:00.000Z'), endsAt: new Date('2026-04-01T10:00:00.000Z') }, ctx,
    ));
    expect(otherUser).toEqual([]);

    expect(await uow.transaction(async (tx) => tx.interviews.findBookedFor(
      [], { startsAt: new Date('2026-04-01T08:00:00.000Z'), endsAt: new Date('2026-04-01T10:00:00.000Z') }, ctx,
    ))).toEqual([]);
  });

  it('excludes a cancelled interview from conflict detection', async () => {
    const id = await schedule();
    await uow.transaction(async (tx) => {
      const iv = await tx.interviews.findByIdForUpdate(id, ctx);
      iv?.cancel('candidate unavailable', ctx.actor);
      if (iv) await tx.interviews.save(iv);
    });

    const booked = await uow.transaction(async (tx) => tx.interviews.findBookedFor(
      [11], { startsAt: new Date('2026-04-01T08:00:00.000Z'), endsAt: new Date('2026-04-01T10:00:00.000Z') }, ctx,
    ));
    expect(booked).toEqual([]);
  });

  it('scopes through the requisition, not a denormalised project column', async () => {
    const { reqId, appId } = await seedApplication(99);
    const id = await uow.transaction(async (tx) => {
      const iv = anInterview({
        id: await tx.interviews.nextId(ctx),
        interviewNo: 'INT-00009', applicationId: appId, candidateId: 501, requisitionId: reqId, ctx,
      });
      await tx.interviews.save(iv);
      return iv.id;
    });

    expect(await uow.transaction(async (tx) => tx.interviews.findById(id, scopedCtx([3])))).toBeNull();
    expect(await uow.transaction(async (tx) => tx.interviews.findById(id, ctx))).not.toBeNull();
    expect(await uow.transaction(async (tx) =>
      tx.interviews.countForApplication(appId, scopedCtx([3])))).toBe(0);
  });

  it('rejects a duplicate interview number at the database', async () => {
    const { reqId, appId } = await seedApplication();
    await uow.transaction(async (tx) => {
      const iv = anInterview({
        id: await tx.interviews.nextId(ctx), interviewNo: 'INT-00001',
        applicationId: appId, candidateId: 501, requisitionId: reqId, ctx,
      });
      await tx.interviews.save(iv);
    });

    await expect(uow.transaction(async (tx) => {
      const dup = anInterview({
        id: await tx.interviews.nextId(ctx), interviewNo: 'INT-00001', round: 2,
        applicationId: appId, candidateId: 501, requisitionId: reqId, ctx,
      });
      await tx.interviews.save(dup);
    })).rejects.toBeInstanceOf(ConstraintViolationError);
  });
});
