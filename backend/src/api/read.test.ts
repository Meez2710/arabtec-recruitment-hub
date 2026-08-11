// Read-layer integration tests — real HTTP, real database.

import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import { createTestDatabase } from '../infrastructure/db/testing/database.js';
import type { TestDatabase } from '../infrastructure/db/testing/database.js';
import { compose } from './composition-root.js';
import type { Application as Composed } from './composition-root.js';
import { createApiApp, API_PREFIX } from './server.js';
import { JwtTokenVerifier } from './auth/authenticate.js';
import { StaticPrincipalResolver } from './auth/principal.js';
import type { Principal } from './auth/principal.js';
import { DEFAULT_CONFIG } from './infrastructure/gateways.js';

const SECRET = 'test-secret';

const ALL_PERMS = [
  'requisition.create', 'requisition.edit', 'requisition.submit', 'requisition.approve',
  'requisition.assign_recruiter', 'requisition.hold', 'requisition.close',
  'requisition.view_all', 'requisition.view_own',
  'candidate.link', 'candidate.move_stage', 'hiring.record',
  'interview.schedule', 'interview.edit', 'interview.feedback',
  'interview.view_all', 'interview.view_assigned',
  'offer.create', 'offer.edit', 'offer.approve', 'offer.approve_director',
  'offer.send', 'offer.result_update',
];

const principal = (over: Partial<Principal> = {}): Principal => ({
  userId: 7, userName: 'Mona Adel', permissions: ALL_PERMS,
  projectScopes: [], isGlobalScope: true, tenantId: 1,
  mustChangePassword: false, status: 'active', ...over,
});

const PRINCIPALS = new Map<number, Principal>([
  [7, principal()],
  [11, principal({ userId: 11, userName: 'Approver' })],
  // VIEW_OWN but not VIEW_ALL — must be pinned to their own records.
  [20, principal({
    userId: 20, userName: 'Own Only',
    permissions: ALL_PERMS.filter((p) => p !== 'requisition.view_all' && p !== 'interview.view_all'),
  })],
  // Scoped to project 3 only.
  [21, principal({ userId: 21, userName: 'Scoped', isGlobalScope: false, projectScopes: [3] })],
]);

let harness: TestDatabase;
let composed: Composed;
let app: Express;

const auth = (userId = 7): string => `Bearer ${jwt.sign({ sub: userId }, SECRET, { expiresIn: '1h' })}`;
const get = (path: string, userId = 7): request.Test =>
  request(app).get(`${API_PREFIX}${path}`).set('Authorization', auth(userId));

beforeAll(async () => {
  harness = await createTestDatabase();
  composed = compose(harness.db, {
    year: () => 2026,
    config: { ...DEFAULT_CONFIG, requisitionApprovalRequired: false },
  });
  app = createApiApp({
    app: composed,
    verifier: new JwtTokenVerifier(SECRET),
    principals: new StaticPrincipalResolver(PRINCIPALS),
  });
});

afterAll(async () => { await harness.close(); });
beforeEach(async () => { await harness.reset(); });

/* ------------------------------- fixtures --------------------------------- */

const post = (path: string, body: unknown, userId = 7): request.Test =>
  request(app).post(`${API_PREFIX}${path}`).set('Authorization', auth(userId)).send(body as object);

const openRequisition = async (over: Record<string, unknown> = {}): Promise<number> => {
  const created = await post('/requisitions', {
    title: 'Site Engineer', projectId: 3, departmentId: 4, headcount: 2, ...over,
  }).expect(201);
  const id = created.body.id as number;
  await post(`/requisitions/${id}/submit`, {}).expect(200);
  await post(`/requisitions/${id}/recruiter`, { recruiterId: 7 }).expect(200);
  return id;
};

const addCandidate = async (requisitionId: number, candidateId: number): Promise<number> =>
  (await post('/applications', { requisitionId, candidateId }).expect(201)).body.id as number;

/**
 * Interview slots must be in the future — the aggregate refuses a past slot and
 * the clock here is the real one, so a hard-coded date rots.
 */
const FUTURE = new Date(Date.now() + 30 * 86_400_000).toISOString();
const PAST_WINDOW = new Date(Date.now() + 29 * 86_400_000).toISOString();
const FAR_WINDOW = new Date(Date.now() + 31 * 86_400_000).toISOString();
const BEYOND = new Date(Date.now() + 60 * 86_400_000).toISOString();

