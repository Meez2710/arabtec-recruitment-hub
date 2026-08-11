// Application (pipeline) endpoints, plus the two hire operations.
//
// Note what is NOT here: no endpoint sets a stage directly to HIRED or
// OFFER_SENT. Those are SYSTEM transitions driven by the Offer context through
// the published pipeline operation (BL-14), and `PipelineService.transition`
// rejects them with a MANUAL trigger. The API surface therefore cannot express
// the illegal move at all, which is better than rejecting it at runtime.

import type { Router } from 'express';
import { Router as createRouter } from 'express';
import { z } from 'zod';
import type { PipelineService } from '../../modules/hiring/application/pipeline-service.js';
import { PIPELINE_PERMISSIONS } from '../../modules/hiring/application/pipeline-service.js';
import type { HiringService } from '../../modules/hiring/application/hiring-service.js';
import { HIRING_PERMISSIONS } from '../../modules/hiring/application/auth-context.js';
import { ALL_STAGES } from '../../modules/hiring/index.js';
import { requirePermission } from '../auth/authenticate.js';
import { expectedVersion, idParam, isoDate, nonEmpty, route } from '../http/validate.js';

/**
 * Derived from the domain's own vocabulary, not retyped.
 *
 * `ALL_STAGES` is the single source of truth; a stage added there is accepted
 * here on the next build, and the drift test that guards the enum guards this
 * too, transitively.
 */
const stageEnum = z.enum(ALL_STAGES as unknown as [string, ...string[]]);

const addBody = z.object({
  requisitionId: z.coerce.number().int().positive(),
  candidateId: z.coerce.number().int().positive(),
  initialStage: z.enum(['SOURCED', 'MATCHED']).optional(),
  recruiterId: z.coerce.number().int().positive().nullable().optional(),
});

const transitionBody = z.object({
  toStage: stageEnum,
  reason: nonEmpty(500).optional(),
  expectedVersion,
});

const bulkBody = z.object({
  applicationIds: z.array(z.coerce.number().int().positive()).min(1).max(200),
  toStage: stageEnum,
  reason: nonEmpty(500).optional(),
});

const nextActionBody = z.object({
  action: nonEmpty(500).nullable(),
  dueAt: isoDate.nullable(),
});

const hireBody = z.object({ expectedApplicationVersion: expectedVersion });
const reverseHireBody = z.object({
  reason: nonEmpty(500),
  expectedApplicationVersion: expectedVersion,
});

export const applicationRoutes = (
  pipeline: PipelineService,
  hiring: HiringService,
): Router => {
  const router = createRouter();

  router.post('/', requirePermission(PIPELINE_PERMISSIONS.ADD_CANDIDATE), route(
    { body: addBody },
    async ({ body, auth }, res) => {
      const result = await pipeline.addCandidate(body, auth);
      res.status(201).location(`/api/v1/applications/${result.id}`).json(result);
    },
  ));

  router.post('/:id/transition', requirePermission(PIPELINE_PERMISSIONS.MOVE_STAGE), route(
    { params: idParam, body: transitionBody },
    async ({ params, body, auth }, res) => {
      res.json(await pipeline.transition({
        applicationId: params.id,
        toStage: body.toStage as Parameters<PipelineService['transition']>[0]['toStage'],
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        ...(body.expectedVersion !== undefined ? { expectedVersion: body.expectedVersion } : {}),
      }, auth));
    },
  ));

  router.post('/:id/resume', requirePermission(PIPELINE_PERMISSIONS.MOVE_STAGE), route(
    { params: idParam, body: z.object({ expectedVersion }) },
    async ({ params, body, auth }, res) => {
      res.json(await pipeline.resume(params.id, auth, body.expectedVersion));
    },
  ));

  router.post('/bulk/transition', requirePermission(PIPELINE_PERMISSIONS.BULK_ACTION), route(
    { body: bulkBody },
    async ({ body, auth }, res) => {
      // Partial success is a real outcome here: the service reports per-id
      // results and 200 is correct even when some ids failed. Collapsing that
      // to a single status would lose which ones.
      res.json(await pipeline.bulkTransition(
        body.applicationIds,
        body.toStage as Parameters<PipelineService['bulkTransition']>[1],
        auth,
        body.reason !== undefined ? { reason: body.reason } : {},
      ));
    },
  ));

  router.put('/:id/next-action', requirePermission(PIPELINE_PERMISSIONS.MOVE_STAGE), route(
    { params: idParam, body: nextActionBody },
    async ({ params, body, auth }, res) => {
      res.json(await pipeline.setNextAction(params.id, body.action, body.dueAt, auth));
    },
  ));

  router.post('/:id/recruiter', requirePermission(PIPELINE_PERMISSIONS.ASSIGN_RECRUITER), route(
    { params: idParam, body: z.object({ recruiterId: z.coerce.number().int().positive() }) },
    async ({ params, body, auth }, res) => {
      res.json(await pipeline.assignRecruiter(params.id, body.recruiterId, auth));
    },
  ));

  /* ------------------------------ hire ---------------------------------- */
  // Separate permissions from anything above: recording a hire consumes a seat
  // and reversing one gives headcount back after the fact.

  router.post('/:id/hire', requirePermission(HIRING_PERMISSIONS.RECORD_HIRE), route(
    { params: idParam, body: hireBody },
    async ({ params, body, auth }, res) => {
      res.json(await hiring.recordHire({
        applicationId: params.id,
        ...(body.expectedApplicationVersion !== undefined
          ? { expectedApplicationVersion: body.expectedApplicationVersion }
          : {}),
      }, auth));
    },
  ));

  router.post('/:id/reverse-hire', requirePermission(HIRING_PERMISSIONS.REVERSE_HIRE), route(
    { params: idParam, body: reverseHireBody },
    async ({ params, body, auth }, res) => {
      res.json(await hiring.reverseHire({
        applicationId: params.id,
        reason: body.reason,
        ...(body.expectedApplicationVersion !== undefined
          ? { expectedApplicationVersion: body.expectedApplicationVersion }
          : {}),
      }, auth));
    },
  ));

  return router;
};
