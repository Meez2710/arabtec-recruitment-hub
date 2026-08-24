// Candidate Parsing — end to end, with and without a provider.
//
// The two cases that matter, tested side by side: a deployment with NO AI works
// exactly as it did before, and a deployment WITH a capability produces a
// proposal that a human must still accept before anything is written.

import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import { createTestDatabase } from '../infrastructure/db/testing/database.js';
import type { TestDatabase } from '../infrastructure/db/testing/database.js';
import { aiTask, candidate, candidateProposal } from '../infrastructure/db/schema/index.js';
import { compose } from './composition-root.js';
import type { Application as Composed } from './composition-root.js';
import { createApiApp, API_PREFIX } from './server.js';
import { JwtTokenVerifier } from './auth/authenticate.js';
import { StaticPrincipalResolver } from './auth/principal.js';
import type { Principal } from './auth/principal.js';
import { InMemoryDocumentStore } from '../modules/talent/infrastructure/document-store.js';
import { PlainTextDocumentParser } from '../infrastructure/ai/plain-text-parser.js';
import { buildExtractionPreview, toProposedFields } from '../infrastructure/ai/resume-parse-handler.js';
import { AI_CAPABILITIES } from '../modules/shared/kernel/ai/index.js';
import type {
  AIOutcome, ExtractedResume, ResumeExtractor,
} from '../modules/shared/kernel/ai/index.js';

const SECRET = 'test-secret';
const PERMS = [
  'candidate.create', 'candidate.edit', 'candidate.view_all', 'candidate.view_own',
  'candidate.upload_document', 'candidate.review_proposal',
];

const principal = (over: Partial<Principal> = {}): Principal => ({
  userId: 7, userName: 'Mona Adel', permissions: PERMS,
  projectScopes: [], isGlobalScope: true, tenantId: 1,
  mustChangePassword: false, status: 'active', ...over,
});
const PRINCIPALS = new Map<number, Principal>([[7, principal()]]);

/**
 * A stub extractor.
 *
 * Deliberately NOT a model: this suite tests the PIPELINE — task, worker,
 * proposal, review — not anybody's inference quality. The Ollama/Qwen adapter
 * drops into this same slot in the AI phase.
 */
class StubResumeExtractor implements ResumeExtractor {
  readonly version = 'stub-2.0.0';
  constructor(private readonly outcome: AIOutcome<ExtractedResume>) {}
  async extract(): Promise<AIOutcome<ExtractedResume>> { return this.outcome; }
}

/** Abstains the way a provider outage does: temporarily. */
class UnavailableExtractor implements ResumeExtractor {
  readonly version = 'stub-2.0.0';
  async extract(): Promise<AIOutcome<ExtractedResume>> {
    return {
      abstained: true, permanent: false,
      reason: 'The model endpoint timed out.',
      provenance,
    };
  }
}

const provenance = {
  capability: AI_CAPABILITIES.RESUME_EXTRACT,
  modelId: 'qwen2.5-stub',
  promptVersionId: 'resume-v1',
  producedAt: new Date(),
};

const extracted = (over: Partial<ExtractedResume> = {}): AIOutcome<ExtractedResume> => ({
  content: {
    fullName: 'Ahmed Hassan',
    email: 'ahmed.hassan@example.com',
    phone: '+201001234567',
    location: 'Cairo',
    totalYearsExperience: 9,
    skills: ['AutoCAD', 'Primavera'],
    employment: [{ employer: 'Orascom', title: 'Site Engineer', current: true }],
    education: [{ institution: 'Cairo University', field: 'Civil Engineering', to: '2015' }],
    languages: ['Arabic', 'English'],
    certifications: ['PMP'],
    uncertainFields: ['phone'],
    ...over,
  },
  confidence: 0.9,
  reasoningSummary: 'stub',
  sourcesUsed: ['doc-1'],
  provenance,
});

let harness: TestDatabase;
let store: InMemoryDocumentStore;
let withAi: Composed;
let aiApp: Express;
let plainApp: Express;

const auth = (): string => `Bearer ${jwt.sign({ sub: 7 }, SECRET, { expiresIn: '1h' })}`;

const build = (app: Composed): Express => createApiApp({
  app, verifier: new JwtTokenVerifier(SECRET),
  principals: new StaticPrincipalResolver(PRINCIPALS),
});

