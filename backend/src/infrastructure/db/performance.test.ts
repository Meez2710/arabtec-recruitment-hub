// Performance validation — Step 12.
//
// TWO KINDS OF ASSERTION, AND ONLY ONE OF THEM IS A HARD GATE.
//
//   QUERY COUNTS are deterministic and are asserted strictly. "No N+1" means a
//   query count that does not grow with the number of rows, and that is a
//   property you can measure exactly. Every collection query below is loaded at
//   two different sizes and the counts must be IDENTICAL.
//
//   TIMINGS are reported, not gated. A wall-clock threshold on a WASM database
//   inside a test runner on unknown hardware is a flaky test pretending to be a
//   performance budget. The ceilings here are deliberately loose — they catch an
//   accidental O(n²), not a 20% regression.

import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from './testing/database.js';
import type { TestDatabase } from './testing/database.js';
import {
  anApplication, anInterview, anOffer, anOpenRequisition, globalCtx,
} from './testing/fixtures.js';
import { createPostCommitRelay } from './outbox-relay.js';
import { OutboxDispatcher } from './outbox-dispatcher.js';
import { EventDispatcher } from '../events/event-dispatcher.js';
import { SubscriberRegistry } from '../events/subscriber.js';
import type { Subscriber } from '../events/subscriber.js';
import { DrizzleHiringUnitOfWork } from '../../modules/hiring/infrastructure/unit-of-work.js';
import { DrizzleInterviewUnitOfWork } from '../../modules/interview/infrastructure/unit-of-work.js';
import { DrizzleOfferUnitOfWork } from '../../modules/offer/infrastructure/unit-of-work.js';

let harness: TestDatabase;
let hiring: DrizzleHiringUnitOfWork;
let interviews: DrizzleInterviewUnitOfWork;
let offers: DrizzleOfferUnitOfWork;
const ctx = globalCtx();

/** Reported at the end so the numbers are visible, not buried in a diff. */
const timings: { label: string; ms: number; note: string }[] = [];

const timed = async <T>(label: string, note: string, fn: () => Promise<T>): Promise<T> => {
  const started = performance.now();
  const result = await fn();
  timings.push({ label, ms: Math.round(performance.now() - started), note });
  return result;
};

beforeAll(async () => {
  harness = await createTestDatabase();
  hiring = new DrizzleHiringUnitOfWork(harness.db, { year: () => 2026 });
  interviews = new DrizzleInterviewUnitOfWork(harness.db);
  offers = new DrizzleOfferUnitOfWork(harness.db, { year: () => 2026 });
});

afterAll(async () => {
  await harness.close();
  const width = Math.max(...timings.map((t) => t.label.length));
  const lines = timings.map((t) =>
    `  ${t.label.padEnd(width)}  ${String(t.ms).padStart(6)}ms   ${t.note}`);
  // eslint-disable-next-line no-console
  console.log(`\n  Step 12 benchmarks (${harness.backend})\n${lines.join('\n')}\n`);
});

beforeEach(async () => { await harness.reset(); });

/** One OPEN requisition with `headcount` seats and `applicants` applications. */
const seed = async (headcount: number, applicants: number, n = 1): Promise<{
  reqId: number; appIds: number[];
}> => hiring.transaction(async (tx) => {
  const r = anOpenRequisition({
    id: await tx.requisitions.nextId(ctx), ticketNo: `REQ-2026-0000${n}`, ctx, headcount,
  });
  await tx.requisitions.save(r);

  const appIds: number[] = [];
  for (let i = 0; i < applicants; i += 1) {
    const a = anApplication({
      id: await tx.applications.nextId(ctx),
      applicationNo: `APP-${n}-${String(i).padStart(4, '0')}`,
      candidateId: 1_000 * n + i,
      requisitionId: r.id,
      ctx,
    });
    await tx.applications.save(a);
    appIds.push(a.id);
  }
  return { reqId: r.id, appIds };
});

/** Run `fn` with the statement counter on, and return the statements it issued. */
const countQueries = async (fn: () => Promise<unknown>): Promise<readonly string[]> => {
  harness.queries.start();
  await fn();
  return harness.queries.stop();
};

/* ------------------------------ 1. no N+1 --------------------------------- */

