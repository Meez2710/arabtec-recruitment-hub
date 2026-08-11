export type MatchingErrorCode = 'MATCH_ALREADY_RESOLVED';

export abstract class MatchingDomainError extends Error {
  abstract readonly code: MatchingErrorCode;
  readonly details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

/** A dismissed or linked suggestion is settled; re-deciding it would rewrite history. */
export class MatchAlreadyResolvedError extends MatchingDomainError {
  readonly code = 'MATCH_ALREADY_RESOLVED' as const;
  constructor(status: string) {
    super(`This suggestion has already been ${status.toLowerCase()}.`, { status });
  }
}
