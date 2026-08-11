// The ambient transaction handle.
//
// WHY THIS EXISTS
//
// A cross-context gateway (ADR-0007) is constructed by the composition root and
// therefore holds the ROOT database handle. But it is called from INSIDE a
// service's transaction — `RequisitionService.close` asks the Offer context
// whether any live offers block the close, while holding a row lock.
//
// Running that query on the root handle is wrong in two different ways
// depending on the driver, and both are bad:
//
//   node-postgres  the query takes a DIFFERENT pooled connection. It therefore
//                  runs OUTSIDE the transaction and cannot see its uncommitted
//                  state, and it holds a second connection while the first is
//                  still open — which deadlocks the pool under load, at the
//                  worst possible moment.
//
//   PGlite         single connection. The query queues behind a transaction
//                  that cannot commit until the query returns. Hard deadlock.
//
// The gateway cannot take an executor parameter: its interface lives in the
// (frozen) business layer and reads `applicationsWithLiveOffers(id, ctx)`.
//
// So the transaction publishes itself here, and any adapter that finds one
// joins it. This is deliberately the ONLY other piece of ambient state besides
// the request context, and for the same reason: the alternative is threading a
// parameter through an interface that must not know about databases.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Executor } from './types.js';

const storage = new AsyncLocalStorage<Executor>();

/** Run `fn` with `tx` published as the ambient handle. */
export const withTransaction = <T>(tx: Executor, fn: () => Promise<T>): Promise<T> =>
  storage.run(tx, fn);

/**
 * The transaction currently in flight, if any.
 *
 * Adapters should prefer this over their injected handle so a read issued
 * inside a transaction joins it rather than racing it.
 */
export const currentTransaction = (): Executor | undefined => storage.getStore();

/**
 * The handle an adapter should actually use.
 *
 * Inside a transaction: that transaction. Outside one: the handle the adapter
 * was constructed with.
 */
export const executorFor = (fallback: Executor): Executor =>
  storage.getStore() ?? fallback;