/** Scheduling and offer drafting both require the application to be INTERVIEWING. */
const toInterviewing = async (appId: number): Promise<void> => {
  for (const stage of ['MATCHED', 'INTERVIEWING']) {
    await post(`/applications/${appId}/transition`, { toStage: stage }).expect(200);
  }
};

/* ------------------------------ requisitions ------------------------------ */

describe('GET /requisitions', () => {
  it('paginates with a total that survives the limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      await post('/requisitions', {
        title: `Role ${i}`, projectId: 3, departmentId: 4, headcount: 1,
      }).expect(201);
    }

    const page = await get('/requisitions?limit=2&offset=0').expect(200);
    expect(page.body.items).toHaveLength(2);
    // The count comes from the same query as the rows, so it cannot disagree.
    expect(page.body.total).toBe(5);
    expect(page.body).toMatchObject({ limit: 2, offset: 0 });

    const second = await get('/requisitions?limit=2&offset=4').expect(200);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.total).toBe(5);
  });

  it('rolls up seat and application counts without a second query per row', async () => {
    const id = await openRequisition({ headcount: 3 });
    await addCandidate(id, 501);
    await addCandidate(id, 502);

    harness.queries.start();
    const res = await get('/requisitions?limit=50').expect(200);
    const statements = harness.queries.stop()
      .filter((q) => /^\s*select/i.test(q) && !/nextval/i.test(q));

    const row = res.body.items.find((r: { id: number }) => r.id === id);
    expect(row).toMatchObject({ headcount: 3, openSeats: 3, filledSeats: 0, applicationCount: 2 });
    // ONE statement for the whole list, rollups included.
    expect(statements).toHaveLength(1);
  });

  it('filters by state, project and free text', async () => {
    const open = await openRequisition({ title: 'Crane Operator' });
    await post('/requisitions', {
      title: 'Draft Only', projectId: 9, departmentId: 4, headcount: 1,
    }).expect(201);

    expect((await get('/requisitions?state=OPEN').expect(200)).body.items.map((r: { id: number }) => r.id))
      .toEqual([open]);
    expect((await get('/requisitions?state=OPEN,DRAFT').expect(200)).body.total).toBe(2);
    expect((await get('/requisitions?projectId=9').expect(200)).body.total).toBe(1);
    expect((await get('/requisitions?q=crane').expect(200)).body.items.map((r: { id: number }) => r.id))
      .toEqual([open]);
    expect((await get('/requisitions?q=REQ-2026').expect(200)).body.total).toBe(2);
    expect((await get('/requisitions?hasOpenSeats=true').expect(200)).body.total).toBe(2);
  });

  it('sorts on a whitelisted column and ignores anything else', async () => {
    await post('/requisitions', { title: 'AAA', projectId: 3, departmentId: 4, headcount: 1 });
    await post('/requisitions', { title: 'ZZZ', projectId: 3, departmentId: 4, headcount: 1 });

    const asc = await get('/requisitions?sort=title&direction=asc').expect(200);
    expect(asc.body.items[0].title).toBe('AAA');

    // A stale bookmark with an unknown sort should render a list, not 400.
    const bogus = await get('/requisitions?sort=;drop table&direction=asc').expect(200);
    expect(bogus.body.items).toHaveLength(2);
  });

  it('returns the detail with its seats, and 404 for anything unreachable', async () => {
    const id = await openRequisition();
    const detail = await get(`/requisitions/${id}`).expect(200);
    expect(detail.body.seats).toHaveLength(2);
    expect(detail.body.seats[0]).toMatchObject({ seatNo: 1, state: 'OPEN' });

    await get('/requisitions/99999').expect(404);
  });

  it('pins a VIEW_OWN caller to their own records', async () => {
    await openRequisition();                                     // recruiter 7
    await post('/requisitions', {
      title: 'Someone else', projectId: 3, departmentId: 4, headcount: 1,
    }).expect(201);

    // User 20 owns nothing, and cannot widen the filter by asking for user 7.
    expect((await get('/requisitions', 20).expect(200)).body.total).toBe(0);
    expect((await get('/requisitions?recruiterId=7', 20).expect(200)).body.total).toBe(0);
  });

  it('hides out-of-scope rows from a project-scoped caller', async () => {
    await openRequisition({ projectId: 3 });
    await post('/requisitions', {
      title: 'Other project', projectId: 77, departmentId: 4, headcount: 1,
    }).expect(201);

    const scoped = await get('/requisitions', 21).expect(200);
    expect(scoped.body.total).toBe(1);
    expect(scoped.body.items[0].projectId).toBe(3);
  });
});

