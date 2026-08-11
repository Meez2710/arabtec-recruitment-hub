// Concurrency validation against a REAL multi-connection PostgreSQL — Step 11.
//
// Everything here needs two sessions genuinely in flight at once, which PGlite
// cannot provide. Set TEST_DATABASE_URL (or DATABASE_URL) to a disposable
// database and these run; leave it unset and they skip with the reason printed.
//
//     createdb arabtec_test
//     TEST_DATABASE_URL=postgres://localhost/arabtec_test npm test
//
// The harness DROPS AND RECREATES the public schema, so it refuses to run
// against a database whose name does not look disposable. See testing/backend.ts.
//
// These are the tests that turn the Step-7 `[MODELLED]` claims into `[REAL]`
// ones: not "the second writer would be refused if they were concurrent", but
// "the second writer was refused while both were concurrent".

import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from './testing/database.js';
import type { TestDatabase } from './testing/database.js';
import { resolveBackend } from './testing/backend.js';
import { anApplication, anOpenRequisition, globalCtx } from './testing/fixtures.js';
import { hiringRequisition, hiringSeat, outboxEvent } from './schema/index.js';
import { createPostCommitRelay } from './outbox-relay.js';
import { OutboxDispatcher } from './outbox-dispatcher.js';
import { EventDispatcher } from '../events/event-dispatcher.js';
import { SubscriberRegistry } from '../events/subscriber.js';
import { DrizzleHiringUnitOfWork } from '../../modules/hiring/infrastructure/unit-of-work.js';
import { NoOpenSeatError } from '../../modules/hiring/domain/errors.js';
import { StaleAggregateError } from '../../modules/shared/kernel/errors.js';

/**
 * Resolve the backend at module load so `describe.skipIf` can see it.
 *
 * A misconfigured URL must not crash the whole file — it becomes a skip with
 * the safety error as its reason, which is the useful outcome either way.
 */
const availability = ((): { available: boolean; reason: string } => {
  try {
    const choice = resolveBackend();
    return { available: choice.kind === 'postgres', reason: choice.reason };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
})();

if (!availability.available) {
  // eslint-disable-next-line no-console
  console.log(
    `\n  ⏭  Step 11 real-PostgreSQL concurrency tests SKIPPED.\n     ${availability.reason}\n` +
    '     To run them: TEST_DATABASE_URL=postgres://localhost/arabtec_test npm test\n',
  );
}

const describeReal = describe.skipIf(!availability.available);

let harness: TestDatabase;
let uow: DrizzleHiringUnitOfWork;
const ctx = globalCtx();

beforeAll(async () => {
  if (!availability.available) return;
  harness = await createTestDatabase();
  uow = new DrizzleHiringUnitOfWork(harness.db, { year: () => 2026 });
});

afterAll(async () => { if (harness) await harness.close(); });
beforeEach(async () => { if (harness) await harness.reset(); });

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
      applicationNo: `APP-${String(i).padStart(5, '0')}`,
      candidateId: 500 + i, requisitionId: r.id, ctx,
    });
    await tx.applications.save(a);
    appIds.push(a.id);
  }
  return { reqId: r.id, appIds };
});

const settledIn = async (ms: number): Promise<'pending'> =>
  new Promise((resolve) => { setTimeout(() => resolve('pending'), ms); });

/* ------------------------- 1. the row lock actually blocks ----------------- */

describeReal('SELECT … FOR UPDATE under real contention', () => {
  it('blocks a second session until the first commits', async () => {
    const { reqId } = await seed(2, 0);
    const a = await harness.connect();
    const b = await harness.connect();

    try {
      await a.query('BEGIN');
      await a.query('SELECT * FROM hiring_requisition WHERE id = $1 FOR UPDATE', [reqId]);

      await b.query('BEGIN');
      const bLock = b.query(
        'SELECT * FROM hiring_requisition WHERE id = $1 FOR UPDATE', [reqId],
      );

      // B must still be waiting. This is the assertion PGlite cannot make.
      const race = await Promise.race([bLock.then(() => 'acquired' as const), settledIn(400)]);
      expect(race).toBe('pending');

      await a.query('COMMIT');
      await bLock;                    // resolves once A releases
      await b.query('COMMIT');
    } finally {
      await a.release();
      await b.release();
    }
  });

  it('does not block a reader that is not asking for the lock', async () => {
    const { reqId } = await seed(2, 0);
    const a = await harness.connect();
    const b = await harness.connect();
    try {
      await a.query('BEGIN');
      await a.query('SELECT * FROM hiring_requisition WHERE id = $1 FOR UPDATE', [reqId]);

      // MVCC: a plain read sees the last committed version and never waits.
      await b.query('SELECT * FROM hiring_requisition WHERE id = $1', [reqId]);
      await a.query('COMMIT');
    } finally {
      await a.release();
      await b.release();
    }
  });

  it('locks only the requisition row, not the whole table', async () => {
    const first = await seed(2, 0);
    const second = await uow.transaction(async (tx) => {
      const r = anOpenRequisition({
        id: await tx.requisitions.nextId(ctx), ticketNo: 'REQ-2026-00002', ctx,
      });
      await tx.requisitions.save(r);
      return r.id;
    });

    const a = await harness.connect();
    const b = await harness.connect();
    try {
      await a.query('BEGIN');
      await a.query('SELECT * FROM hiring_requisition WHERE id = $1 FOR UPDATE', [first.reqId]);
      await b.query('BEGIN');
      // Contention is per requisition, which is the correct granularity: two
      // recruiters hiring onto different requisitions never wait on each other.
      await b.query('SELECT * FROM hiring_requisition WHERE id = $1 FOR UPDATE', [second]);
      await b.query('COMMIT');
      await a.query('COMMIT');
    } finally {
      await a.release();
      await b.release();
    }
  });
});

