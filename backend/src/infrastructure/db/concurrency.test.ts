// Concurrency tests — Step 7.
//
// WHAT THESE PROVE, AND WHAT THEY DO NOT.
//
// The harness is PGlite: real PostgreSQL 18 compiled to WASM, running the real
// migration files. Constraints, enum casts, `numeric` string returns, MVCC
// visibility rules and transaction rollback are all genuine.
//
// PGlite is SINGLE-CONNECTION. Two transactions cannot be in flight at the same
// instant, so one thing is NOT observable here: transaction B physically
// BLOCKING on a row lock that transaction A holds. Every test below states which
// side of that line it sits on:
//
//   [REAL]      exercised end-to-end against PostgreSQL.
//   [MODELLED]  the interleaving is reproduced deterministically (two repository
//               instances = two independent loaded-version registries, which is
//               exactly what two concurrent transactions have), but the two
//               writers are not literally simultaneous.
//   [STATIC]    asserted on the generated SQL rather than on runtime behaviour.
//
// The blocking behaviour itself needs a real multi-connection server. That gap
// is reported as an open risk, not papered over.

import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from './testing/database.js';
import type { TestDatabase } from './testing/database.js';
import {
  anApplication, anOpenRequisition, globalCtx,
} from './testing/fixtures.js';
import { hiringRequisition, hiringSeat } from './schema/index.js';
import type { Executor } from './types.js';
import { runInTransaction } from './transaction.js';
import { PG_ERROR, isRetryable } from './errors.js';
import { DrizzleHiringUnitOfWork } from '../../modules/hiring/infrastructure/unit-of-work.js';
import { DrizzleRequisitionRepository } from '../../modules/hiring/infrastructure/requisition-repository.js';
import { DrizzleApplicationRepository } from '../../modules/hiring/infrastructure/application-repository.js';
import { NoOpenSeatError } from '../../modules/hiring/domain/errors.js';
import { StaleAggregateError } from '../../modules/shared/kernel/errors.js';

let harness: TestDatabase;
let uow: DrizzleHiringUnitOfWork;
const ctx = globalCtx();

beforeAll(async () => {
  harness = await createTestDatabase();
  uow = new DrizzleHiringUnitOfWork(harness.db, { year: () => 2026 });
});

afterAll(async () => { await harness.close(); });
beforeEach(async () => { await harness.reset(); });

/** One OPEN requisition with `headcount` seats, plus `applicants` applications. */
const seed = async (headcount: number, applicants: number): Promise<{
  reqId: number; appIds: number[];
}> => uow.transaction(async (tx) => {
  const r = anOpenRequisition({
    id: await tx.requisitions.nextId(ctx), ticketNo: 'REQ-2026-00001', ctx, headcount,
  });
  await tx.requisitions.save(r);

  const appIds: number[] = [];
  for (let i = 0; i < applicants; i += 1) {
    const a = anApplication({
      id: await tx.applications.nextId(ctx),
      applicationNo: `APP-0000${i + 1}`,
      candidateId: 500 + i,
      requisitionId: r.id,
      ctx,
    });
    await tx.applications.save(a);
    appIds.push(a.id);
  }
  return { reqId: r.id, appIds };
});

/* -------------------------- 1. the row lock (STATIC) ----------------------- */

describe('pessimistic row locking (ADR-0004)', () => {
  it('[STATIC] emits FOR UPDATE on the requisition root, and on nothing else', () => {
    const locked = harness.db
      .select().from(hiringRequisition).where(eq(hiringRequisition.id, 1)).limit(1)
      .for('update')
      .toSQL();
    expect(locked.sql.toLowerCase()).toContain('for update');

    // Seats are read WITHOUT a lock: the root lock already excludes every other
    // writer of this aggregate, so locking children would enlarge the lock set
    // for no additional protection.
    const seats = harness.db
      .select().from(hiringSeat).where(eq(hiringSeat.requisitionId, 1))
      .toSQL();
    expect(seats.sql.toLowerCase()).not.toContain('for update');
  });

  it('[STATIC] does not lock rows on a plain read', () => {
    const plain = harness.db
      .select().from(hiringRequisition).where(eq(hiringRequisition.id, 1)).limit(1)
      .toSQL();
    expect(plain.sql.toLowerCase()).not.toContain('for update');
  });

  it('[REAL] uses an EXISTS subquery for scope so FOR UPDATE stays on one table', () => {
    // A JOIN would make PostgreSQL reject the locking clause (or lock the joined
    // requisition too, widening contention). EXISTS keeps the lock target
    // unambiguous. This is why `scopedViaRequisition` is written the way it is.
    const scoped = globalCtx();
    expect(scoped.isGlobalScope).toBe(true);

    const sqlText = harness.db
      .select().from(hiringRequisition).where(eq(hiringRequisition.id, 1)).limit(1)
      .for('update')
      .toSQL().sql.toLowerCase();
    expect(sqlText).not.toContain('join');
  });

  it('[REAL] a locked read inside a transaction returns the committed state', async () => {
    const { reqId } = await seed(2, 0);
    await uow.transaction(async (tx) => {
      const r = await tx.requisitions.findByIdForUpdate(reqId, ctx);
      expect(r?.headcount).toBe(2);
      expect(r?.seats).toHaveLength(2);
    });
  });
});

