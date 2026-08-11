// API integration tests — the real app, in process, over real HTTP.
//
// No mocked services and no stubbed repositories. A request enters Express,
// passes middleware, reaches a controller, runs a service, writes through a
// repository into a real PostgreSQL, commits, and delivers events to real
// subscribers. If any layer's contract is wrong, these fail.
//
// PGlite by default so this runs anywhere; a real server when
// TEST_DATABASE_URL is set. Same tests either way.

import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import { createTestDatabase } from '../infrastructure/db/testing/database.js';
import type { TestDatabase } from '../infrastructure/db/testing/database.js';
import { timelineEntry } from '../infrastructure/db/schema/index.js';
import { compose } from './composition-root.js';
import type { Application as Composed } from './composition-root.js';
import { createApiApp, API_PREFIX } from './server.js';
import { JwtTokenVerifier } from './auth/authenticate.js';
import { StaticPrincipalResolver } from './auth/principal.js';
import type { Principal } from './auth/principal.js';
import { RecordingNotificationHub } from './infrastructure/subscribers/notification-subscriber.js';
import { DEFAULT_CONFIG } from './infrastructure/gateways.js';

const SECRET = 'test-secret';

const principal = (over: Partial<Principal> = {}): Principal => ({
  userId: 7,
  userName: 'Mona Adel',
  permissions: [
    'requisition.create', 'requisition.edit', 'requisition.submit', 'requisition.approve',
    'requisition.assign_recruiter', 'requisition.hold', 'requisition.close',
    'requisition.cancel', 'requisition.reopen',
    'candidate.link', 'candidate.move_stage', 'application.bulk_action',
    'hiring.record', 'hiring.reverse',
    'interview.schedule', 'interview.edit', 'interview.feedback', 'interview.view_all',
    'offer.create', 'offer.edit', 'offer.approve', 'offer.approve_director',
    'offer.send', 'offer.result_update',
  ],
  projectScopes: [],
  isGlobalScope: true,
  tenantId: 1,
  mustChangePassword: false,
  status: 'active',
  ...over,
});

const PRINCIPALS = new Map<number, Principal>([
  [7, principal()],
  [8, principal({ userId: 8, userName: 'Limited User', permissions: ['requisition.create'] })],
  [9, principal({ userId: 9, userName: 'Must Change', mustChangePassword: true })],
  [10, principal({ userId: 10, userName: 'Suspended', status: 'suspended' })],
  [11, principal({ userId: 11, userName: 'Approver' })],
]);

const tokenFor = (userId: number): string => jwt.sign({ sub: userId }, SECRET, { expiresIn: '1h' });

let harness: TestDatabase;
let composed: Composed;
let app: Express;
let hub: RecordingNotificationHub;

const auth = (userId = 7): string => `Bearer ${tokenFor(userId)}`;