/* --------------------- 2. concurrent seat acquisition --------------------- */

describeReal('concurrent seat acquisition (H2)', () => {
  it('gives the last seat to exactly one of two simultaneous hires', async () => {
    const { reqId, appIds } = await seed(1, 2);

    const attempt = async (appId: number): Promise<'filled' | 'refused'> => {
      try {
        await uow.transaction(async (tx) => {
          const r = await tx.requisitions.findByIdForUpdate(reqId, ctx);
          // Widen the window the lock has to cover.
          await new Promise((resolve) => { setTimeout(resolve, 50); });
          r?.fillSeat(appId, ctx.actor);
          if (r) await tx.requisitions.save(r);
        });
        return 'filled';
      } catch (error) {
        expect(error).toBeInstanceOf(NoOpenSeatError);
        return 'refused';
      }
    };

    const results = await Promise.all(appIds.map(attempt));
    expect(results.filter((r) => r === 'filled')).toHaveLength(1);
    expect(results.filter((r) => r === 'refused')).toHaveLength(1);

    const seats = await harness.db.select().from(hiringSeat)
      .where(eq(hiringSeat.requisitionId, reqId));
    expect(seats.filter((s) => s.state === 'FILLED')).toHaveLength(1);
  });

  it('never overfills under a burst of simultaneous hires', async () => {
    const SEATS = 3;
    const APPLICANTS = 10;
    const { reqId, appIds } = await seed(SEATS, APPLICANTS);

    const outcomes = await Promise.all(appIds.map(async (appId) => {
      try {
        await uow.transaction(async (tx) => {
          const r = await tx.requisitions.findByIdForUpdate(reqId, ctx);
          r?.fillSeat(appId, ctx.actor);
          if (r) await tx.requisitions.save(r);
        });
        return true;
      } catch {
        return false;
      }
    }));

    expect(outcomes.filter(Boolean)).toHaveLength(SEATS);
    const seats = await harness.db.select().from(hiringSeat)
      .where(eq(hiringSeat.requisitionId, reqId));
    expect(seats.filter((s) => s.state === 'FILLED')).toHaveLength(SEATS);
    // H1 also holds: the seat count still matches headcount.
    expect(seats).toHaveLength(SEATS);
  });
});

/* ------------------------ 3. optimistic locking, live --------------------- */

describeReal('optimistic locking under real concurrency', () => {
  it('lets exactly one of two simultaneous unlocked writers win', async () => {
    const { reqId } = await seed(2, 0);
    const before = (await harness.db.select().from(hiringRequisition)
      .where(eq(hiringRequisition.id, reqId)))[0]!.version;

    // No FOR UPDATE: both read the same version, both then write. The version
    // guard is the only thing standing between this and a lost update.
    const attempt = async (headcount: number): Promise<'ok' | 'stale'> => {
      try {
        await uow.transaction(async (tx) => {
          const r = await tx.requisitions.findById(reqId, ctx);
          await new Promise((resolve) => { setTimeout(resolve, 60); });
          r?.adjustHeadcount(headcount, ctx.actor);
          if (r) await tx.requisitions.save(r);
        });
        return 'ok';
      } catch (error) {
        expect(error).toBeInstanceOf(StaleAggregateError);
        return 'stale';
      }
    };

    const results = await Promise.all([attempt(5), attempt(9)]);
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'stale')).toHaveLength(1);

    const rows = await harness.db.select().from(hiringRequisition)
      .where(eq(hiringRequisition.id, reqId));
    // Whichever won, its value is intact — no silent merge of the two writes.
    expect([5, 9]).toContain(rows[0]?.headcount);
    // Exactly ONE write landed. Two would mean the guard let a lost update
    // through; zero would mean both were wrongly rejected.
    expect(rows[0]?.version).toBe(before + 1);
  });
});

