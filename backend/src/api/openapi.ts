// OpenAPI 3.1 document.
//
// Hand-written rather than generated from decorators or reflection. That is a
// deliberate trade: a decorator-driven generator would put a second source of
// truth into every controller and couple the routing to a framework, and this
// API has ~40 endpoints with a very regular shape. When the surface grows past
// what one file can hold honestly, generate it from the zod schemas — they are
// already the validation source of truth.
//
// Served as JSON plus a zero-dependency HTML viewer. No CDN script tag: a docs
// page that fetches a bundle from a third party is a supply-chain hole in every
// environment it is deployed to.

import type { Router } from 'express';
import { Router as createRouter } from 'express';

const ERROR_SCHEMA = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: { type: 'object', additionalProperties: true },
        requestId: { type: 'string' },
        correlationId: { type: 'string' },
      },
      required: ['code', 'message'],
    },
  },
} as const;

const errorResponse = (description: string): Record<string, unknown> => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

const COMMON_ERRORS = {
  400: errorResponse('Malformed request or failed validation.'),
  401: errorResponse('Missing, invalid or expired credentials.'),
  403: errorResponse('Authenticated, but not permitted.'),
  404: errorResponse('Not found, or outside your data scope — deliberately indistinguishable.'),
  409: errorResponse('The record changed since you read it. Reload and retry.'),
  422: errorResponse('A business rule refused the operation. The request itself was valid.'),
};

const PAGING = [
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
  { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
  { name: 'sort', in: 'query', schema: { type: 'string' },
    description: 'Whitelisted column. An unknown value falls back to the default rather than erroring.' },
  { name: 'direction', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } },
] as const;

const q = (name: string, type = 'integer', description?: string): Record<string, unknown> => ({
  name, in: 'query', schema: { type }, ...(description !== undefined ? { description } : {}),
});

/** GET list + GET detail for one resource. */
const readPair = (
  tag: string, resource: string, summary: string, filters: readonly Record<string, unknown>[],
): Record<string, unknown> => ({
  [`/${resource}`]: {
    get: {
      tags: [tag],
      summary,
      description:
        'Returns `{ items, total, limit, offset }`. `total` is the count BEFORE the limit and '
        + 'comes from the same query as the rows, so the two can never disagree.',
      parameters: [...PAGING, ...filters],
      responses: { 200: { description: 'A page of results.' }, ...COMMON_ERRORS },
    },
  },
  [`/${resource}/{id}`]: {
    get: {
      tags: [tag],
      summary: `${summary.replace(/^List /, 'Get one ')} with its children.`,
      parameters: [idPath],
      responses: { 200: { description: 'The record.' }, ...COMMON_ERRORS },
    },
  },
});

const idPath = {
  name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 },
} as const;

/** One state-transition endpoint: POST /{resource}/{id}/{action}. */
const transition = (
  tag: string, resource: string, action: string, summary: string,
  bodyProps: Record<string, unknown> = {},
  required: readonly string[] = [],
): Record<string, unknown> => ({
  [`/${resource}/{id}/${action}`]: {
    post: {
      tags: [tag],
      summary,
      parameters: [idPath],
      requestBody: {
        required: required.length > 0,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                expectedVersion: {
                  type: 'integer', minimum: 0,
                  description:
                    'Optimistic concurrency. Omit to skip the check; supply the version '
                    + 'you read to get a 409 instead of overwriting someone else\'s change.',
                },
                ...bodyProps,
              },
              required: [...required],
            },
          },
        },
      },
      responses: { 200: { description: 'The updated resource.' }, ...COMMON_ERRORS },
    },
  },
});

const reasonProp = {
  reason: { type: 'string', minLength: 1, maxLength: 500 },
} as const;

