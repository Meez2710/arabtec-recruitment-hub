// Candidate matching — end to end, advisory only.

import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import { createTestDatabase } from '../infrastructure/db/testing/database.js';
import type { TestDatabase } from '../infrastructure/db/testing/database.js';
import { aiTask, candidateMatch, hiringApplication } from '../infrastructure/db/schema/index.js';
import { compose } from './composition-root.js';
import type { Application as Composed } from './composition-root.js';
import { createApiApp, API_PREFIX } from './server.js';
import { JwtTokenVerifier } from './auth/authenticate.js';
import { StaticPrincipalResolver } from './auth/principal.js';
import type { Principal } from './auth/principal.js';
import { InMemoryDocumentStore } from '../modules/talent/infrastructure/document-store.js';
import { DEFAULT_CONFIG } from './infrastructure/gateways.js';
import { AI_CAPABILITIES } from '../modules/shared/kernel/ai/index.js';
import type {
  AIOutcome, CandidateMatch, CandidateMatcher, MatchCriteria,
} from '../modules/shared/kernel/ai/index.js';

const SECRET = 'test-secret';
const PERMS = [
  'candidate.create', 'candidate.view_all', 'candidate.link',
  'requisition.create', 'requisition.submit', 'requisition.assign_recruiter',
  'matching.view', 'matching.request', 'matching.resolve',
];

const principal = (over: Partial<Principal> = {}): Principal => ({
  userId: 7, userName: 'Mona Adel', permissions: PERMS,
  projectScopes: [], isGlobalScope: true, tenantId: 1,
  mustChangePassword: false, status: 'active', ...over,
});
const PRINCIPALS = new Map<number, Principal>([
  [7, principal()],
  [8, principal({ userId: 8, permissions: ['matching.view'] })],
]);

const provenance = {
  capability: AI_CAPABILITIES.CANDIDATE_MATCH,
  modelId: 'qwen2.5-match',
  promptVersionId: 'match-v1',
  producedAt: new Date(),
};

/** Returns whatever it was told to. The pipeline is under test, not a model. */
class StubMatcher implements CandidateMatcher {
  constructor(private outcome: AIOutcome<readonly CandidateMatch[]>) {}
  set(outcome: AIOutcome<readonly CandidateMatch[]>): void { this.outcome = outcome; }
  async match(_c: MatchCriteria): Promise<AIOutcome<readonly CandidateMatch[]>> {
    return this.outcome;
  }
  async score(): Promise<AIOutcome<CandidateMatch>> {
    return { abstained: true, permanent: true, reason: 'not used', provenance };
  }
}

const suggestions = (items: readonly { id: number; score: number }[]):
AIOutcome<readonly CandidateMatch[]> => ({
  content: items.map((i) => ({
    candidateId: i.id,
    score: i.score,
    evidence: [{ dimension: 'skills', detail: 'AutoCAD, Revit', contribution: 0.6 }],
    missingRequirements: ['PMP'],
  })),
  confidence: 0.8,
  reasoningSummary: 'stub',
  sourcesUsed: [],
  provenance,
});

let harness: TestDatabase;
let composed: Composed;
let app: Express;
let matcher: StubMatcher;

const auth = (id = 7): string => `Bearer ${jwt.sign({ sub: id }, SECRET, { expiresIn: '1h' })}`;
const post = (p: string, body: unknown = {}, id = 7): request.Test =>
  request(app).post(`${API_PREFIX}${p}`).set('Authorization', auth(id)).send(body as object);
const get = (p: string, id = 7): request.Test =>
  request(app).get(`${API_PREFIX}${p}`).set('Authorization', auth(id));

beforeAll(async () => {
  harness = await createTestDatabase();
  matcher = new StubMatcher(suggestions([]));
  composed = compose(harness.db, {
    documents: new InMemoryDocumentStore(),
    year: () => 2026,
    config: { ...DEFAULT_CONFIG, requisitionApprovalRequired: false },
    capabilities: { candidateMatcher: matcher },
  });
  app = createApiApp({
    app: composed,
    verifier: new JwtTokenVerifier(SECRET),
    principals: new StaticPrincipalResolver(PRINCIPALS),
  });
});

afterAll(async () => { await harness.close(); });
beforeEach(async () => { await harness.reset(); });

const openRequisition = async (): Promise<number> => {
  const created = await post('/requisitions', {
    title: 'Site Engineer', projectId: 3, departmentId: 4, headcount: 2,
  }).expect(201);
  const id = created.body.id as number;
  await post(`/requisitions/${id}/submit`).expect(200);
  await post(`/requisitions/${id}/recruiter`, { recruiterId: 7 }).expect(200);
  return id;
};

