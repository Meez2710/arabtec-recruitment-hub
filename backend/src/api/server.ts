// The API application factory.
//
// Returns an Express app; it does NOT listen. That separation is what lets the
// integration tests drive the real app in-process without a port, and lets the
// same app be mounted under the legacy server or run standalone.
//
// MIDDLEWARE ORDER IS LOAD-BEARING and reads top to bottom:
//
//   1. request context   — so every later layer, including the error handler,
//                          has a correlation id to attach
//   2. body parsing      — with a size limit; an unbounded JSON body is a
//                          denial-of-service with no exploit required
//   3. health            — BEFORE auth. A liveness probe that needs a valid
//                          token is a liveness probe that reports "down" the
//                          moment auth breaks, which is exactly when you need
//                          it to still answer
//   4. authenticate      — everything below this line has an AuthContext
//   5. routers
//   6. 404               — after all routers, or it would swallow them
//   7. error handler     — last; Express identifies it by arity

import express from 'express';
import type { Express, Router } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { requestContextMiddleware } from './http/request-context.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { authenticate } from './auth/authenticate.js';
import type { TokenVerifier } from './auth/authenticate.js';
import type { PrincipalResolver } from './auth/principal.js';
import { requisitionRoutes } from './controllers/requisitions.controller.js';
import { applicationRoutes } from './controllers/applications.controller.js';
import { interviewRoutes } from './controllers/interviews.controller.js';
import { offerRoutes } from './controllers/offers.controller.js';
import { readRoutes } from './controllers/read.controller.js';
import { candidateRoutes } from './controllers/candidates.controller.js';
import { talentReadRoutes } from './controllers/talent-read.controller.js';
import { cvIntakeRoutes } from './controllers/cv-intake.controller.js';
import { matchingRoutes } from './controllers/matching.controller.js';
import { searchRoutes } from './controllers/search.controller.js';
import { healthRoutes } from './controllers/health.controller.js';
import { databaseReachable } from '../infrastructure/db/health.js';
import { outboxHealth } from './workers/outbox-worker.js';
import { openApiRoutes } from './openapi.js';
import type { Application as Composed } from './composition-root.js';

export interface ApiServerOptions {
  readonly app: Composed;
  readonly verifier: TokenVerifier;
  readonly principals: PrincipalResolver;
  /** Allowed browser origins. Omit to disable CORS entirely. */
  readonly corsOrigins?: readonly string[];
  readonly bodyLimit?: string;
  readonly exposeStack?: boolean;
  readonly onDefect?: (error: unknown, info: { requestId: string; path: string }) => void;
  /** Reports readiness. Injected so the server does not own health policy. */
  readonly readiness?: () => Promise<{ ok: boolean; details: Record<string, unknown> }>;
}

export const API_PREFIX = '/api/v1';

export const createApiApp = (opts: ApiServerOptions): Express => {
  const app = express();

  // Express's own header, which advertises the framework to anyone scanning.
  app.disable('x-powered-by');
  // Trust the first proxy hop so `req.ip` is the client, not the load balancer.
  app.set('trust proxy', 1);

  app.use(requestContextMiddleware);
  app.use(express.json({ limit: opts.bodyLimit ?? '25mb' }));
  app.use(cookieParser());

  if (opts.corsOrigins !== undefined) {
    app.use(cors({
      origin: [...opts.corsOrigins],
      // The live UI authenticates by cookie, so credentials must be allowed —
      // which is exactly why the origin list is explicit and never `*`.
      credentials: true,
    }));
  }

  // Unauthenticated on purpose. See the note above.
  app.use('/health', healthRoutes({
    databaseReachable: async () => databaseReachable(opts.app.db),
    backlog: async () => outboxHealth(opts.app.db),
    subscribers: () => opts.app.registry.names,
    aiBacklog: async () => (opts.app.aiWorker === null ? null : opts.app.aiWorker.backlog()),
  }, opts.readiness));
  app.use(`${API_PREFIX}/docs`, openApiRoutes());

  const api: Router = express.Router();
  api.use(authenticate({ verifier: opts.verifier, principals: opts.principals }));
  // Reads first. GET-only, so it cannot shadow a command route.
  api.use(readRoutes(opts.app.read));
  api.use('/requisitions', requisitionRoutes(opts.app.requisitions));
  api.use('/applications', applicationRoutes(opts.app.pipeline, opts.app.hiring));
  api.use('/interviews', interviewRoutes(opts.app.interviews));
  api.use('/offers', offerRoutes(opts.app.offers));
  api.use('/candidates', candidateRoutes(opts.app.candidates, opts.app.proposals));
  // AFTER the command router: its literal paths (/duplicates, /proposals/:id)
  // must match before `/:id` here can swallow them.
  api.use('/candidates', talentReadRoutes(opts.app.talentRead));
  api.use('/cv-intake', cvIntakeRoutes(opts.app.intake, opts.app.talentRead));
  api.use(matchingRoutes(opts.app.matching, opts.app.matchingRead));
  api.use(searchRoutes(opts.app.search));
  app.use(API_PREFIX, api);

  app.use(notFoundHandler);
  app.use(errorHandler({
    ...(opts.onDefect ? { onDefect: opts.onDefect } : {}),
    ...(opts.exposeStack ? { exposeStack: opts.exposeStack } : {}),
  }));

  return app;
};
