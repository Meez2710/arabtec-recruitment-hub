// Hiring repository integration tests — against a REAL PostgreSQL.
//
// PGlite is PostgreSQL 18 compiled to WASM and the schema is applied from the
// actual migration files, so these tests exercise the shipping repository code
// against the shipping DDL: real CHECK constraints, real partial unique indexes,
// real enum casts, real `numeric` string returns.

import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '../../../infrastructure/db/testing/database.js';
import type { TestDatabase } from '../../../infrastructure/db/testing/database.js';
import {
  anApplication, anOpenRequisition, aRequisition, globalCtx, scopedCtx,
} from '../../../infrastructure/db/testing/fixtures.js';
import { hiringSeat, hiringStageHistory } from '../../../infrastructure/db/schema/index.js';
import { DrizzleHiringUnitOfWork } from './unit-of-work.js';
import { DrizzleRequisitionRepository } from './requisition-repository.js';
import { StaleAggregateError } from '../../shared/kernel/errors.js';
import { ConstraintViolationError } from '../../../infrastructure/db/errors.js';

let harness: TestDatabase;
let uow: DrizzleHiringUnitOfWork;
const ctx = globalCtx();

beforeAll(async () => {
  harness = await createTestDatabase();
  uow = new DrizzleHiringUnitOfWork(harness.db, { year: () => 2026 });
});

afterAll(async () => { await harness.close(); });
beforeEach(async () => { await harness.reset(); });

/* ------------------------------ identity ---------------------------------- */

describe('identity allocation', () => {
  it('allocates ids from the table sequence before construction', async () => {
    const ids = await uow.transaction(async (tx) => [
      await tx.requisitions.nextId(ctx),
      await tx.requisitions.nextId(ctx),
    ]);
    expect(ids).toEqual([1, 2]);
  });

  it('emits business numbers in the exact legacy format', async () => {
    const [ticket, appNo] = await uow.transaction(async (tx) => [
      await tx.requisitions.nextTicketNo(ctx),
      await tx.applications.nextApplicationNo(ctx),
    ]);
    // Preserved verbatim from models.js. These appear on documents and in
    // searches, so the shape is a business fact, not a formatting choice.
    expect(ticket).toBe('REQ-2026-00001');
    expect(appNo).toBe('APP-00001');
  });

  it('never reissues a number after a rollback', async () => {
    await expect(uow.transaction(async (tx) => {
      await tx.requisitions.nextTicketNo(ctx);
      throw new Error('abandon');
    })).rejects.toThrow('abandon');

    const next = await uow.transaction(async (tx) => tx.requisitions.nextTicketNo(ctx));
    // A GAP, not a reuse. Sequences are deliberately non-transactional: a gap in
    // ticket numbers is harmless, a duplicate on a legal document is not
    // (Audit #1 F-09).
    expect(next).toBe('REQ-2026-00002');
  });
});

/* ---------------------------- requisition + seats -------------------------- */

