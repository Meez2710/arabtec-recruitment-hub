// Talent API integration tests — real HTTP, real database, no AI configured.
//
// The composition root wires NO AI provider in these tests, which is the point:
// creating, editing, documenting and proposing all work in a deployment where
// AI does not exist.

import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import { createTestDatabase } from '../infrastructure/db/testing/database.js';
import type { TestDatabase } from '../infrastructure/db/testing/database.js';
import { candidate, candidateDocument, timelineEntry } from '../infrastructure/db/schema/index.js';
import { compose } from './composition-root.js';
import { createApiApp, API_PREFIX } from './server.js';
import { JwtTokenVerifier } from './auth/authenticate.js';
import { StaticPrincipalResolver } from './auth/principal.js';
import type { Principal } from './auth/principal.js';
import { InMemoryDocumentStore } from '../modules/talent/infrastructure/document-store.js';

const SECRET = 'test-secret';
const PERMS = [
  'candidate.create', 'candidate.edit', 'candidate.view_all', 'candidate.view_own',
  'candidate.upload_document', 'candidate.delete_document',
  'candidate.change_state', 'candidate.assign_owner', 'candidate.review_proposal',
];

const principal = (over: Partial<Principal> = {}): Principal => ({
  userId: 7, userName: 'Mona Adel', permissions: PERMS,
  projectScopes: [], isGlobalScope: true, tenantId: 1,
  mustChangePassword: false, status: 'active', ...over,
});

const PRINCIPALS = new Map<number, Principal>([
  [7, principal()],
  [8, principal({ userId: 8, userName: 'Read Only', permissions: ['candidate.view_all'] })],
]);

let harness: TestDatabase;
let app: Express;
let store: InMemoryDocumentStore;

const auth = (id = 7): string => `Bearer ${jwt.sign({ sub: id }, SECRET, { expiresIn: '1h' })}`;
const post = (p: string, body: unknown, id = 7): request.Test =>
  request(app).post(`${API_PREFIX}${p}`).set('Authorization', auth(id)).send(body as object);
const get = (p: string, id = 7): request.Test =>
  request(app).get(`${API_PREFIX}${p}`).set('Authorization', auth(id));

beforeAll(async () => {
  harness = await createTestDatabase();
  store = new InMemoryDocumentStore();
  app = createApiApp({
    // No AI provider anywhere in this composition.
    app: compose(harness.db, { documents: store, year: () => 2026 }),
    verifier: new JwtTokenVerifier(SECRET),
    principals: new StaticPrincipalResolver(PRINCIPALS),
  });
});

afterAll(async () => { await harness.close(); });
beforeEach(async () => { await harness.reset(); });

const create = async (over: Record<string, unknown> = {}): Promise<{ id: number; version: number }> => {
  const res = await post('/candidates', {
    fullName: 'Ahmed Hassan', email: 'ahmed@example.com', ...over,
  }).expect(201);
  return { id: res.body.candidate.id as number, version: res.body.candidate.version as number };
};

const base64 = (text: string): string => Buffer.from(text).toString('base64');

