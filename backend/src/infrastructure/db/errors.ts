// PostgreSQL error translation.
//
// A driver error is an infrastructure detail. The application layer only ever
// sees kernel errors, so the boundary where a SQLSTATE becomes a domain-shaped
// failure is HERE — never in a service, and never leaked to a caller.
//
// Two categories matter:
//
//   1. CONSTRAINT violations. The database is the last line of defence beneath a
//      domain invariant. If one fires, the aggregate has already been bypassed
//      or two transactions raced. Either way the operation must fail loudly.
//
//   2. TRANSIENT failures — deadlock and serialization. These are not bugs; they
//      are the normal cost of concurrency, and the correct response is to retry
//      the whole transaction from the top (see unit-of-work.ts).

/** SQLSTATE codes this layer reacts to by name rather than by string literal. */
export const PG_ERROR = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  LOCK_NOT_AVAILABLE: '55P03',
} as const;

/** The subset of a `pg` error we read. Drivers differ in what else they attach. */
export interface DriverError {
  readonly code?: string;
  readonly constraint?: string;
  readonly detail?: string;
  readonly message?: string;
}

export const asDriverError = (err: unknown): DriverError | null => {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as Record<string, unknown>;
  // PGlite nests the SQLSTATE one level down on some paths; check both.
  const cause = typeof e['cause'] === 'object' && e['cause'] !== null
    ? (e['cause'] as Record<string, unknown>)
    : null;
  const code = typeof e['code'] === 'string'
    ? e['code']
    : typeof cause?.['code'] === 'string' ? (cause['code'] as string) : undefined;
  if (code === undefined) return null;
  return {
    code,
    constraint: typeof e['constraint'] === 'string' ? e['constraint'] : undefined,
    detail: typeof e['detail'] === 'string' ? e['detail'] : undefined,
    message: typeof e['message'] === 'string' ? e['message'] : undefined,
  };
};

export const sqlState = (err: unknown): string | undefined => asDriverError(err)?.code;

/**
 * Whether re-running the whole transaction could succeed.
 *
 * Only deadlock and serialization qualify. A unique violation is NOT retryable —
 * retrying it just fails again more expensively, and the caller needs to see it.
 */
export const isRetryable = (err: unknown): boolean => {
  const code = sqlState(err);
  return code === PG_ERROR.DEADLOCK_DETECTED || code === PG_ERROR.SERIALIZATION_FAILURE;
};

/** Whether this is a unique-index collision on the named index. */
export const isUniqueViolation = (err: unknown, constraint?: string): boolean => {
  const e = asDriverError(err);
  if (e?.code !== PG_ERROR.UNIQUE_VIOLATION) return false;
  if (constraint === undefined) return true;
  // PGlite and pg both populate `constraint`; fall back to the message for
  // drivers that do not, rather than silently reporting "not a match".
  return e.constraint === constraint || (e.message?.includes(constraint) ?? false);
};

export const isCheckViolation = (err: unknown, constraint?: string): boolean => {
  const e = asDriverError(err);
  if (e?.code !== PG_ERROR.CHECK_VIOLATION) return false;
  if (constraint === undefined) return true;
  return e.constraint === constraint || (e.message?.includes(constraint) ?? false);
};

/**
 * Raised when a database constraint fires.
 *
 * This is deliberately NOT a domain error. Reaching it means an invariant was
 * enforced by storage instead of by an aggregate — a bug or a lost race, not a
 * business outcome — so it must not be catchable as one and must not be shown
 * to a user as a business message.
 */
export class ConstraintViolationError extends Error {
  readonly code = 'CONSTRAINT_VIOLATION' as const;
  readonly constraintName: string | undefined;
  readonly sqlState: string | undefined;

  constructor(err: unknown, context: string) {
    const e = asDriverError(err);
    super(
      `Database constraint ${e?.constraint ?? '(unnamed)'} violated during ${context}. ` +
      'A domain invariant was bypassed or two transactions raced.',
    );
    this.name = 'ConstraintViolationError';
    this.constraintName = e?.constraint;
    this.sqlState = e?.code;
    this.cause = err;
  }
}