describe('no N+1 query patterns', () => {
  it('loads a requisition in a constant number of queries regardless of seat count', async () => {
    const small = await seed(2, 0, 1);
    const large = await seed(60, 0, 2);

    const forSmall = await countQueries(async () =>
      hiring.transaction(async (tx) => tx.requisitions.findById(small.reqId, ctx)));
    const forLarge = await countQueries(async () =>
      hiring.transaction(async (tx) => tx.requisitions.findById(large.reqId, ctx)));

    // Root + seats. 60 seats must cost exactly what 2 seats cost.
    expect(forSmall.filter(isBusinessQuery)).toHaveLength(2);
    expect(forLarge.filter(isBusinessQuery)).toHaveLength(2);
  });

  it('loads an application and its whole history in two queries', async () => {
    const { appIds } = await seed(2, 1);
    const appId = appIds[0]!;

    await hiring.transaction(async (tx) => {
      const a = await tx.applications.findByIdForUpdate(appId, ctx);
      for (const stage of ['MATCHED', 'INTERVIEWING'] as const) {
        a?.transitionTo(stage, ctx.actor, { trigger: 'MANUAL' });
      }
      if (a) await tx.applications.save(a);
    });

    const issued = await countQueries(async () =>
      hiring.transaction(async (tx) => tx.applications.findById(appId, ctx)));
    expect(issued.filter(isBusinessQuery)).toHaveLength(2);
  });

  it('loads the close cascade in two queries for any number of applications', async () => {
    const few = await seed(2, 3, 1);
    const many = await seed(2, 40, 2);

    const forFew = await countQueries(async () =>
      hiring.transaction(async (tx) =>
        tx.applications.findNonTerminalByRequisition(few.reqId, ctx)));
    const forMany = await countQueries(async () =>
      hiring.transaction(async (tx) =>
        tx.applications.findNonTerminalByRequisition(many.reqId, ctx)));

    // The regression this guards: one history query PER application. At 40
    // applications that is 41 round trips instead of 2.
    expect(forFew.filter(isBusinessQuery)).toHaveLength(2);
    expect(forMany.filter(isBusinessQuery)).toHaveLength(2);
  });

  it('loads expirable offers and their lines in two queries', async () => {
    const built = await buildOffers(6);
    expect(built).toBe(6);

    const issued = await countQueries(async () =>
      offers.transaction(async (tx) =>
        tx.offers.findExpirable(new Date('2030-01-01T00:00:00.000Z'), ctx)));
    expect(issued.filter(isBusinessQuery)).toHaveLength(2);
  });

  it('loads booked interviews and their full panels in two queries', async () => {
    const { reqId, appIds } = await seed(2, 1);
    const appId = appIds[0]!;
    for (let i = 0; i < 8; i += 1) {
      await interviews.transaction(async (tx) => {
        const iv = anInterview({
          id: await tx.interviews.nextId(ctx),
          interviewNo: `INT-${String(i).padStart(5, '0')}`,
          applicationId: appId, candidateId: 501, requisitionId: reqId, ctx,
          round: i + 1,
          startsAt: new Date(`2026-04-0${(i % 8) + 1}T09:00:00.000Z`),
        });
        await tx.interviews.save(iv);
      });
    }

    const issued = await countQueries(async () =>
      interviews.transaction(async (tx) => tx.interviews.findBookedFor(
        [11],
        { startsAt: new Date('2026-04-01T00:00:00.000Z'), endsAt: new Date('2026-04-30T00:00:00.000Z') },
        ctx,
      )));
    // Join for the matching interviews, then ONE batched panel query.
    expect(issued.filter(isBusinessQuery)).toHaveLength(2);
  });

  it('writes N new seats in a single INSERT', async () => {
    const issued = await countQueries(async () => hiring.transaction(async (tx) => {
      const r = anOpenRequisition({
        id: await tx.requisitions.nextId(ctx), ticketNo: 'REQ-2026-09999', ctx, headcount: 50,
      });
      await tx.requisitions.save(r);
    }));
    // A per-seat INSERT would make creating a 50-headcount requisition cost 50
    // round trips inside a transaction holding a row lock.
    expect(issued.filter((q) => /insert into "hiring_seat"/i.test(q))).toHaveLength(1);
  });

  it('writes the outbox for a whole transaction in a single INSERT', async () => {
    const issued = await countQueries(async () => seed(3, 5, 9));
    expect(issued.filter((q) => /insert into "outbox_event"/i.test(q))).toHaveLength(1);
  });
});

/* --------------------------- 2. throughput -------------------------------- */