export const openApiDocument = (): Record<string, unknown> => ({
  openapi: '3.1.0',
  info: {
    title: 'Arabtec Recruitment Hub API',
    version: '1.0.0',
    description:
      'Applicant tracking for Arabtec. Every endpoint delegates to an application '
      + 'service; no business logic exists in this layer.\n\n'
      + '**Status codes.** 422 means a business rule refused a well-formed, authorised '
      + 'request — show the message, it is written for the user. 400 means the request '
      + 'itself was wrong. 409 means optimistic concurrency: reload and retry.\n\n'
      + '**Scope.** A record outside your project scope returns 404, identical to a record '
      + 'that does not exist, so status codes cannot be used to enumerate data.',
  },
  servers: [{ url: '/api/v1' }],
  components: {
    schemas: { Error: ERROR_SCHEMA },
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      cookieAuth: { type: 'apiKey', in: 'cookie', name: 'token' },
    },
  },
  security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  tags: [
    { name: 'Requisitions', description: 'Hiring requests and their seats.' },
    { name: 'Applications', description: 'Candidates in a pipeline, and hires.' },
    { name: 'Interviews', description: 'Scheduling, panels and the assessment sheet.' },
    { name: 'Offers', description: 'Drafting, approval, issue and outcome.' },
    { name: 'Candidates', description:
      'Talent pool. Manual by default; AI produces proposals a human reviews. Every list and '
      + 'detail carries `fieldSources` (USER | AI_APPROVED | IMPORT) and an `ai` block whose '
      + 'parsing/matching/embedding fields are null placeholders until the AI phase.' },
    { name: 'Timeline', description: 'Append-only audit trail.' },
    { name: 'Dashboard', description: 'Aggregate counts and My Work.' },
    { name: 'Health', description: 'Liveness, readiness and event-delivery backlog.' },
  ],
  paths: {
    ...readPair('Requisitions', 'requisitions', 'List requisitions.', [
      q('state', 'string', 'Repeatable, or comma-separated.'),
      q('projectId'), q('departmentId'), q('recruiterId'), q('requesterId'),
      q('q', 'string', 'Free text over ticket number and title.'),
      q('hasOpenSeats', 'boolean'),
    ]),
    ...readPair('Applications', 'applications', 'List applications.', [
      q('requisitionId'), q('candidateId'),
      q('stage', 'string', 'Repeatable, or comma-separated.'),
      q('recruiterId'), q('q', 'string'),
      q('dueBefore', 'string', 'Open next-actions due at or before this instant — the My Work list.'),
      q('inactiveSince', 'string', 'No activity since this instant — the stalled list.'),
      q('liveOnly', 'boolean', 'Exclude HIRED / REJECTED / WITHDRAWN / OFFER_DECLINED.'),
    ]),
    ...readPair('Interviews', 'interviews', 'List interviews.', [
      q('status', 'string'), q('applicationId'), q('candidateId'), q('requisitionId'),
      q('panellistId', 'integer', 'Interviews this user sits on.'),
      q('from', 'string'), q('to', 'string'),
    ]),
    ...readPair('Offers', 'offers', 'List offers.', [
      q('status', 'string'), q('applicationId'), q('candidateId'), q('requisitionId'),
      q('preparedBy'), q('expiringBefore', 'string'), q('awaitingApproval', 'boolean'),
    ]),
    ...readPair('Candidates', 'candidates', 'List candidates.', [
      q('q', 'string', 'Free text over name, number, email, company and position.'),
      q('state', 'string', 'Repeatable or comma-separated. ERASED is hidden unless asked for.'),
      q('ownerRecruiterId'), q('source', 'string'),
      q('skills', 'string', 'Comma-separated. ALL must be present.'),
      q('tags', 'string'),
      q('minYearsExperience', 'number'), q('maxYearsExperience', 'number'),
      q('hasCv', 'boolean'), q('hasPendingProposal', 'boolean'),
      q('createdFrom', 'string'), q('createdTo', 'string'),
    ]),
    '/candidates/{id}/proposals': {
      get: {
        tags: ['Candidates'],
        summary: 'Proposal history, newest first, each field beside its current value.',
        parameters: [idPath, ...PAGING],
        responses: { 200: { description: 'A page of proposals.' }, ...COMMON_ERRORS },
      },
    },
    '/candidates/{id}/duplicates': {
      get: {
        tags: ['Candidates'],
        summary: 'Possible duplicates by email, phone, LinkedIn or a shared CV.',
        description: 'Reports only. Merging is never decided by a query.',
        parameters: [idPath],
        responses: { 200: { description: 'Warnings.' }, ...COMMON_ERRORS },
      },
    },
    '/candidates/{id}/activity': {
      get: {
        tags: ['Candidates'],
        summary: 'Pipeline activity for this person.',
        description:
          'The candidate is visible tenant-wide; the activity counted here is PROJECT-scoped, '
          + 'so a scoped recruiter sees the person and only the activity their projects cover.',
        parameters: [idPath],
        responses: { 200: { description: 'Activity summary.' }, ...COMMON_ERRORS },
      },
    },
    '/timeline': {
      get: {
        tags: ['Timeline'],
        summary: 'Audit trail, newest first.',
        description:
          'Scoped through the entity each entry describes — the trail carries no project of '
          + 'its own, and an unrecognised entity type is refused rather than allowed.',
        parameters: [
          ...PAGING,
          q('entityType', 'string', 'Requisition | Application | Interview | Offer'),
          q('entityId'), q('actorId'), q('from', 'string'), q('to', 'string'),
        ],
        responses: { 200: { description: 'A page of timeline entries.' }, ...COMMON_ERRORS },
      },
    },
    '/dashboard/summary': {
      get: {
        tags: ['Dashboard'],
        summary: 'Counts for the landing screen, plus a My Work block scoped to the caller.',
        responses: { 200: { description: 'Summary counts.' }, ...COMMON_ERRORS },
      },
    },

    '/requisitions': {
      post: {
        tags: ['Requisitions'], summary: 'Create a requisition (DRAFT).',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  title: { type: 'string', minLength: 1, maxLength: 200 },
                  projectId: { type: 'integer', minimum: 1 },
                  departmentId: { type: 'integer', minimum: 1 },
                  headcount: {
                    type: 'integer', minimum: 1, maximum: 999,
                    description: 'One seat is created per head.',
                  },
                },
                required: ['title', 'projectId', 'departmentId', 'headcount'],
              },
            },
          },
        },
        responses: { 201: { description: 'Created.' }, ...COMMON_ERRORS },
      },
    },
    '/requisitions/{id}': {
      patch: {
        tags: ['Requisitions'],
        summary: 'Edit a requisition. Only legal while DRAFT or REJECTED.',
        parameters: [idPath],
        responses: { 200: { description: 'Updated.' }, ...COMMON_ERRORS },
      },
    },
    ...transition('Requisitions', 'requisitions', 'submit', 'Submit for approval.'),
    ...transition('Requisitions', 'requisitions', 'recall', 'Recall a submission.'),
    ...transition('Requisitions', 'requisitions', 'approve', 'Approve.'),
    ...transition('Requisitions', 'requisitions', 'revise', 'Return a rejected requisition to draft.'),
    ...transition('Requisitions', 'requisitions', 'resume', 'Resume from hold.'),
    ...transition('Requisitions', 'requisitions', 'reject', 'Reject with a reason.', reasonProp, ['reason']),
    ...transition('Requisitions', 'requisitions', 'hold', 'Put on hold.', reasonProp, ['reason']),
    ...transition(
      'Requisitions', 'requisitions', 'close',
      'Close. Cascades non-terminal applications; refused while a live offer is outstanding.',
      reasonProp, ['reason'],
    ),
    ...transition('Requisitions', 'requisitions', 'cancel', 'Cancel.', reasonProp, ['reason']),
    ...transition(
      'Requisitions', 'requisitions', 'reopen', 'Reopen a closed requisition.',
      { ...reasonProp, additionalHeadcount: { type: 'integer', minimum: 0, maximum: 999 } },
      ['reason', 'additionalHeadcount'],
    ),
    ...transition(
      'Requisitions', 'requisitions', 'headcount', 'Adjust headcount.',
      { headcount: { type: 'integer', minimum: 1, maximum: 999 } }, ['headcount'],
    ),
    ...transition(
      'Requisitions', 'requisitions', 'recruiter', 'Assign a recruiter (opens an APPROVED requisition).',
      { recruiterId: { type: 'integer', minimum: 1 } }, ['recruiterId'],
    ),

    '/applications': {
      post: {
        tags: ['Applications'],
        summary: 'Add a candidate to a requisition pipeline.',
        responses: { 201: { description: 'Created.' }, ...COMMON_ERRORS },
      },
    },
    ...transition(
      'Applications', 'applications', 'transition', 'Move a candidate to another stage.',
      {
        toStage: { type: 'string' },
        reason: { type: 'string', maxLength: 500 },
      },
      ['toStage'],
    ),
    ...transition('Applications', 'applications', 'resume', 'Resume from ON_HOLD.'),
    ...transition(
      'Applications', 'applications', 'hire',
      'Record a hire. Consumes a seat; refused if the requisition is full or the candidate '
      + 'already holds an active hire.',
      { expectedApplicationVersion: { type: 'integer', minimum: 0 } },
    ),
    ...transition(
      'Applications', 'applications', 'reverse-hire', 'Reverse a hire and release the seat.',
      reasonProp, ['reason'],
    ),
    '/applications/bulk/transition': {
      post: {
        tags: ['Applications'],
        summary: 'Move many applications at once.',
        description:
          'Partial success is normal: the response reports per-id outcomes and the status '
          + 'is 200 even when some ids failed.',
        responses: { 200: { description: 'Per-id results.' }, ...COMMON_ERRORS },
      },
    },
    '/applications/{id}/next-action': {
      put: {
        tags: ['Applications'], summary: 'Set or clear the next action and its due date.',
        parameters: [idPath],
        responses: { 200: { description: 'Updated.' }, ...COMMON_ERRORS },
      },
    },

    '/interviews': {
      post: {
        tags: ['Interviews'], summary: 'Schedule an interview.',
        responses: { 201: { description: 'Scheduled.' }, ...COMMON_ERRORS },
      },
    },
    ...transition(
      'Interviews', 'interviews', 'reschedule',
      'Reschedule. Bumps a counter; the status stays SCHEDULED (BL-16).',
      { startsAt: { type: 'string', format: 'date-time' } }, ['startsAt'],
    ),
    ...transition('Interviews', 'interviews', 'complete', 'Mark completed.'),
    ...transition('Interviews', 'interviews', 'no-show', 'Mark no-show.'),
    ...transition('Interviews', 'interviews', 'cancel', 'Cancel.', reasonProp, ['reason']),
    '/interviews/{id}/panel': {
      put: {
        tags: ['Interviews'], summary: 'Replace the panel.',
        parameters: [idPath],
        responses: { 200: { description: 'Updated.' }, ...COMMON_ERRORS },
      },
    },
    '/interviews/{id}/assessment': {
      put: {
        tags: ['Interviews'],
        summary: 'Submit or revise your assessment.',
        description:
          'The evaluator is the authenticated user; it cannot be supplied in the body. '
          + 'Scores are 1–5 or the literal "NA", which is excluded from the average rather '
          + 'than scored zero. Produces a recommendation only — it never moves the candidate.',
        parameters: [idPath],
        responses: { 200: { description: 'Recorded.' }, ...COMMON_ERRORS },
      },
    },
    '/interviews/{id}/recommendation': {
      get: {
        tags: ['Interviews'],
        summary: 'Rule-based recommendation aggregated from the panel\'s assessments.',
        parameters: [idPath],
        responses: { 200: { description: 'Recommendation.' }, ...COMMON_ERRORS },
      },
    },

    '/offers': {
      post: {
        tags: ['Offers'],
        summary: 'Draft an offer.',
        description:
          'Compensation is a list of {componentCode, amount}. Amounts are entered by hand; '
          + 'no ratio or derivation exists anywhere in the system.',
        responses: { 201: { description: 'Drafted.' }, ...COMMON_ERRORS },
      },
    },
    '/offers/{id}/compensation': {
      put: {
        tags: ['Offers'], summary: 'Replace compensation lines. Locked once the offer is out.',
        parameters: [idPath],
        responses: { 200: { description: 'Updated.' }, ...COMMON_ERRORS },
      },
    },
    ...transition('Offers', 'offers', 'submit', 'Submit for approval.'),
    ...transition('Offers', 'offers', 'recall', 'Recall from approval.'),
    ...transition('Offers', 'offers', 'approve', 'Approve. Self-approval is refused (BL-12).'),
    ...transition('Offers', 'offers', 'reject-approval', 'Reject at approval.', reasonProp, ['reason']),
    ...transition(
      'Offers', 'offers', 'send',
      'Issue the offer. Pins the template and variable snapshot so a reprint years later '
      + 'reproduces the original document. Moves the application to OFFER_SENT.',
    ),
    ...transition('Offers', 'offers', 'accept', 'Record acceptance.'),
    ...transition('Offers', 'offers', 'decline', 'Record a decline.', reasonProp, ['reason']),
    ...transition('Offers', 'offers', 'withdraw', 'Withdraw the offer.', reasonProp, ['reason']),
  },
});

