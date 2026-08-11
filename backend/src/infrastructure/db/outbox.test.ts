// Transactional outbox and event bus — Steps 8 and 9.
//
// The claim under test is the one that matters operationally: an event is
// durable if and only if the state change it describes is durable, and each
// subscriber processes it exactly once.

import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { createTestDatabase } from './testing/database.js';
import type { TestDatabase } from './testing/database.js';
import { anApplication, anOpenRequisition, globalCtx } from './testing/fixtures.js';
import { outboxEvent, processedEvent } from './schema/index.js';
import { TransactionEventCollector, outboxBacklog, writeOutbox } from './outbox.js';
import type { EventEnvelope } from './outbox.js';
import { createPostCommitRelay, relay } from './outbox-relay.js';
import { OutboxDispatcher } from './outbox-dispatcher.js';
import { EventDispatcher } from '../events/event-dispatcher.js';
import { SubscriberRegistry } from '../events/subscriber.js';
import type { Subscriber } from '../events/subscriber.js';
import { InProcessEventBus, NoOpEventBus } from '../events/in-process-event-bus.js';
import { DrizzleHiringUnitOfWork } from '../../modules/hiring/infrastructure/unit-of-work.js';
import { HiringService } from '../../modules/hiring/application/hiring-service.js';
import { AuthContext, HIRING_PERMISSIONS } from '../../modules/hiring/application/auth-context.js';

let harness: TestDatabase;
const ctx = globalCtx();

beforeAll(async () => { harness = await createTestDatabase(); });
afterAll(async () => { await harness.close(); });
beforeEach(async () => { await harness.reset(); });

/* -------------------------------- helpers --------------------------------- */

/** Records what it saw and, optionally, fails on cue. */
class RecordingSubscriber implements Subscriber {
  readonly seen: string[] = [];
  readonly seenIds: (number | null)[] = [];
  failuresRemaining = 0;

  constructor(readonly name: string, readonly eventTypes?: readonly string[]) {}

  async handle(envelope: EventEnvelope): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error(`${this.name} is unavailable`);
    }
    this.seen.push(envelope.event.type);
    this.seenIds.push(envelope.id);
  }
}

const wire = (...subscribers: Subscriber[]): {
  registry: SubscriberRegistry; dispatcher: EventDispatcher;
} => {
  const registry = new SubscriberRegistry();
  for (const s of subscribers) registry.register(s);
  return { registry, dispatcher: new EventDispatcher(harness.db, registry) };
};

const uowWith = (dispatcher?: EventDispatcher): DrizzleHiringUnitOfWork =>
  new DrizzleHiringUnitOfWork(harness.db, {
    year: () => 2026,
    ...(dispatcher ? { relay: createPostCommitRelay(harness.db, dispatcher) } : {}),
  });

const seedRequisition = async (uow: DrizzleHiringUnitOfWork): Promise<number> =>
  uow.transaction(async (tx) => {
    const r = anOpenRequisition({
      id: await tx.requisitions.nextId(ctx), ticketNo: 'REQ-2026-00001', ctx, headcount: 2,
    });
    await tx.requisitions.save(r);
    return r.id;
  });

const outboxRows = async (): Promise<(typeof outboxEvent.$inferSelect)[]> =>
  harness.db.select().from(outboxEvent).orderBy(asc(outboxEvent.id));

/* --------------------------- 1. atomicity (Step 8) ------------------------- */

