// Requisition endpoints.
//
// EVERY handler in this file does exactly three things: parse, call ONE service
// method, respond. There is no `if` on domain state, no derived field, no
// second service call to "complete" a result. If an endpoint ever seems to need
// one, the operation is missing from the service and belongs there — that is
// the rule that keeps a use case testable without HTTP.
//
// State transitions are POSTs to named sub-resources (`/submit`, `/approve`)
// rather than a PATCH that infers intent from a status field. The requisition
// state machine has eight states and guarded edges; letting a client PATCH
// `state` would put edge selection in the client and make every transition look
// identical in the audit trail.

import type { Router } from 'express';
import { Router as createRouter } from 'express';
import { z } from 'zod';
import type { RequisitionService } from '../../modules/hiring/application/requisition-service.js';
import { REQUISITION_PERMISSIONS } from '../../modules/hiring/application/requisition-service.js';
import { requirePermission } from '../auth/authenticate.js';
import { expectedVersion, idParam, nonEmpty, route } from '../http/validate.js';

const createBody = z.object({
  title: nonEmpty(200),
  projectId: z.coerce.number().int().positive(),
  departmentId: z.coerce.number().int().positive(),
  headcount: z.coerce.number().int().min(1).max(999),
});

const updateBody = z.object({
  title: nonEmpty(200).optional(),
  projectId: z.coerce.number().int().positive().optional(),
  departmentId: z.coerce.number().int().positive().optional(),
  expectedVersion,
});

const versionOnly = z.object({ expectedVersion });
const reasonBody = z.object({ reason: nonEmpty(500), expectedVersion });
const headcountBody = z.object({
  headcount: z.coerce.number().int().min(1).max(999),
  expectedVersion,
});
const recruiterBody = z.object({
  recruiterId: z.coerce.number().int().positive(),
  expectedVersion,
});
const reopenBody = z.object({
  reason: nonEmpty(500),
  additionalHeadcount: z.coerce.number().int().min(0).max(999),
  expectedVersion,
});

export const requisitionRoutes = (service: RequisitionService): Router => {
  const router = createRouter();
  const P = REQUISITION_PERMISSIONS;

  router.post('/', requirePermission(P.CREATE), route(
    { body: createBody },
    async ({ body, auth }, res) => {
      const result = await service.create(body, auth);
      // 201 + Location: the client just made something that has a URL.
      res.status(201).location(`/api/v1/requisitions/${result.id}`).json(result);
    },
  ));

  router.patch('/:id', requirePermission(P.EDIT), route(
    { params: idParam, body: updateBody },
    async ({ params, body, auth }, res) => {
      const { expectedVersion: version, ...patch } = body;
      res.json(await service.update(params.id, patch, auth, version));
    },
  ));

  /** Each transition is its own endpoint, and its own permission. */
  const transition = (
    path: string,
    permission: string,
    call: (id: number, body: { expectedVersion?: number }, auth: Parameters<
      RequisitionService['submit']
    >[1]) => Promise<unknown>,
  ): void => {
    router.post(`/:id/${path}`, requirePermission(permission), route(
      { params: idParam, body: versionOnly },
      async ({ params, body, auth }, res) => {
        res.json(await call(params.id, body, auth));
      },
    ));
  };

  transition('submit', P.SUBMIT, (id, b, auth) => service.submit(id, auth, b.expectedVersion));
  transition('recall', P.SUBMIT, (id, b, auth) => service.recall(id, auth, b.expectedVersion));
  transition('approve', P.APPROVE, (id, b, auth) => service.approve(id, auth, b.expectedVersion));
  transition('revise', P.EDIT, (id, b, auth) => service.revise(id, auth, b.expectedVersion));
  transition('resume', P.HOLD, (id, b, auth) => service.resume(id, auth, b.expectedVersion));

  router.post('/:id/reject', requirePermission(P.APPROVE), route(
    { params: idParam, body: reasonBody },
    async ({ params, body, auth }, res) => {
      res.json(await service.reject(params.id, body.reason, auth, body.expectedVersion));
    },
  ));

  router.post('/:id/hold', requirePermission(P.HOLD), route(
    { params: idParam, body: reasonBody },
    async ({ params, body, auth }, res) => {
      res.json(await service.hold(params.id, body.reason, auth, body.expectedVersion));
    },
  ));

  router.post('/:id/close', requirePermission(P.CLOSE), route(
    { params: idParam, body: reasonBody },
    async ({ params, body, auth }, res) => {
      // Returns the cascade result too — how many applications were moved off a
      // dead requisition (BL-22). The service decides that; we just relay it.
      res.json(await service.close(params.id, body.reason, auth, body.expectedVersion));
    },
  ));

  router.post('/:id/cancel', requirePermission(P.CANCEL), route(
    { params: idParam, body: reasonBody },
    async ({ params, body, auth }, res) => {
      res.json(await service.cancel(params.id, body.reason, auth, body.expectedVersion));
    },
  ));

  router.post('/:id/reopen', requirePermission(P.REOPEN), route(
    { params: idParam, body: reopenBody },
    async ({ params, body, auth }, res) => {
      res.json(await service.reopen(
        params.id, body.reason, body.additionalHeadcount, auth, body.expectedVersion,
      ));
    },
  ));

  router.post('/:id/headcount', requirePermission(P.EDIT), route(
    { params: idParam, body: headcountBody },
    async ({ params, body, auth }, res) => {
      res.json(await service.adjustHeadcount(
        params.id, body.headcount, auth, body.expectedVersion,
      ));
    },
  ));

  router.post('/:id/recruiter', requirePermission(P.ASSIGN_RECRUITER), route(
    { params: idParam, body: recruiterBody },
    async ({ params, body, auth }, res) => {
      res.json(await service.assignRecruiter(
        params.id, body.recruiterId, auth, body.expectedVersion,
      ));
    },
  ));

  return router;
};