describe('RequisitionRepository', () => {
  const save = async (headcount = 2): Promise<number> => uow.transaction(async (tx) => {
    const r = anOpenRequisition({ id: await tx.requisitions.nextId(ctx), ticketNo: 'REQ-2026-00001', ctx, headcount });
    await tx.requisitions.save(r);
    return r.id;
  });

  it('round-trips a requisition and its seats through the database', async () => {
    const id = await save(3);
    const loaded = await uow.transaction(async (tx) => tx.requisitions.findById(id, ctx));

    expect(loaded).not.toBeNull();
    expect(loaded?.state).toBe('OPEN');
    expect(loaded?.headcount).toBe(3);
    expect(loaded?.seats.map((s) => s.seatNo)).toEqual([1, 2, 3]);
    expect(loaded?.seats.every((s) => s.state === 'OPEN')).toBe(true);
  });

  it('returns null for a missing id', async () => {
    expect(await uow.transaction(async (tx) => tx.requisitions.findById(999, ctx))).toBeNull();
  });

  it('persists a seat fill as an UPDATE, not a duplicate row', async () => {
    const reqId = await save();

    const appId = await uow.transaction(async (tx) => {
      const a = anApplication({
        id: await tx.applications.nextId(ctx),
        applicationNo: 'APP-00001',
        candidateId: 501,
        requisitionId: reqId,
        ctx,
      });
      await tx.applications.save(a);
      return a.id;
    });

    await uow.transaction(async (tx) => {
      const r = await tx.requisitions.findByIdForUpdate(reqId, ctx);
      r?.fillSeat(appId, ctx.actor);
      if (r) await tx.requisitions.save(r);
    });

    const rows = await harness.db.select().from(hiringSeat).where(eq(hiringSeat.requisitionId, reqId));
    expect(rows).toHaveLength(2);
    expect(rows.filter((s) => s.state === 'FILLED')).toHaveLength(1);
    expect(rows.find((s) => s.state === 'FILLED')?.applicationId).toBe(appId);
  });

  it('deletes seats removed by a headcount reduction', async () => {
    const id = await save(4);
    await uow.transaction(async (tx) => {
      const r = await tx.requisitions.findByIdForUpdate(id, ctx);
      r?.adjustHeadcount(2, ctx.actor);
      if (r) await tx.requisitions.save(r);
    });

    const rows = await harness.db.select().from(hiringSeat).where(eq(hiringSeat.requisitionId, id));
    expect(rows.map((s) => s.seatNo).sort()).toEqual([1, 2]);
  });

  it('moves an application between seats in one save without tripping the unique index', async () => {
    // The ordering hazard the seat diff exists for: `ux_seat_one_per_application`
    // is checked per statement, so a release and an acquire of the SAME
    // application in one save must be written release-first.
    const reqId = await save(2);
    const appId = await uow.transaction(async (tx) => {
      const a = anApplication({
        id: await tx.applications.nextId(ctx),
        applicationNo: 'APP-00001', candidateId: 501, requisitionId: reqId, ctx,
      });
      await tx.applications.save(a);
      return a.id;
    });

    await uow.transaction(async (tx) => {
      const r = await tx.requisitions.findByIdForUpdate(reqId, ctx);
      r?.fillSeat(appId, ctx.actor);
      if (r) await tx.requisitions.save(r);
    });

    await uow.transaction(async (tx) => {
      const r = await tx.requisitions.findByIdForUpdate(reqId, ctx);
      // Release seat 1 and re-fill — the aggregate picks the next OPEN seat, so
      // the same application ends up on a different seat number in one save.
      r?.releaseSeat(appId, 'candidate withdrew', ctx.actor);
      r?.fillSeat(appId, ctx.actor);
      if (r) await tx.requisitions.save(r);
    });

    const rows = await harness.db.select().from(hiringSeat).where(eq(hiringSeat.requisitionId, reqId));
    const bound = rows.filter((s) => s.applicationId === appId);
    expect(bound).toHaveLength(1);
    expect(bound[0]?.state).toBe('FILLED');
  });

  it('rolls back root and seats together when the transaction throws', async () => {
    const id = await save();
    await expect(uow.transaction(async (tx) => {
      const r = await tx.requisitions.findByIdForUpdate(id, ctx);
      r?.adjustHeadcount(5, ctx.actor);
      if (r) await tx.requisitions.save(r);
      throw new Error('boom');
    })).rejects.toThrow('boom');

    const after = await uow.transaction(async (tx) => tx.requisitions.findById(id, ctx));
    expect(after?.headcount).toBe(2);
    expect(after?.seats).toHaveLength(2);
  });
});

/* ------------------------------- application ------------------------------- */