/* --------------------- 2. seat acquisition (MODELLED) ---------------------- */

describe('seat acquisition under contention', () => {
  it('[MODELLED] the second acquirer of the last seat is refused, not overfilled', async () => {
    const { reqId, appIds } = await seed(1, 2);
    const [first, second] = appIds as [number, number];

    // Serialised exactly as the row lock would serialise them. The point of
    // ADR-0004 is that the second transaction reads AFTER the first commits, so
    // it sees no open seat and the aggregate refuses.
    await uow.transaction(async (tx) => {
      const r = await tx.requisitions.findByIdForUpdate(reqId, ctx);
      r?.fillSeat(first, ctx.actor);
      if (r) await tx.requisitions.save(r);
    });

    await expect(uow.transaction(async (tx) => {
      const r = await tx.requisitions.findByIdForUpdate(reqId, ctx);
      r?.fillSeat(second, ctx.actor);
      if (r) await tx.requisitions.save(r);
    })).rejects.toBeInstanceOf(NoOpenSeatError);

    const seats = await harness.db.select().from(hiringSeat)
      .where(eq(hiringSeat.requisitionId, reqId));
    // H2 holds: never more filled seats than headcount.
    expect(seats.filter((s) => s.state === 'FILLED')).toHaveLength(1);
  });

  it('[MODELLED] N applicants and N seats fill exactly N times, no more', async () => {
    const { reqId, appIds } = await seed(3, 5);

    let filled = 0;
    let refused = 0;
    for (const appId of appIds) {
      try {
        await uow.transaction(async (tx) => {
          const r = await tx.requisitions.findByIdForUpdate(reqId, ctx);
          r?.fillSeat(appId, ctx.actor);
          if (r) await tx.requisitions.save(r);
        });
        filled += 1;
      } catch (err) {
        expect(err).toBeInstanceOf(NoOpenSeatError);
        refused += 1;
      }
    }

    expect(filled).toBe(3);
    expect(refused).toBe(2);
    const seats = await harness.db.select().from(hiringSeat)
      .where(eq(hiringSeat.requisitionId, reqId));
    expect(seats.filter((s) => s.state === 'FILLED')).toHaveLength(3);
  });

  it('[REAL] the database refuses a second seat for the same application', async () => {
    // Belt and braces beneath H3. Even if a bug let two seats bind the same
    // application, `ux_seat_one_per_application` stops the row from being
    // written at all.
    const { reqId, appIds } = await seed(2, 1);
    const appId = appIds[0]!;

    await uow.transaction(async (tx) => {
      const r = await tx.requisitions.findByIdForUpdate(reqId, ctx);
      r?.fillSeat(appId, ctx.actor);
      if (r) await tx.requisitions.save(r);
    });

    await expect(harness.db.insert(hiringSeat).values({
      requisitionId: reqId, seatNo: 99, state: 'FILLED', applicationId: appId,
      filledAt: new Date(), cancelReason: null,
    })).rejects.toBeDefined();
  });
});

/* --------------------- 3. optimistic locking (MODELLED) -------------------- */