const VIEWER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Arabtec Recruitment Hub API</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 :root{color-scheme:light dark}
 body{font:15px/1.55 ui-sans-serif,system-ui,sans-serif;margin:0;padding:2rem;max-width:60rem}
 h1{font-size:1.4rem;margin:0 0 .25rem}
 .sub{opacity:.7;margin:0 0 2rem}
 .op{display:flex;gap:.75rem;align-items:baseline;padding:.5rem 0;border-top:1px solid #8883}
 .m{font:600 11px ui-monospace,monospace;padding:.15rem .45rem;border-radius:3px;
    background:#8882;letter-spacing:.04em;min-width:3.4rem;text-align:center}
 .p{font:13px ui-monospace,monospace}
 .s{opacity:.75;font-size:.9em}
 h2{font-size:1rem;margin:2rem 0 0}
 a{color:inherit}
</style></head><body>
<h1>Arabtec Recruitment Hub API</h1>
<p class="sub">OpenAPI 3.1 · <a href="./openapi.json">openapi.json</a></p>
<div id="out">Loading…</div>
<script>
fetch('./openapi.json').then(r=>r.json()).then(doc=>{
  const byTag={};
  for(const [path,ops] of Object.entries(doc.paths)){
    for(const [method,op] of Object.entries(ops)){
      const tag=(op.tags&&op.tags[0])||'Other';
      (byTag[tag]=byTag[tag]||[]).push({method,path,summary:op.summary||''});
    }
  }
  const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  document.getElementById('out').innerHTML=Object.entries(byTag).map(([tag,ops])=>
    '<h2>'+esc(tag)+'</h2>'+ops.map(o=>
      '<div class="op"><span class="m">'+esc(o.method.toUpperCase())+
      '</span><span class="p">'+esc(o.path)+'</span><span class="s">'+esc(o.summary)+'</span></div>'
    ).join('')).join('');
}).catch(e=>{document.getElementById('out').textContent='Failed to load: '+e.message;});
</script></body></html>`;

export const openApiRoutes = (): Router => {
  const router = createRouter();
  const document = openApiDocument();

  router.get('/openapi.json', (_req, res) => { res.json(document); });
  router.get('/', (_req, res) => { res.type('html').send(VIEWER_HTML); });

  return router;
};