/* ------------------------------ applications ------------------------------ */

describe('GET /applications', () => {
  it('joins the requisition once for the whole page', async () => {
    const reqId = await openRequisition();
    for (const c of [501, 502, 503]) await addCandidate(reqId, c);

    harness.queries.start();
    const res = await get('/applications?limit=50').expect(200);
    const statements = harness.queries.stop().filter((q) => /^\s*select/i.test(q));

    expect(res.body.total).toBe(3);
    expect(res.body.items[0]).toMatchObject({
      requisitionTicketNo: 'REQ-2026-00001', requisitionTitle: 'Site Engineer',
    });
    expect(statements).toHaveLength(1);
  });

  it('filters by stage, requisition, liveOnly and due date', async () => {
    const reqId = await openRequisition();
    const a = await addCandidate(reqId, 501);
    const b = await addCandidate(reqId, 502);

    await post(`/applications/${a}/transition`, { toStage: 'MATCHED' }).expect(200);
    await post(`/applications/${b}/transition`, {
      toStage: 'REJECTED', reason: 'not a fit',
    }).expect(200);
    await request(app).put(`${API_PREFIX}/applications/${a}/next-action`)
      .set('Authorization', auth())
      .send({ action: 'call them', dueAt: '2026-01-01T09:00:00.000Z' })
      .expect(200);

    expect((await get('/applications?stage=MATCHED').expect(200)).body.total).toBe(1);
    expect((await get('/applications?liveOnly=true').expect(200)).body.total).toBe(1);
    expect((await get(`/applications?requisitionId=${reqId}`).expect(200)).body.total).toBe(2);
    expect((await get('/applications?dueBefore=2026-06-01T00:00:00.000Z').expect(200)).body.total)
      .toBe(1);
    expect((await get('/applications?dueBefore=2025-06-01T00:00:00.000Z').expect(200)).body.total)
      .toBe(0);
  });

  it('returns the detail with its full stage history', async () => {
    const reqId = await openRequisition();
    const id = await addCandidate(reqId, 501);
    await post(`/applications/${id}/transition`, { toStage: 'MATCHED' }).expect(200);

    const detail = await get(`/applications/${id}`).expect(200);
    expect(detail.body.history.map((h: { toStage: string }) => h.toStage))
      .toEqual(['SOURCED', 'MATCHED']);
    expect(detail.body.reasons).toEqual({});
  });
});

/* ------------------------------- interviews ------------------------------- */

