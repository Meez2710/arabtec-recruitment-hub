// Bulk CV upload — multipart intake.
//
// Multipart, not base64 JSON: fifty CVs base64-encoded is ~35% larger and has
// to be buffered as one string before parsing. Multer streams each part.
//
// Files are held in memory rather than on disk because they go straight to the
// DocumentStore. `limits` are enforced by multer BEFORE the handler runs, so an
// oversized upload is rejected without ever being fully read.

import { createHash } from 'node:crypto';
import type { Request, Router } from 'express';
import { Router as createRouter } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { CvIntakeService } from '../../modules/talent/index.js';
import type { PageRequest } from '../queries/ports.js';
import type { TalentReadModel } from '../queries/talent-ports.js';
import { TALENT_PERMISSIONS } from '../../modules/talent/index.js';
import { requirePermission } from '../auth/authenticate.js';
import { badRequest } from '../http/errors.js';
import { expectedVersion, idParam, isoDate, nonEmpty, route } from '../http/validate.js';

export interface CvIntakeRouteOptions {
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
}

const upload = (opts: CvIntakeRouteOptions): multer.Multer => multer({
  storage: multer.memoryStorage(),
  limits: {
    files: opts.maxFiles ?? 100,
    fileSize: opts.maxFileBytes ?? 15 * 1024 * 1024,
  },
});

const convertBody = z.object({
  /** Fields the reviewer typed or corrected. Recorded as USER provenance. */
  manual: z.object({
    fullName: nonEmpty(200).optional(),
    email: z.email().max(320).nullable().optional(),
    phone: z.string().trim().min(3).max(40).nullable().optional(),
    location: nonEmpty(200).nullable().optional(),
    currentCompany: nonEmpty(200).nullable().optional(),
    currentPosition: nonEmpty(200).nullable().optional(),
    yearsExperience: z.coerce.number().min(0).max(70).nullable().optional(),
    skills: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
    source: nonEmpty(100).nullable().optional(),
  }).default({}),
  /** Extracted fields the reviewer accepted. Recorded as AI_APPROVED. */
  acceptedFields: z.array(z.string().min(1).max(60)).max(60).default([]),
  ownerRecruiterId: z.coerce.number().int().positive().nullable().optional(),
  expectedVersion,
});

const itemParams = z.object({
  id: z.coerce.number().int().positive(),
  itemId: z.string().min(1).max(80),
});

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.string().max(40).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
  status: z.union([z.string(), z.array(z.string())]).optional(),
  uploadedBy: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(200).optional(),
  hasOutstanding: z.coerce.boolean().optional(),
  createdFrom: isoDate.optional(),
  createdTo: isoDate.optional(),
});

const pageOf = (q: {
  limit: number; offset: number; sort?: string; direction?: 'asc' | 'desc';
}): PageRequest => ({
  limit: q.limit,
  offset: q.offset,
  ...(q.sort !== undefined ? { sort: q.sort } : {}),
  ...(q.direction !== undefined ? { direction: q.direction } : {}),
});

const defined = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export const cvIntakeRoutes = (
  intake: CvIntakeService,
  read: TalentReadModel,
  opts: CvIntakeRouteOptions = {},
): Router => {
  const router = createRouter();
  const P = TALENT_PERMISSIONS;
  const files = upload(opts);

  router.post(
    '/',
    requirePermission(P.CREATE),
    files.array('files'),
    route(
      { body: z.object({ label: nonEmpty(200).optional() }) },
      async ({ body, auth }, res) => {
        const uploaded = ((res.req as Request).files ?? []) as Express.Multer.File[];
        if (uploaded.length === 0) throw badRequest('Attach at least one file.');

        res.status(201).json(await intake.upload({
          label: body.label ?? `Intake ${new Date().toISOString().slice(0, 10)}`,
          files: uploaded.map((f) => {
            const bytes = new Uint8Array(f.buffer);
            return {
              fileName: f.originalname,
              mimeType: f.mimetype,
              bytes,
              // Hashed server-side. A client-chosen hash is a write primitive
              // into content-addressed storage.
              fileHash: createHash('sha256').update(bytes).digest('hex'),
            };
          }),
        }, auth));
      },
    ),
  );

  router.get('/', requirePermission(P.VIEW_ALL, P.VIEW_OWN), route(
    { query: listQuery },
    async ({ query, auth }, res) => {
      const statuses = query.status === undefined
        ? undefined
        : (Array.isArray(query.status) ? query.status : [query.status])
          .flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
      // A VIEW_OWN caller sees only their own uploads, and cannot widen it.
      const pinned = auth.has(P.VIEW_ALL) ? query.uploadedBy : auth.userId;

      res.json(await read.intakeBatches(defined({
        status: statuses !== undefined && statuses.length > 0 ? statuses : undefined,
        uploadedBy: pinned,
        q: query.q,
        hasOutstanding: query.hasOutstanding,
        createdFrom: query.createdFrom,
        createdTo: query.createdTo,
      }), pageOf(query), auth));
    },
  ));

  // Read model, not the aggregate: the detail carries live parse state and
  // progress rollups that no aggregate holds.
  router.get('/:id', requirePermission(P.VIEW_ALL, P.VIEW_OWN), route(
    { params: idParam },
    async ({ params, auth }, res) => {
      const found = await read.intakeBatch(params.id, auth);
      if (found === null) {
        res.status(404).json({
          error: {
            code: 'NOT_FOUND', message: 'CV intake batch not found.',
            details: { entityType: 'CvIntakeBatch', id: params.id },
          },
        });
        return;
      }
      res.json(found);
    },
  ));

  router.post('/:id/items/:itemId/convert', requirePermission(P.CREATE), route(
    { params: itemParams, body: convertBody },
    async ({ params, body, auth }, res) => {
      // Creates a real Candidate under its ordinary invariants — a name and a
      // contact channel are still required, whether typed or accepted.
      res.status(201).json(await intake.convert({
        batchId: params.id,
        itemId: params.itemId,
        manual: body.manual,
        acceptedFields: body.acceptedFields,
        ...(body.ownerRecruiterId !== undefined
          ? { ownerRecruiterId: body.ownerRecruiterId } : {}),
        ...(body.expectedVersion !== undefined
          ? { expectedVersion: body.expectedVersion } : {}),
      }, auth));
    },
  ));

  router.post('/:id/items/:itemId/discard', requirePermission(P.CREATE), route(
    { params: itemParams, body: z.object({ reason: nonEmpty(500), expectedVersion }) },
    async ({ params, body, auth }, res) => {
      res.json(await intake.discard({
        batchId: params.id, itemId: params.itemId, reason: body.reason,
        ...(body.expectedVersion !== undefined
          ? { expectedVersion: body.expectedVersion } : {}),
      }, auth));
    },
  ));

  router.post('/:id/cancel', requirePermission(P.CREATE), route(
    { params: idParam, body: z.object({ reason: nonEmpty(500), expectedVersion }) },
    async ({ params, body, auth }, res) => {
      res.json(await intake.cancel(params.id, body.reason, auth, body.expectedVersion));
    },
  ));

  return router;
};