describe('candidates — manual, no AI', () => {
  it('creates and edits by hand', async () => {
    const { id } = await create();
    const res = await request(app).patch(`${API_PREFIX}/candidates/${id}`)
      .set('Authorization', auth())
      .send({ currentCompany: 'Orascom', skills: ['AutoCAD', 'Revit'], yearsExperience: 8.5 })
      .expect(200);

    expect(res.body.fieldSources.currentCompany).toBe('USER');
    const rows = await harness.db.select().from(candidate);
    // numeric round-trips exactly; a float column would drift.
    expect(rows[0]?.yearsExperience).toBe('8.5');
    expect(rows[0]?.skills).toEqual(['AutoCAD', 'Revit']);
  });

  it('emits CAN- numbers and refuses a record nobody can contact', async () => {
    const first = await post('/candidates', { fullName: 'A', phone: '+201001234567' }).expect(201);
    expect(first.body.candidate.candidateNo).toBe('CAN-00001');

    const noContact = await post('/candidates', { fullName: 'B' });
    expect(noContact.status).toBe(422);
    expect(noContact.body.error.code).toBe('CONTACT_REQUIRED');
  });

  it('warns about possible duplicates without blocking creation', async () => {
    await create({ email: 'shared@example.com', phone: '+20 100 123 4567' });
    const second = await post('/candidates', {
      fullName: 'Different Person',
      email: 'SHARED@example.com',
      phone: '00201001234567',
    }).expect(201);

    // Created anyway — two people really do share a family email — but the
    // recruiter is told, and told which signals matched.
    expect(second.body.possibleDuplicates).toHaveLength(1);
    expect(second.body.possibleDuplicates[0].matchedOn.sort()).toEqual(['email', 'phone']);
  });

  it('deduplicates documents by content, not by filename', async () => {
    const { id } = await create();
    await post(`/candidates/${id}/documents`, {
      docType: 'CV', fileName: 'cv.pdf', mimeType: 'application/pdf', content: base64('PDF-BYTES'),
    }).expect(201);

    const duplicate = await post(`/candidates/${id}/documents`, {
      docType: 'CV', fileName: 'cv (1).pdf', mimeType: 'application/pdf', content: base64('PDF-BYTES'),
    });
    expect(duplicate.status).toBe(422);
    expect(duplicate.body.error.code).toBe('DUPLICATE_DOCUMENT');
    // One blob for both uploads — identical bytes are stored once.
    expect(await harness.db.select().from(candidateDocument)).toHaveLength(1);
  });

  it('keeps the blob when a document is detached', async () => {
    const { id } = await create();
    const attached = await post(`/candidates/${id}/documents`, {
      docType: 'CV', fileName: 'cv.pdf', mimeType: 'application/pdf', content: base64('X'),
    }).expect(201);
    expect(attached.body.documentCount).toBe(1);
    const documentId = (await harness.db.select().from(candidateDocument))[0]!.documentId;

    await request(app).delete(`${API_PREFIX}/candidates/${id}/documents/${documentId}`)
      .set('Authorization', auth()).expect(200);

    expect(await harness.db.select().from(candidateDocument)).toHaveLength(0);
    // The blob survives: the same hash may be attached to another candidate,
    // and a shared CV is normal when two recruiters source the same person.
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(Buffer.from('X')).digest('hex');
    expect(await store.get(hash)).not.toBeNull();
  });

  it('refuses to edit a merged record', async () => {
    const { id } = await create();
    await post(`/candidates/${id}/state`, { state: 'MERGED', reason: 'dupe' }).expect(200);
    const res = await request(app).patch(`${API_PREFIX}/candidates/${id}`)
      .set('Authorization', auth()).send({ location: 'Cairo' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CANDIDATE_NOT_EDITABLE');
  });

  it('enforces permissions and optimistic concurrency', async () => {
    const { id, version } = await create();
    await post('/candidates', { fullName: 'X', email: 'x@y.z' }, 8).expect(403);

    await request(app).patch(`${API_PREFIX}/candidates/${id}`)
      .set('Authorization', auth()).send({ location: 'Cairo', expectedVersion: version })
      .expect(200);
    const stale = await request(app).patch(`${API_PREFIX}/candidates/${id}`)
      .set('Authorization', auth()).send({ location: 'Giza', expectedVersion: version });
    expect(stale.status).toBe(409);
  });
});

describe('proposals — review before anything is written', () => {
  const raise = async (candidateId: number, fields: unknown[]): Promise<number> =>
    (await post(`/candidates/${candidateId}/proposals`, {
      origin: 'resume.extract', taskId: 'task-1', modelId: 'qwen-test', fields,
    }).expect(201)).body.id as number;

  it('applies only the accepted fields and stamps their provenance', async () => {
    const { id } = await create();
    const proposalId = await raise(id, [
      { field: 'currentPosition', value: 'Site Engineer', confidence: 0.9 },
      { field: 'phone', value: '+201999999999', confidence: 0.4 },
    ]);

    const reviewed = await post(`/candidates/proposals/${proposalId}/review`, {
      decisions: { currentPosition: true, phone: false },
    }).expect(200);

    expect(reviewed.body.appliedFields).toEqual(['currentPosition']);
    expect(reviewed.body.proposal.status).toBe('APPLIED');

    const rows = await harness.db.select().from(candidate);
    expect(rows[0]?.currentPosition).toBe('Site Engineer');
    // The rejected suggestion never touched the record.
    expect(rows[0]?.phone).toBeNull();

    const provenance = rows[0]?.provenance as Record<string, { source: string; modelId?: string }>;
    expect(provenance['currentPosition']).toMatchObject({
      source: 'AI_APPROVED', modelId: 'qwen-test',
    });
    expect(provenance['phone']).toBeUndefined();
  });

  it('never writes a field a reviewer did not accept', async () => {
    const { id } = await create();
    const proposalId = await raise(id, [{ field: 'location', value: 'Alexandria' }]);
    await post(`/candidates/proposals/${proposalId}/review`, { decisions: {} }).expect(200);

    const rows = await harness.db.select().from(candidate);
    expect(rows[0]?.location).toBeNull();
  });

  it('validates accepted values exactly as typed ones', async () => {
    const { id } = await create();
    const proposalId = await raise(id, [{ field: 'yearsExperience', value: 500 }]);
    const res = await post(`/candidates/proposals/${proposalId}/review`, {
      decisions: { yearsExperience: true },
    });
    // Acceptance is not a licence to bypass a rule.
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_CANDIDATE_FIELD');
  });

  it('supersedes an unreviewed proposal when a new one arrives', async () => {
    const { id } = await create();
    const first = await raise(id, [{ field: 'location', value: 'Cairo' }]);
    const second = await raise(id, [{ field: 'location', value: 'Alexandria' }]);
    expect(second).not.toBe(first);

    expect((await get(`/candidates/proposals/${first}`).expect(200)).body.status)
      .toBe('SUPERSEDED');
    expect((await get(`/candidates/proposals/${second}`).expect(200)).body.status)
      .toBe('PENDING');
  });

  it('cannot be reviewed twice', async () => {
    const { id } = await create();
    const proposalId = await raise(id, [{ field: 'location', value: 'Cairo' }]);
    await post(`/candidates/proposals/${proposalId}/review`, { decisions: { location: true } })
      .expect(200);
    const again = await post(`/candidates/proposals/${proposalId}/review`, {
      decisions: { location: true },
    });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('PROPOSAL_ALREADY_RESOLVED');
  });

  it('drops fields no reviewer may accept', async () => {
    const { id } = await create();
    const proposalId = await raise(id, [
      { field: 'location', value: 'Cairo' },
      { field: 'state', value: 'BLACKLISTED' },
    ]);
    const proposal = await get(`/candidates/proposals/${proposalId}`).expect(200);
    expect(proposal.body.fields.map((f: { field: string }) => f.field)).toEqual(['location']);
  });

  it('audits the whole flow through the existing outbox', async () => {
    const { id } = await create();
    const proposalId = await raise(id, [{ field: 'location', value: 'Cairo' }]);
    await post(`/candidates/proposals/${proposalId}/review`, { decisions: { location: true } })
      .expect(200);

    const entries = await harness.db.select().from(timelineEntry);
    const types = entries.map((e) => e.eventType);
    expect(types).toContain('CandidateCreated');
    expect(types).toContain('CandidateProposalRaised');
    expect(types).toContain('CandidateProposalResolved');
    // The approval is auditable as a distinct act, separate from a manual edit.
    expect(types).toContain('CandidateAIFieldsApproved');
  });
});

/* ------------------------------ read model -------------------------------- */

describe('talent read model', () => {
  const withCv = async (id: number, content: string): Promise<void> => {
    await post(`/candidates/${id}/documents`, {
      docType: 'CV', fileName: 'cv.pdf', mimeType: 'application/pdf', content: base64(content),
    }).expect(201);
  };

  it('lists with pagination, a stable total and provenance badges', async () => {
    for (let i = 0; i < 4; i += 1) {
      await post('/candidates', {
        fullName: `Person ${i}`, email: `p${i}@example.com`, skills: ['AutoCAD'],
      }).expect(201);
    }

    const page = await get('/candidates?limit=2&offset=0').expect(200);
    expect(page.body.items).toHaveLength(2);
    expect(page.body.total).toBe(4);
    // The AI block is present and null-filled — the shape is final today.
    expect(page.body.items[0].ai).toMatchObject({
      pendingProposalId: null, processingStatus: null,
      lastParsingTaskId: null, embeddingModelId: null,
    });
  });

  it('rolls up documents and applications in one statement', async () => {
    const { id } = await create();
    await withCv(id, 'BYTES');

    harness.queries.start();
    const res = await get('/candidates?limit=50').expect(200);
    const statements = harness.queries.stop().filter((q) => /^\s*select/i.test(q));

    expect(res.body.items[0]).toMatchObject({ documentCount: 1, hasCv: true, applicationCount: 0 });
    expect(statements).toHaveLength(1);
  });

  it('searches, filters and sorts', async () => {
    await post('/candidates', {
      fullName: 'Ahmed Structural', email: 'a@x.com',
      skills: ['AutoCAD', 'Revit'], yearsExperience: 10, source: 'referral',
    }).expect(201);
    const { id } = await create({ fullName: 'Zeinab Civil', email: 'z@x.com', skills: ['Revit'] });
    await withCv(id, 'CV-BYTES');

    expect((await get('/candidates?q=structural').expect(200)).body.total).toBe(1);
    expect((await get('/candidates?q=CAN-').expect(200)).body.total).toBe(2);
    // jsonb containment: ALL listed skills must be present.
    expect((await get('/candidates?skills=Revit').expect(200)).body.total).toBe(2);
    expect((await get('/candidates?skills=AutoCAD,Revit').expect(200)).body.total).toBe(1);
    expect((await get('/candidates?hasCv=true').expect(200)).body.total).toBe(1);
    expect((await get('/candidates?hasCv=false').expect(200)).body.total).toBe(1);
    expect((await get('/candidates?source=referral').expect(200)).body.total).toBe(1);
    expect((await get('/candidates?minYearsExperience=5').expect(200)).body.total).toBe(1);

    const sorted = await get('/candidates?sort=fullName&direction=asc').expect(200);
    expect(sorted.body.items[0].fullName).toBe('Ahmed Structural');
  });

  it('hides erased records unless asked for explicitly', async () => {
    const { id } = await create();
    await post(`/candidates/${id}/state`, { state: 'ERASED', reason: 'erasure request' })
      .expect(200);
    expect((await get('/candidates').expect(200)).body.total).toBe(0);
    expect((await get('/candidates?state=ERASED').expect(200)).body.total).toBe(1);
  });

  it('returns the detail with documents, provenance, proposal and duplicates', async () => {
    const { id } = await create({ email: 'shared@x.com' });
    await withCv(id, 'CV-BYTES');
    await post(`/candidates/${id}/proposals`, {
      origin: 'resume.extract', taskId: 't-1', modelId: 'qwen-test',
      fields: [{ field: 'currentPosition', value: 'Site Engineer', confidence: 0.88 }],
    }).expect(201);
    // A second candidate sharing the email AND the exact CV bytes.
    const other = await post('/candidates', {
      fullName: 'Other', email: 'shared@x.com',
    }).expect(201);
    await withCv(other.body.candidate.id as number, 'CV-BYTES');

    const detail = await get(`/candidates/${id}`).expect(200);
    expect(detail.body.documents).toHaveLength(1);
    expect(detail.body.documents[0].sharedWithCandidateIds).toEqual([other.body.candidate.id]);

    expect(detail.body.pendingProposal.fields[0]).toMatchObject({
      field: 'currentPosition', confidence: 0.88, decision: 'PENDING', currentValue: null,
    });
    expect(detail.body.ai.pendingProposalFieldCount).toBe(1);
    expect(detail.body.ai.lastProposalModelId).toBe('qwen-test');

    expect(detail.body.duplicateWarnings).toHaveLength(1);
    expect(detail.body.duplicateWarnings[0].matchedOn.sort()).toEqual(['document', 'email']);

    await get('/candidates/99999').expect(404);
  });

  it('shows the current value beside each suggestion', async () => {
    const { id } = await create();
    await request(app).patch(`${API_PREFIX}/candidates/${id}`)
      .set('Authorization', auth()).send({ location: 'Cairo' }).expect(200);
    await post(`/candidates/${id}/proposals`, {
      origin: 'resume.extract', fields: [{ field: 'location', value: 'Alexandria' }],
    }).expect(201);

    const detail = await get(`/candidates/${id}`).expect(200);
    // A reviewer needs the diff, not the suggestion alone.
    expect(detail.body.pendingProposal.fields[0]).toMatchObject({
      value: 'Alexandria', currentValue: 'Cairo',
    });
  });

  it('badges approved AI fields distinctly from typed ones', async () => {
    const { id } = await create();
    await request(app).patch(`${API_PREFIX}/candidates/${id}`)
      .set('Authorization', auth()).send({ location: 'Cairo' }).expect(200);
    const proposalId = (await post(`/candidates/${id}/proposals`, {
      origin: 'resume.extract', taskId: 't-9', modelId: 'qwen-test',
      fields: [{ field: 'currentPosition', value: 'Site Engineer' }],
    }).expect(201)).body.id as number;
    await post(`/candidates/proposals/${proposalId}/review`, {
      decisions: { currentPosition: true },
    }).expect(200);

    const detail = await get(`/candidates/${id}`).expect(200);
    expect(detail.body.fieldSources).toMatchObject({
      location: 'USER', currentPosition: 'AI_APPROVED',
    });
    expect(detail.body.ai.aiApprovedFields).toEqual(['currentPosition']);
    const badge = detail.body.provenance.find(
      (b: { field: string }) => b.field === 'currentPosition',
    );
    expect(badge).toMatchObject({ source: 'AI_APPROVED', taskId: 't-9', modelId: 'qwen-test' });
  });

  it('lists proposal history newest first', async () => {
    const { id } = await create();
    await post(`/candidates/${id}/proposals`, {
      origin: 'bulk.import', fields: [{ field: 'location', value: 'Cairo' }],
    }).expect(201);
    await post(`/candidates/${id}/proposals`, {
      origin: 'resume.extract', fields: [{ field: 'location', value: 'Giza' }],
    }).expect(201);

    const list = await get(`/candidates/${id}/proposals`).expect(200);
    expect(list.body.total).toBe(2);
    expect(list.body.items[0].origin).toBe('resume.extract');
    expect(list.body.items[0].status).toBe('PENDING');
    expect(list.body.items[1].status).toBe('SUPERSEDED');
  });

  it('summarises pipeline activity', async () => {
    const { id } = await create();
    const empty = await get(`/candidates/${id}/activity`).expect(200);
    expect(empty.body).toMatchObject({
      applicationCount: 0, interviewCount: 0, offerCount: 0, isHired: false,
    });
    expect(empty.body.currentStages).toEqual([]);
    await get('/candidates/99999/activity').expect(404);
  });

  it('pins a VIEW_OWN caller to candidates they own', async () => {
    await create();                                   // owner defaults to user 7
    const limited = new Map(PRINCIPALS);
    limited.set(30, principal({
      userId: 30, userName: 'Own Only',
      permissions: PERMS.filter((p) => p !== 'candidate.view_all'),
    }));
    const scopedApp = createApiApp({
      app: compose(harness.db, { documents: store, year: () => 2026 }),
      verifier: new JwtTokenVerifier(SECRET),
      principals: new StaticPrincipalResolver(limited),
    });

    const own = await request(scopedApp).get(`${API_PREFIX}/candidates`)
      .set('Authorization', auth(30)).expect(200);
    expect(own.body.total).toBe(0);
    // Asking for someone else's id must not widen it.
    const widened = await request(scopedApp).get(`${API_PREFIX}/candidates?ownerRecruiterId=7`)
      .set('Authorization', auth(30)).expect(200);
    expect(widened.body.total).toBe(0);
  });
});
