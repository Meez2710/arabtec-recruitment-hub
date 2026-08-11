// Per-request ambient context — correlation and request ids.
//
// AsyncLocalStorage rather than a parameter threaded through every call: the
// outbox writer needs the correlation id, and it sits four layers below the
// controller behind interfaces that must not learn about HTTP.
//
// This is the ONLY ambient state in the system. Nothing else may go here —
// AuthContext in particular is passed explicitly, because "who is asking" is a
// domain input, not an environment detail.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export interface RequestContext {
  /** Unique to this HTTP request. */
  readonly requestId: string;
  /**
   * Shared by everything the request causes, including work that outlives it.
   * Taken from the inbound header when present so a trace spans services.
   */
  readonly correlationId: string;
  readonly startedAt: number;
  readonly method: string;
  readonly path: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const currentContext = (): RequestContext | undefined => storage.getStore();

export const currentCorrelationId = (): string | null =>
  storage.getStore()?.correlationId ?? null;

const CORRELATION_HEADER = 'x-correlation-id';
const REQUEST_HEADER = 'x-request-id';

/** Reject header values that could forge a log line or a header. */
const clean = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  return /^[\w.:-]+$/.test(trimmed) ? trimmed : null;
};

export const requestContextMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const context: RequestContext = {
    requestId: clean(req.header(REQUEST_HEADER)) ?? randomUUID(),
    correlationId: clean(req.header(CORRELATION_HEADER)) ?? randomUUID(),
    startedAt: Date.now(),
    method: req.method,
    path: req.path,
  };

  // Echo both so a client can correlate its own logs with ours.
  res.setHeader(REQUEST_HEADER, context.requestId);
  res.setHeader(CORRELATION_HEADER, context.correlationId);

  storage.run(context, () => { next(); });
};

/** For workers and tests: run a block under a synthetic context. */
export const withContext = <T>(context: Partial<RequestContext>, fn: () => T): T =>
  storage.run(
    {
      requestId: context.requestId ?? randomUUID(),
      correlationId: context.correlationId ?? randomUUID(),
      startedAt: context.startedAt ?? Date.now(),
      method: context.method ?? 'WORKER',
      path: context.path ?? '-',
    },
    fn,
  );
