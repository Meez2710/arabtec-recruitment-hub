// Candidate matching endpoints.
//
// Suggestions are advisory: `/matches` reads them, `/dismiss` records a human
// saying no, `/link` records a human saying yes and delegates the actual
// pipeline entry to the Hiring context.

import type { Router } from 'express';
import { Router as createRouter } from 'express';
import { z } from 'zod';
import type { MatchingService } from '../../modules/matching/index.js';
import { MATCHING_PERMISSIONS } from '../../modules/matching/index.js';
import type { PageRequest } from '../queries/ports.js';
import type { MatchingReadModel } from '../queries/matching-ports.js';
import { requirePermission } from '../auth/authenticate.js';
import { expectedVersion, idParam, nonEmpty, route } from '../http/validate.js';

const listQuery = z.object({
  status: z.union([z.string(), z.array(z.string())]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  minScore: z.coerce.number().min(0).max(1).optional(),
});

export const matchingRoutes = (
  matching: MatchingService,
  read: MatchingReadModel,
): Router => {
  const router = createRouter();
  const P = MATCHING_PERMISSIONS;

  router.post('/requisitions/:id/matches/refresh', requirePermission(P.REQUEST), route(
    { params: idParam, body: z.object({
      limit: z.coerce.number().int().min(1).max(200).optional(),
      refreshToken: z.string().max(80).optional(),
    }) },
    async ({ params, body, auth }, res) => {
      // 202: the work is queued, not done. Returning 200 would imply results
      // are ready, which they are not — inference takes seconds.
      res.status(202).json(await matching.requestMatching({
        requisitionId: params.id,
        ...(body.limit !== undefined ? { limit: body.limit } : {}),
        ...(body.refreshToken !== undefined ? { refreshToken: body.refreshToken } : {}),
      }, auth));
    },
  ));

  /**
   * Suggestions for a requisition, best first, joined to the candidate.
   *
   * ONE query: a list of matches without names is unusable, and fetching each
   * candidate separately is the N+1 this whole read layer avoids.
   */
  router.get('/requisitions/:id/matches', requirePermission(P.VIEW), route(
    { params: idParam, query: listQuery },
    async ({ params, query, auth }, res) => {
      const statuses = query.status === undefined
        ? undefined
        : (Array.isArray(query.status) ? query.status : [query.status])
          .flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);

      const page: PageRequest = { limit: query.limit, offset: query.offset };
      res.json(await read.matchesFor(params.id, {
        ...(statuses !== undefined && statuses.length > 0 ? { status: statuses } : {}),
        ...(query.minScore !== undefined ? { minScore: query.minScore } : {}),
      }, page, auth));
    },
  ));

  router.post('/matches/:id/dismiss', requirePermission(P.RESOLVE), route(
    { params: idParam, body: z.object({ reason: nonEmpty(500), expectedVersion }) },
    async ({ params, body, auth }, res) => {
      res.json(await matching.dismiss(params.id, body.reason, auth, body.expectedVersion));
    },
  ));

  router.post('/matches/:id/link', requirePermission(P.RESOLVE), route(
    { params: idParam, body: z.object({ expectedVersion }) },
    async ({ params, body, auth }, res) => {
      // The application is created by Hiring, under Hiring's rules — this
      // caller still needs `candidate.link` for that to succeed.
      res.status(201).json(await matching.link(params.id, auth, body.expectedVersion));
    },
  ));

  return router;
};
