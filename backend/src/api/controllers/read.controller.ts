// Read endpoints (GET).
//
// Mounted on the same paths as the command controllers; no conflict, because
// commands are POST/PATCH/PUT and reads are GET.
//
// Scope narrowing lives here and only here: a caller with VIEW_ALL sees the
// project scope their AuthContext allows, a caller with only VIEW_OWN is
// additionally pinned to their own records. That is an access decision about
// the caller, not a business rule about the data — the read model still applies
// the tenant/project predicate underneath regardless.

import type { Router } from 'express';
import { Router as createRouter } from 'express';
import { z } from 'zod';
import { ALL_STAGES, HIRING_PERMISSIONS, REQUISITION_STATES } from '../../modules/hiring/index.js';
import { INTERVIEW_STATUSES } from '../../modules/interview/index.js';
import { OFFER_STATUSES } from '../../modules/offer/index.js';
import { INTERVIEW_PERMISSIONS } from '../../modules/interview/application/interview-service.js';
import { OFFER_PERMISSIONS } from '../../modules/offer/application/offer-service.js';
import { requirePermission } from '../auth/authenticate.js';
import { idParam, isoDate, route } from '../http/validate.js';
import type { AuthContext } from '../../modules/shared/kernel/auth-context.js';
import type { PageRequest, ReadModel } from '../queries/ports.js';

/** Repeated on every list endpoint. 200 is a hard ceiling, not a suggestion. */
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

/** `?state=OPEN&state=CLOSED` or `?state=OPEN,CLOSED` — both are natural to send. */
const csvEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      const parts = (Array.isArray(v) ? v : [v]).flatMap((s) => s.split(','))
        .map((s) => s.trim()).filter(Boolean);
      return parts.filter((p): p is T[number] => (values as readonly string[]).includes(p));
    })
    .transform((v) => (v === undefined || v.length === 0 ? undefined : v));

const requisitionQuery = z.object({
  ...paging,
  state: csvEnum(REQUISITION_STATES as unknown as [string, ...string[]]),
  projectId: z.coerce.number().int().positive().optional(),
  departmentId: z.coerce.number().int().positive().optional(),
  recruiterId: z.coerce.number().int().positive().optional(),
  requesterId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(200).optional(),
  hasOpenSeats: z.coerce.boolean().optional(),
});

const applicationQuery = z.object({
  ...paging,
  requisitionId: z.coerce.number().int().positive().optional(),
  candidateId: z.coerce.number().int().positive().optional(),
  stage: csvEnum(ALL_STAGES as unknown as [string, ...string[]]),
  recruiterId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(200).optional(),
  dueBefore: isoDate.optional(),
  inactiveSince: isoDate.optional(),
  liveOnly: z.coerce.boolean().optional(),
});