/* -------------------------- 4. deadlock handling -------------------------- */

describeReal('deadlock detection and retry', () => {
  it('resolves a genuine deadlock by retrying the whole transaction', async () => {
    const first = await seed(2, 0);
    const second = await uow.transaction(async (tx) => {
      const r = anOpenRequisition({
        id: await tx.requisitions.nextId(ctx), ticketNo: 'REQ-2026-00002', ctx,
      });
      await tx.requisitions.save(r);
      return r.id;
    });

    const retries: number[] = [];
    const retrying = new DrizzleHiringUnitOfWork(harness.db, {
      year: () => 2026,
      maxAttempts: 5,
      baseDelayMs: 10,
      onRetry: (attempt) => retries.push(attempt),
    });

    // Two transactions locking the same two rows in OPPOSITE order — the
    // textbook deadlock. PostgreSQL detects it and kills one with 40P01; the
    // Unit of Work must re-run that one from the top and succeed.
    const lockBoth = async (a: number, b: number): Promise<void> => {
      await retrying.transaction(async (tx) => {
        const one = await tx.requisitions.findByIdForUpdate(a, ctx);
        await new Promise((resolve) => { setTimeout(resolve, 80); });
        const two = await tx.requisitions.findByIdForUpdate(b, ctx);
        one?.assignRecruiter(21, ctx.actor);
        two?.assignRecruiter(22, ctx.actor);
        if (one) await tx.requisitions.save(one);
        if (two) await tx.requisitions.save(two);
      });
    };

    await Promise.all([
      lockBoth(first.reqId, second),
      lockBoth(second, first.reqId),
    ]);

    // Both completed. At least one of them had to be retried to get there.
    expect(retries.length).toBeGreaterThan(0);
  });
});

/* ---------------------- 5. parallel outbox dispatchers -------------------- */

describeReal('parallel outbox dispatchers', () => {
  it('shares one backlog without delivering anything twice', async () => {
    const seen: number[] = [];
    const registry = new SubscriberRegistry().register({
      name: 'audit',
      async handle(envelope): Promise<void> {
        if (envelope.id !== null) seen.push(envelope.id);
      },
    });
    const dispatcher = new EventDispatcher(harness.db, registry);

    await seed(5, 20);
    const pending = await harness.db.select().from(outboxEvent);
    expect(pending.length).toBeGreaterThan(20);

    // Four workers racing on the same rows. SKIP LOCKED is what makes them
    // share the backlog instead of serialising, and the ledger is what makes a
    // race harmless if two ever do reach the same row.
    const workers = Array.from({ length: 4 }, () =>
      new OutboxDispatcher(harness.db, dispatcher, { batchSize: 5 }));
    await Promise.all(workers.map(async (w) => w.drainUntilEmpty()));

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(pending.length);

    const after = await harness.db.select().from(outboxEvent);
    expect(after.every((r) => r.publishedAt !== null)).toBe(true);
  });

  it('does not double-deliver when the fast path and a poller overlap', async () => {
    const seen: number[] = [];
    const registry = new SubscriberRegistry().register({
      name: 'audit',
      async handle(envelope): Promise<void> {
        if (envelope.id !== null) seen.push(envelope.id);
      },
    });
    const dispatcher = new EventDispatcher(harness.db, registry);
    const relaying = new DrizzleHiringUnitOfWork(harness.db, {
      year: () => 2026, relay: createPostCommitRelay(harness.db, dispatcher),
    });
    const poller = new OutboxDispatcher(harness.db, dispatcher, { batchSize: 10 });

    await Promise.all([
      (async (): Promise<void> => {
        for (let i = 0; i < 8; i += 1) {
          await relaying.transaction(async (tx) => {
            const r = anOpenRequisition({
              id: await tx.requisitions.nextId(ctx),
              ticketNo: `REQ-2026-2${String(i).padStart(4, '0')}`, ctx,
            });
            await tx.requisitions.save(r);
          });
        }
      })(),
      (async (): Promise<void> => {
        for (let i = 0; i < 8; i += 1) await poller.drainOnce();
      })(),
    ]);

    await poller.drainUntilEmpty();
    expect(new Set(seen).size).toBe(seen.length);
    const rows = await harness.db.select().from(outboxEvent);
    expect(rows.every((r) => r.publishedAt !== null)).toBe(true);
  });
});