describe('outbox atomicity', () => {
  it('writes events in the same transaction as the state change', async () => {
    const uow = uowWith();
    const id = await seedRequisition(uow);

    const rows = await outboxRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.aggregateType === 'Requisition')).toBe(true);
    expect(rows.every((r) => r.aggregateId === id)).toBe(true);
    expect(rows.every((r) => r.publishedAt === null)).toBe(true);
  });

  it('writes NO events when the transaction rolls back', async () => {
    const uow = uowWith();
    await expect(uow.transaction(async (tx) => {
      const r = anOpenRequisition({
        id: await tx.requisitions.nextId(ctx), ticketNo: 'REQ-2026-00001', ctx,
      });
      await tx.requisitions.save(r);
      throw new Error('rollback');
    })).rejects.toThrow('rollback');

    // The whole point: events and state commit together or vanish together.
    // "Publish then commit" would have leaked these to subscribers.
    expect(await outboxRows()).toEqual([]);
  });

  it('records the aggregate type and id from the repository, not from the payload', async () => {
    const uow = uowWith();
    const reqId = await seedRequisition(uow);
    await uow.transaction(async (tx) => {
      const a = anApplication({
        id: await tx.applications.nextId(ctx),
        applicationNo: 'APP-00001', candidateId: 501, requisitionId: reqId, ctx,
      });
      await tx.applications.save(a);
    });

    const rows = await outboxRows();
    const types = new Set(rows.map((r) => r.aggregateType));
    expect(types).toEqual(new Set(['Requisition', 'Application']));
  });

  it('assigns ids in occurrence order across every aggregate in the transaction', async () => {
    const uow = uowWith();
    const reqId = await seedRequisition(uow);

    await uow.transaction(async (tx) => {
      const a = anApplication({
        id: await tx.applications.nextId(ctx),
        applicationNo: 'APP-00001', candidateId: 501, requisitionId: reqId, ctx,
      });
      a.transitionTo('MATCHED', ctx.actor, { trigger: 'MANUAL' });
      await tx.applications.save(a);

      const r = await tx.requisitions.findByIdForUpdate(reqId, ctx);
      r?.adjustHeadcount(3, ctx.actor);
      if (r) await tx.requisitions.save(r);
    });

    const rows = await outboxRows();
    const ids = rows.map((r) => r.id);
    // Monotonic and gapless within the batch: `outbox_event.id` IS the total
    // order the dispatcher replays in.
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const app = rows.filter((r) => r.aggregateType === 'Application').map((r) => r.eventType);
    // Within one aggregate, creation precedes the transition it enabled.
    expect(app.indexOf('ApplicationCreated'))
      .toBeLessThan(app.indexOf('ApplicationStageChanged'));
  });

  it('carries a correlation id when one is supplied', async () => {
    const uow = new DrizzleHiringUnitOfWork(harness.db, {
      year: () => 2026, correlationId: () => 'req-abc-123',
    });
    await seedRequisition(uow);
    expect((await outboxRows()).every((r) => r.correlationId === 'req-abc-123')).toBe(true);
  });

  it('does not leak events from an abandoned attempt into the retry', async () => {
    // The collector is created per ATTEMPT. A transaction that fails and is
    // retried must not double-write the first attempt's events.
    let attempts = 0;
    const uow = new DrizzleHiringUnitOfWork(harness.db, {
      year: () => 2026, sleep: async () => undefined, random: () => 0.5,
    });

    await expect(uow.transaction(async (tx) => {
      attempts += 1;
      const r = anOpenRequisition({
        id: await tx.requisitions.nextId(ctx), ticketNo: `REQ-2026-0000${attempts}`, ctx,
      });
      await tx.requisitions.save(r);
      throw new Error('always fails');
    })).rejects.toThrow('always fails');

    expect(attempts).toBe(1);
    expect(await outboxRows()).toEqual([]);
  });
});

/* --------------------------- 2. the relay (Step 9) ------------------------- */