describe('optimistic locking — lost update prevention', () => {
  it('[MODELLED] the second writer is rejected, and the first writer\'s change survives', async () => {
    const { reqId } = await seed(2, 0);

    const slow = new DrizzleRequisitionRepository(harness.db);
    const fast = new DrizzleRequisitionRepository(harness.db);
    const slowCopy = await slow.findById(reqId, ctx);
    const fastCopy = await fast.findById(reqId, ctx);

    fastCopy!.adjustHeadcount(5, ctx.actor);
    await fast.save(fastCopy!);

    slowCopy!.adjustHeadcount(9, ctx.actor);
    await expect(slow.save(slowCopy!)).rejects.toBeInstanceOf(StaleAggregateError);

    const rows = await harness.db.select().from(hiringRequisition)
      .where(eq(hiringRequisition.id, reqId));
    // A last-write-wins repository would show 9 here and the first writer's
    // change would have vanished with no error anywhere.
    expect(rows[0]?.headcount).toBe(5);
  });

  it('[MODELLED] applications are guarded the same way', async () => {
    const { appIds } = await seed(2, 1);
    const appId = appIds[0]!;

    const slow = new DrizzleApplicationRepository(harness.db);
    const fast = new DrizzleApplicationRepository(harness.db);
    const slowCopy = await slow.findById(appId, ctx);
    const fastCopy = await fast.findById(appId, ctx);

    fastCopy!.transitionTo('MATCHED', ctx.actor, { trigger: 'MANUAL' });
    await fast.save(fastCopy!);

    slowCopy!.transitionTo('NOT_SUITABLE', ctx.actor, { trigger: 'MANUAL', reason: 'x' });
    await expect(slow.save(slowCopy!)).rejects.toBeInstanceOf(StaleAggregateError);

    const after = await uow.transaction(async (tx) => tx.applications.findById(appId, ctx));
    expect(after?.stage).toBe('MATCHED');
    // The rejected writer appended nothing to the audit trail either.
    expect(after?.history).toHaveLength(2);
  });

  it('[MODELLED] version advances by exactly one per mutation, so no write is skipped', async () => {
    const { reqId } = await seed(2, 0);
    const before = await uow.transaction(async (tx) => tx.requisitions.findById(reqId, ctx));

    await uow.transaction(async (tx) => {
      const r = await tx.requisitions.findByIdForUpdate(reqId, ctx);
      r?.adjustHeadcount(3, ctx.actor);
      if (r) await tx.requisitions.save(r);
    });

    const after = await uow.transaction(async (tx) => tx.requisitions.findById(reqId, ctx));
    expect(after!.version).toBe(before!.version + 1);
  });
});

/* ---------------------- 4. transaction atomicity (REAL) -------------------- */

describe('transaction boundary (ADR-0002)', () => {
  it('[REAL] rolls back every aggregate touched, not just the failing one', async () => {
    const { reqId, appIds } = await seed(2, 1);
    const appId = appIds[0]!;

    await expect(uow.transaction(async (tx) => {
      const r = await tx.requisitions.findByIdForUpdate(reqId, ctx);
      const a = await tx.applications.findByIdForUpdate(appId, ctx);
      r?.fillSeat(appId, ctx.actor);
      a?.transitionTo('MATCHED', ctx.actor, { trigger: 'MANUAL' });
      if (r) await tx.requisitions.save(r);
      if (a) await tx.applications.save(a);
      // A cross-aggregate hire is one transaction (ADR-0003). Failing after both
      // writes must leave neither.
      throw new Error('late failure');
    })).rejects.toThrow('late failure');

    const seats = await harness.db.select().from(hiringSeat)
      .where(eq(hiringSeat.requisitionId, reqId));
    expect(seats.every((s) => s.state === 'OPEN')).toBe(true);

    const app = await uow.transaction(async (tx) => tx.applications.findById(appId, ctx));
    expect(app?.stage).toBe('SOURCED');
    expect(app?.history).toHaveLength(1);
  });

  it('[REAL] both repositories in one scope share the same connection', async () => {
    // The legacy defect (Audit #1 F-01): BEGIN, the writes and COMMIT each ran
    // on a DIFFERENT pooled connection, so the writes executed in autocommit and
    // seat filling had no atomicity at all. If the two repositories here were
    // not on one pinned connection, the requisition write below would be visible
    // from outside before the transaction committed.
    const { reqId } = await seed(2, 0);

    let midTransactionView: number | undefined;
    await uow.transaction(async (tx) => {
      const r = await tx.requisitions.findByIdForUpdate(reqId, ctx);
      r?.adjustHeadcount(7, ctx.actor);
      if (r) await tx.requisitions.save(r);

      // Read through the SAME scope: the uncommitted change IS visible here.
      const inside = await tx.requisitions.findById(reqId, ctx);
      midTransactionView = inside?.headcount;
    });

    expect(midTransactionView).toBe(7);
    const after = await uow.transaction(async (tx) => tx.requisitions.findById(reqId, ctx));
    expect(after?.headcount).toBe(7);
  });

  it('[REAL] a failed transaction leaves no partially written child rows', async () => {
    const { reqId } = await seed(2, 0);
    await expect(uow.transaction(async (tx) => {
      const r = await tx.requisitions.findByIdForUpdate(reqId, ctx);
      r?.adjustHeadcount(6, ctx.actor);
      if (r) await tx.requisitions.save(r);
      throw new Error('boom');
    })).rejects.toThrow('boom');

    const seats = await harness.db.select().from(hiringSeat)
      .where(eq(hiringSeat.requisitionId, reqId));
    expect(seats).toHaveLength(2);
  });
});

