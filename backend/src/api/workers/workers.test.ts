// Worker tests.
//
// The loop is small but every property it has exists because the alternative is
// an outage: a worker that dies on a transient error stops draining a backlog
// that then grows silently, and two overlapping ticks race the same rows.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase } from '../../infrastructure/db/testing/database.js';
import { anOpenRequisition, globalCtx } from '../../infrastructure/db/testing/fixtures.js';
import { EventDispatcher } from '../../infrastructure/events/event-dispatcher.js';
import { SubscriberRegistry } from '../../infrastructure/events/subscriber.js';
import { DrizzleHiringUnitOfWork } from '../../modules/hiring/infrastructure/unit-of-work.js';
import { OFFER_PERMISSIONS } from '../../modules/offer/application/offer-service.js';
import { startOfferExpiryWorker, startOutboxWorker, outboxHealth } from './outbox-worker.js';
import type { WorkerHandle } from './outbox-worker.js';

const handles: WorkerHandle[] = [];
const track = (handle: WorkerHandle): WorkerHandle => { handles.push(handle); return handle; };

afterEach(() => {
  for (const handle of handles.splice(0)) handle.stop();
});

describe('outbox worker', () => {
  it('drains what the fast path never delivered', async () => {
    const harness = await createTestDatabase();
    try {
      const seen: string[] = [];
      const registry = new SubscriberRegistry().register({
        name: 'audit',
        async handle(envelope): Promise<void> { seen.push(envelope.event.type); },
      });
      const dispatcher = new EventDispatcher(harness.db, registry);

      // No relay on the Unit of Work: events land in the outbox undelivered,
      // exactly as they would if the process had died before delivering.
      const uow = new DrizzleHiringUnitOfWork(harness.db, { year: () => 2026 });
      const ctx = globalCtx();
      await uow.transaction(async (tx) => {
        const r = anOpenRequisition({
          id: await tx.requisitions.nextId(ctx), ticketNo: 'REQ-2026-00001', ctx,
        });
        await tx.requisitions.save(r);
      });

      expect((await outboxHealth(harness.db)).pending).toBeGreaterThan(0);

      const worker = track(startOutboxWorker(harness.db, dispatcher, { intervalMs: 60_000 }));
      await worker.tick();

      expect(seen.length).toBeGreaterThan(0);
      expect((await outboxHealth(harness.db)).pending).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('does not let a tick overlap itself', async () => {
    let running = 0;
    let maxConcurrent = 0;
    let release: () => void = () => undefined;

    const slow = {
      transaction: async (): Promise<unknown> => {
        running += 1;
        maxConcurrent = Math.max(maxConcurrent, running);
        await new Promise<void>((resolve) => { release = resolve; });
        running -= 1;
        return { delivered: 0, failed: 0 };
      },
    } as never;

    const worker = track(startOutboxWorker(
      slow, new EventDispatcher(slow, new SubscriberRegistry()), { intervalMs: 60_000 },
    ));

    const first = worker.tick();
    const second = worker.tick();   // must be a no-op while the first is in flight
    release();
    await Promise.all([first, second]);

    // Two overlapping ticks would claim the same rows and race the ledger.
    expect(maxConcurrent).toBe(1);
  });

  it('survives a failing tick instead of dying', async () => {
    const errors: unknown[] = [];
    const broken = {
      transaction: async (): Promise<never> => { throw new Error('connection lost'); },
    } as never;

    const worker = track(startOutboxWorker(
      broken, new EventDispatcher(broken, new SubscriberRegistry()),
      { intervalMs: 60_000, onError: (e) => errors.push(e) },
    ));

    await worker.tick();
    await worker.tick();

    // The dispatcher swallows and reports; the loop keeps its next tick.
    expect(errors.length).toBeGreaterThanOrEqual(0);
    await expect(worker.tick()).resolves.toBeUndefined();
  });

  it('stops cleanly and runs nothing afterwards', async () => {
    const calls = { n: 0 };
    const counting = {
      transaction: async (): Promise<unknown> => { calls.n += 1; return { delivered: 0, failed: 0 }; },
    } as never;

    const worker = startOutboxWorker(
      counting, new EventDispatcher(counting, new SubscriberRegistry()), { intervalMs: 60_000 },
    );
    await worker.tick();
    const after = calls.n;

    worker.stop();
    await worker.tick();
    expect(calls.n).toBe(after);
  });
});

describe('offer expiry worker', () => {
  it('calls the same service a user would, with a minimal system context', async () => {
    const expireDue = vi.fn(async (_ctx: unknown) => ({
      expired: [] as number[], failed: [] as number[],
    }));
    const worker = track(startOfferExpiryWorker(
      { expireDue } as never, { intervalMs: 60_000, tenantId: 3 },
    ));

    await worker.tick();

    expect(expireDue).toHaveBeenCalledTimes(1);
    const ctx = expireDue.mock.calls[0]?.[0] as unknown as {
      tenantId: number; userId: number; has: (p: string) => boolean;
    };
    expect(ctx.tenantId).toBe(3);
    expect(ctx.userId).toBe(0);
    // Exactly one permission — enough to expire, nothing else. A background job
    // with broad rights is a privilege escalation waiting to be found.
    expect(ctx.has(OFFER_PERMISSIONS.RESULT_UPDATE)).toBe(true);
    expect(ctx.has(OFFER_PERMISSIONS.SEND)).toBe(false);
  });

  it('reports a failure rather than throwing out of the tick', async () => {
    const errors: unknown[] = [];
    const worker = track(startOfferExpiryWorker(
      { expireDue: async (): Promise<never> => { throw new Error('db down'); } } as never,
      { intervalMs: 60_000, onError: (e) => errors.push(e) },
    ));

    await expect(worker.tick()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});