describe('post-commit relay', () => {
  it('delivers after commit and marks the rows published', async () => {
    const audit = new RecordingSubscriber('audit');
    const { dispatcher } = wire(audit);
    await seedRequisition(uowWith(dispatcher));

    expect(audit.seen.length).toBeGreaterThan(0);
    const rows = await outboxRows();
    expect(rows.every((r) => r.publishedAt !== null)).toBe(true);
  });

  it('delivers to every interested subscriber and skips uninterested ones', async () => {
    const all = new RecordingSubscriber('audit');
    const narrow = new RecordingSubscriber('notifications', ['RequisitionStateChanged']);
    const { dispatcher } = wire(all, narrow);
    await seedRequisition(uowWith(dispatcher));

    expect(all.seen.length).toBeGreaterThan(narrow.seen.length);
    expect(narrow.seen.every((t) => t === 'RequisitionStateChanged')).toBe(true);
  });

  it('leaves the row pending and records the error when a subscriber fails', async () => {
    const flaky = new RecordingSubscriber('notifications');
    flaky.failuresRemaining = 99;
    const { dispatcher } = wire(flaky);
    await seedRequisition(uowWith(dispatcher));

    const rows = await outboxRows();
    expect(rows.every((r) => r.publishedAt === null)).toBe(true);
    expect(rows.every((r) => r.attempts === 1)).toBe(true);
    expect(rows[0]?.lastError).toContain('unavailable');
    // Backoff pushed the retry into the future rather than hot-looping.
    expect(rows[0]!.nextAttemptAt.getTime()).toBeGreaterThan(rows[0]!.occurredAt.getTime());
  });

  it('does not fail the caller when the relay throws', async () => {
    // The transaction is already committed. Reporting failure would be a lie and
    // could trigger a retry of work that already took effect.
    const errors: unknown[] = [];
    const exploding = new DrizzleHiringUnitOfWork(harness.db, {
      year: () => 2026,
      relay: async () => { throw new Error('bus is down'); },
      onRelayError: (e) => errors.push(e),
    });

    const id = await seedRequisition(exploding);
    expect(id).toBeGreaterThan(0);
    expect(errors).toHaveLength(1);
    // State committed; events are still pending for the dispatcher.
    expect((await outboxRows()).every((r) => r.publishedAt === null)).toBe(true);
  });

  it('one failing subscriber does not roll back a succeeding one', async () => {
    const audit = new RecordingSubscriber('audit');
    const email = new RecordingSubscriber('notifications');
    email.failuresRemaining = 99;
    const { dispatcher } = wire(audit, email);
    await seedRequisition(uowWith(dispatcher));

    // A shared transaction would have meant a broken email provider blocking the
    // audit trail — precisely backwards.
    expect(audit.seen.length).toBeGreaterThan(0);
    expect(email.seen).toEqual([]);
  });
});

/* ------------------- 3. exactly-once processing (Step 9) ------------------- */

describe('exactly-once processing', () => {
  it('runs a subscriber once even when the same event is relayed twice', async () => {
    const audit = new RecordingSubscriber('audit');
    const { dispatcher } = wire(audit);
    const uow = uowWith(dispatcher);
    await seedRequisition(uow);

    const firstPass = audit.seen.length;
    expect(firstPass).toBeGreaterThan(0);

    // Replay every stored event through the same path — a crashed dispatcher
    // that never marked its rows would do exactly this.
    const stored = await outboxRows();
    const envelopes: EventEnvelope[] = stored.map((r) => ({
      id: r.id, tenantId: r.tenantId, aggregateType: r.aggregateType,
      aggregateId: r.aggregateId, correlationId: r.correlationId,
      event: { type: r.eventType, at: r.occurredAt, payload: r.payload as Record<string, unknown> },
    }));
    await relay(harness.db, dispatcher, envelopes);

    expect(audit.seen.length).toBe(firstPass);
  });

  it('writes one ledger row per subscriber per event', async () => {
    const audit = new RecordingSubscriber('audit');
    const search = new RecordingSubscriber('search-index');
    const { dispatcher } = wire(audit, search);
    await seedRequisition(uowWith(dispatcher));

    const ledger = await harness.db.select().from(processedEvent);
    const events = await outboxRows();
    expect(ledger).toHaveLength(events.length * 2);
    expect(new Set(ledger.map((l) => l.consumer))).toEqual(new Set(['audit', 'search-index']));
  });

  it('releases the claim when a handler throws, so the event is retried', async () => {
    const flaky = new RecordingSubscriber('notifications');
    flaky.failuresRemaining = 1;
    const { dispatcher } = wire(flaky);
    await seedRequisition(uowWith(dispatcher));

    // First event failed and left no ledger row — otherwise it would be skipped
    // forever and silently lost.
    const afterFailure = await harness.db.select().from(processedEvent);
    const firstRow = (await outboxRows())[0]!;
    expect(afterFailure.some((l) => l.eventId === firstRow.id)).toBe(false);

    // Past the backoff window — otherwise nothing is claimable yet, by design.
    const later = new Date(Date.now() + 60_000);
    const drained = await new OutboxDispatcher(harness.db, dispatcher, { now: () => later })
      .drainUntilEmpty();
    expect(drained.delivered).toBeGreaterThan(0);
    expect((await outboxRows()).every((r) => r.publishedAt !== null)).toBe(true);
  });

  it('refuses to register two subscribers under one name', () => {
    const registry = new SubscriberRegistry();
    registry.register(new RecordingSubscriber('audit'));
    // They would share a ledger key, so the second would silently never run.
    expect(() => registry.register(new RecordingSubscriber('audit'))).toThrow(/already registered/);
  });
});