const makeCandidate = async (name: string): Promise<number> =>
  (await post('/candidates', {
    fullName: name, email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`,
  }).expect(201)).body.candidate.id as number;

describe('requesting matches', () => {
  it('queues a task and returns 202 rather than pretending results are ready', async () => {
    const reqId = await openRequisition();
    const res = await post(`/requisitions/${reqId}/matches/refresh`).expect(202);

    expect(res.body.queued).toBe(true);
    const tasks = await harness.db.select().from(aiTask);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ capability: 'candidate.match', priority: 'BATCH' });
  });

  it('is idempotent, and a refresh token forces a new run', async () => {
    const reqId = await openRequisition();
    await post(`/requisitions/${reqId}/matches/refresh`).expect(202);
    const repeat = await post(`/requisitions/${reqId}/matches/refresh`).expect(202);
    expect(repeat.body.queued).toBe(false);
    expect(await harness.db.select().from(aiTask)).toHaveLength(1);

    // A recruiter who edited the requisition wants fresh suggestions.
    const forced = await post(`/requisitions/${reqId}/matches/refresh`, {
      refreshToken: 'after-edit',
    }).expect(202);
    expect(forced.body.queued).toBe(true);
    expect(await harness.db.select().from(aiTask)).toHaveLength(2);
  });

  it('queues nothing when no matcher is configured', async () => {
    const plain = compose(harness.db, {
      documents: new InMemoryDocumentStore(), year: () => 2026,
      config: { ...DEFAULT_CONFIG, requisitionApprovalRequired: false },
    });
    const plainApp = createApiApp({
      app: plain, verifier: new JwtTokenVerifier(SECRET),
      principals: new StaticPrincipalResolver(PRINCIPALS),
    });
    const reqId = await openRequisition();

    const res = await request(plainApp)
      .post(`${API_PREFIX}/requisitions/${reqId}/matches/refresh`)
      .set('Authorization', auth()).send({}).expect(202);
    expect(res.body).toEqual({ queued: false, taskId: null });
    expect(await harness.db.select().from(aiTask)).toEqual([]);
  });
});

describe('recording suggestions', () => {
  const runFor = async (reqId: number, ids: readonly { id: number; score: number }[]):
  Promise<void> => {
    matcher.set(suggestions(ids));
    await post(`/requisitions/${reqId}/matches/refresh`, { refreshToken: String(Math.random()) })
      .expect(202);
    await composed.aiWorker!.drainUntilEmpty();
  };

  it('records suggestions and enters nobody into a pipeline', async () => {
    const reqId = await openRequisition();
    const a = await makeCandidate('Ahmed Hassan');
    await runFor(reqId, [{ id: a, score: 0.82 }]);

    const list = await get(`/requisitions/${reqId}/matches`).expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({
      candidateId: a, fullName: 'Ahmed Hassan', status: 'SUGGESTED', applicationId: null,
    });
    expect(list.body.items[0].score).toBeCloseTo(0.82, 3);
    expect(list.body.items[0].evidence[0]).toMatchObject({ kind: 'skills', weight: 0.6 });
    expect(list.body.items[0].missingRequirements).toEqual(['PMP']);
    expect(list.body.items[0].generation).toMatchObject({ modelId: 'qwen2.5-match' });

    // ADVISORY: nobody is in the pipeline.
    expect(await harness.db.select().from(hiringApplication)).toEqual([]);
  });

  it('orders by score, best first', async () => {
    const reqId = await openRequisition();
    const a = await makeCandidate('Low Score');
    const b = await makeCandidate('High Score');
    await runFor(reqId, [{ id: a, score: 0.3 }, { id: b, score: 0.91 }]);

    const list = await get(`/requisitions/${reqId}/matches`).expect(200);
    expect(list.body.items.map((m: { fullName: string }) => m.fullName))
      .toEqual(['High Score', 'Low Score']);
  });

  it('refreshes an open suggestion but never resurrects a dismissed one', async () => {
    const reqId = await openRequisition();
    const a = await makeCandidate('Ahmed Hassan');
    const b = await makeCandidate('Sara Ali');
    await runFor(reqId, [{ id: a, score: 0.5 }, { id: b, score: 0.6 }]);

    const list = await get(`/requisitions/${reqId}/matches`).expect(200);
    const dismissed = list.body.items.find((m: { candidateId: number }) => m.candidateId === a);
    await post(`/matches/${dismissed.id}/dismiss`, { reason: 'wrong discipline' }).expect(200);

    await runFor(reqId, [{ id: a, score: 0.95 }, { id: b, score: 0.7 }]);

    const after = await get(`/requisitions/${reqId}/matches`).expect(200);
    // The dismissed one stays gone — a "smart" feature that argues with you is
    // one people stop using.
    expect(after.body.items).toHaveLength(1);
    expect(after.body.items[0].candidateId).toBe(b);
    expect(after.body.items[0].score).toBeCloseTo(0.7, 3);

    const all = await get(`/requisitions/${reqId}/matches?status=SUGGESTED,DISMISSED`)
      .expect(200);
    expect(all.body.total).toBe(2);
  });

  it('abstains when the matcher finds nobody', async () => {
    const reqId = await openRequisition();
    matcher.set(suggestions([]));
    await post(`/requisitions/${reqId}/matches/refresh`).expect(202);
    await composed.aiWorker!.drainUntilEmpty();

    expect((await harness.db.select().from(aiTask))[0]?.state).toBe('ABSTAINED');
    expect(await harness.db.select().from(candidateMatch)).toEqual([]);
  });

  it('keeps a missing matcher retryable', async () => {
    const reqId = await openRequisition();
    await post(`/requisitions/${reqId}/matches/refresh`).expect(202);

    const { AITaskWorker } = await import('../infrastructure/ai/task-worker.js');
    const bare = new AITaskWorker(harness.db, {
      capabilities: {},
      documents: new InMemoryDocumentStore(),
      proposals: composed.proposals,
      matching: composed.matching,
    });
    await bare.drainUntilEmpty();

    // TEMPORARY — the requisition is fine, the environment is not.
    expect((await harness.db.select().from(aiTask))[0]?.state).toBe('QUEUED');
  });
});

describe('acting on a suggestion', () => {
  const oneSuggestion = async (): Promise<{ reqId: number; matchId: number; candidateId: number }> => {
    const reqId = await openRequisition();
    const candidateId = await makeCandidate('Ahmed Hassan');
    matcher.set(suggestions([{ id: candidateId, score: 0.8 }]));
    await post(`/requisitions/${reqId}/matches/refresh`).expect(202);
    await composed.aiWorker!.drainUntilEmpty();
    const list = await get(`/requisitions/${reqId}/matches`).expect(200);
    return { reqId, matchId: list.body.items[0].id as number, candidateId };
  };

  it('links through the Hiring context, creating a real application', async () => {
    const { matchId, candidateId } = await oneSuggestion();
    const res = await post(`/matches/${matchId}/link`).expect(201);

    expect(res.body).toMatchObject({ status: 'LINKED' });
    const applications = await harness.db.select().from(hiringApplication);
    expect(applications).toHaveLength(1);
    // Created by Hiring under Hiring's rules — entry stage, application number
    // and all.
    expect(applications[0]).toMatchObject({ candidateId, stage: 'SOURCED' });
    expect(res.body.applicationId).toBe(applications[0]?.id);
  });

  it('refuses to link without the Hiring permission the command needs', async () => {
    const { matchId } = await oneSuggestion();
    // User 8 has matching.view only — no matching.resolve, no candidate.link.
    await post(`/matches/${matchId}/link`, {}, 8).expect(403);
    expect(await harness.db.select().from(hiringApplication)).toEqual([]);
  });

  it('cannot dismiss or link a settled suggestion twice', async () => {
    const { matchId } = await oneSuggestion();
    await post(`/matches/${matchId}/dismiss`, { reason: 'no' }).expect(200);

    const again = await post(`/matches/${matchId}/dismiss`, { reason: 'no' });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('MATCH_ALREADY_RESOLVED');

    const link = await post(`/matches/${matchId}/link`);
    expect(link.status).toBe(422);
  });

  it('enforces optimistic concurrency', async () => {
    const { matchId } = await oneSuggestion();
    const stale = await post(`/matches/${matchId}/dismiss`, {
      reason: 'no', expectedVersion: 99,
    });
    expect(stale.status).toBe(409);
  });

  it('filters by minimum score', async () => {
    const reqId = await openRequisition();
    const a = await makeCandidate('Weak Match');
    const b = await makeCandidate('Strong Match');
    matcher.set(suggestions([{ id: a, score: 0.2 }, { id: b, score: 0.9 }]));
    await post(`/requisitions/${reqId}/matches/refresh`).expect(202);
    await composed.aiWorker!.drainUntilEmpty();

    const filtered = await get(`/requisitions/${reqId}/matches?minScore=0.5`).expect(200);
    expect(filtered.body.total).toBe(1);
    expect(filtered.body.items[0].fullName).toBe('Strong Match');
  });
});