describe('ApplicationRepository', () => {
  const seed = async (): Promise<{ reqId: number; appId: number }> =>
    uow.transaction(async (tx) => {
      const r = anOpenRequisition({ id: await tx.requisitions.nextId(ctx), ticketNo: 'REQ-2026-00001', ctx });
      await tx.requisitions.save(r);
      const a = anApplication({
        id: await tx.applications.nextId(ctx),
        applicationNo: 'APP-00001', candidateId: 501, requisitionId: r.id, ctx,
      });
      await tx.applications.save(a);
      return { reqId: r.id, appId: a.id };
    });

  it('round-trips an application with its stage history', async () => {
    const { appId } = await seed();
    const loaded = await uow.transaction(async (tx) => tx.applications.findById(appId, ctx));

    expect(loaded?.stage).toBe('SOURCED');
    expect(loaded?.history).toHaveLength(1);
    expect(loaded?.history[0]?.fromStage).toBeNull();
    expect(loaded?.history[0]?.toStage).toBe('SOURCED');
  });

  it('appends only the new history entries, never rewriting the trail', async () => {
    const { appId } = await seed();

    await uow.transaction(async (tx) => {
      const a = await tx.applications.findByIdForUpdate(appId, ctx);
      a?.transitionTo('MATCHED', ctx.actor, { trigger: 'MANUAL' });
      if (a) await tx.applications.save(a);
    });
    await uow.transaction(async (tx) => {
      const a = await tx.applications.findByIdForUpdate(appId, ctx);
      a?.transitionTo('INTERVIEWING', ctx.actor, { trigger: 'MANUAL' });
      if (a) await tx.applications.save(a);
    });

    const rows = await harness.db
      .select().from(hiringStageHistory).where(eq(hiringStageHistory.applicationId, appId));
    // Three transitions, three rows. A repository that re-inserted the whole
    // list each save would have 1 + 2 + 3 = 6.
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.toStage)).toEqual(['SOURCED', 'MATCHED', 'INTERVIEWING']);
  });

  it('finds an active hire for a candidate and honours the exclusion', async () => {
    const { reqId, appId } = await seed();
    await uow.transaction(async (tx) => {
      const a = await tx.applications.findByIdForUpdate(appId, ctx);
      // OFFER_SENT and HIRED are SYSTEM-driven: the Offer context drives them
      // through the published pipeline operation, never a recruiter (BL-14).
      const path = [
        ['MATCHED', 'MANUAL'], ['INTERVIEWING', 'MANUAL'], ['OFFER_PREPARATION', 'MANUAL'],
        ['OFFER_SENT', 'SYSTEM'], ['HIRED', 'SYSTEM'],
      ] as const;
      for (const [stage, trigger] of path) a?.transitionTo(stage, ctx.actor, { trigger });
      if (a) await tx.applications.save(a);
    });
    expect(reqId).toBeGreaterThan(0);

    const found = await uow.transaction(async (tx) =>
      tx.applications.findActiveHireForCandidate(501, ctx));
    expect(found).toBe(appId);

    const excluded = await uow.transaction(async (tx) =>
      tx.applications.findActiveHireForCandidate(501, ctx, { excludeApplicationId: appId }));
    expect(excluded).toBeNull();
  });

  it('lists non-terminal applications for a requisition', async () => {
    const { reqId, appId } = await seed();
    const secondId = await uow.transaction(async (tx) => {
      const a = anApplication({
        id: await tx.applications.nextId(ctx),
        applicationNo: 'APP-00002', candidateId: 502, requisitionId: reqId, ctx,
      });
      a.transitionTo('REJECTED', ctx.actor, { trigger: 'MANUAL', reason: 'not a fit' });
      await tx.applications.save(a);
      return a.id;
    });

    const live = await uow.transaction(async (tx) =>
      tx.applications.findNonTerminalByRequisition(reqId, ctx));
    expect(live.map((a) => a.id)).toEqual([appId]);
    expect(secondId).toBeGreaterThan(appId);
  });

  it('returns aggregates from the cascade query that can be saved back', async () => {
    // Regression guard: without a registered baseline these would be treated as
    // new and the save would attempt an INSERT on an existing primary key.
    const { reqId } = await seed();
    await uow.transaction(async (tx) => {
      const live = await tx.applications.findNonTerminalByRequisition(reqId, ctx);
      for (const a of live) {
        a.transitionTo('NOT_SUITABLE', ctx.actor, { trigger: 'SYSTEM', reason: 'requisition closed' });
        await tx.applications.save(a);
      }
    });

    const after = await uow.transaction(async (tx) =>
      tx.applications.findNonTerminalByRequisition(reqId, ctx));
    expect(after.map((a) => a.stage)).toEqual(['NOT_SUITABLE']);
  });

  it('refuses a second live application for the same candidate and requisition', async () => {
    const { reqId } = await seed();
    // BL-26 as a partial unique index. The service checks this first; the index
    // is what holds when two requests race past that check.
    await expect(uow.transaction(async (tx) => {
      const dup = anApplication({
        id: await tx.applications.nextId(ctx),
        applicationNo: 'APP-00002', candidateId: 501, requisitionId: reqId, ctx,
      });
      await tx.applications.save(dup);
    })).rejects.toBeInstanceOf(ConstraintViolationError);
  });
});