beforeAll(async () => {
  harness = await createTestDatabase();
  hub = new RecordingNotificationHub();
  composed = compose(harness.db, {
    notifications: hub,
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
beforeEach(async () => { await harness.reset(); hub.dispatched.length = 0; });

/* --------------------------- helpers -------------------------------------- */

const createRequisition = async (over: Record<string, unknown> = {}): Promise<{
  id: number; version: number;
}> => {
  const res = await request(app)
    .post(`${API_PREFIX}/requisitions`)
    .set('Authorization', auth())
    .send({ title: 'Site Engineer', projectId: 3, departmentId: 4, headcount: 2, ...over });
  expect(res.status).toBe(201);
  return { id: res.body.id as number, version: res.body.version as number };
};

/** DRAFT -> APPROVED (approval disabled) -> OPEN via recruiter assignment. */
const openRequisition = async (): Promise<number> => {
  const { id } = await createRequisition();
  await request(app).post(`${API_PREFIX}/requisitions/${id}/submit`)
    .set('Authorization', auth()).send({}).expect(200);
  await request(app).post(`${API_PREFIX}/requisitions/${id}/recruiter`)
    .set('Authorization', auth()).send({ recruiterId: 7 }).expect(200);
  return id;
};

const addCandidate = async (requisitionId: number, candidateId: number): Promise<number> => {
  const res = await request(app).post(`${API_PREFIX}/applications`)
    .set('Authorization', auth())
    .send({ requisitionId, candidateId });
  expect(res.status).toBe(201);
  return res.body.id as number;
};

/**
 * Take a candidate all the way to HIRED, the only way the domain allows.
 *
 * Note what is NOT here: no manual move to OFFER_PREPARATION. Drafting an offer
 * drives that transition itself, and no endpoint can set OFFER_SENT or HIRED
 * directly — those are SYSTEM transitions owned by the Offer context (BL-14).
 * A hire therefore REQUIRES an issued and accepted offer.
 */
const takeToHired = async (
  reqId: number, appId: number, candidateId: number, offerNo: number,
): Promise<void> => {
  for (const stage of ['MATCHED', 'INTERVIEWING']) {
    await request(app).post(`${API_PREFIX}/applications/${appId}/transition`)
      .set('Authorization', auth()).send({ toStage: stage }).expect(200);
  }

  const offerRes = await request(app).post(`${API_PREFIX}/offers`)
    .set('Authorization', auth())
    .send({
      applicationId: appId, candidateId, requisitionId: reqId,
      positionTitle: 'Site Engineer', currency: 'EGP',
      lines: [{ componentCode: 'BASIC_SALARY', amount: 10_000 + offerNo }],
    })
    .expect(201);
  const offerId = offerRes.body.id as number;

  await request(app).post(`${API_PREFIX}/offers/${offerId}/submit`)
    .set('Authorization', auth()).send({}).expect(200);
  // BL-12: user 7 prepared it, so a different user must approve.
  await request(app).post(`${API_PREFIX}/offers/${offerId}/approve`)
    .set('Authorization', auth(11)).send({}).expect(200);
  await request(app).post(`${API_PREFIX}/offers/${offerId}/send`)
    .set('Authorization', auth()).send({}).expect(200);
  await request(app).post(`${API_PREFIX}/offers/${offerId}/accept`)
    .set('Authorization', auth()).send({}).expect(200);
};

/* ------------------------------ 1. auth ----------------------------------- */

describe('authentication', () => {
  it('rejects a request with no credentials', async () => {
    const res = await request(app).get(`${API_PREFIX}/interviews/1/recommendation`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a malformed, unsigned or expired token identically', async () => {
    for (const token of [
      'Bearer nonsense',
      `Bearer ${jwt.sign({ sub: 7 }, 'wrong-secret')}`,
      `Bearer ${jwt.sign({ sub: 7 }, SECRET, { expiresIn: '-1h' })}`,
    ]) {
      const res = await request(app).post(`${API_PREFIX}/requisitions`)
        .set('Authorization', token).send({});
      // Same answer to all three. Distinguishing them tells an attacker which
      // half of the problem to work on.
      expect(res.status).toBe(401);
    }
  });

  it('rejects a token for a user who no longer exists', async () => {
    const res = await request(app).post(`${API_PREFIX}/requisitions`)
      .set('Authorization', auth(999)).send({});
    expect(res.status).toBe(401);
  });

  it('blocks a suspended account and one that must change its password', async () => {
    const suspended = await request(app).post(`${API_PREFIX}/requisitions`)
      .set('Authorization', auth(10)).send({});
    expect(suspended.status).toBe(403);
    expect(suspended.body.error.code).toBe('ACCOUNT_INACTIVE');

    const mustChange = await request(app).post(`${API_PREFIX}/requisitions`)
      .set('Authorization', auth(9)).send({});
    expect(mustChange.status).toBe(403);
    expect(mustChange.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('accepts the cookie the live UI already sets', async () => {
    const res = await request(app).post(`${API_PREFIX}/requisitions`)
      .set('Cookie', `token=${tokenFor(7)}`)
      .send({ title: 'Via cookie', projectId: 3, departmentId: 4, headcount: 1 });
    expect(res.status).toBe(201);
  });
});

describe('authorization', () => {
  it('refuses an operation the caller lacks permission for', async () => {
    const res = await request(app).post(`${API_PREFIX}/requisitions/1/close`)
      .set('Authorization', auth(8)).send({ reason: 'no longer needed' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('is enforced by the SERVICE, not only by the route gate', async () => {
    // The route gate is defence in depth. Calling the service directly with a
    // context that lacks the permission must still be refused — otherwise a
    // worker or a job could bypass authorization entirely.
    const { AuthContext } = await import('../modules/shared/kernel/auth-context.js');
    const powerless = new AuthContext({
      tenantId: 1, userId: 8, userName: 'Limited', permissions: [],
      projectScopes: [], isGlobalScope: true,
    });
    await expect(composed.requisitions.create(
      { title: 'x', projectId: 3, departmentId: 4, headcount: 1 }, powerless,
    )).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

/* --------------------------- 2. validation -------------------------------- */

describe('validation', () => {
  it('rejects a malformed body with 400 and per-field detail', async () => {
    const res = await request(app).post(`${API_PREFIX}/requisitions`)
      .set('Authorization', auth())
      .send({ title: '', projectId: 'abc', departmentId: 4, headcount: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    const paths = (res.body.error.details.issues as { path: string }[]).map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['title', 'projectId', 'headcount']));
  });

  it('rejects an unparseable path id before reaching a service', async () => {
    const res = await request(app).post(`${API_PREFIX}/requisitions/not-a-number/submit`)
      .set('Authorization', auth()).send({});
    expect(res.status).toBe(400);
  });

  it('rejects a stage outside the domain vocabulary', async () => {
    const res = await request(app).post(`${API_PREFIX}/applications/1/transition`)
      .set('Authorization', auth()).send({ toStage: 'PROMOTED' });
    expect(res.status).toBe(400);
  });

  it('rejects money with more than two decimal places', async () => {
    const res = await request(app).post(`${API_PREFIX}/offers`)
      .set('Authorization', auth())
      .send({
        applicationId: 1, candidateId: 1, requisitionId: 1,
        positionTitle: 'Engineer', currency: 'EGP',
        lines: [{ componentCode: 'BASIC_SALARY', amount: 1000.005 }],
      });
    expect(res.status).toBe(400);
  });

  it('returns 404 with a distinct code for an unknown route', async () => {
    const res = await request(app).get(`${API_PREFIX}/nope`).set('Authorization', auth());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
  });
});

/* ----------------------- 3. the happy path, end to end -------------------- */

describe('requisition lifecycle', () => {
  it('creates, submits, opens and closes through the real stack', async () => {
    const { id } = await createRequisition({ headcount: 3 });

    const submitted = await request(app).post(`${API_PREFIX}/requisitions/${id}/submit`)
      .set('Authorization', auth()).send({}).expect(200);
    expect(submitted.body.state).toBe('APPROVED');

    const opened = await request(app).post(`${API_PREFIX}/requisitions/${id}/recruiter`)
      .set('Authorization', auth()).send({ recruiterId: 7 }).expect(200);
    expect(opened.body.state).toBe('OPEN');

    const closed = await request(app).post(`${API_PREFIX}/requisitions/${id}/close`)
      .set('Authorization', auth()).send({ reason: 'filled' }).expect(200);
    expect(closed.body.state).toBe('CLOSED');
  });

  it('returns 422 when a business rule refuses, with a message worth showing', async () => {
    const { id } = await createRequisition();
    // RESUME is only legal from ON_HOLD. From DRAFT there is no such edge.
    const res = await request(app).post(`${API_PREFIX}/requisitions/${id}/resume`)
      .set('Authorization', auth()).send({});

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ILLEGAL_TRANSITION');
    expect(res.body.error.message).toMatch(/cannot/i);
  });

  it('returns 409 when the caller is holding a stale version', async () => {
    const { id, version } = await createRequisition();
    await request(app).post(`${API_PREFIX}/requisitions/${id}/submit`)
      .set('Authorization', auth()).send({}).expect(200);

    const stale = await request(app).post(`${API_PREFIX}/requisitions/${id}/recruiter`)
      .set('Authorization', auth())
      .send({ recruiterId: 7, expectedVersion: version });

    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_AGGREGATE');
  });

  it('returns 404 for a requisition that does not exist', async () => {
    const res = await request(app).post(`${API_PREFIX}/requisitions/99999/submit`)
      .set('Authorization', auth()).send({});
    expect(res.status).toBe(404);
  });

  it('hides an out-of-scope requisition as 404, not 403', async () => {
    const { id } = await createRequisition({ projectId: 77 });
    const scoped = new Map(PRINCIPALS);
    scoped.set(12, principal({ userId: 12, isGlobalScope: false, projectScopes: [3] }));
    const scopedApp = createApiApp({
      app: composed,
      verifier: new JwtTokenVerifier(SECRET),
      principals: new StaticPrincipalResolver(scoped),
    });

    const res = await request(scopedApp).post(`${API_PREFIX}/requisitions/${id}/submit`)
      .set('Authorization', `Bearer ${tokenFor(12)}`).send({});
    // Identical to a nonexistent record: status codes must not be usable to
    // enumerate what exists (ADR-0005).
    expect(res.status).toBe(404);
  });
});

/* ------------------------- 4. cross-context flow -------------------------- */

describe('the full hire flow across three contexts', () => {
  it('moves a candidate from sourced to hired and consumes a seat', async () => {
    const reqId = await openRequisition();
    const appId = await addCandidate(reqId, 501);

    await takeToHired(reqId, appId, 501, 1);

    const hired = await request(app).post(`${API_PREFIX}/applications/${appId}/hire`)
      .set('Authorization', auth()).send({}).expect(200);
    expect(hired.body.stage).toBe('HIRED');
    expect(hired.body.filledSeats).toBe(1);
    expect(hired.body.requisitionState).toBe('OPEN');
  });

  it('refuses a hire before an offer has been accepted', async () => {
    // HIRED is reachable only from OFFER_SENT. The API cannot express the
    // shortcut and the domain refuses it.
    const reqId = await openRequisition();
    const appId = await addCandidate(reqId, 505);
    const res = await request(app).post(`${API_PREFIX}/applications/${appId}/hire`)
      .set('Authorization', auth()).send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('round-trips offer money as a number, not a concatenated string', async () => {
    const reqId = await openRequisition();
    const appId = await addCandidate(reqId, 503);
    for (const stage of ['MATCHED', 'INTERVIEWING']) {
      await request(app).post(`${API_PREFIX}/applications/${appId}/transition`)
        .set('Authorization', auth()).send({ toStage: stage }).expect(200);
    }

    const res = await request(app).post(`${API_PREFIX}/offers`)
      .set('Authorization', auth())
      .send({
        applicationId: appId, candidateId: 503, requisitionId: reqId,
        positionTitle: 'Site Engineer', currency: 'EGP',
        lines: [
          { componentCode: 'BASIC_SALARY', amount: 12500.5 },
          { componentCode: 'TRANSPORTATION', amount: 1250.25 },
        ],
      })
      .expect(201);
    expect(res.body.totalNet).toBeCloseTo(13750.75, 2);
  });

  it('refuses self-approval of an offer (BL-12)', async () => {
    const reqId = await openRequisition();
    const appId = await addCandidate(reqId, 502);
    for (const stage of ['MATCHED', 'INTERVIEWING']) {
      await request(app).post(`${API_PREFIX}/applications/${appId}/transition`)
        .set('Authorization', auth()).send({ toStage: stage }).expect(200);
    }
    const offerRes = await request(app).post(`${API_PREFIX}/offers`)
      .set('Authorization', auth())
      .send({
        applicationId: appId, candidateId: 502, requisitionId: reqId,
        positionTitle: 'Site Engineer', currency: 'EGP',
        lines: [{ componentCode: 'BASIC_SALARY', amount: 10000 }],
      })
      .expect(201);

    await request(app).post(`${API_PREFIX}/offers/${offerRes.body.id}/submit`)
      .set('Authorization', auth()).send({}).expect(200);

    const res = await request(app).post(`${API_PREFIX}/offers/${offerRes.body.id}/approve`)
      .set('Authorization', auth()).send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('OFFER_SELF_APPROVAL_FORBIDDEN');
  });

  it('refuses to overfill a requisition', async () => {
    const { id } = await createRequisition({ headcount: 1 });
    await request(app).post(`${API_PREFIX}/requisitions/${id}/submit`)
      .set('Authorization', auth()).send({}).expect(200);
    await request(app).post(`${API_PREFIX}/requisitions/${id}/recruiter`)
      .set('Authorization', auth()).send({ recruiterId: 7 }).expect(200);

    const first = await addCandidate(id, 601);
    const second = await addCandidate(id, 602);
    await takeToHired(id, first, 601, 1);
    await takeToHired(id, second, 602, 2);

    await request(app).post(`${API_PREFIX}/applications/${first}/hire`)
      .set('Authorization', auth()).send({}).expect(200);

    const overfill = await request(app).post(`${API_PREFIX}/applications/${second}/hire`)
      .set('Authorization', auth()).send({});
    expect(overfill.status).toBe(422);
    expect(overfill.body.error.code).toBe('NO_OPEN_SEAT');
  });
});

/* -------------------- 5. correlation, audit, notifications ---------------- */

describe('request context and subscribers', () => {
  it('echoes a supplied correlation id and stamps it on the audit trail', async () => {
    const correlationId = 'trace-abc-123';
    const res = await request(app).post(`${API_PREFIX}/requisitions`)
      .set('Authorization', auth())
      .set('x-correlation-id', correlationId)
      .send({ title: 'Traced', projectId: 3, departmentId: 4, headcount: 1 })
      .expect(201);

    expect(res.headers['x-correlation-id']).toBe(correlationId);
    expect(res.headers['x-request-id']).toBeDefined();

    const rows = await harness.db.select().from(timelineEntry);
    expect(rows.length).toBeGreaterThan(0);
    // One HTTP request, one correlation id, all the way down to the audit rows
    // written by a subscriber after commit.
    expect(rows.every((r) => r.correlationId === correlationId)).toBe(true);
  });

  it('generates a correlation id when the caller supplies none', async () => {
    const res = await request(app).post(`${API_PREFIX}/requisitions`)
      .set('Authorization', auth())
      .send({ title: 'Untraced', projectId: 3, departmentId: 4, headcount: 1 })
      .expect(201);
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('ignores a correlation id that could forge a log line', async () => {
    const res = await request(app).post(`${API_PREFIX}/requisitions`)
      .set('Authorization', auth())
      // Node refuses to transmit a raw newline, so the realistic attack is a
      // value with separators the log format would misread.
      .set('x-correlation-id', 'evil id; INFO: fake log entry')
      .send({ title: 'Injection', projectId: 3, departmentId: 4, headcount: 1 })
      .expect(201);
    expect(res.headers['x-correlation-id']).not.toContain('fake log');
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('writes an audit entry per domain event, without any service calling audit', async () => {
    const { id } = await createRequisition();
    await request(app).post(`${API_PREFIX}/requisitions/${id}/submit`)
      .set('Authorization', auth()).send({}).expect(200);

    const rows = await harness.db.select().from(timelineEntry);
    const types = rows.map((r) => r.eventType);
    expect(types).toContain('RequisitionCreated');
    expect(types).toContain('RequisitionStateChanged');
    expect(rows.every((r) => r.entityType === 'Requisition')).toBe(true);
    // previous/new are NOT NULL by design — an event with nothing to say
    // records `{}`, never a missing column.
    expect(rows.every((r) => r.previousValue !== null && r.newValue !== null)).toBe(true);
  });

  it('does not duplicate audit rows when an event is redelivered', async () => {
    await createRequisition();
    const before = (await harness.db.select().from(timelineEntry)).length;
    expect(before).toBeGreaterThan(0);

    // Simulate a crashed dispatcher: replay everything.
    const { OutboxDispatcher } = await import('../infrastructure/db/outbox-dispatcher.js');
    await new OutboxDispatcher(harness.db, composed.dispatcher).drainUntilEmpty();

    expect((await harness.db.select().from(timelineEntry)).length).toBe(before);
  });

  it('notifies the assigned recruiter without any service sending a message', async () => {
    await openRequisition();
    const titles = hub.dispatched.map((d) => d.request.title);
    expect(titles.some((t) => t.includes('assigned'))).toBe(true);
  });

  it('rolls back state AND events together when an operation fails', async () => {
    const { id } = await createRequisition();
    const before = (await harness.db.select().from(timelineEntry)).length;

    await request(app).post(`${API_PREFIX}/requisitions/${id}/approve`)
      .set('Authorization', auth()).send({}).expect(422);

    // A rejected operation leaves no audit trail of a thing that did not happen.
    expect((await harness.db.select().from(timelineEntry)).length).toBe(before);
  });
});

/* ------------------------------- 6. health -------------------------------- */

describe('health and docs', () => {
  it('answers liveness without touching the database', async () => {
    const res = await request(app).get('/health/live').expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('answers readiness and reports the database', async () => {
    const res = await request(app).get('/health/ready').expect(200);
    expect(res.body).toMatchObject({ status: 'ready', database: 'up' });
  });

  it('reports 503 rather than 500 when a dependency is down', async () => {
    const failing = createApiApp({
      app: composed,
      verifier: new JwtTokenVerifier(SECRET),
      principals: new StaticPrincipalResolver(PRINCIPALS),
      readiness: async () => ({ ok: false, details: { database: 'down' } }),
    });
    const res = await request(failing).get('/health/ready');
    expect(res.status).toBe(503);
  });

  it('reports the outbox backlog and the registered subscribers', async () => {
    await createRequisition();
    const res = await request(app).get('/health/outbox').expect(200);
    expect(res.body.subscribers).toEqual(['audit-timeline', 'notifications']);
    // The post-commit relay delivered everything, so nothing is pending.
    expect(res.body.pending).toBe(0);
    expect(res.body.healthy).toBe(true);
  });

  it('serves the OpenAPI document and a viewer, unauthenticated', async () => {
    const doc = await request(app).get(`${API_PREFIX}/docs/openapi.json`).expect(200);
    expect(doc.body.openapi).toBe('3.1.0');
    expect(Object.keys(doc.body.paths).length).toBeGreaterThan(25);

    const viewer = await request(app).get(`${API_PREFIX}/docs/`).expect(200);
    expect(viewer.text).toContain('Arabtec Recruitment Hub API');
    // No third-party script tag: a docs page that fetches a CDN bundle is a
    // supply-chain hole in every environment it ships to.
    expect(viewer.text).not.toMatch(/src=["']https?:/);
  });
});

/* --------------------------- 7. error hygiene ----------------------------- */

describe('error responses', () => {
  it('never leaks internals on a 500', async () => {
    const broken = compose({
      execute: async () => { throw new Error('connection string: postgres://secret@host/db'); },
      transaction: async () => { throw new Error('connection string: postgres://secret@host/db'); },
    } as never, { year: () => 2026 });

    const brokenApp = createApiApp({
      app: broken,
      verifier: new JwtTokenVerifier(SECRET),
      principals: new StaticPrincipalResolver(PRINCIPALS),
    });

    const res = await request(brokenApp).post(`${API_PREFIX}/requisitions`)
      .set('Authorization', auth())
      .send({ title: 'x', projectId: 3, departmentId: 4, headcount: 1 });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect(res.body.error.details).toBeUndefined();
    // Still correlatable: the operator can find this exact failure in the log.
    expect(res.body.error.requestId).toBeDefined();
  });

  it('carries the request and correlation ids on every error', async () => {
    const res = await request(app).post(`${API_PREFIX}/requisitions`)
      .set('Authorization', auth()).send({ title: '' });
    expect(res.body.error.requestId).toBeDefined();
    expect(res.body.error.correlationId).toBeDefined();
  });
});
