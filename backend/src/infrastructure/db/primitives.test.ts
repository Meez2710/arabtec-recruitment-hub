// Unit tests for the persistence primitives — no database, no aggregates.
//
// These cover the pieces every repository depends on and that a repository test
// would only exercise incidentally: the loaded-version registry, the sequence
// reader's guard and driver normalisation, error classification, and the fact
// that the production client wires up at all.

import { describe, expect, it } from 'vitest';
import { createDb, createPool } from './client.js';
import { LoadRegistry, assertUpdated } from './version-guard.js';
import { formatFlatNumber, formatYearlyNumber, nextval } from './sequences.js';
import { NUMBER_PREFIXES } from './sequences.js';
import {
  ConstraintViolationError, PG_ERROR, asDriverError,
  isCheckViolation, isUniqueViolation, sqlState,
} from './errors.js';
import type { Executor } from './types.js';
import { StaleAggregateError } from '../../modules/shared/kernel/errors.js';

/* ------------------------------- the client ------------------------------- */

describe('production client', () => {
  it('builds a pool and a drizzle handle without connecting', async () => {
    // `pg.Pool` is lazy — no socket is opened until a query runs. Constructing
    // here is enough to catch a broken driver import or a bad option name,
    // which would otherwise surface only in production.
    const pool = createPool({ connectionString: 'postgres://user@127.0.0.1:1/none' });
    try {
      const db = createDb(pool);
      expect(typeof db.select).toBe('function');
      expect(typeof db.transaction).toBe('function');
    } finally {
      await pool.end();
    }
  });
});

/* --------------------------- the version registry ------------------------- */

describe('LoadRegistry', () => {
  it('reports an unknown id as unknown, which is what makes save() insert', () => {
    const registry = new LoadRegistry();
    expect(registry.knows(1)).toBe(false);
    expect(registry.baselineOf(1)).toBeUndefined();
  });

  it('remembers the version a row had when it was READ, not the current one', () => {
    // The whole point: an aggregate may bump its version several times in one
    // transaction, so `aggregate.version - 1` is not a safe baseline.
    const registry = new LoadRegistry();
    registry.record(1, 4);
    expect(registry.baselineOf(1)?.version).toBe(4);
    registry.record(1, 7);
    expect(registry.baselineOf(1)?.version).toBe(7);
  });

  it('tracks append-only child counts so only the tail is inserted', () => {
    const registry = new LoadRegistry();
    registry.record(1, 2, { history: 3 });
    expect(registry.baselineOf(1)?.appendedCounts['history']).toBe(3);
    // Absent key means "none stored yet", not "unknown".
    expect(registry.baselineOf(1)?.appendedCounts['panel']).toBeUndefined();
  });

  it('forgets an id on request', () => {
    const registry = new LoadRegistry();
    registry.record(9, 1);
    registry.forget(9);
    expect(registry.knows(9)).toBe(false);
  });
});

describe('assertUpdated', () => {
  it('passes silently when the guarded UPDATE matched a row', async () => {
    await expect(assertUpdated(1, 'Requisition', 5, 2, async () => 2)).resolves.toBeUndefined();
  });

  it('reports the version that actually won when the row was changed', async () => {
    const err = await assertUpdated(0, 'Requisition', 5, 2, async () => 9)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleAggregateError);
    expect((err as StaleAggregateError).details).toMatchObject({
      entityType: 'Requisition', id: 5, expectedVersion: 2, actualVersion: 9,
    });
  });

  it('reports -1 when the row is gone, so the log can tell the cases apart', async () => {
    // Both produce the same user-facing message. The distinction matters for
    // diagnosis: "reload and retry" is useless advice if the row was deleted.
    const err = await assertUpdated(0, 'Offer', 5, 2, async () => null)
      .catch((e: unknown) => e);
    expect((err as StaleAggregateError).details).toMatchObject({ actualVersion: -1 });
  });
});

/* -------------------------------- sequences ------------------------------- */

const executorReturning = (result: unknown): Executor =>
  ({ execute: async () => result } as unknown as Executor);

