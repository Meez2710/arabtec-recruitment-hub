// Offer endpoints.
//
// Compensation is a list of `{ componentCode, amount }` and nothing else. There
// is no `basicSalary` field, no percentage, no computed total in the request or
// the response shape this layer imposes — the total is a plain sum the
// aggregate performs. The 40/30/30 pattern in the sample letters was explicitly
// rejected as company policy, so nothing in the API can express it either.

import type { Router } from 'express';
import { Router as createRouter } from 'express';
import { z } from 'zod';
import type { OfferService } from '../../modules/offer/application/offer-service.js';
import { OFFER_PERMISSIONS } from '../../modules/offer/application/offer-service.js';
import { requirePermission } from '../auth/authenticate.js';
import { expectedVersion, idParam, isoDate, nonEmpty, route } from '../http/validate.js';

const compensationLine = z.object({
  componentCode: nonEmpty(60),
  // Two decimals max: the column is numeric(14,2) and silently rounding a
  // salary on a document someone signs is not acceptable.
  amount: z.coerce.number().min(0).max(999_999_999_999.99)
    .refine((n) => Number.isInteger(Math.round(n * 100)) && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6,
      { message: 'amount may have at most 2 decimal places' }),
});

const lines = z.array(compensationLine).min(1).max(20);

const draftBody = z.object({
  applicationId: z.coerce.number().int().positive(),
  candidateId: z.coerce.number().int().positive(),
  requisitionId: z.coerce.number().int().positive(),
  positionTitle: nonEmpty(200),
  /** ISO 4217. The letters are EGP; the field is not assumed to be. */
  currency: z.string().trim().length(3).toUpperCase(),
  lines,
  joiningDate: isoDate.nullable().optional(),
});

const versionOnly = z.object({ expectedVersion });
const reasonBody = z.object({ reason: nonEmpty(500), expectedVersion });

export const offerRoutes = (service: OfferService): Router => {
  const router = createRouter();
  const P = OFFER_PERMISSIONS;

  router.post('/', requirePermission(P.CREATE), route(
    { body: draftBody },
    async ({ body, auth }, res) => {
      const result = await service.draft({
        applicationId: body.applicationId,
        candidateId: body.candidateId,
        requisitionId: body.requisitionId,
        positionTitle: body.positionTitle,
        currency: body.currency,
        lines: body.lines,
        ...(body.joiningDate !== undefined ? { joiningDate: body.joiningDate } : {}),
      }, auth);
      res.status(201).location(`/api/v1/offers/${result.id}`).json(result);
    },
  ));

  router.put('/:id/compensation', requirePermission(P.EDIT), route(
    { params: idParam, body: z.object({ lines, expectedVersion }) },
    async ({ params, body, auth }, res) => {
      res.json(await service.setCompensation(params.id, body.lines, auth, body.expectedVersion));
    },
  ));

  router.post('/:id/submit', requirePermission(P.EDIT), route(
    { params: idParam, body: versionOnly },
    async ({ params, body, auth }, res) => {
      res.json(await service.submit(params.id, auth, body.expectedVersion));
    },
  ));

  router.post('/:id/recall', requirePermission(P.EDIT), route(
    { params: idParam, body: versionOnly },
    async ({ params, body, auth }, res) => {
      res.json(await service.recall(params.id, auth, body.expectedVersion));
    },
  ));

  // BL-12: the aggregate refuses self-approval. The permission gate cannot see
  // who prepared the offer, so the real check is and stays in the domain.
  router.post('/:id/approve', requirePermission(P.APPROVE, P.APPROVE_DIRECTOR), route(
    { params: idParam, body: versionOnly },
    async ({ params, body, auth }, res) => {
      res.json(await service.approve(params.id, auth, body.expectedVersion));
    },
  ));

  router.post('/:id/reject-approval', requirePermission(P.APPROVE, P.APPROVE_DIRECTOR), route(
    { params: idParam, body: reasonBody },
    async ({ params, body, auth }, res) => {
      res.json(await service.rejectApproval(params.id, body.reason, auth, body.expectedVersion));
    },
  ));

  router.post('/:id/send', requirePermission(P.SEND), route(
    { params: idParam, body: versionOnly },
    async ({ params, body, auth }, res) => {
      // Pins the template and its variable snapshot so a 2026 letter reprinted
      // in 2028 reproduces the 2026 document. The service does that; we relay.
      res.json(await service.send(params.id, auth, body.expectedVersion));
    },
  ));

  router.post('/:id/accept', requirePermission(P.RESULT_UPDATE), route(
    { params: idParam, body: versionOnly },
    async ({ params, body, auth }, res) => {
      res.json(await service.accept(params.id, auth, body.expectedVersion));
    },
  ));

  router.post('/:id/decline', requirePermission(P.RESULT_UPDATE), route(
    { params: idParam, body: reasonBody },
    async ({ params, body, auth }, res) => {
      res.json(await service.decline(params.id, body.reason, auth, body.expectedVersion));
    },
  ));

  router.post('/:id/withdraw', requirePermission(P.RESULT_UPDATE), route(
    { params: idParam, body: reasonBody },
    async ({ params, body, auth }, res) => {
      res.json(await service.withdraw(params.id, body.reason, auth, body.expectedVersion));
    },
  ));

  return router;
};