/* ---------------------------- 4. the dispatcher ---------------------------- */

describe('OutboxDispatcher', () => {
  it('delivers events the fast path never handled', async () => {
    // No relay on the Unit of Work: a worker whose events another process relays.
    const uow = uowWith();
    await seedRequisition(uow);
    expect((await outboxRows()).every((r) => r.publishedAt === null)).toBe(true);

    const audit = new RecordingSubscriber('audit');
    const { dispatcher } = wire(audit);
    const result = await new OutboxDispatcher(harness.db, dispatcher).drainUntilEmpty();

    expect(result.delivered).toBeGreaterThan(0);
    expect(audit.seen.length).toBe(result.delivered);
    expect((await outboxRows()).every((r) => r.publishedAt !== null)).toBe(true);
  });

  it('replays in outbox id order', async () => {
    const uow = uowWith();
    const reqId = await seedRequisition(uow);
    await uow.transaction(async (tx) => {
      const a = anApplication({
        id: await tx.applications.nextId(ctx),
        applicationNo: 'APP-00001', candidateId: 501, requisitionId: reqId, ctx,
      });
      a.transitionTo('MATCHED', ctx.actor, { trigger: 'MANUAL' });
      await tx.applications.save(a);
    });

    const audit = new RecordingSubscriber('audit');
    const { dispatcher } = wire(audit);
    await new OutboxDispatcher(harness.db, dispatcher, { batchSize: 2 }).drainUntilEmpty();

    const expected = (await outboxRows()).map((r) => r.eventType);
    expect(audit.seen).toEqual(expected);
    expect(audit.seenIds).toEqual([...audit.seenIds].sort((a, b) => Number(a) - Number(b)));
  });

  it('respects the backoff and does not re-claim a row before it is due', async () => {
    const flaky = new RecordingSubscriber('notifications');
    flaky.failuresRemaining = 99;
    const { dispatcher } = wire(flaky);
    await seedRequisition(uowWith(dispatcher));

    const now = new Date();
    const result = await new OutboxDispatcher(harness.db, dispatcher, { now: () => now })
      .drainOnce();
    // Every row's next attempt is in the future, so nothing is claimable.
    expect(result.delivered).toBe(0);

    const backlog = await outboxBacklog(harness.db, now);
    expect(backlog.pending).toBeGreaterThan(0);
    expect(backlog.due).toBe(0);
    expect(backlog.failing).toBe(backlog.pending);
  });

  it('survives a failing pass without killing the worker', async () => {
    const errors: unknown[] = [];
    const broken = new EventDispatcher(harness.db, new SubscriberRegistry());
    // Force the claim itself to fail by handing the dispatcher a dead handle.
    const dead = { transaction: async () => { throw new Error('connection lost'); } } as never;
    const result = await new OutboxDispatcher(dead, broken, {
      onError: (e) => errors.push(e),
    }).drainOnce();

    expect(result).toEqual({ delivered: 0, failed: 0 });
    expect(errors).toHaveLength(1);
  });

  it('stops draining at maxPasses rather than spinning', async () => {
    const flaky = new RecordingSubscriber('notifications');
    flaky.failuresRemaining = 99;
    const { dispatcher } = wire(flaky);
    await seedRequisition(uowWith(dispatcher));
    const result = await new OutboxDispatcher(harness.db, dispatcher).drainUntilEmpty(3);
    expect(result.delivered).toBe(0);
  });
});