describe('nextval', () => {
  it('reads node-postgres shape ({ rows: [...] })', async () => {
    const db = executorReturning({ rows: [{ value: '42' }] });
    expect(await nextval(db, 'seq_offer_no')).toBe(42);
  });

  it('reads PGlite shape (array-like)', async () => {
    const db = executorReturning([{ value: 7 }]);
    expect(await nextval(db, 'seq_offer_no')).toBe(7);
  });

  it('refuses a sequence name that is not a plain identifier', async () => {
    // The name is interpolated because `nextval()` takes a regclass literal, so
    // the guard is what turns "every caller passes a constant" from a convention
    // into a runtime guarantee.
    const db = executorReturning([{ value: 1 }]);
    await expect(nextval(db, "seq'; DROP TABLE offer; --")).rejects.toThrow(/unexpected sequence name/);
    await expect(nextval(db, 'Seq_Offer')).rejects.toThrow(/unexpected sequence name/);
  });

  it('fails loudly when the driver returns nothing usable', async () => {
    await expect(nextval(executorReturning([]), 'seq_offer_no')).rejects.toThrow(/returned no value/);
    await expect(nextval(executorReturning(null), 'seq_offer_no')).rejects.toThrow(/returned no value/);
    await expect(nextval(executorReturning({ rows: 'nope' }), 'seq_offer_no'))
      .rejects.toThrow(/returned no value/);
  });
});

describe('business number formats', () => {
  it('matches the live system exactly', () => {
    // Transcribed from models.js. Existing records carry these shapes, they are
    // printed on documents and searched by HR, so a change here is a business
    // change — not a refactor.
    expect(formatYearlyNumber(NUMBER_PREFIXES.requisition, 2026, 1)).toBe('REQ-2026-00001');
    expect(formatYearlyNumber(NUMBER_PREFIXES.offer, 2026, 137)).toBe('OFR-2026-00137');
    expect(formatFlatNumber(NUMBER_PREFIXES.application, 42)).toBe('APP-00042');
    expect(formatFlatNumber(NUMBER_PREFIXES.interview, 9)).toBe('INT-00009');
  });

  it('widens rather than truncates past five digits', () => {
    expect(formatFlatNumber('APP', 1_234_567)).toBe('APP-1234567');
  });
});

/* ------------------------------ error mapping ----------------------------- */

describe('driver error classification', () => {
  const err = (fields: Record<string, unknown>): unknown => Object.assign(new Error('x'), fields);

  it('reads the SQLSTATE from the error, or from its cause', () => {
    expect(sqlState(err({ code: PG_ERROR.UNIQUE_VIOLATION }))).toBe('23505');
    // PGlite nests the code one level down on some paths.
    expect(sqlState(err({ cause: { code: '40001' } }))).toBe('40001');
    expect(sqlState(new Error('no code'))).toBeUndefined();
    expect(asDriverError('a string')).toBeNull();
    expect(asDriverError(null)).toBeNull();
  });

  it('matches a violation by constraint name, and by message when the driver omits it', () => {
    expect(isUniqueViolation(err({ code: '23505', constraint: 'ux_offer_no' }), 'ux_offer_no')).toBe(true);
    expect(isUniqueViolation(err({ code: '23505', constraint: 'other' }), 'ux_offer_no')).toBe(false);
    expect(isUniqueViolation(
      Object.assign(new Error('duplicate key value violates unique constraint "ux_offer_no"'), { code: '23505' }),
      'ux_offer_no',
    )).toBe(true);
    // Without a name, any unique violation matches.
    expect(isUniqueViolation(err({ code: '23505' }))).toBe(true);
    expect(isUniqueViolation(err({ code: '23514' }))).toBe(false);
  });

  it('matches check violations the same way', () => {
    expect(isCheckViolation(err({ code: '23514', constraint: 'ck_offer_approver' }), 'ck_offer_approver')).toBe(true);
    expect(isCheckViolation(err({ code: '23514' }))).toBe(true);
    expect(isCheckViolation(err({ code: '23505' }), 'ck_offer_approver')).toBe(false);
  });

  it('wraps a violation in an error that is NOT a domain error', () => {
    // Reaching a constraint means an aggregate was bypassed or two transactions
    // raced — a bug, not a business outcome. It must not be catchable as one.
    const wrapped = new ConstraintViolationError(
      err({ code: '23505', constraint: 'ux_seat_one_per_application' }),
      'seat write',
    );
    expect(wrapped.code).toBe('CONSTRAINT_VIOLATION');
    expect(wrapped.constraintName).toBe('ux_seat_one_per_application');
    expect(wrapped.sqlState).toBe('23505');
    expect(wrapped.message).toContain('seat write');
    expect(wrapped).not.toBeInstanceOf(StaleAggregateError);
  });

  it('names the constraint as unnamed rather than crashing when the driver gives none', () => {
    expect(new ConstraintViolationError(new Error('bare'), 'ctx').message).toContain('(unnamed)');
  });
});
