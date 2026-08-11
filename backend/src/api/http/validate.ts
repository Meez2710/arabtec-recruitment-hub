// Request validation and the typed handler wrapper.
//
// Validation here is about SHAPE only — is this a number, is this string
// non-empty, is this one of the enum's values. It is never about business
// rules. "A requisition needs at least one seat" is `ck_requisition_headcount`
// and an aggregate invariant; if it also lived here it would be a third copy
// that drifts.
//
// The test for whether a check belongs in this file: could the answer ever
// depend on stored data? If yes, it is a domain rule and it stays in the
// aggregate.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import type { AuthContext } from '../../modules/shared/kernel/auth-context.js';
import { unauthorized } from './errors.js';

/** Set by `authenticate`. Read by every controller. */
export interface AuthedRequest extends Request {
  auth?: AuthContext;
}

export const requireAuth = (req: Request): AuthContext => {
  const auth = (req as AuthedRequest).auth;
  if (auth === undefined) throw unauthorized();
  return auth;
};

/**
 * Wrap an async handler so a rejected promise reaches the error middleware.
 *
 * Express 4 does not await handlers: an async handler that throws produces an
 * unhandled rejection and a request that hangs until the client times out.
 */
export const handler = (
  fn: (req: Request, res: Response) => Promise<void>,
): RequestHandler =>
  (req, res, next) => { fn(req, res).catch(next); };

export interface ParsedRequest<B, P, Q> {
  readonly body: B;
  readonly params: P;
  readonly query: Q;
  readonly auth: AuthContext;
}

export interface RouteSchemas<B, P, Q> {
  readonly body?: z.ZodType<B>;
  readonly params?: z.ZodType<P>;
  readonly query?: z.ZodType<Q>;
}

/**
 * Parse and hand the controller a fully typed request.
 *
 * Parsing REPLACES the raw values rather than merging: an unvalidated field can
 * never reach a service by accident, because it is not on the object the
 * controller receives.
 */
export const route = <B = unknown, P = unknown, Q = unknown>(
  schemas: RouteSchemas<B, P, Q>,
  fn: (input: ParsedRequest<B, P, Q>, res: Response) => Promise<void>,
): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    void (async (): Promise<void> => {
      const auth = requireAuth(req);
      const parsed: ParsedRequest<B, P, Q> = {
        body: (schemas.body ? schemas.body.parse(req.body) : undefined) as B,
        params: (schemas.params ? schemas.params.parse(req.params) : undefined) as P,
        query: (schemas.query ? schemas.query.parse(req.query) : undefined) as Q,
        auth,
      };
      await fn(parsed, res);
    })().catch(next);
  };

/* ------------------------------ shared shapes ----------------------------- */

/** Path ids arrive as strings. Coerce once, here, not in every controller. */
export const idParam = z.object({
  id: z.coerce.number().int().positive(),
});

/**
 * `If-Match`-style optimistic concurrency.
 *
 * Optional on purpose: services treat `undefined` as "no expectation" and the
 * repository's version guard still protects against a lost update. Supplying it
 * upgrades the failure from "last writer wins within this transaction" to
 * "you were looking at a stale screen".
 */
export const expectedVersion = z.coerce.number().int().min(0).optional();

export const nonEmpty = (max: number): z.ZodString => z.string().trim().min(1).max(max);

/** ISO-8601 in, `Date` out. Rejects "tomorrow" and other things `new Date()` accepts. */
export const isoDate = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

export const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