beforeAll(async () => {
  harness = await createTestDatabase();
  store = new InMemoryDocumentStore();

  withAi = compose(harness.db, {
    documents: store, year: () => 2026,
    capabilities: {
      documentParser: new PlainTextDocumentParser(),
      resumeExtractor: new StubResumeExtractor(extracted()),
    },
  });
  aiApp = build(withAi);
  // Same code, no capabilities configured at all.
  plainApp = build(compose(harness.db, { documents: store, year: () => 2026 }));
});

afterAll(async () => { await harness.close(); });
beforeEach(async () => { await harness.reset(); });

const post = (app: Express, p: string, body: unknown): request.Test =>
  request(app).post(`${API_PREFIX}${p}`).set('Authorization', auth()).send(body as object);

const createCandidate = async (app: Express): Promise<number> =>
  (await post(app, '/candidates', {
    fullName: 'Placeholder', email: 'p@example.com',
  }).expect(201)).body.candidate.id as number;

const uploadCv = async (app: Express, id: number, text: string): Promise<void> => {
  await post(app, `/candidates/${id}/documents`, {
    docType: 'CV', fileName: 'cv.txt', mimeType: 'text/plain',
    content: Buffer.from(text).toString('base64'),
  }).expect(201);
};

/* ------------------------- 1. no provider configured ----------------------- */

describe('with no AI configured', () => {
  it('uploads a CV and queues nothing at all', async () => {
    const id = await createCandidate(plainApp);
    await uploadCv(plainApp, id, 'Ahmed Hassan\nSite Engineer');

    // Not "queued and ignored" — never submitted.
    expect(await harness.db.select().from(aiTask)).toEqual([]);
    expect(await harness.db.select().from(candidateProposal)).toEqual([]);
  });

  it('exposes no dispatcher or worker', () => {
    const plain = compose(harness.db, { documents: store });
    expect(plain.ai).toBeNull();
    expect(plain.aiWorker).toBeNull();
  });
});

/* --------------------------- 2. the parse pipeline ------------------------- */