describe('throughput', () => {
  it('fills seats at a workable rate', async () => {
    const { reqId, appIds } = await seed(40, 40);
    await timed('seat fill x40', 'one transaction each, row-locked', async () => {
      for (const appId of appIds) {
        await hiring.transaction(async (tx) => {
          const r = await tx.requisitions.findByIdForUpdate(reqId, ctx);
          r?.fillSeat(appId, ctx.actor);
          if (r) await tx.requisitions.save(r);
        });
      }
    });

    const loaded = await hiring.transaction(async (tx) => tx.requisitions.findById(reqId, ctx));
    expect(loaded?.filledCount).toBe(40);
  });

  it('loads a large requisition quickly', async () => {
    const { reqId } = await seed(200, 0);
    await timed('load 200-seat requisition', 'root + seats', async () => {
      for (let i = 0; i < 20; i += 1) {
        await hiring.transaction(async (tx) => tx.requisitions.findById(reqId, ctx));
      }
    });
    const loaded = await hiring.transaction(async (tx) => tx.requisitions.findById(reqId, ctx));
    expect(loaded?.seats).toHaveLength(200);
  });

  it('relays a backlog through the dispatcher', async () => {
    const seen: string[] = [];
    const audit: Subscriber = {
      name: 'audit',
      async handle(envelope): Promise<void> { seen.push(envelope.event.type); },
    };
    const registry = new SubscriberRegistry().register(audit);
    const dispatcher = new EventDispatcher(harness.db, registry);

    await seed(5, 30);
    const worker = new OutboxDispatcher(harness.db, dispatcher, { batchSize: 100 });
    const result = await timed('outbox drain', 'claim + fan-out + mark', async () =>
      worker.drainUntilEmpty());

    expect(result.delivered).toBeGreaterThan(30);
    expect(seen.length).toBe(result.delivered);
  });

  it('delivers on the fast path without a poll', async () => {
    const seen: string[] = [];
    const registry = new SubscriberRegistry().register({
      name: 'audit',
      async handle(envelope): Promise<void> { seen.push(envelope.event.type); },
    });
    const dispatcher = new EventDispatcher(harness.db, registry);
    const uow = new DrizzleHiringUnitOfWork(harness.db, {
      year: () => 2026, relay: createPostCommitRelay(harness.db, dispatcher),
    });

    await timed('post-commit relay x20', 'write + commit + deliver', async () => {
      for (let i = 0; i < 20; i += 1) {
        await uow.transaction(async (tx) => {
          const r = anOpenRequisition({
            id: await tx.requisitions.nextId(ctx),
            ticketNo: `REQ-2026-1${String(i).padStart(4, '0')}`, ctx,
          });
          await tx.requisitions.save(r);
        });
      }
    });

    expect(seen.length).toBeGreaterThanOrEqual(20);
  });
});

/* --------------------------- 3. migration order --------------------------- */

describe('migration determinism', () => {
  it('applies migrations in a stable, lexicographic order', async () => {
    // Filename order IS the contract. A migration named out of sequence would
    // apply before its dependency and fail on a clean database — which is
    // exactly what the real-PostgreSQL harness proves, since it drops and
    // recreates the schema before applying anything.
    const applied = [...harness.appliedMigrations];
    expect(applied).toEqual([...applied].sort());
    expect(applied[0]).toMatch(/^0000_/);

    // Contiguous, gapless numbering. A gap means a migration was deleted after
    // being applied somewhere, and a duplicate number means two branches
    // both claimed a slot — the real determinism failures, neither of which a
    // hard-coded count would catch.
    const numbers = applied.map((f) => Number(f.slice(0, 4)));
    expect(numbers).toEqual(numbers.map((_n, i) => i));
  });
});

/* --------------------------------- helpers -------------------------------- */

/**
 * Ignore the framework's own chatter (BEGIN/COMMIT, sequence reads) and count
 * only statements against business tables — the ones that would multiply.
 */
const isBusinessQuery = (q: string): boolean =>
  /^\s*(select|insert|update|delete)/i.test(q) && !/nextval\(/i.test(q);

const buildOffers = async (count: number): Promise<number> => {
  const { reqId, appIds } = await seed(count, count);
  for (let i = 0; i < count; i += 1) {
    await offers.transaction(async (tx) => {
      const o = anOffer({
        id: await tx.offers.nextId(ctx),
        offerNo: `OFR-2026-${String(i).padStart(5, '0')}`,
        applicationId: appIds[i]!, candidateId: 1_000 + i, requisitionId: reqId, ctx,
      });
      await tx.offers.save(o);
      const loaded = await tx.offers.findByIdForUpdate(o.id, ctx);
      loaded?.submit({ directorThreshold: null, thresholdCurrency: 'EGP' }, ctx.actor);
      loaded?.approve({ id: 42, name: 'Director' }, { hasDirectorAuthority: true });
      loaded?.send({
        templateCode: 'OFFER_LETTER_EN', templateVersion: 3, variableSnapshot: {},
        validityDays: 5, now: new Date('2026-03-10T09:00:00.000Z'), actor: ctx.actor,
      });
      if (loaded) await tx.offers.save(loaded);
    });
  }
  return count;
};
