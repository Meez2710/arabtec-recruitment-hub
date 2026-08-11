// The transaction primitive, shared by all three Units of Work.
//
// TWO THINGS HAPPEN HERE AND NOTHING ELSE.
//
// 1. ONE transaction, one pinned connection. Drizzle's `transaction()` checks a
//    connection out of the pool, issues BEGIN, hands the SAME handle to the
//    callback, and issues COMMIT or ROLLBACK on that handle.
//
//    This is the direct fix for Audit #1 F-01: the legacy `tx()` helper ran
//    BEGIN, the writes, and COMMIT as three separate `pool.query()` calls, each
//    of which checks out an arbitrary connection. The BEGIN was orphaned on a
//    connection that then did nothing, and the writes executed in autocommit —
//    so seat filling, the one place with overfill protection, had no atomicity
//    at all in production.
//
// 2. RETRY on transient serialization failures. A deadlock or serialization
//    failure is not a bug; it is the normal cost of concurrent access, and the
//    only correct response is to re-run the ENTIRE transaction from the top.
//    Retrying a statement would be wrong — the aggregate state in memory was
//    derived from reads that have now been rolled back.
//
// Retry is safe here precisely BECAUSE the domain is pure: re-running the
// callback re-reads, re-decides and re-writes with no side effects escaping in
// between. Events are published only after commit (ADR-0006), so a retried
// attempt cannot double-publish.

import { isRetryable } from './errors.js';
import type { Executor } from './types.js';

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

export interface TransactionOptions {
  /**
   * READ COMMITTED is the default and is correct for this system: every
   * cross-aggregate decision is protected by an explicit `SELECT … FOR UPDATE`
   * (ADR-0004) rather than by snapshot isolation. Raising it would trade
   * predictable, narrow row contention for unpredictable serialization aborts.
   */
  readonly isolationLevel?: IsolationLevel;
  /** Total attempts, not retries. 1 disables retrying. */
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  /** Injected so tests are deterministic and instant. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly onRetry?: (attempt: number, err: unknown) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Exponential backoff with full jitter.
 *
 * Jitter is not decoration. Without it, two transactions that deadlocked
 * together back off by the same amount and collide again on the retry, and
 * again — the failure mode it exists to fix reproduces itself in lockstep.
 */
const backoffMs = (attempt: number, base: number, random: () => number): number =>
  Math.floor(random() * base * 2 ** (attempt - 1));

export const runInTransaction = async <T>(
  db: Executor,
  fn: (tx: Executor) => Promise<T>,
  opts: TransactionOptions = {},
): Promise<T> => {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 25;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await db.transaction(
        async (tx) => fn(tx as unknown as Executor),
        opts.isolationLevel ? { isolationLevel: opts.isolationLevel } : undefined,
      );
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === maxAttempts) throw err;
      opts.onRetry?.(attempt, err);
      await sleep(backoffMs(attempt, baseDelayMs, random));
    }
  }
  /* c8 ignore next 2 -- unreachable: the loop either returns or throws. */
  throw lastError;
};