describe('resume parsing', () => {
  it('queues a task on CV upload and idempotently on re-upload', async () => {
    const id = await createCandidate(aiApp);
    await uploadCv(aiApp, id, 'Ahmed Hassan');

    const tasks = await harness.db.select().from(aiTask);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      capability: 'resume.extract', state: 'QUEUED', entityType: 'Candidate', entityId: id,
    });

    // The same bytes again must not re-run a model.
    const handle = await withAi.ai!.submit({
      capability: AI_CAPABILITIES.RESUME_EXTRACT,
      input: {}, tenantId: 1,
      idempotencyKey: tasks[0]!.idempotencyKey,
    });
    expect(handle.deduplicated).toBe(true);
    expect(await harness.db.select().from(aiTask)).toHaveLength(1);
  });

  it('does not queue for a non-CV attachment', async () => {
    const id = await createCandidate(aiApp);
    await post(aiApp, `/candidates/${id}/documents`, {
      docType: 'CERTIFICATE', fileName: 'pmp.txt', mimeType: 'text/plain',
      content: Buffer.from('PMP').toString('base64'),
    }).expect(201);
    expect(await harness.db.select().from(aiTask)).toEqual([]);
  });

  it('produces a PROPOSAL and writes nothing to the candidate', async () => {
    const id = await createCandidate(aiApp);
    await uploadCv(aiApp, id, 'Ahmed Hassan\nSite Engineer at Orascom');

    const result = await withAi.aiWorker!.drainUntilEmpty();
    expect(result).toMatchObject({ succeeded: 1, failed: 0 });

    const rows = await harness.db.select().from(candidate);
    // The candidate is UNTOUCHED. Every extracted value is only a suggestion.
    expect(rows[0]?.fullName).toBe('Placeholder');
    expect(rows[0]?.currentPosition).toBeNull();

    const proposals = await harness.db.select().from(candidateProposal);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      status: 'PENDING', origin: 'resume.extract', modelId: 'qwen2.5-stub',
    });

    const task = (await harness.db.select().from(aiTask))[0];
    expect(task).toMatchObject({ state: 'SUCCEEDED', modelId: 'qwen2.5-stub' });
    expect(task?.proposalId).toBe(proposals[0]?.id);
  });

  it('applies only what a human accepts, with AI provenance', async () => {
    const id = await createCandidate(aiApp);
    await uploadCv(aiApp, id, 'Ahmed Hassan');
    await withAi.aiWorker!.drainUntilEmpty();

    const detail = await request(aiApp).get(`${API_PREFIX}/candidates/${id}`)
      .set('Authorization', auth()).expect(200);
    const proposalId = detail.body.pendingProposal.id as number;
    expect(detail.body.ai.pendingProposalFieldCount).toBeGreaterThan(5);

    await post(aiApp, `/candidates/proposals/${proposalId}/review`, {
      decisions: { fullName: true, currentPosition: true },
    }).expect(200);

    const after = await request(aiApp).get(`${API_PREFIX}/candidates/${id}`)
      .set('Authorization', auth()).expect(200);
    expect(after.body.fullName).toBe('Ahmed Hassan');
    expect(after.body.currentPosition).toBe('Site Engineer');
    // Rejected suggestions never landed.
    expect(after.body.email).toBe('p@example.com');
    expect(after.body.fieldSources).toMatchObject({
      fullName: 'AI_APPROVED', currentPosition: 'AI_APPROVED',
    });
    expect(after.body.ai.aiApprovedFields.sort()).toEqual(['currentPosition', 'fullName']);
  });

  it('abstains, terminally, when a document cannot be read', async () => {
    const id = await createCandidate(aiApp);
    await post(aiApp, `/candidates/${id}/documents`, {
      docType: 'CV', fileName: 'cv.pdf', mimeType: 'application/pdf',
      content: Buffer.from('%PDF-1.7 binary').toString('base64'),
    }).expect(201);

    const result = await withAi.aiWorker!.drainUntilEmpty();
    expect(result).toMatchObject({ succeeded: 0, abstained: 1, failed: 0 });

    const task = (await harness.db.select().from(aiTask))[0];
    // ABSTAINED is terminal: a PDF does not become readable by retrying.
    expect(task?.state).toBe('ABSTAINED');
    expect(task?.abstainReason).toMatch(/pdf/i);
    expect(await harness.db.select().from(candidateProposal)).toEqual([]);
  });

  it('abstains when a task is queued but no provider is configured', async () => {
    const id = await createCandidate(aiApp);
    await uploadCv(aiApp, id, 'Ahmed Hassan');

    // A task queued while AI was on, drained by a worker that has nothing.
    const orphan = compose(harness.db, { documents: store, capabilities: { documentParser: undefined } });
    expect(orphan.aiWorker).toBeNull();

    const bare = new (await import('../infrastructure/ai/task-worker.js')).AITaskWorker(
      harness.db,
      { capabilities: {}, documents: store, proposals: withAi.proposals },
    );
    const result = await bare.drainUntilEmpty();
    expect(result).toMatchObject({ abstained: 1 });
    expect((await harness.db.select().from(aiTask))[0]?.abstainReason)
      .toMatch(/no résumé parsing provider/i);
  });

  it('recovers tasks a crashed worker left running', async () => {
    const id = await createCandidate(aiApp);
    await uploadCv(aiApp, id, 'Ahmed Hassan');
    await harness.db.update(aiTask).set({ state: 'RUNNING' });

    const recovered = await withAi.aiWorker!.recoverStalled(new Date(Date.now() + 1_000));
    expect(recovered).toBe(1);
    expect((await withAi.aiWorker!.backlog()).queued).toBe(1);
  });

  it('reports a backlog for operations', async () => {
    const id = await createCandidate(aiApp);
    await uploadCv(aiApp, id, 'Ahmed Hassan');
    expect(await withAi.aiWorker!.backlog()).toMatchObject({ queued: 1, running: 0, failed: 0 });

    const health = await request(aiApp).get('/health/ai').expect(200);
    expect(health.body).toMatchObject({ configured: true, queued: 1, healthy: true });
  });

  it('surfaces parse status on the read model without a contract change', async () => {
    const id = await createCandidate(aiApp);
    await uploadCv(aiApp, id, 'Ahmed Hassan');

    const queued = await request(aiApp).get(`${API_PREFIX}/candidates/${id}`)
      .set('Authorization', auth()).expect(200);
    // The placeholders designed before parsing existed are now real, and the
    // shape did not change to make them so.
    expect(queued.body.ai.processingStatus).toBe('QUEUED');
    expect(queued.body.ai.lastParsingTaskId).toMatch(/^\d+$/);
    expect(queued.body.ai.lastMatchingTaskId).toBeNull();
    expect(queued.body.ai.embeddingModelId).toBeNull();

    await withAi.aiWorker!.drainUntilEmpty();
    const done = await request(aiApp).get(`${API_PREFIX}/candidates/${id}`)
      .set('Authorization', auth()).expect(200);
    expect(done.body.ai.processingStatus).toBe('SUCCEEDED');
    expect(done.body.ai.lastParsingAt).not.toBeNull();
  });

  it('reports AI as unconfigured rather than unhealthy when there is none', async () => {
    const health = await request(plainApp).get('/health/ai').expect(200);
    expect(health.body).toEqual({ configured: false, healthy: true });
  });
});