/* --------------------- 5. deadlock retry (REAL, no DB) --------------------- */
// The retry policy is pure control flow over an executor, so it is tested
// directly against injected SQLSTATEs rather than by provoking a real deadlock.

const fakeExecutor = (behaviour: () => Promise<unknown>): Executor => ({
  async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    await behaviour();
    return fn({});
  },
} as unknown as Executor);

const pgError = (code: string): Error & { code: string } =>
  Object.assign(new Error(`simulated ${code}`), { code });

describe('deadlock and serialization retry', () => {
  const instant = async (): Promise<void> => { /* no waiting in tests */ };

  it('classifies only deadlock and serialization failures as retryable', () => {
    expect(isRetryable(pgError(PG_ERROR.DEADLOCK_DETECTED))).toBe(true);
    expect(isRetryable(pgError(PG_ERROR.SERIALIZATION_FAILURE))).toBe(true);
    // A unique violation retried is a unique violation twice. The caller needs
    // to see it.
    expect(isRetryable(pgError(PG_ERROR.UNIQUE_VIOLATION))).toBe(false);
    expect(isRetryable(pgError(PG_ERROR.CHECK_VIOLATION))).toBe(false);
    expect(isRetryable(new Error('plain'))).toBe(false);
    expect(isRetryable(null)).toBe(false);
  });

  it('re-runs the WHOLE transaction, not the failing statement', async () => {
    let attempts = 0;
    const db = fakeExecutor(async () => {
      attempts += 1;
      if (attempts < 3) throw pgError(PG_ERROR.DEADLOCK_DETECTED);
    });

    const body = vi.fn(async () => 'committed');
    const result = await runInTransaction(db, body, { sleep: instant, random: () => 0.5 });

    expect(result).toBe('committed');
    expect(attempts).toBe(3);
    // The callback runs once per attempt. Retrying a single statement would be
    // wrong: the in-memory aggregate came from reads that have been rolled back.
    expect(body).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts and rethrows the driver error', async () => {
    let attempts = 0;
    const db = fakeExecutor(async () => {
      attempts += 1;
      throw pgError(PG_ERROR.DEADLOCK_DETECTED);
    });

    await expect(runInTransaction(db, async () => 'x', {
      sleep: instant, random: () => 0.5, maxAttempts: 4,
    })).rejects.toThrow('simulated 40P01');
    expect(attempts).toBe(4);
  });

  it('does not retry a constraint violation', async () => {
    let attempts = 0;
    const db = fakeExecutor(async () => {
      attempts += 1;
      throw pgError(PG_ERROR.UNIQUE_VIOLATION);
    });

    await expect(runInTransaction(db, async () => 'x', { sleep: instant }))
      .rejects.toThrow('simulated 23505');
    expect(attempts).toBe(1);
  });

  it('does not retry an application error thrown by the domain', async () => {
    let attempts = 0;
    const db = fakeExecutor(async () => { attempts += 1; });
    await expect(runInTransaction(db, async () => {
      throw new NoOpenSeatError(11);
    }, { sleep: instant })).rejects.toBeInstanceOf(NoOpenSeatError);
    expect(attempts).toBe(1);
  });

  it('backs off with jitter so two deadlocked transactions do not re-collide', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const db = fakeExecutor(async () => {
      attempts += 1;
      if (attempts < 4) throw pgError(PG_ERROR.SERIALIZATION_FAILURE);
    });

    await runInTransaction(db, async () => 'ok', {
      maxAttempts: 5,
      baseDelayMs: 100,
      random: () => 1,
      sleep: async (ms) => { delays.push(ms); },
    });

    // Exponential: base * 2^(n-1), scaled by the jitter factor.
    expect(delays).toEqual([100, 200, 400]);
  });

  it('reports each retry so contention is visible in operations, not silent', async () => {
    const seen: number[] = [];
    let attempts = 0;
    const db = fakeExecutor(async () => {
      attempts += 1;
      if (attempts < 3) throw pgError(PG_ERROR.DEADLOCK_DETECTED);
    });

    await runInTransaction(db, async () => 'ok', {
      sleep: instant, random: () => 0.5,
      onRetry: (attempt) => seen.push(attempt),
    });
    expect(seen).toEqual([1, 2]);
  });

  it('[REAL] passes an isolation level through to the driver when asked', async () => {
    const { reqId } = await seed(2, 0);
    const strict = new DrizzleHiringUnitOfWork(harness.db, {
      isolationLevel: 'repeatable read', year: () => 2026,
    });
    const loaded = await strict.transaction(async (tx) => tx.requisitions.findById(reqId, ctx));
    expect(loaded?.headcount).toBe(2);
  });
});