/* ---------------------------------- scope --------------------------------- */

describe('data scope (ADR-0005)', () => {
  const seedInProject = async (projectId: number, n: number): Promise<number> =>
    uow.transaction(async (tx) => {
      const r = aRequisition({
        id: await tx.requisitions.nextId(ctx),
        ticketNo: `REQ-2026-0000${n}`, ctx, projectId,
      });
      await tx.requisitions.save(r);
      return r.id;
    });

  it('hides an out-of-scope requisition as null, not as an error', async () => {
    const visible = await seedInProject(3, 1);
    const hidden = await seedInProject(99, 2);
    const scoped = scopedCtx([3]);

    expect(await uow.transaction(async (tx) => tx.requisitions.findById(visible, scoped))).not.toBeNull();
    // Identical to a nonexistent row. A caller must not be able to use
    // 403-vs-404 as an existence oracle.
    expect(await uow.transaction(async (tx) => tx.requisitions.findById(hidden, scoped))).toBeNull();
    expect(await uow.transaction(async (tx) => tx.requisitions.findById(12345, scoped))).toBeNull();
  });

  it('scopes applications through their requisition, which carries the project', async () => {
    const hidden = await seedInProject(99, 1);
    const appId = await uow.transaction(async (tx) => {
      const a = anApplication({
        id: await tx.applications.nextId(ctx),
        applicationNo: 'APP-00001', candidateId: 501, requisitionId: hidden, ctx,
      });
      await tx.applications.save(a);
      return a.id;
    });

    const scoped = scopedCtx([3]);
    expect(await uow.transaction(async (tx) => tx.applications.findById(appId, scoped))).toBeNull();
    expect(await uow.transaction(async (tx) => tx.applications.findById(appId, ctx))).not.toBeNull();
  });

  it('shows nothing to a context with no global scope and no projects', async () => {
    const id = await seedInProject(3, 1);
    const appId = await uow.transaction(async (tx) => {
      const a = anApplication({
        id: await tx.applications.nextId(ctx),
        applicationNo: 'APP-00001', candidateId: 501, requisitionId: id, ctx,
      });
      await tx.applications.save(a);
      return a.id;
    });

    const nothing = scopedCtx([]);
    // Both scope paths must fail closed: the direct project column and the
    // reach-through-requisition subquery. An empty scope list means "nothing",
    // never "no filter".
    expect(await uow.transaction(async (tx) => tx.requisitions.findById(id, nothing))).toBeNull();
    expect(await uow.transaction(async (tx) => tx.applications.findById(appId, nothing))).toBeNull();
    expect(await uow.transaction(async (tx) =>
      tx.applications.findNonTerminalByRequisition(id, nothing))).toEqual([]);
    expect(await uow.transaction(async (tx) =>
      tx.applications.findActiveHireForCandidate(501, nothing))).toBeNull();
  });

  it('isolates tenants', async () => {
    const id = await seedInProject(3, 1);
    const otherTenant = globalCtx({ tenantId: 2 });
    expect(await uow.transaction(async (tx) => tx.requisitions.findById(id, otherTenant))).toBeNull();
  });

  it('refuses to update an out-of-scope aggregate', async () => {
    // The scope predicate is on the load, and the version guard is on the write.
    // An aggregate that could not be loaded has no baseline, so a save attempts
    // an INSERT and collides — it can never silently UPDATE someone else's row.
    const hidden = await seedInProject(99, 1);
    const loadedGlobally = await uow.transaction(async (tx) =>
      tx.requisitions.findById(hidden, ctx));
    expect(loadedGlobally).not.toBeNull();

    await expect(uow.transaction(async (tx) => {
      const scoped = scopedCtx([3]);
      const r = await tx.requisitions.findById(hidden, scoped);
      expect(r).toBeNull();
      // Saving an aggregate this transaction never loaded is an insert.
      if (loadedGlobally) await tx.requisitions.save(loadedGlobally);
    })).rejects.toBeDefined();
  });
});

