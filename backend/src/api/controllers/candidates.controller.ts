// Candidate endpoints.
//
// The upload endpoint hashes the bytes HERE rather than trusting a client-sent
// hash: the hash is the dedup key and the storage key, so a client that could
// choose it could overwrite another candidate's CV.

import { createHash } from 'node:crypto';
import type { Router } from 'express';
import { Router as createRouter } from 'express';
import { z } from 'zod';
import type { CandidateService } from '../../modules/talent/index.js';
import type { ProposalService } from '../../modules/talent/index.js';
import {
  CANDIDATE_STATES, DOCUMENT_TYPES, TALENT_PERMISSIONS,
} from '../../modules/talent/index.js';
import { requirePermission } from '../auth/authenticate.js';
import { expectedVersion, idParam, nonEmpty, route } from '../http/validate.js';

const stringList = z.array(z.string().trim().min(1).max(120)).max(200);

const editable = {
  fullName: nonEmpty(200).optional(),
  email: z.email().max(320).nullable().optional(),
  phone: z.string().trim().min(3).max(40).nullable().optional(),
  nationality: nonEmpty(100).nullable().optional(),
  location: nonEmpty(200).nullable().optional(),
  linkedinUrl: z.url().max(500).nullable().optional(),
  currentCompany: nonEmpty(200).nullable().optional(),
  currentPosition: nonEmpty(200).nullable().optional(),
  yearsExperience: z.coerce.number().min(0).max(70).nullable().optional(),
  noticePeriod: nonEmpty(100).nullable().optional(),
  university: nonEmpty(200).nullable().optional(),
  major: nonEmpty(200).nullable().optional(),
  graduationYear: z.coerce.number().int().min(1900).max(2200).nullable().optional(),
  skills: stringList.optional(),
  languages: stringList.optional(),
  certifications: stringList.optional(),
  tags: stringList.optional(),
  source: nonEmpty(100).nullable().optional(),
};

const createBody = z.object({
  ...editable,
  fullName: nonEmpty(200),
  ownerRecruiterId: z.coerce.number().int().positive().nullable().optional(),
});

const updateBody = z.object({ ...editable, expectedVersion });

const stateBody = z.object({
  state: z.enum(CANDIDATE_STATES as unknown as [string, ...string[]]),
  reason: nonEmpty(500).nullable().optional(),
  expectedVersion,
});

const documentBody = z.object({
  docType: z.enum(DOCUMENT_TYPES as unknown as [string, ...string[]]),
  fileName: nonEmpty(300),
  mimeType: nonEmpty(200),
  /** Base64. Multipart arrives with the upload endpoint in the bulk-CV slice. */
  content: z.string().min(1).max(30_000_000),
  note: nonEmpty(2_000).nullable().optional(),
  expectedVersion,
});

const proposalBody = z.object({
  origin: nonEmpty(80),
  taskId: z.string().max(120).optional(),
  modelId: z.string().max(120).optional(),
  documentId: z.string().max(80).nullable().optional(),
  fields: z.array(z.object({
    field: nonEmpty(60),
    value: z.unknown(),
    confidence: z.coerce.number().min(0).max(1).optional(),
    evidence: z.string().max(1_000).nullable().optional(),
  })).min(1).max(60),
});

const reviewBody = z.object({
  /** field -> accept. Anything omitted is rejected; a review is not partial. */
  decisions: z.record(z.string().min(1).max(60), z.boolean()),
  expectedVersion,
});

const duplicateQuery = z.object({
  email: z.string().trim().max(320).optional(),
  phone: z.string().trim().max(40).optional(),
  linkedinUrl: z.string().trim().max(500).optional(),
});

