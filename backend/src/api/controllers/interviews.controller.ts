// Interview endpoints.
//
// Two things this surface deliberately does NOT allow:
//
//   * There is no `status: 'RESCHEDULED'`. Rescheduling POSTs to /reschedule
//     and bumps a counter; the interview stays SCHEDULED (BL-16). A rescheduled
//     interview must never drop out of "upcoming" and leave a panel unprepared.
//
//   * `/assessment` returns the assessment, not a pipeline move. The sheet
//     produces a RECOMMENDATION only; advancing the candidate is a separate,
//     human act through the pipeline endpoint. That was an explicit product
//     decision and encoding it in the API keeps it from eroding.

import type { Router } from 'express';
import { Router as createRouter } from 'express';
import { z } from 'zod';
import type { InterviewService } from '../../modules/interview/application/interview-service.js';
import { INTERVIEW_PERMISSIONS } from '../../modules/interview/application/interview-service.js';
import { INTERVIEW_MODES } from '../../modules/interview/index.js';
import { requirePermission } from '../auth/authenticate.js';
import { expectedVersion, idParam, isoDate, nonEmpty, route } from '../http/validate.js';

const panelMember = z.object({
  userId: z.coerce.number().int().positive(),
  role: z.enum(['RECRUITER', 'HIRING_MANAGER']),
  isLead: z.boolean().default(false),
});

const scheduleBody = z.object({
  applicationId: z.coerce.number().int().positive(),
  candidateId: z.coerce.number().int().positive(),
  requisitionId: z.coerce.number().int().positive(),
  mode: z.enum(INTERVIEW_MODES as unknown as [string, ...string[]]),
  startsAt: isoDate,
  durationMinutes: z.coerce.number().int().min(1).max(600),
  panel: z.array(panelMember).min(1).max(20),
  locationOrLink: nonEmpty(1_000).nullable().optional(),
  candidateEmail: z.email().optional(),
  title: nonEmpty(200).optional(),
});

/** 1–5 or the literal 'NA'. 'NA' is excluded from the average, not scored zero. */
const score = z.union([z.coerce.number().int().min(1).max(5), z.literal('NA')]);

const assessmentBody = z.object({
  scores: z.record(z.string().min(1).max(60), score),
  criticalFlags: z.record(z.string().min(1).max(60), z.boolean()).optional(),
  justification: nonEmpty(5_000).optional(),
  allowUpdate: z.boolean().optional(),
  expectedVersion,
});

export const interviewRoutes = (service: InterviewService): Router => {
  const router = createRouter();
  const P = INTERVIEW_PERMISSIONS;

  router.post('/', requirePermission(P.SCHEDULE), route(
    { body: scheduleBody },
    async ({ body, auth }, res) => {
      const result = await service.schedule({
        applicationId: body.applicationId,
        candidateId: body.candidateId,
        requisitionId: body.requisitionId,
        mode: body.mode as Parameters<InterviewService['schedule']>[0]['mode'],
        startsAt: body.startsAt,
        durationMinutes: body.durationMinutes,
        panel: body.panel,
        ...(body.locationOrLink !== undefined ? { locationOrLink: body.locationOrLink } : {}),
        ...(body.candidateEmail !== undefined ? { candidateEmail: body.candidateEmail } : {}),
        ...(body.title !== undefined ? { title: body.title } : {}),
      }, auth);
      res.status(201).json(result);
    },
  ));

  router.post('/:id/reschedule', requirePermission(P.EDIT), route(
    { params: idParam, body: z.object({ startsAt: isoDate, expectedVersion }) },
    async ({ params, body, auth }, res) => {
      res.json(await service.reschedule(params.id, body.startsAt, auth, body.expectedVersion));
    },
  ));

  router.put('/:id/panel', requirePermission(P.EDIT), route(
    { params: idParam, body: z.object({ panel: z.array(panelMember).min(1).max(20), expectedVersion }) },
    async ({ params, body, auth }, res) => {
      res.json(await service.setPanel(params.id, body.panel, auth, body.expectedVersion));
    },
  ));

  router.post('/:id/complete', requirePermission(P.EDIT), route(
    { params: idParam, body: z.object({ expectedVersion }) },
    async ({ params, body, auth }, res) => {
      res.json(await service.complete(params.id, auth, body.expectedVersion));
    },
  ));

  router.post('/:id/no-show', requirePermission(P.EDIT), route(
    { params: idParam, body: z.object({ expectedVersion }) },
    async ({ params, body, auth }, res) => {
      res.json(await service.markNoShow(params.id, auth, body.expectedVersion));
    },
  ));

  router.post('/:id/cancel', requirePermission(P.EDIT), route(
    { params: idParam, body: z.object({ reason: nonEmpty(500), expectedVersion }) },
    async ({ params, body, auth }, res) => {
      res.json(await service.cancel(params.id, body.reason, auth, body.expectedVersion));
    },
  ));

  router.put('/:id/assessment', requirePermission(P.FEEDBACK), route(
    { params: idParam, body: assessmentBody },
    async ({ params, body, auth }, res) => {
      // The evaluator is the AUTHENTICATED user, never a body field. Accepting
      // `evaluatorUserId` from the client would let anyone sign the sheet as
      // anyone else — and the sheet is a document with signature blocks.
      res.json(await service.recordAssessment({
        interviewId: params.id,
        scores: body.scores as Parameters<InterviewService['recordAssessment']>[0]['scores'],
        ...(body.criticalFlags !== undefined ? { criticalFlags: body.criticalFlags } : {}),
        ...(body.justification !== undefined ? { justification: body.justification } : {}),
        ...(body.allowUpdate !== undefined ? { allowUpdate: body.allowUpdate } : {}),
        ...(body.expectedVersion !== undefined ? { expectedVersion: body.expectedVersion } : {}),
      }, auth));
    },
  ));

  router.get('/:id/recommendation', requirePermission(P.VIEW_ALL, P.VIEW_ASSIGNED), route(
    { params: idParam },
    async ({ params, auth }, res) => {
      res.json(await service.recommendation(params.id, auth));
    },
  ));

  return router;
};