describe('GET /interviews', () => {
  const schedule = async (reqId: number, appId: number, startsAt: string): Promise<number> =>
    (await post('/interviews', {
      applicationId: appId, candidateId: 501, requisitionId: reqId,
      mode: 'ONSITE', startsAt, durationMinutes: 60,
      panel: [
        { userId: 11, role: 'RECRUITER', isLead: true },
        { userId: 12, role: 'HIRING_MANAGER', isLead: false },
      ],
    }).expect(201)).body.interview.id as number;

  it('aggregates the panel without duplicating rows', async () => {
    const reqId = await openRequisition();
    const appId = await addCandidate(reqId, 501);
    await toInterviewing(appId);
    await schedule(reqId, appId, FUTURE);

    const res = await get('/interviews').expect(200);
    // A join on the panel would have returned this interview twice and made the
    // total 2.
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].panelUserIds).toEqual([11, 12]);
    expect(res.body.items[0].assessmentCount).toBe(0);
  });

  it('filters by window and panellist', async () => {
    const reqId = await openRequisition();
    const appId = await addCandidate(reqId, 501);
    await toInterviewing(appId);
    await schedule(reqId, appId, FUTURE);

    expect((await get(`/interviews?from=${PAST_WINDOW}&to=${FAR_WINDOW}`)
      .expect(200)).body.total).toBe(1);
    expect((await get(`/interviews?from=${BEYOND}`).expect(200)).body.total).toBe(0);
    expect((await get('/interviews?panellistId=11').expect(200)).body.total).toBe(1);
    expect((await get('/interviews?panellistId=99').expect(200)).body.total).toBe(0);
    expect((await get('/interviews?status=CANCELLED').expect(200)).body.total).toBe(0);
  });

  it('pins a VIEW_ASSIGNED caller to interviews they sit on', async () => {
    const reqId = await openRequisition();
    const appId = await addCandidate(reqId, 501);
    await toInterviewing(appId);
    await schedule(reqId, appId, FUTURE);

    // User 20 is not on the panel, and asking for someone else's id must not help.
    expect((await get('/interviews', 20).expect(200)).body.total).toBe(0);
    expect((await get('/interviews?panellistId=11', 20).expect(200)).body.total).toBe(0);
  });

  it('returns the detail with panel and assessments', async () => {
    const reqId = await openRequisition();
    const appId = await addCandidate(reqId, 501);
    await toInterviewing(appId);
    const id = await schedule(reqId, appId, FUTURE);

    await request(app).put(`${API_PREFIX}/interviews/${id}/assessment`)
      .set('Authorization', auth(11))
      .send({
        scores: {
          openness: 4, conscientiousness: 'NA', extraversion: 3,
          agreeableness: 5, emotional_stability: 4,
        },
        justification: 'solid',
      })
      .expect(200);

    const detail = await get(`/interviews/${id}`).expect(200);
    expect(detail.body.panel).toHaveLength(2);
    expect(detail.body.assessments).toHaveLength(1);
    // 'NA' survives as the string it is — coercing it would change the fit score.
    expect(detail.body.assessments[0].scores.conscientiousness).toBe('NA');
  });
});

/* --------------------------------- offers --------------------------------- */

describe('GET /offers', () => {
  const draft = async (reqId: number, appId: number): Promise<number> =>
    (await post('/offers', {
      applicationId: appId, candidateId: 501, requisitionId: reqId,
      positionTitle: 'Site Engineer', currency: 'EGP',
      lines: [
        { componentCode: 'BASIC_SALARY', amount: 12500.5 },
        { componentCode: 'TRANSPORTATION', amount: 1250.25 },
      ],
    }).expect(201)).body.id as number;

  const seed = async (): Promise<{ reqId: number; appId: number; offerId: number }> => {
    const reqId = await openRequisition();
    const appId = await addCandidate(reqId, 501);
    for (const stage of ['MATCHED', 'INTERVIEWING']) {
      await post(`/applications/${appId}/transition`, { toStage: stage }).expect(200);
    }
    return { reqId, appId, offerId: await draft(reqId, appId) };
  };

  it('sums compensation in SQL as a number', async () => {
    const { offerId } = await seed();
    const list = await get('/offers').expect(200);
    expect(list.body.items[0]).toMatchObject({ id: offerId, status: 'DRAFT' });
    // Summed by the database, not concatenated.
    expect(list.body.items[0].totalNet).toBeCloseTo(13750.75, 2);
    expect(typeof list.body.items[0].totalNet).toBe('number');
  });

  it('filters by status, awaiting approval and expiry', async () => {
    const { offerId } = await seed();
    expect((await get('/offers?status=DRAFT').expect(200)).body.total).toBe(1);
    expect((await get('/offers?awaitingApproval=true').expect(200)).body.total).toBe(0);

    await post(`/offers/${offerId}/submit`, {}).expect(200);
    expect((await get('/offers?awaitingApproval=true').expect(200)).body.total).toBe(1);

    await post(`/offers/${offerId}/approve`, {}, 11).expect(200);
    await post(`/offers/${offerId}/send`, {}).expect(200);
    // Sent with 5 days validity; a far-future cutoff catches it, a near one does not.
    expect((await get('/offers?expiringBefore=2030-01-01T00:00:00.000Z').expect(200)).body.total)
      .toBe(1);
    expect((await get('/offers?expiringBefore=2026-01-01T00:00:00.000Z').expect(200)).body.total)
      .toBe(0);
  });

  it('returns the detail with its lines', async () => {
    const { offerId } = await seed();
    const detail = await get(`/offers/${offerId}`).expect(200);
    expect(detail.body.lines).toHaveLength(2);
    expect(detail.body.lines.map((l: { componentCode: string }) => l.componentCode))
      .toEqual(['BASIC_SALARY', 'TRANSPORTATION']);
    expect(detail.body.lines[0].amount).toBeCloseTo(12500.5, 2);
  });
});