/* ---------------------------- 3. field mapping ----------------------------- */

describe('extraction mapping', () => {
  const resume = (over: Partial<ExtractedResume> = {}): ExtractedResume => {
    const outcome = extracted(over);
    return 'content' in outcome ? outcome.content : ({} as ExtractedResume);
  };

  it('maps only what was found, and never invents a null', () => {
    const fields = toProposedFields(resume({
      email: undefined, skills: [], certifications: [],
    }), 0.9);
    const names = fields.map((f) => f.field);

    // "I did not find a phone number" and "this person has no phone number" are
    // different claims; only one is safe to write, so absent stays absent.
    expect(names).not.toContain('email');
    expect(names).not.toContain('skills');
    expect(names).toContain('fullName');
  });

  it('halves confidence for fields the extractor flagged as uncertain', () => {
    const fields = toProposedFields(resume(), 0.9);
    expect(fields.find((f) => f.field === 'fullName')?.confidence).toBeCloseTo(0.9, 5);
    // One number for a whole résumé hides that the name was certain and the
    // phone was a guess.
    expect(fields.find((f) => f.field === 'phone')?.confidence).toBeCloseTo(0.45, 5);
  });

  it('prefers the current employment for the current role', () => {
    const fields = toProposedFields(resume({
      employment: [
        { employer: 'Old Co', title: 'Junior' },
        { employer: 'Orascom', title: 'Site Engineer', current: true },
      ],
    }), 0.9);
    expect(fields.find((f) => f.field === 'currentCompany')?.value).toBe('Orascom');
  });

  it('ignores an implausible graduation year rather than proposing it', () => {
    const fields = toProposedFields(resume({
      education: [{ institution: 'X', to: 'sometime' }],
    }), 0.9);
    expect(fields.map((f) => f.field)).not.toContain('graduationYear');
    expect(fields.find((f) => f.field === 'university')?.value).toBe('X');
  });
});

/* --------------------- 3b. the full extraction preview --------------------- */

describe('extraction preview — every field, none silently missing', () => {
  const resumeOf = (over: Partial<ExtractedResume> = {}): ExtractedResume => {
    const outcome = extracted(over);
    return 'content' in outcome ? outcome.content : ({} as ExtractedResume);
  };

  // Contains every value the default stub resume claims, so evidence location
  // succeeds for all of them except where a test deliberately breaks it.
  const FULL_CV_TEXT = [
    'Ahmed Hassan', 'ahmed.hassan@example.com', '+201001234567', 'Cairo',
    'Old Co', 'Junior Engineer',
    'Orascom', 'Site Engineer',
    'Cairo University', 'Civil Engineering', '2015',
    'AutoCAD', 'Primavera', 'Arabic', 'English', 'PMP',
  ].join('\n');

  const input = (over: Partial<ExtractedResume> = {}) => ({
    resume: resumeOf({
      employment: [
        { employer: 'Old Co', title: 'Junior Engineer' },
        { employer: 'Orascom', title: 'Site Engineer', current: true },
      ],
      ...over,
    }),
    document: { text: FULL_CV_TEXT, pageCount: 1, pages: [FULL_CV_TEXT] },
    aiConfidence: 0.9,
    parser: 'test-parser',
    parserVersion: '1',
  });

  it('marks a field the CV never states as not_stated rather than omitting the row', () => {
    const rows = buildExtractionPreview(input());
    // The stub resume never sets a headline — the extraction schema captures
    // one, but nothing maps it to a candidate column, so buildProposedFields
    // never touches it either.
    expect(rows.find((r) => r.field === 'headline')).toMatchObject({
      status: 'not_stated', value: null,
    });
  });

  it('marks a hallucinated value as rejected, with a reason, instead of dropping the row', () => {
    const rows = buildExtractionPreview(input({ email: 'ghost@nowhere.example' }));
    const email = rows.find((r) => r.field === 'email');
    expect(email?.status).toBe('rejected');
    expect(email?.value).toBe('ghost@nowhere.example');
    expect(email?.reason).toBeTruthy();
  });

  it('lists every employment entry, not only the one mapped to a candidate column', () => {
    const rows = buildExtractionPreview(input());
    const history = rows.filter((r) => r.section === 'Employment history');
    expect(history).toHaveLength(2);
    expect(history.every((r) => r.status === 'verified')).toBe(true);
    expect(history[0]?.value).toContain('Old Co');
    expect(history[1]?.value).toContain('Orascom');
  });

  it('never lists the same known field twice', () => {
    const rows = buildExtractionPreview(input());
    const known = rows
      .filter((r) => r.section !== 'Employment history' && r.section !== 'Education history')
      .map((r) => r.field);
    expect(new Set(known).size).toBe(known.length);
  });
});

