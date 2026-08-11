// Optimistic locking — the loaded-version registry.
//
// THE PROBLEM THIS SOLVES
//
// An aggregate bumps its own `version` in memory, once per mutating method. A
// service may call two of them in one transaction, so by the time `save()` runs,
// `aggregate.version` may be `loaded + 2`. Writing
//
//     WHERE version = aggregate.version - 1
//
// would therefore be wrong in exactly the case that matters, and — worse —
// wrong in a way that silently WIDENS the guard rather than failing.
//
// The only correct baseline is the version the row actually had when this
// transaction read it. So the repository records it at load time and uses it at
// save time. That also gives `save()` its insert-vs-update decision for free:
// an aggregate this transaction never loaded is by definition new.
//
// The registry is per-repository, and repositories are constructed per
// transaction (ADR-0002), so its lifetime is exactly one transaction. It is
// never a process-wide identity map — that would be a cache, with all the
// staleness problems a cache brings, and it would leak state between requests.

import { StaleAggregateError } from '../../modules/shared/kernel/errors.js';

/** What was true about a row when this transaction read it. */
export interface Baseline {
  readonly version: number;
  /**
   * Row counts for append-only children, so `save()` inserts only the tail.
   * Stage history is append-only; re-inserting the whole list every save would
   * duplicate the trail and break the audit guarantee.
   */
  readonly appendedCounts: Readonly<Record<string, number>>;
}

export class LoadRegistry {
  private readonly baselines = new Map<number, Baseline>();

  record(id: number, version: number, appendedCounts: Record<string, number> = {}): void {
    this.baselines.set(id, { version, appendedCounts });
  }

  baselineOf(id: number): Baseline | undefined {
    return this.baselines.get(id);
  }

  /** False means "this transaction has not seen this row", i.e. `save()` inserts. */
  knows(id: number): boolean {
    return this.baselines.has(id);
  }

  forget(id: number): void {
    this.baselines.delete(id);
  }
}

/**
 * Translate a zero-row versioned UPDATE into the error the application layer
 * already understands.
 *
 * Distinguishing "stale" from "gone" costs one extra SELECT, and only on the
 * failure path. It is worth it: `StaleAggregateError` tells the user to reload
 * and retry, which is useless advice if the row was actually deleted.
 */
export const assertUpdated = async (
  rowCount: number,
  entityType: string,
  id: number,
  expectedVersion: number,
  readActualVersion: () => Promise<number | null>,
): Promise<void> => {
  if (rowCount > 0) return;
  const actual = await readActualVersion();
  // `-1` is the sentinel for "row is gone or out of scope". The message the user
  // sees is the same either way; the detail is for the log.
  throw new StaleAggregateError(entityType, id, expectedVersion, actual ?? -1);
};
