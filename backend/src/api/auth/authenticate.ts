// Authentication and authorization middleware.
//
// AUTHENTICATION answers "who is this" and happens once, here.
// AUTHORIZATION answers "may they do this" and happens TWICE, on purpose:
//
//   * `requirePermission` on the route — a cheap, early, declarative gate that
//     keeps an unauthorised request from reaching a service at all, and makes
//     the permission visible in the route table and in OpenAPI.
//
//   * the service itself — the real check. Services already call
//     `ctx.has(PERMISSION)` and throw ForbiddenError, and they must keep doing
//     so, because a service is also reachable from a worker, a job and a test.
//
// The route gate is an optimisation and a piece of documentation. It is never
// the only thing standing between a caller and an operation. Deleting every
// `requirePermission` in this codebase would change no security outcome — and
// there is a test that asserts exactly that for the hire endpoint.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { ForbiddenError } from '../../modules/shared/kernel/errors.js';
import { HttpError, unauthorized } from '../http/errors.js';
import type { AuthedRequest } from '../http/validate.js';
import { toAuthContext } from './principal.js';
import type { PrincipalResolver } from './principal.js';

export interface TokenVerifier {
  /** Returns the user id, or null when the token is absent/invalid/expired. */
  verify(token: string): number | null;
}

/**
 * Verifies the tokens the live system already issues: `{ sub, jti }`, HS256.
 *
 * Same secret resolution as the legacy layer, including its fail-closed rule —
 * a guessable default in production is how a whole system gets impersonated.
 */
export class JwtTokenVerifier implements TokenVerifier {
  private readonly secret: string;

  constructor(secret?: string) {
    const resolved = secret ?? process.env['JWT_SECRET'];
    if (resolved === undefined || resolved === '') {
      if (process.env['NODE_ENV'] === 'production') {
        throw new Error('JWT_SECRET is required in production');
      }
      this.secret = 'dev-secret-local-only';
    } else {
      this.secret = resolved;
    }
  }

  verify(token: string): number | null {
    try {
      const payload = jwt.verify(token, this.secret);
      if (typeof payload !== 'object' || payload === null) return null;
      const sub = (payload as { sub?: unknown }).sub;
      const id = typeof sub === 'string' ? Number(sub) : sub;
      return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
    } catch {
      // Expired, malformed, wrong signature — all the same answer to the
      // caller. Distinguishing them tells an attacker which half to work on.
      return null;
    }
  }
}

const bearerToken = (req: Request): string | null => {
  const header = req.header('authorization');
  if (header !== undefined && header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token.length > 0) return token;
  }
  // The live UI authenticates by cookie; accept both so one API serves both.
  const cookies = (req as Request & { cookies?: Record<string, unknown> }).cookies;
  const fromCookie = cookies?.['token'];
  return typeof fromCookie === 'string' && fromCookie.length > 0 ? fromCookie : null;
};

export interface AuthenticateOptions {
  readonly verifier: TokenVerifier;
  readonly principals: PrincipalResolver;
}

export const authenticate = (opts: AuthenticateOptions): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    void (async (): Promise<void> => {
      const token = bearerToken(req);
      if (token === null) throw unauthorized();

      const userId = opts.verifier.verify(token);
      if (userId === null) throw unauthorized('Your session is invalid or has expired.');

      const principal = await opts.principals.resolve(userId);
      // A token for a deleted or deactivated user is not an authorization
      // problem, it is an authentication one: that identity no longer exists.
      if (principal === null) throw unauthorized('Your session is no longer valid.');
      if (principal.status !== 'active') {
        throw new HttpError(403, 'ACCOUNT_INACTIVE', 'This account is not active.');
      }
      if (principal.mustChangePassword) {
        throw new HttpError(
          403, 'PASSWORD_CHANGE_REQUIRED',
          'You must change your password before continuing.',
        );
      }

      (req as AuthedRequest).auth = toAuthContext(principal);
      next();
    })().catch(next);
  };

/**
 * Declarative route gate. Defence in depth, not the enforcement point.
 *
 * Throws the SAME `ForbiddenError` a service throws, so the client sees one
 * shape whichever layer refused.
 */
export const requirePermission = (...permissions: readonly string[]): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    const auth = (req as AuthedRequest).auth;
    if (auth === undefined) { next(unauthorized()); return; }
    if (!permissions.some((p) => auth.has(p))) {
      next(new ForbiddenError(permissions[0] ?? 'unknown'));
      return;
    }
    next();
  };