/* ------------------- 4. transactional submission (Decision 1) -------------- */

describe('parse task submission is transactional', () => {
  it('writes the document and its task in ONE transaction', async () => {
    const id = await createCandidate(aiApp);
    await uploadCv(aiApp, id, 'Ahmed Hassan');
    // Both present after one committed request.
    expect(await harness.db.select().from(aiTask)).toHaveLength(1);
  });

  it('rolls the task back when the document write fails', async () => {
    const id = await createCandidate(aiApp);
    await uploadCv(aiApp, id, 'Ahmed Hassan');
    expect(await harness.db.select().from(aiTask)).toHaveLength(1);

    // Re-uploading identical bytes trips DuplicateDocumentError inside the
    // transaction. Nothing may be left behind — not a second task, and not the
    // first one's disappearance.
    const again = await post(aiApp, `/candidates/${id}/documents`, {
      docType: 'CV', fileName: 'again.txt', mimeType: 'text/plain',
      content: Buffer.from('Ahmed Hassan').toString('base64'),
    });
    expect(again.status).toBe(422);
    expect(await harness.db.select().from(aiTask)).toHaveLength(1);
  });

  it('creates no task at all when the candidate does not exist', async () => {
    const missing = await post(aiApp, '/candidates/99999/documents', {
      docType: 'CV', fileName: 'cv.txt', mimeType: 'text/plain',
      content: Buffer.from('X').toString('base64'),
    });
    expect(missing.status).toBe(404);
    // The transaction rolled back, so the submit inside it did too.
    expect(await harness.db.select().from(aiTask)).toEqual([]);
  });
});

/* --------------- 5. abstention permanence (Decision 2) --------------------- */