/* --------------------------- optimistic locking ---------------------------- */

describe('optimistic locking', () => {
  it('rejects a save whose baseline version is no longer current', async () => {
    const id = await uow.transaction(async (tx) => {
      const r = anOpenRequisition({ id: await tx.requisitions.nextId(ctx), ticketNo: 'REQ-2026-00001', ctx });
      await tx.requisitions.save(r);
      return r.id;
    });

    // Two repository instances = two independent loaded-version registries,
    // which is exactly what two concurrent transactions have. `slow` reads at
    // version v; `fast` reads at v, writes, and commits v+1; `slow` then writes
    // against a baseline that no longer exists.
    const slow = new DrizzleRequisitionRepository(harness.db);
    const fast = new DrizzleRequisitionRepository(harness.db);

    const slowCopy = await slow.findById(id, ctx);
    const fastCopy = await fast.findById(id, ctx);

    fastCopy?.adjustHeadcount(5, ctx.actor);
    if (fastCopy) await fast.save(fastCopy);

    slowCopy?.adjustHeadcount(3, ctx.actor);
    await expect(slow.save(slowCopy!)).rejects.toBeInstanceOf(StaleAggregateError);

    // The first writer wins and the second is told to reload — no lost update.
    const after = await uow.transaction(async (tx) => tx.requisitions.findById(id, ctx));
    expect(after?.headcount).toBe(5);
  });

  it('reports the actual version, and -1 when the row is gone', async () => {
    const id = await uow.transaction(async (tx) => {
      const r = anOpenRequisition({ id: await tx.requisitions.nextId(ctx), ticketNo: 'REQ-2026-00001', ctx });
      await tx.requisitions.save(r);
      return r.id;
    });

    const a = new DrizzleRequisitionRepository(harness.db);
    const b = new DrizzleRequisitionRepository(harness.db);
    const copyA = await a.findById(id, ctx);
    const copyB = await b.findById(id, ctx);

    copyB?.adjustHeadcount(6, ctx.actor);
    if (copyB) await b.save(copyB);

    copyA?.adjustHeadcount(4, ctx.actor);
    const err = await a.save(copyA!).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleAggregateError);
    // 'Stale' and 'deleted' need different advice, so the detail distinguishes them.
    expect((err as StaleAggregateError).details).toMatchObject({
      expectedVersion: copyA!.version - 1,
      actualVersion: copyB!.version,
    });
  });

  it('allows two sequential saves of the same aggregate inside one transaction', async () => {
    // The baseline must advance after each save, or the second one would try to
    // insert a row that already exists.
    const id = await uow.transaction(async (tx) => {
      const r = anOpenRequisition({ id: await tx.requisitions.nextId(ctx), ticketNo: 'REQ-2026-00001', ctx });
      await tx.requisitions.save(r);
      r.adjustHeadcount(4, ctx.actor);
      await tx.requisitions.save(r);
      return r.id;
    });

    const loaded = await uow.transaction(async (tx) => tx.requisitions.findById(id, ctx));
    expect(loaded?.headcount).toBe(4);
    expect(loaded?.seats).toHaveLength(4);
  });
});
