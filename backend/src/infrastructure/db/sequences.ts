// Sequence reads — surrogate ids and business numbers.
//
// Every one of these is a single `nextval()`. That is the whole point.
//
// The legacy implementation read a counter from a `system_setting` row, added
// one in JavaScript, and wrote it back: three statements, no lock, no
// transaction. It survived only because the old SQLite data layer accidentally
// serialised every query. The moment two requests overlapped it produced
// DUPLICATE OFFER NUMBERS on documents sent to candidates (Audit #1 F-09).
//
// A sequence cannot collide. It is also deliberately non-transactional: a
// rolled-back transaction still consumes its number. A gap in ticket numbers is
// harmless; a duplicate on a legal document is not.

import { sql } from 'drizzle-orm';
import type { Executor } from './types.js';

/**
 * Read the next value of a named sequence.
 *
 * The name is interpolated, not bound, because `nextval()` takes a regclass
 * literal. Every call site passes a compile-time constant from `SEQUENCES` /
 * `ID_SEQUENCES`, so no caller-controlled string reaches this — the guard below
 * makes that a runtime guarantee rather than a convention.
 */
export const nextval = async (db: Executor, sequenceName: string): Promise<number> => {
  if (!/^[a-z][a-z0-9_]*$/.test(sequenceName)) {
    throw new Error(`Refusing to interpolate an unexpected sequence name: ${sequenceName}`);
  }
  const result: unknown = await db.execute(
    sql.raw(`SELECT nextval('${sequenceName}') AS value`),
  );
  const row = readFirst<{ value: string | number }>(result);
  if (row === undefined || row === null) {
    throw new Error(`Sequence ${sequenceName} returned no value`);
  }
  // bigint arrives as a string from node-postgres; sequences here stay far
  // inside Number.MAX_SAFE_INTEGER, so this is exact.
  return Number(row.value);
};

/**
 * Drivers disagree on the shape of `execute()`: node-postgres returns a
 * `QueryResult` with `.rows`, PGlite returns an array-like. Normalise once.
 */
const readFirst = <T>(result: unknown): T | undefined => {
  if (Array.isArray(result)) return result[0] as T | undefined;
  if (typeof result === 'object' && result !== null && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) return rows[0] as T | undefined;
  }
  return undefined;
};

/**
 * Business-number formats, preserved EXACTLY as the live system emits them.
 *
 * These are not new conventions — they are transcribed from `models.js`
 * (`Requests.nextTicketNo`, `Applications.nextNo`, `Interviews.nextNo`,
 * `Offers.nextNo`). Existing records carry these shapes and are printed on
 * documents, quoted in emails and searched by HR, so changing them would be a
 * business change, not a refactor.
 *
 * The prefix stays configurable because it already was: the legacy code read
 * `ticket_prefix` / `application_prefix` / `interview_prefix` / `offer_prefix`
 * from `system_setting`, with these values as defaults.
 */
export const NUMBER_PREFIXES = {
  requisition: 'REQ',
  application: 'APP',
  interview: 'INT',
  offer: 'OFR',
} as const;

/** `REQ-2026-00001` — prefix, calendar year, zero-padded counter. */
export const formatYearlyNumber = (prefix: string, year: number, counter: number): string =>
  `${prefix}-${year}-${String(counter).padStart(5, '0')}`;

/** `APP-00001` — prefix and zero-padded counter, no year. */
export const formatFlatNumber = (prefix: string, counter: number): string =>
  `${prefix}-${String(counter).padStart(5, '0')}`;
