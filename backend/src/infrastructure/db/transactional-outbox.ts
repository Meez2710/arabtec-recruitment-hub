// The transaction-plus-outbox envelope shared by all three Units of Work.
//
// Extracted rather than triplicated: the write/relay ordering below is subtle,
// and three copies of it would drift. Each context's Unit of Work supplies only
// the one thing that differs — how to build its transaction scope.
//
// THE ORDERING, AND WHY EACH STEP IS WHERE IT IS
//
//   1. open transaction
//   2. run the service body  -> repositories drain events into the collector
//   3. write the outbox      -> SAME transaction, so events and state commit
//                               together or not at all
//   4. COMMIT
//   5. relay                 -> AFTER commit, so a subscriber can never observe
//                               a state that was rolled back (ADR-0006)
//
// Step 3 must be last inside the transaction: a repository can still be writing
// during step 2, and an outbox flush before the final `save()` would miss its
// events.

import { TransactionEventCollector, writeOutbox } from './outbox.js';
import type { EventEnvelope } from './outbox.js';
import { runInTransaction } from './transaction.js';
import { currentTransaction, withTransaction } from './current-transaction.js';
import type { TransactionOptions } from './transaction.js';
import type { Executor } from './types.js';

/** Delivers committed events. Injected so a Unit of Work never depends on a bus. */
export type PostCommitRelay = (envelopes: readonly EventEnvelope[]) => Promise<void>;

export interface OutboxAwareOptions extends TransactionOptions {
  /**
   * Absent means "write the outbox, deliver nothing". That is a legitimate
   * production configuration — a worker whose events a separate dispatcher
   * process relays — as well as the default in tests.
   */
  readonly relay?: PostCommitRelay;
  /** Supplied by the HTTP layer later; ties every event to one request. */
  readonly correlationId?: () => string | null;
  /**
   * Relay failure is NOT transaction failure. Surfaced here, never thrown.
   */
  readonly onRelayError?: (error: unknown) => void;
}

export const runTransactionWithOutbox = async <TScope, TResult>(
  db: Executor,
  opts: OutboxAwareOptions,
  buildScope: (tx: Executor, collector: TransactionEventCollector) => TScope,
  fn: (scope: TScope) => Promise<TResult>,
): Promise<TResult> => {
  // JOIN an in-flight transaction rather than opening a second one.
  //
  // A cross-context gateway calls another context's service, and that service
  // opens its own Unit of Work — `MatchingService.link` asking Hiring to create
  // an application, for example. Nesting there is wrong twice over: on a pooled
  // driver the inner call takes a DIFFERENT connection and commits
  // independently of the outer one (so a rollback leaves half the work), and on
  // a single-connection driver it deadlocks outright.
  //
  // Joining makes the whole cross-context operation ONE transaction, which is
  // what the caller meant. Events go to the same outbox; the relay is skipped
  // because the inner call cannot know when the outer transaction commits —
  // the polling dispatcher delivers them a moment later instead.
  const ambient = currentTransaction();
  if (ambient !== undefined) {
    const collector = new TransactionEventCollector();
    const value = await fn(buildScope(ambient, collector));
    await writeOutbox(ambient, collector.records, opts.correlationId?.() ?? null);
    return value;
  }

  let committed: readonly EventEnvelope[] = [];

  const result = await runInTransaction(db, async (tx) => {
    // Fresh per ATTEMPT, not per call: a transaction that deadlocks and retries
    // must not carry the abandoned attempt's events into the next one.
    const collector = new TransactionEventCollector();
    committed = [];

    // Publish the handle so any adapter reached from inside this callback —
    // notably a cross-context gateway — joins THIS transaction instead of
    // taking a second connection and reading around it.
    const value = await withTransaction(tx, async () => fn(buildScope(tx, collector)));
    committed = await writeOutbox(tx, collector.records, opts.correlationId?.() ?? null);
    return value;
  }, opts);

  if (committed.length > 0 && opts.relay !== undefined) {
    try {
      await opts.relay(committed);
    } catch (error) {
      // The transaction is committed and the caller's work succeeded. Throwing
      // here would report a failure that did not happen and could trigger a
      // retry of an operation that already took effect. The rows stay
      // unpublished, so the polling dispatcher delivers them instead.
      opts.onRelayError?.(error);
    }
  }

  return result;
};