export const candidateRoutes = (
  candidates: CandidateService,
  proposals: ProposalService,
): Router => {
  const router = createRouter();
  const P = TALENT_PERMISSIONS;

  router.post('/', requirePermission(P.CREATE), route(
    { body: createBody },
    async ({ body, auth }, res) => {
      const result = await candidates.create(body, auth);
      // 201 even with duplicate warnings — they are advisory, and a recruiter
      // with the person on the phone must not be blocked by a heuristic.
      res.status(201).location(`/api/v1/candidates/${result.candidate.id}`).json(result);
    },
  ));

  router.patch('/:id', requirePermission(P.EDIT), route(
    { params: idParam, body: updateBody },
    async ({ params, body, auth }, res) => {
      const { expectedVersion: version, ...patch } = body;
      res.json(await candidates.update(params.id, patch, auth, version));
    },
  ));

  router.post('/:id/state', requirePermission(P.CHANGE_STATE), route(
    { params: idParam, body: stateBody },
    async ({ params, body, auth }, res) => {
      res.json(await candidates.changeState(
        params.id,
        body.state as Parameters<CandidateService['changeState']>[1],
        body.reason ?? null,
        auth,
        body.expectedVersion,
      ));
    },
  ));

  router.post('/:id/owner', requirePermission(P.ASSIGN_OWNER), route(
    { params: idParam, body: z.object({
      recruiterId: z.coerce.number().int().positive().nullable(), expectedVersion,
    }) },
    async ({ params, body, auth }, res) => {
      res.json(await candidates.assignOwner(
        params.id, body.recruiterId, auth, body.expectedVersion,
      ));
    },
  ));

  router.post('/:id/documents', requirePermission(P.UPLOAD_DOCUMENT), route(
    { params: idParam, body: documentBody },
    async ({ params, body, auth }, res) => {
      const bytes = new Uint8Array(Buffer.from(body.content, 'base64'));
      // Hashed server-side. A client-supplied hash is a write primitive into
      // content-addressed storage.
      const fileHash = createHash('sha256').update(bytes).digest('hex');

      res.status(201).json(await candidates.attachDocument(params.id, {
        docType: body.docType as Parameters<CandidateService['attachDocument']>[1]['docType'],
        fileName: body.fileName,
        mimeType: body.mimeType,
        bytes,
        fileHash,
        note: body.note ?? null,
      }, auth, body.expectedVersion));
    },
  ));

  router.delete('/:id/documents/:documentId', requirePermission(P.DELETE_DOCUMENT), route(
    {
      params: z.object({
        id: z.coerce.number().int().positive(),
        documentId: z.string().min(1).max(80),
      }),
    },
    async ({ params, auth }, res) => {
      res.json(await candidates.removeDocument(params.id, params.documentId, auth));
    },
  ));

  router.get('/duplicates', requirePermission(P.VIEW_ALL, P.VIEW_OWN), route(
    { query: duplicateQuery },
    async ({ query, auth }, res) => {
      res.json({ possibleDuplicates: await candidates.findDuplicates(query, auth) });
    },
  ));

  /* ------------------------------ proposals ------------------------------- */
  // Origin-agnostic: an AI extraction and a bulk import raise the same shape and
  // are reviewed the same way.

  router.post('/:id/proposals', requirePermission(P.EDIT), route(
    { params: idParam, body: proposalBody },
    async ({ params, body, auth }, res) => {
      res.status(201).json(await proposals.raise({
        candidateId: params.id,
        origin: body.origin,
        ...(body.taskId !== undefined ? { taskId: body.taskId } : {}),
        ...(body.modelId !== undefined ? { modelId: body.modelId } : {}),
        ...(body.documentId !== undefined ? { documentId: body.documentId } : {}),
        fields: body.fields.map((f) => ({
          field: f.field,
          value: f.value,
          ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
          ...(f.evidence !== undefined ? { evidence: f.evidence } : {}),
        })),
      }, auth));
    },
  ));

  router.get('/proposals/:id', requirePermission(P.VIEW_ALL, P.VIEW_OWN), route(
    { params: idParam },
    async ({ params, auth }, res) => { res.json(await proposals.get(params.id, auth)); },
  ));

  router.post('/proposals/:id/review', requirePermission(P.REVIEW_PROPOSAL, P.EDIT), route(
    { params: idParam, body: reviewBody },
    async ({ params, body, auth }, res) => {
      res.json(await proposals.review(params.id, body.decisions, auth, body.expectedVersion));
    },
  ));

  return router;
};
