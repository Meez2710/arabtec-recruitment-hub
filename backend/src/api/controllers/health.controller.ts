// Health endpoints.
//
// THREE of them, because they answer three different questions and conflating
// them is how a deploy takes an application down:
//
//   /health/live    Is the process alive? Never touches the database. If this
//                   needed a database, a brief database blip would make the
//                   orchestrator KILL every healthy pod at once.
//
//   /health/ready   Can it serve traffic? Checks the database. A failing
//                   readiness probe removes the instance from the load balancer
//                   without restarting it, which is the correct response to a
//                   dependency being down.
//
//   /health/outbox  Operational depth: how far behind is event delivery. Not a
//                   probe — a metric endpoint for humans and dashboards.
//
// All unauthenticated, and all deliberately terse. A health endpoint that leaks
// versions, connection strings or table counts is reconnaissance.

import type { Router } from 'express';
import { Router as createRouter } from 'express';
import { handler } from '../http/validate.js';

export type ReadinessCheck = () => Promise<{ ok: boolean; details: Record<string, unknown> }>;

/**
 * Everything the health endpoints need, as plain functions.
 *
 * Deliberately NOT the composed application: a health controller that holds the
 * whole object graph can reach anything, and the wiring point stops being the
 * composition root.
 */
export interface HealthDeps {
  readonly databaseReachable: () => Promise<boolean>;
  readonly backlog: () => Promise<{ pending: number; due: number; failing: number }>;
  readonly subscribers: () => readonly string[];
  /** Null when no AI provider is configured — a normal state, not an error. */
  readonly aiBacklog: () => Promise<{ queued: number; running: number; failed: number } | null>;
}

export const healthRoutes = (deps: HealthDeps, readiness?: ReadinessCheck): Router => {
  const router = createRouter();

  router.get('/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/ready', handler(async (_req, res) => {
    const check = readiness ?? defaultReadiness(deps);
    const result = await check();
    // 503, not 500: "not ready yet" is a normal state during startup and a
    // 500 would look like a defect to every dashboard.
    res.status(result.ok ? 200 : 503).json({
      status: result.ok ? 'ready' : 'unavailable',
      ...result.details,
    });
  }));

  router.get('/outbox', handler(async (_req, res) => {
    const backlog = await deps.backlog();
    res.json({
      ...backlog,
      subscribers: deps.subscribers(),
      // A growing `failing` count is the signal that a subscriber is broken;
      // `pending` alone is normal and transient.
      healthy: backlog.failing === 0,
    });
  }));

  router.get('/ai', handler(async (_req, res) => {
    const backlog = await deps.aiBacklog();
    // `configured: false` is a deployment fact, not a fault. The system runs
    // without AI by design.
    res.json(backlog === null
      ? { configured: false, healthy: true }
      : { configured: true, ...backlog, healthy: backlog.failed === 0 });
  }));

  return router;
};

const defaultReadiness = (deps: HealthDeps): ReadinessCheck =>
  async () => {
    const up = await deps.databaseReachable();
    // No error detail in the body either way — it would carry the connection
    // string.
    return { ok: up, details: { database: up ? 'up' : 'down' } };
  };