const interviewQuery = z.object({
  ...paging,
  status: csvEnum(INTERVIEW_STATUSES as unknown as [string, ...string[]]),
  applicationId: z.coerce.number().int().positive().optional(),
  candidateId: z.coerce.number().int().positive().optional(),
  requisitionId: z.coerce.number().int().positive().optional(),
  panellistId: z.coerce.number().int().positive().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

const offerQuery = z.object({
  ...paging,
  status: csvEnum(OFFER_STATUSES as unknown as [string, ...string[]]),
  applicationId: z.coerce.number().int().positive().optional(),
  candidateId: z.coerce.number().int().positive().optional(),
  requisitionId: z.coerce.number().int().positive().optional(),
  preparedBy: z.coerce.number().int().positive().optional(),
  expiringBefore: isoDate.optional(),
  awaitingApproval: z.coerce.boolean().optional(),
});

const timelineQuery = z.object({
  ...paging,
  entityType: z.enum(['Requisition', 'Application', 'Interview', 'Offer']).optional(),
  entityId: z.coerce.number().int().positive().optional(),
  actorId: z.coerce.number().int().positive().optional(),
  eventType: csvEnum(['x'] as unknown as [string, ...string[]]).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

/** Strip undefined so exactOptionalPropertyTypes stays satisfied. */
const defined = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export const readRoutes = (read: ReadModel, now: () => Date = () => new Date()): Router => {
  const router = createRouter();
  const P = HIRING_PERMISSIONS;

  /**
   * VIEW_OWN without VIEW_ALL pins the caller to their own records.
   *
   * An explicit `recruiterId` filter cannot widen that: the narrowed value wins,
   * so `?recruiterId=99` from a VIEW_OWN user returns their own rows, not user
   * 99's. Filters must never be able to escalate.
   */
  const ownOnly = (ctx: AuthContext): number | undefined =>
    ctx.has(P.VIEW_ALL) ? undefined : ctx.userId;

  router.get('/requisitions', requirePermission(P.VIEW_ALL, P.VIEW_OWN), route(
    { query: requisitionQuery },
    async ({ query, auth }, res) => {
      const pinned = ownOnly(auth);
      res.json(await read.requisitions(defined({
        state: query.state,
        projectId: query.projectId,
        departmentId: query.departmentId,
        recruiterId: pinned ?? query.recruiterId,
        requesterId: query.requesterId,
        q: query.q,
        hasOpenSeats: query.hasOpenSeats,
      }), pageOf(query), auth));
    },
  ));

  router.get('/requisitions/:id', requirePermission(P.VIEW_ALL, P.VIEW_OWN), route(
    { params: idParam },
    async ({ params, auth }, res) => {
      const found = await read.requisition(params.id, auth);
      // 404 for out-of-scope as well as missing — the read side must not become
      // the one place existence leaks (ADR-0005).
      if (found === null) { res.status(404).json(notFound('Requisition', params.id)); return; }
      res.json(found);
    },
  ));

  router.get('/applications', requirePermission(P.VIEW_ALL, P.VIEW_OWN), route(
    { query: applicationQuery },
    async ({ query, auth }, res) => {
      const pinned = ownOnly(auth);
      res.json(await read.applications(defined({
        requisitionId: query.requisitionId,
        candidateId: query.candidateId,
        stage: query.stage,
        recruiterId: pinned ?? query.recruiterId,
        q: query.q,
        dueBefore: query.dueBefore,
        inactiveSince: query.inactiveSince,
        liveOnly: query.liveOnly,
      }), pageOf(query), auth));
    },
  ));

  router.get('/applications/:id', requirePermission(P.VIEW_ALL, P.VIEW_OWN), route(
    { params: idParam },
    async ({ params, auth }, res) => {
      const found = await read.application(params.id, auth);
      if (found === null) { res.status(404).json(notFound('Application', params.id)); return; }
      res.json(found);
    },
  ));

  const IV = INTERVIEW_PERMISSIONS;

  router.get('/interviews', requirePermission(IV.VIEW_ALL, IV.VIEW_ASSIGNED), route(
    { query: interviewQuery },
    async ({ query, auth }, res) => {
      // VIEW_ASSIGNED without VIEW_ALL means "interviews I sit on".
      const pinned = auth.has(IV.VIEW_ALL) ? query.panellistId : auth.userId;
      res.json(await read.interviews(defined({
        status: query.status,
        applicationId: query.applicationId,
        candidateId: query.candidateId,
        requisitionId: query.requisitionId,
        panellistId: pinned,
        from: query.from,
        to: query.to,
      }), pageOf(query), auth));
    },
  ));

  router.get('/interviews/:id', requirePermission(IV.VIEW_ALL, IV.VIEW_ASSIGNED), route(
    { params: idParam },
    async ({ params, auth }, res) => {
      const found = await read.interview(params.id, auth);
      if (found === null) { res.status(404).json(notFound('Interview', params.id)); return; }
      res.json(found);
    },
  ));

  const OF = OFFER_PERMISSIONS;

  router.get('/offers', requirePermission(OF.CREATE, OF.APPROVE, OF.SEND, OF.RESULT_UPDATE), route(
    { query: offerQuery },
    async ({ query, auth }, res) => {
      res.json(await read.offers(defined({
        status: query.status,
        applicationId: query.applicationId,
        candidateId: query.candidateId,
        requisitionId: query.requisitionId,
        preparedBy: query.preparedBy,
        expiringBefore: query.expiringBefore,
        awaitingApproval: query.awaitingApproval,
      }), pageOf(query), auth));
    },
  ));

  router.get('/offers/:id', requirePermission(OF.CREATE, OF.APPROVE, OF.SEND, OF.RESULT_UPDATE), route(
    { params: idParam },
    async ({ params, auth }, res) => {
      const found = await read.offer(params.id, auth);
      if (found === null) { res.status(404).json(notFound('Offer', params.id)); return; }
      res.json(found);
    },
  ));

  router.get('/timeline', requirePermission(P.VIEW_ALL, P.VIEW_OWN), route(
    { query: timelineQuery },
    async ({ query, auth }, res) => {
      res.json(await read.timeline(defined({
        entityType: query.entityType,
        entityId: query.entityId,
        actorId: query.actorId,
        from: query.from,
        to: query.to,
      }), pageOf(query), auth));
    },
  ));

  router.get('/dashboard/summary', requirePermission(P.VIEW_ALL, P.VIEW_OWN), route(
    {},
    async ({ auth }, res) => { res.json(await read.dashboard(auth, now())); },
  ));

  return router;
};

const notFound = (entityType: string, id: number): unknown => ({
  error: { code: 'NOT_FOUND', message: `${entityType} not found.`, details: { entityType, id } },
});
