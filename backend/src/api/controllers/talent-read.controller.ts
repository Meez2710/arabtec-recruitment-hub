// Talent read endpoints (GET).
//
// Mounted at /candidates AFTER the command router, so the literal paths that
// router owns (`/candidates/duplicates`, `/candidates/proposals/:id`) match
// first and are never swallowed by `/candidates/:id`.

import type { Router } from 'express';
import { Router as createRouter } from 'express';
import { z } from 'zod';
import { CANDIDATE_STATES, TALENT_PERMISSIONS } from '../../modules/talent/index.js';
import { requirePermission } from '../auth/authenticate.js';
import { idParam, isoDate, route } from '../http/validate.js';
import type { PageRequest } from '../queries/ports.js';
import type { TalentReadModel } from '../queries/talent-ports.js';

const paging = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.string().max(40).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
};

const pageOf = (q: {
  limit: number; offset: number; sort?: string; direction?: 'asc' | 'desc';
}): PageRequest => ({
  limit: q.limit,
  offset: q.offset,
  ...(q.sort !== undefined ? { sort: q.sort } : {}),
  ...(q.direction !== undefined ? { direction: q.direction } : {}),
});

/** `?skills=a&skills=b` or `?skills=a,b`. */
const csv = z.union([z.string(), z.array(z.string())]).optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    const parts = (Array.isArray(v) ? v : [v]).flatMap((s) => s.split(','))
      .map((s) => s.trim()).filter(Boolean);
    return parts.length === 0 ? undefined : parts;
  });

const listQuery = z.object({
  ...paging,
  q: z.string().trim().max(200).optional(),
  state: csv,
  ownerRecruiterId: z.coerce.number().int().positive().optional(),
  source: z.string().trim().max(100).optional(),
  skills: csv,
  tags: csv,
  minYearsExperience: z.coerce.number().min(0).max(70).optional(),
  maxYearsExperience: z.coerce.number().min(0).max(70).optional(),
  hasCv: z.coerce.boolean().optional(),
  hasPendingProposal: z.coerce.boolean().optional(),
  createdFrom: isoDate.optional(),
  createdTo: isoDate.optional(),
});

const defined = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const notFound = (id: number): unknown => ({
  error: {
    code: 'NOT_FOUND', message: 'Candidate not found.',
    details: { entityType: 'Candidate', id },
  },
});

export const talentReadRoutes = (read: TalentReadModel): Router => {
  const router = createRouter();
  const P = TALENT_PERMISSIONS;
  const viewer = requirePermission(P.VIEW_ALL, P.VIEW_OWN);

  router.get('/', viewer, route(
    { query: listQuery },
    async ({ query, auth }, res) => {
      // VIEW_OWN without VIEW_ALL pins the caller to candidates they own, and an
      // explicit ownerRecruiterId cannot widen that.
      const pinned = auth.has(P.VIEW_ALL) ? query.ownerRecruiterId : auth.userId;
      const validStates = query.state?.filter(
        (s) => (CANDIDATE_STATES as readonly string[]).includes(s),
      );
      res.json(await read.candidates(defined({
        q: query.q,
        state: validStates !== undefined && validStates.length > 0 ? validStates : undefined,
        ownerRecruiterId: pinned,
        source: query.source,
        skills: query.skills,
        tags: query.tags,
        minYearsExperience: query.minYearsExperience,
        maxYearsExperience: query.maxYearsExperience,
        hasCv: query.hasCv,
        hasPendingProposal: query.hasPendingProposal,
        createdFrom: query.createdFrom,
        createdTo: query.createdTo,
      }), pageOf(query), auth));
    },
  ));

  router.get('/:id', viewer, route(
    { params: idParam },
    async ({ params, auth }, res) => {
      const found = await read.candidate(params.id, auth);
      if (found === null) { res.status(404).json(notFound(params.id)); return; }
      res.json(found);
    },
  ));

  router.get('/:id/proposals', viewer, route(
    { params: idParam, query: z.object(paging) },
    async ({ params, query, auth }, res) => {
      res.json(await read.proposals(params.id, pageOf(query), auth));
    },
  ));

  router.get('/:id/duplicates', viewer, route(
    { params: idParam },
    async ({ params, auth }, res) => {
      res.json({ possibleDuplicates: await read.duplicates(params.id, auth) });
    },
  ));

  router.get('/:id/activity', viewer, route(
    { params: idParam },
    async ({ params, auth }, res) => {
      const found = await read.activity(params.id, auth);
      if (found === null) { res.status(404).json(notFound(params.id)); return; }
      res.json(found);
    },
  ));

  return router;
};