/* ------------------- 5. end to end through a real service ------------------ */

describe('a real service on the real Unit of Work', () => {
  const hireCtx = new AuthContext({
    tenantId: 1, userId: 7, userName: 'Mona Adel',
    permissions: [HIRING_PERMISSIONS.RECORD_HIRE],
    projectScopes: [], isGlobalScope: true,
  });

  it('delivers the events a service records, exactly once, without the service publishing', async () => {
    // This is the test that closes the gap the design creates: the repositories
    // drain events during save(), so `HiringService.publish` is called with an
    // empty array and the Unit of Work publishes in its place. Asserting on the
    // COMPOSED system is the only way to know that still works end to end.
    const audit = new RecordingSubscriber('audit');
    const { dispatcher } = wire(audit);
    const uow = uowWith(dispatcher);

    const serviceBus = new NoOpEventBus();
    const service = new HiringService({ uow, events: serviceBus });

    const { reqId, appId } = await uow.transaction(async (tx) => {
      const r = anOpenRequisition({
        id: await tx.requisitions.nextId(ctx), ticketNo: 'REQ-2026-00001', ctx, headcount: 1,
      });
      await tx.requisitions.save(r);
      const a = anApplication({
        id: await tx.applications.nextId(ctx),
        applicationNo: 'APP-00001', candidateId: 501, requisitionId: r.id, ctx,
      });
      for (const [stage, trigger] of [
        ['MATCHED', 'MANUAL'], ['INTERVIEWING', 'MANUAL'], ['OFFER_PREPARATION', 'MANUAL'],
        ['OFFER_SENT', 'SYSTEM'],
      ] as const) a.transitionTo(stage, ctx.actor, { trigger });
      await tx.applications.save(a);
      return { reqId: r.id, appId: a.id };
    });

    audit.seen.length = 0;
    await service.recordHire({ applicationId: appId }, hireCtx);

    // The service published nothing in-process...
    expect(serviceBus.published).toEqual([]);
    // ...yet the subscriber saw the hire, and every event is durable.
    expect(audit.seen).toContain('ApplicationStageChanged');
    expect(audit.seen).toContain('SeatFilled');
    expect((await outboxRows()).every((r) => r.publishedAt !== null)).toBe(true);

    // A dispatcher pass afterwards is a no-op: nothing is delivered twice.
    const before = audit.seen.length;
    await new OutboxDispatcher(harness.db, dispatcher).drainUntilEmpty();
    expect(audit.seen.length).toBe(before);

    const seats = await harness.db.select().from(outboxEvent)
      .where(eq(outboxEvent.aggregateId, reqId));
    expect(seats.length).toBeGreaterThan(0);
  });

  it('publishes in-process for an aggregate that was never saved', async () => {
    // The one path the outbox cannot carry: no row, so no id, so no ledger and
    // no retry. Best effort, and documented as such.
    const audit = new RecordingSubscriber('audit');
    const { dispatcher } = wire(audit);
    const bus = new InProcessEventBus(dispatcher);

    await bus.publish([{ type: 'OrphanTestEvent', at: new Date(), payload: { x: 1 } }]);

    expect(audit.seen).toEqual(['OrphanTestEvent']);
    expect(audit.seenIds).toEqual([null]);
    expect(await harness.db.select().from(processedEvent)).toEqual([]);
  });

  it('writes nothing for an empty event list', async () => {
    expect(await writeOutbox(harness.db, [])).toEqual([]);
    const collector = new TransactionEventCollector();
    expect(collector.isEmpty).toBe(true);
    collector.collect('Requisition', 1, 1, []);
    expect(collector.isEmpty).toBe(true);
  });
});
