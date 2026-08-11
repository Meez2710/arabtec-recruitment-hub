// Error → HTTP mapping.
//
// The whole point of the error taxonomy built in Phase 1 is that this file needs
// no prose parsing and no instanceof-chain per rule. Three families, three
// rules:
//
//   ApplicationError        -> its `code` maps to a status  (403 / 404 / 409)
//   DomainError             -> 422. A business rule refused. The request was
//                              well-formed and the caller was allowed; the
//                              domain simply says no.
//   ConstraintViolationError-> 500. A database constraint fired, which means an
//                              aggregate was bypassed or two writers raced past
//                              a lock. That is a BUG, not a business outcome,
//                              and it must page someone rather than read as a
//                              normal rejection.
//
// 422 vs 400 matters: 400 means "fix your request", 422 means "your request was
// fine, the answer is no". A UI shows those differently.

import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { ApplicationError } from '../../modules/shared/kernel/errors.js';
import { DomainError } from '../../modules/hiring/index.js';
import { InterviewDomainError } from '../../modules/interview/index.js';
import { OfferDomainError } from '../../modules/offer/index.js';
import { TalentDomainError } from '../../modules/talent/index.js';
import { MatchingDomainError } from '../../modules/matching/index.js';
import { ConstraintViolationError } from '../../infrastructure/db/errors.js';
import { currentContext } from './request-context.js';

export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
    readonly requestId?: string;
    readonly correlationId?: string;
  };
}

/** Raised by the HTTP layer itself. Never by a service. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>): HttpError =>
  new HttpError(400, 'BAD_REQUEST', message, details);

export const unauthorized = (message = 'Authentication required.'): HttpError =>
  new HttpError(401, 'UNAUTHENTICATED', message);

const APPLICATION_STATUS: Record<string, number> = {
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  // 409, not 400: the request was valid, the resource moved underneath it.
  STALE_AGGREGATE: 409,
};

interface Mapped {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details: Record<string, unknown>;
  /** True when the cause is a defect rather than an expected outcome. */
  readonly isDefect: boolean;
}

export const mapError = (error: unknown): Mapped => {
  if (error instanceof ZodError) {
    return {
      status: 400,
      code: 'VALIDATION_FAILED',
      message: 'The request body or parameters are invalid.',
      details: { issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      isDefect: false,
    };
  }

  if (error instanceof HttpError) {
    return {
      status: error.status, code: error.code, message: error.message,
      details: error.details, isDefect: error.status >= 500,
    };
  }

  if (error instanceof ApplicationError) {
    return {
      status: APPLICATION_STATUS[error.code] ?? 400,
      code: error.code,
      message: error.message,
      details: error.details,
      isDefect: false,
    };
  }

  if (error instanceof ConstraintViolationError) {
    // Check this BEFORE DomainError — it is neither, and mapping it to 422
    // would disguise a correctness bug as a business rejection.
    return {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'An internal error occurred.',
      details: {},
      isDefect: true,
    };
  }

  // One base class per context — a Phase-1 design decision, and a frozen one.
  // They are structurally identical (`code` + `details`) and map identically;
  // there is simply no shared supertype to test against, so a new context means
  // a new line here. `domain-errors.test.ts` fails if one is ever forgotten.
  if (
    error instanceof DomainError
    || error instanceof InterviewDomainError
    || error instanceof OfferDomainError
    || error instanceof TalentDomainError
    || error instanceof MatchingDomainError
  ) {
    return {
      status: 422,
      code: error.code,
      // Domain messages are written for humans and are safe to surface — that
      // is why they exist. "This requisition has no open seat." beats a 422
      // with no explanation.
      message: error.message,
      details: error.details,
      isDefect: false,
    };
  }

  return {
    status: 500,
    code: 'INTERNAL_ERROR',
    message: 'An internal error occurred.',
    details: {},
    isDefect: true,
  };
};

export interface ErrorHandlerOptions {
  /** Injected so this file depends on no logger. */
  readonly onDefect?: (error: unknown, info: { requestId: string; path: string }) => void;
  /** Include the stack in the response. NEVER in production. */
  readonly exposeStack?: boolean;
}

export const errorHandler = (opts: ErrorHandlerOptions = {}) =>
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (error: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const mapped = mapError(error);
    const context = currentContext();

    if (mapped.isDefect) {
      opts.onDefect?.(error, {
        requestId: context?.requestId ?? '-',
        path: `${req.method} ${req.path}`,
      });
    }

    const body: ErrorBody = {
      error: {
        code: mapped.code,
        message: mapped.message,
        // A 500 carries NO details. Constraint names, SQL fragments and stack
        // frames are reconnaissance; they belong in the log, not the response.
        ...(mapped.isDefect ? {} : { details: mapped.details }),
        ...(context ? { requestId: context.requestId, correlationId: context.correlationId } : {}),
        ...(opts.exposeStack && error instanceof Error ? { details: { stack: error.stack } } : {}),
      },
    };

    res.status(mapped.status).json(body);
  };

/** 404 for an unmatched route. Registered after every router. */
export const notFoundHandler = (req: Request, res: Response): void => {
  const context = currentContext();
  res.status(404).json({
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `No route for ${req.method} ${req.path}.`,
      ...(context ? { requestId: context.requestId, correlationId: context.correlationId } : {}),
    },
  });
};
