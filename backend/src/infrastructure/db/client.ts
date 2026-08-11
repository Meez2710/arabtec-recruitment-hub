// The production database handle.
//
// One pool per process. Repositories never see it — they receive an `Executor`
// from the Unit of Work, which is always a transaction handle in practice.
//
// `pg` is already a dependency of the legacy layer; this adds no new driver.

import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Executor } from './types.js';

export interface DbConfig {
  readonly connectionString: string;
  /**
   * Pool ceiling. Every transaction pins one connection for its whole duration,
   * so this is the real limit on concurrent write operations — not a tuning
   * knob to raise casually.
   */
  readonly max?: number;
  readonly idleTimeoutMillis?: number;
  /** Fail fast rather than queue forever when the pool is exhausted. */
  readonly connectionTimeoutMillis?: number;
}

/**
 * `numeric` is returned as a STRING by `pg` and stays that way here.
 *
 * There is a tempting one-line "fix" — registering a global type parser that
 * converts OID 1700 to a float — and it is wrong: it silently loses precision on
 * every numeric column in the system, including money. The conversion belongs at
 * the mapper, per column, where the range is known. See numeric.ts.
 */
export const createPool = (config: DbConfig): pg.Pool =>
  new pg.Pool({
    connectionString: config.connectionString,
    max: config.max ?? 10,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5_000,
  });

export const createDb = (pool: pg.Pool): Executor =>
  drizzle(pool) as unknown as Executor;
