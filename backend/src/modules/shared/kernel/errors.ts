// Application-layer errors — authorization and existence, not business rules.
// Shared kernel: every context raises these, none of them owns them.
//
// Business-rule failures are DomainErrors and come from the aggregate. Keeping
// the two families separate means the HTTP layer can map "you may not do this"
// and "that rule forbids this" to different statuses without inspecting prose.

export type ApplicationErrorCode = 'FORBIDDEN' | 'NOT_FOUND' | 'STALE_AGGREGATE';

export abstract class ApplicationError extends Error {
  abstract readonly code: ApplicationErrorCode;
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

/** The caller lacks a required permission. */
export class ForbiddenError extends ApplicationError {
  readonly code = 'FORBIDDEN' as const;
  constructor(permission: string) {
    super('You do not have permission to perform this action.', { permission });
  }
}

/**
 * The record does not exist, or is outside the caller's scope.
 *
 * Deliberately indistinguishable (ADR-0005). If out-of-scope returned 403 while
 * missing returned 404, a caller could enumerate which records exist by reading
 * the status code.
 */
export class NotFoundError extends ApplicationError {
  readonly code = 'NOT_FOUND' as const;
  constructor(entityType: string, id: number) {
    super(`${entityType} not found.`, { entityType, id });
  }
}

/** Optimistic concurrency: the aggregate moved on since the caller read it. */
export class StaleAggregateError extends ApplicationError {
  readonly code = 'STALE_AGGREGATE' as const;
  constructor(entityType: string, id: number, expected: number, actual: number) {
    super(
      `This ${entityType.toLowerCase()} was changed by someone else. Reload and try again.`,
      { entityType, id, expectedVersion: expected, actualVersion: actual },
    );
  }
}