describe('abstention permanence', () => {
  it('keeps a TEMPORARY abstention retryable instead of losing the work', async () => {
    const flaky = compose(harness.db, {
      documents: store, year: () => 2026,
      capabilities: {
        documentParser: new PlainTextDocumentParser(),
        resumeExtractor: new UnavailableExtractor(),
      },
    });
    const flakyApp = build(flaky);

    const id = await createCandidate(flakyApp);
    await uploadCv(flakyApp, id, 'Ahmed Hassan');
    await flaky.aiWorker!.drainUntilEmpty();

    const task = (await harness.db.select().from(aiTask))[0];
    // Back to QUEUED with backoff — a CV uploaded while the model was down is
    // parsed when it returns, not silently discarded.
    expect(task?.state).toBe('QUEUED');
    expect(task?.abstainReason).toMatch(/timed out/i);
    expect(task!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('succeeds on a later pass once the provider returns', async () => {
    const flaky = compose(harness.db, {
      documents: store, year: () => 2026,
      capabilities: {
        documentParser: new PlainTextDocumentParser(),
        resumeExtractor: new UnavailableExtractor(),
      },
    });
    const id = await createCandidate(build(flaky));
    await uploadCv(build(flaky), id, 'Ahmed Hassan');
    await flaky.aiWorker!.drainUntilEmpty();
    expect((await harness.db.select().from(aiTask))[0]?.state).toBe('QUEUED');

    // The provider comes back; the same task is picked up and parsed.
    await harness.db.update(aiTask).set({ nextAttemptAt: new Date(Date.now() - 1_000) });
    await withAi.aiWorker!.drainUntilEmpty();

    expect((await harness.db.select().from(aiTask))[0]?.state).toBe('SUCCEEDED');
    expect(await harness.db.select().from(candidateProposal)).toHaveLength(1);
  });

  it('gives up after maxAttempts so a broken task stays visible', async () => {
    const flaky = compose(harness.db, {
      documents: store, year: () => 2026,
      capabilities: {
        documentParser: new PlainTextDocumentParser(),
        resumeExtractor: new UnavailableExtractor(),
      },
    });
    const id = await createCandidate(build(flaky));
    await uploadCv(build(flaky), id, 'Ahmed Hassan');

    const { AITaskWorker } = await import('../infrastructure/ai/task-worker.js');
    const impatient = new AITaskWorker(harness.db, {
      capabilities: {
        documentParser: new PlainTextDocumentParser(),
        resumeExtractor: new UnavailableExtractor(),
      },
      documents: store,
      proposals: flaky.proposals,
    }, { maxAttempts: 2, baseDelayMs: 0 });

    for (let i = 0; i < 4; i += 1) {
      await harness.db.update(aiTask).set({ nextAttemptAt: new Date(Date.now() - 1_000) });
      await impatient.drainOnce();
    }
    // Bounded: FAILED and visible, not retrying forever.
    expect((await harness.db.select().from(aiTask))[0]?.state).toBe('FAILED');
  });

  it('keeps a PERMANENT abstention terminal', async () => {
    const id = await createCandidate(aiApp);
    await post(aiApp, `/candidates/${id}/documents`, {
      docType: 'CV', fileName: 'cv.pdf', mimeType: 'application/pdf',
      content: Buffer.from('%PDF-1.7').toString('base64'),
    }).expect(201);

    await withAi.aiWorker!.drainUntilEmpty();
    const task = (await harness.db.select().from(aiTask))[0];
    // A PDF does not become readable by waiting.
    expect(task?.state).toBe('ABSTAINED');

    await harness.db.update(aiTask).set({ nextAttemptAt: new Date(Date.now() - 1_000) });
    await withAi.aiWorker!.drainUntilEmpty();
    expect((await harness.db.select().from(aiTask))[0]?.state).toBe('ABSTAINED');
  });
});

/* -------------------- 6. reproduction provenance --------------------------- */

describe('generation provenance', () => {
  it('records everything needed to reproduce the proposal', async () => {
    const id = await createCandidate(aiApp);
    await uploadCv(aiApp, id, 'Ahmed Hassan');
    await withAi.aiWorker!.drainUntilEmpty();

    const row = (await harness.db.select().from(candidateProposal))[0];
    const generation = row?.generation as Record<string, unknown>;

    const { createHash } = await import('node:crypto');
    const expectedHash = createHash('sha256')
      .update(Buffer.from('Ahmed Hassan')).digest('hex');

    expect(generation).toMatchObject({
      capability: 'resume.extract',
      modelId: 'qwen2.5-stub',
      promptVersionId: 'resume-v1',
      documentHash: expectedHash,
      parserVersion: '1.0.0',
      extractorVersion: 'stub-2.0.0',
    });
    expect(generation['generatedAt']).toBeDefined();
  });

  it('surfaces it on the read model for audit', async () => {
    const id = await createCandidate(aiApp);
    await uploadCv(aiApp, id, 'Ahmed Hassan');
    await withAi.aiWorker!.drainUntilEmpty();

    const detail = await request(aiApp).get(`${API_PREFIX}/candidates/${id}`)
      .set('Authorization', auth()).expect(200);
    expect(detail.body.pendingProposal.generation).toMatchObject({
      capability: 'resume.extract', parserVersion: '1.0.0', extractorVersion: 'stub-2.0.0',
    });
  });

  it('leaves it null for a human or import origin', async () => {
    const id = await createCandidate(aiApp);
    await post(aiApp, `/candidates/${id}/proposals`, {
      origin: 'bulk.import', fields: [{ field: 'location', value: 'Cairo' }],
    }).expect(201);

    const row = (await harness.db.select().from(candidateProposal))[0];
    // Nothing to reproduce when a person typed it.
    expect(row?.generation).toBeNull();
  });
});