/* -------------------------------- timeline -------------------------------- */

describe('GET /timeline', () => {
  it('returns an entity history newest first', async () => {
    const id = await openRequisition();
    const res = await get(`/timeline?entityType=Requisition&entityId=${id}`).expect(200);

    expect(res.body.total).toBeGreaterThan(1);
    const times = res.body.items.map((t: { occurredAt: string }) => Date.parse(t.occurredAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(res.body.items.every((t: { entityType: string }) => t.entityType === 'Requisition'))
      .toBe(true);
  });

  it('filters by actor and event type', async () => {
    const id = await openRequisition();
    expect((await get(`/timeline?entityId=${id}&actorId=7`).expect(200)).body.total)
      .toBeGreaterThan(0);
    expect((await get(`/timeline?entityId=${id}&actorId=999`).expect(200)).body.total).toBe(0);
  });

  it('hides audit rows for entities the caller cannot reach', async () => {
    await openRequisition({ projectId: 77 });
    // The trail carries no project of its own, so reachability is proven
    // through the entity. A scoped caller must not read around it.
    expect((await get('/timeline', 21).expect(200)).body.total).toBe(0);
    expect((await get('/timeline').expect(200)).body.total).toBeGreaterThan(0);
  });
});

/* ------------------------------- dashboard -------------------------------- */

describe('GET /dashboard/summary', () => {
  it('reports counts grouped in SQL', async () => {
    const reqId = await openRequisition({ headcount: 2 });
    const appId = await addCandidate(reqId, 501);
    await post(`/applications/${appId}/transition`, { toStage: 'MATCHED' }).expect(200);
    await post('/requisitions', {
      title: 'Draft', projectId: 3, departmentId: 4, headcount: 1,
    }).expect(201);

    const res = await get('/dashboard/summary').expect(200);
    expect(res.body.requisitions.byState).toMatchObject({ OPEN: 1, DRAFT: 1 });
    expect(res.body.requisitions.openSeats).toBe(3);
    expect(res.body.requisitions.filledSeats).toBe(0);
    expect(res.body.applications.byStage).toMatchObject({ MATCHED: 1 });
    expect(res.body.applications.live).toBe(1);
  });

  it('scopes My Work to the calling user', async () => {
    const reqId = await openRequisition();
    const appId = await addCandidate(reqId, 501);
    await request(app).put(`${API_PREFIX}/applications/${appId}/next-action`)
      .set('Authorization', auth())
      .send({ action: 'call', dueAt: '2020-01-01T09:00:00.000Z' })
      .expect(200);

    const mine = await get('/dashboard/summary').expect(200);
    expect(mine.body.myWork.overdue).toBe(1);
    expect(mine.body.myWork.myRequisitions).toBe(1);

    // A different user owns none of it.
    const theirs = await get('/dashboard/summary', 11).expect(200);
    expect(theirs.body.myWork.overdue).toBe(0);
    expect(theirs.body.myWork.myRequisitions).toBe(0);
  });

  it('excludes offers the caller prepared from their own approval queue', async () => {
    const reqId = await openRequisition();
    const appId = await addCandidate(reqId, 501);
    for (const stage of ['MATCHED', 'INTERVIEWING']) {
      await post(`/applications/${appId}/transition`, { toStage: stage }).expect(200);
    }
    const offerId = (await post('/offers', {
      applicationId: appId, candidateId: 501, requisitionId: reqId,
      positionTitle: 'Site Engineer', currency: 'EGP',
      lines: [{ componentCode: 'BASIC_SALARY', amount: 10000 }],
    }).expect(201)).body.id as number;
    await post(`/offers/${offerId}/submit`, {}).expect(200);

    // BL-12: you cannot approve what you prepared, so it is not in your queue.
    expect((await get('/dashboard/summary').expect(200)).body.myWork.offersAwaitingMyApproval)
      .toBe(0);
    expect((await get('/dashboard/summary', 11).expect(200)).body.myWork.offersAwaitingMyApproval)
      .toBe(1);
  });
});
