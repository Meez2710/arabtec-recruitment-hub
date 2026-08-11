// Bulk CV upload — staging intake, end to end.
//
// The rule under test: bulk upload NEVER creates a candidate directly, and the
// Candidate invariants are never relaxed to accommodate it.

import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import { createTestDatabase } from '../infrastructure/db/testing/database.js';
import type { TestDatabase } from '../infrastructure/db/testing/database.js';
import {
  aiTask, candidate, candidateDocument, cvIntakeItem,
} from '../infrastructure/db/schema/index.js';
import { compose } from './composition-root.js';
import type { Application as Composed } from './composition-root.js';
import { createApiApp, API_PREFIX } from './server.js';
import { JwtTokenVerifier } from './auth/authenticate.js';
import { StaticPrincipalResolver } from './auth/principal.js';
import type { Principal } from './auth/principal.js';
import { InMemoryDocumentStore } from '../modules/talent/infrastructure/document-store.js';
import { PlainTextDocumentParser } from '../infrastructure/ai/plain-text-parser.js';
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

const provenance = {
  capability: AI_CAPABILITIES.RESUME_EXTRACT,
  modelId: 'qwen2.5-stub',
  promptVersionId: 'resume-v1',
  producedAt: new Date(),
};

/** Extracts a name from the document text so each file yields a distinct person. */
class NameFromTextExtractor implements ResumeExtractor {
  readonly version = 'stub-2.0.0';
  async extract(parsed: { text: string }): Promise<AIOutcome<ExtractedResume>> {
    const name = parsed.text.split('\n')[0]?.trim() ?? '';
    if (name === '') {
      return {
        abstained: true, permanent: true, reason: 'No name line found.', provenance,
      };
    }
    return {
      content: {
        fullName: name,
        email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`,
        location: 'Cairo',
        skills: ['AutoCAD'],
        employment: [{ employer: 'Orascom', title: 'Site Engineer', current: true }],
        education: [],
        languages: [],
        certifications: [],
        uncertainFields: [],
      },
      confidence: 0.85,
      reasoningSummary: 'stub',
      sourcesUsed: ['doc'],
      provenance,
    };
  }
}

let harness: TestDatabase;
let store: InMemoryDocumentStore;
let composed: Composed;
let app: Express;

const auth = (): string => `Bearer ${jwt.sign({ sub: 7 }, SECRET, { expiresIn: '1h' })}`;

beforeAll(async () => {
  harness = await createTestDatabase();
  store = new InMemoryDocumentStore();
  composed = compose(harness.db, {
    documents: store, year: () => 2026,
    capabilities: {
      documentParser: new PlainTextDocumentParser(),
      resumeExtractor: new NameFromTextExtractor(),
    },
  });
  app = createApiApp({
    app: composed,
    verifier: new JwtTokenVerifier(SECRET),
    principals: new StaticPrincipalResolver(PRINCIPALS),
  });
});

afterAll(async () => { await harness.close(); });
beforeEach(async () => { await harness.reset(); });

const uploadBatch = async (
  files: readonly { name: string; text: string }[],
  label = 'March CVs',
): Promise<{ id: number; version: number; items: { itemId: string; fileName: string }[] }> => {
  let req = request(app).post(`${API_PREFIX}/cv-intake`)
    .set('Authorization', auth())
    .field('label', label);
  for (const f of files) {
    req = req.attach('files', Buffer.from(f.text), { filename: f.name, contentType: 'text/plain' });
  }
  const res = await req;
  expect(res.status).toBe(201);
  return res.body;
};

const post = (path: string, body: unknown): request.Test =>
  request(app).post(`${API_PREFIX}${path}`).set('Authorization', auth()).send(body as object);

describe('bulk upload stages files without creating candidates', () => {
  it('accepts a multipart batch and queues one parse task per file', async () => {
    const batch = await uploadBatch([
      { name: 'a.txt', text: 'Ahmed Hassan\nSite Engineer' },
      { name: 'b.txt', text: 'Sara Ali\nQuantity Surveyor' },
    ]);

    expect(batch.items).toHaveLength(2);
    // NOT candidates — a PDF is not a person until someone says so.
    expect(await harness.db.select().from(candidate)).toEqual([]);
    expect(await harness.db.select().from(aiTask)).toHaveLength(2);
    expect((await harness.db.select().from(aiTask))[0]?.priority).toBe('BATCH');
  });

  it('rejects an upload with no files', async () => {
    const res = await request(app).post(`${API_PREFIX}/cv-intake`)
      .set('Authorization', auth()).field('label', 'Empty');
    expect(res.status).toBe(400);
  });

  it('deduplicates identical bytes within one batch', async () => {
    const batch = await uploadBatch([
      { name: 'cv.txt', text: 'Ahmed Hassan' },
      { name: 'cv (1).txt', text: 'Ahmed Hassan' },
    ]);
    // Same content, one item, one task.
    expect(batch.items).toHaveLength(1);
    expect(await harness.db.select().from(aiTask)).toHaveLength(1);
  });

  it('stages the batch and its tasks in one transaction', async () => {
    await uploadBatch([{ name: 'a.txt', text: 'Ahmed Hassan' }]);
    expect(await harness.db.select().from(cvIntakeItem)).toHaveLength(1);
    expect(await harness.db.select().from(aiTask)).toHaveLength(1);
  });
});

describe('parsing an intake batch', () => {
  it('records extraction on the item, not on any candidate', async () => {
    const batch = await uploadBatch([{ name: 'a.txt', text: 'Ahmed Hassan\nEngineer' }]);
    await composed.aiWorker!.drainUntilEmpty();

    const detail = await request(app).get(`${API_PREFIX}/cv-intake/${batch.id}`)
      .set('Authorization', auth()).expect(200);

    expect(detail.body.items[0].status).toBe('PARSED');
    expect(detail.body.items[0].extracted.map((f: { field: string }) => f.field))
      .toEqual(expect.arrayContaining(['fullName', 'email', 'location']));
    // Still nobody.
    expect(await harness.db.select().from(candidate)).toEqual([]);
  });

  it('marks an unreadable file PARSE_FAILED so a reviewer is not left waiting', async () => {
    let req = request(app).post(`${API_PREFIX}/cv-intake`)
      .set('Authorization', auth()).field('label', 'Mixed');
    req = req.attach('files', Buffer.from('%PDF-1.7 binary'),
      { filename: 'scan.pdf', contentType: 'application/pdf' });
    const batch = (await req.expect(201)).body;

    await composed.aiWorker!.drainUntilEmpty();
    const detail = await request(app).get(`${API_PREFIX}/cv-intake/${batch.id}`)
      .set('Authorization', auth()).expect(200);

    expect(detail.body.items[0].status).toBe('PARSE_FAILED');
    expect(detail.body.items[0].note).toMatch(/pdf/i);
  });
});

describe('conversion creates a real Candidate under the ordinary invariants', () => {
  const parsedBatch = async (): Promise<{ id: number; itemId: string }> => {
    const batch = await uploadBatch([{ name: 'a.txt', text: 'Ahmed Hassan\nEngineer' }]);
    await composed.aiWorker!.drainUntilEmpty();
    return { id: batch.id, itemId: batch.items[0]!.itemId };
  };

  it('creates the candidate from accepted fields, with AI provenance', async () => {
    const { id, itemId } = await parsedBatch();

    const res = await post(`/cv-intake/${id}/items/${itemId}/convert`, {
      acceptedFields: ['fullName', 'email', 'location'],
    }).expect(201);

    const rows = await harness.db.select().from(candidate);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fullName).toBe('Ahmed Hassan');
    expect(rows[0]?.source).toBe('cv-intake');

    const provenanceMap = rows[0]?.provenance as Record<string, { source: string; modelId?: string }>;
    expect(provenanceMap['fullName']).toMatchObject({
      source: 'AI_APPROVED', modelId: 'qwen2.5-stub',
    });
    expect(res.body.appliedAiFields).toEqual(
      expect.arrayContaining(['fullName', 'email', 'location']),
    );

    // The CV follows the candidate, and is NOT re-parsed.
    expect(await harness.db.select().from(candidateDocument)).toHaveLength(1);
    expect(await harness.db.select().from(aiTask)).toHaveLength(1);
  });

  it('marks a typed field USER even when the parser also suggested it', async () => {
    const { id, itemId } = await parsedBatch();
    await post(`/cv-intake/${id}/items/${itemId}/convert`, {
      manual: { fullName: 'Ahmed M. Hassan' },
      acceptedFields: ['fullName', 'email'],
    }).expect(201);

    const rows = await harness.db.select().from(candidate);
    // The reviewer was looking at both and chose; their value wins and is theirs.
    expect(rows[0]?.fullName).toBe('Ahmed M. Hassan');
    const provenanceMap = rows[0]?.provenance as Record<string, { source: string }>;
    expect(provenanceMap['fullName']?.source).toBe('USER');
    expect(provenanceMap['email']?.source).toBe('AI_APPROVED');
  });

  it('refuses to create a candidate with no name', async () => {
    const { id, itemId } = await parsedBatch();
    const res = await post(`/cv-intake/${id}/items/${itemId}/convert`, { acceptedFields: [] });
    // The invariant is NOT relaxed for bulk upload. That is the whole reason
    // staging exists.
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_CANDIDATE_FIELD');
    expect(await harness.db.select().from(candidate)).toEqual([]);
  });

  it('refuses to create a candidate nobody can contact', async () => {
    const { id, itemId } = await parsedBatch();
    const res = await post(`/cv-intake/${id}/items/${itemId}/convert`, {
      manual: { fullName: 'Ahmed Hassan' },
      acceptedFields: ['location'],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CONTACT_REQUIRED');
    expect(await harness.db.select().from(candidate)).toEqual([]);
  });

  it('reports duplicates on conversion without blocking it', async () => {
    await post('/candidates', {
      fullName: 'Existing', email: 'ahmed.hassan@example.com',
    }).expect(201);

    const { id, itemId } = await parsedBatch();
    const res = await post(`/cv-intake/${id}/items/${itemId}/convert`, {
      acceptedFields: ['fullName', 'email'],
    }).expect(201);

    expect(res.body.possibleDuplicates).toHaveLength(1);
    expect(res.body.possibleDuplicates[0].matchedOn).toContain('email');
  });

  it('cannot convert the same item twice', async () => {
    // Two items so the batch stays OPEN after the first conversion — otherwise
    // the batch completes and the closed-batch guard answers first.
    const batch = await uploadBatch([
      { name: 'a.txt', text: 'Ahmed Hassan' },
      { name: 'b.txt', text: 'Sara Ali' },
    ]);
    await composed.aiWorker!.drainUntilEmpty();
    const itemId = batch.items[0]!.itemId;

    await post(`/cv-intake/${batch.id}/items/${itemId}/convert`, {
      acceptedFields: ['fullName', 'email'],
    }).expect(201);

    const again = await post(`/cv-intake/${batch.id}/items/${itemId}/convert`, {
      acceptedFields: ['fullName', 'email'],
    });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('INTAKE_ITEM_NOT_CONVERTIBLE');
    expect(await harness.db.select().from(candidate)).toHaveLength(1);
  });
});

describe('batch lifecycle', () => {
  it('completes once every item is settled', async () => {
    const batch = await uploadBatch([
      { name: 'a.txt', text: 'Ahmed Hassan' },
      { name: 'b.txt', text: 'Sara Ali' },
    ]);
    await composed.aiWorker!.drainUntilEmpty();

    await post(`/cv-intake/${batch.id}/items/${batch.items[0]!.itemId}/convert`, {
      acceptedFields: ['fullName', 'email'],
    }).expect(201);

    let detail = await request(app).get(`${API_PREFIX}/cv-intake/${batch.id}`)
      .set('Authorization', auth()).expect(200);
    expect(detail.body.status).toBe('OPEN');
    expect(detail.body.progress.outstanding).toBe(1);

    await post(`/cv-intake/${batch.id}/items/${batch.items[1]!.itemId}/discard`, {
      reason: 'not relevant',
    }).expect(200);

    detail = await request(app).get(`${API_PREFIX}/cv-intake/${batch.id}`)
      .set('Authorization', auth()).expect(200);
    // No "close" ceremony — a batch with nothing left to review is done.
    expect(detail.body.status).toBe('COMPLETED');
    expect(detail.body.progress.outstanding).toBe(0);
  });

  it('discards everything outstanding when a batch is cancelled', async () => {
    const batch = await uploadBatch([
      { name: 'a.txt', text: 'Ahmed Hassan' },
      { name: 'b.txt', text: 'Sara Ali' },
    ]);
    const res = await post(`/cv-intake/${batch.id}/cancel`, { reason: 'wrong folder' })
      .expect(200);

    expect(res.body.status).toBe('CANCELLED');
    expect(res.body.items.every((i: { status: string }) => i.status === 'DISCARDED')).toBe(true);
    expect(await harness.db.select().from(candidate)).toEqual([]);
  });

  it('refuses to change a cancelled batch', async () => {
    const batch = await uploadBatch([{ name: 'a.txt', text: 'Ahmed Hassan' }]);
    await post(`/cv-intake/${batch.id}/cancel`, { reason: 'x' }).expect(200);

    const res = await post(
      `/cv-intake/${batch.id}/items/${batch.items[0]!.itemId}/convert`,
      { acceptedFields: ['fullName'] },
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INTAKE_BATCH_CLOSED');
  });

  it('never converts a discarded item', async () => {
    const batch = await uploadBatch([{ name: 'a.txt', text: 'Ahmed Hassan' }]);
    await composed.aiWorker!.drainUntilEmpty();
    await post(`/cv-intake/${batch.id}/items/${batch.items[0]!.itemId}/discard`, {
      reason: 'duplicate',
    }).expect(200);

    const res = await post(
      `/cv-intake/${batch.id}/items/${batch.items[0]!.itemId}/convert`,
      { acceptedFields: ['fullName', 'email'] },
    );
    expect(res.status).toBe(422);
  });
});

describe('with no AI configured', () => {
  it('still stages files, queues nothing, and allows manual conversion', async () => {
    const plain = compose(harness.db, { documents: store, year: () => 2026 });
    const plainApp = createApiApp({
      app: plain,
      verifier: new JwtTokenVerifier(SECRET),
      principals: new StaticPrincipalResolver(PRINCIPALS),
    });

    const batch = (await request(plainApp).post(`${API_PREFIX}/cv-intake`)
      .set('Authorization', auth())
      .field('label', 'Manual')
      .attach('files', Buffer.from('Ahmed Hassan'), {
        filename: 'a.txt', contentType: 'text/plain',
      })
      .expect(201)).body;

    expect(await harness.db.select().from(aiTask)).toEqual([]);

    // A recruiter who recognises the name converts it by hand, straight from
    // PENDING_PARSE.
    await request(plainApp)
      .post(`${API_PREFIX}/cv-intake/${batch.id}/items/${batch.items[0].itemId}/convert`)
      .set('Authorization', auth())
      .send({ manual: { fullName: 'Ahmed Hassan', email: 'a@example.com' }, acceptedFields: [] })
      .expect(201);

    expect(await harness.db.select().from(candidate)).toHaveLength(1);
  });
});

/* ------------------------------ read model -------------------------------- */

describe('intake read model', () => {
  it('lists batches with progress and a proposal summary, in one query', async () => {
    const batch = await uploadBatch([
      { name: 'a.txt', text: 'Ahmed Hassan' },
      { name: 'b.txt', text: 'Sara Ali' },
    ], 'March CVs');
    await composed.aiWorker!.drainUntilEmpty();
    await post(`/cv-intake/${batch.id}/items/${batch.items[0]!.itemId}/convert`, {
      acceptedFields: ['fullName', 'email'],
    }).expect(201);

    harness.queries.start();
    const list = await request(app).get(`${API_PREFIX}/cv-intake?limit=50`)
      .set('Authorization', auth()).expect(200);
    const statements = harness.queries.stop().filter((q) => /^\s*select/i.test(q));

    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({ label: 'March CVs', status: 'OPEN' });
    expect(list.body.items[0].progress).toMatchObject({
      total: 2, parsed: 1, converted: 1, outstanding: 1,
    });
    expect(list.body.items[0].progress.completion).toBeCloseTo(0.5, 5);
    expect(list.body.items[0].proposalSummary).toMatchObject({ readyForReview: 1 });
    expect(list.body.items[0].proposalSummary.modelIds).toEqual(['qwen2.5-stub']);
    // Every progress bar in the page, one statement.
    expect(statements).toHaveLength(1);
  });

  it('filters, sorts and paginates', async () => {
    await uploadBatch([{ name: 'a.txt', text: 'Ahmed' }], 'Alpha');
    const second = await uploadBatch([{ name: 'b.txt', text: 'Sara' }], 'Beta');
    await post(`/cv-intake/${second.id}/cancel`, { reason: 'wrong folder' }).expect(200);

    const get = (qs: string): request.Test =>
      request(app).get(`${API_PREFIX}/cv-intake${qs}`).set('Authorization', auth());

    expect((await get('?status=OPEN').expect(200)).body.total).toBe(1);
    expect((await get('?status=OPEN,CANCELLED').expect(200)).body.total).toBe(2);
    expect((await get('?q=alph').expect(200)).body.total).toBe(1);
    expect((await get('?hasOutstanding=true').expect(200)).body.total).toBe(1);
    expect((await get('?uploadedBy=999').expect(200)).body.total).toBe(0);

    const sorted = await get('?sort=label&direction=asc').expect(200);
    expect(sorted.body.items[0].label).toBe('Alpha');

    const page = await get('?limit=1&offset=1').expect(200);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.total).toBe(2);
  });

  it('shows live parsing status per item', async () => {
    const batch = await uploadBatch([{ name: 'a.txt', text: 'Ahmed Hassan' }]);

    let detail = await request(app).get(`${API_PREFIX}/cv-intake/${batch.id}`)
      .set('Authorization', auth()).expect(200);
    expect(detail.body.items[0]).toMatchObject({
      status: 'PENDING_PARSE', parsingStatus: 'QUEUED', parsingError: null,
    });
    expect(detail.body.items[0].parsingTaskId).toMatch(/^\d+$/);

    await composed.aiWorker!.drainUntilEmpty();
    detail = await request(app).get(`${API_PREFIX}/cv-intake/${batch.id}`)
      .set('Authorization', auth()).expect(200);
    expect(detail.body.items[0]).toMatchObject({
      status: 'PARSED', parsingStatus: 'SUCCEEDED',
    });
    expect(detail.body.items[0].generation).toMatchObject({ modelId: 'qwen2.5-stub' });
  });

  it('reports a parse error on the item that failed', async () => {
    const batch = (await request(app).post(`${API_PREFIX}/cv-intake`)
      .set('Authorization', auth()).field('label', 'Scans')
      .attach('files', Buffer.from('%PDF'), {
        filename: 'scan.pdf', contentType: 'application/pdf',
      })
      .expect(201)).body;
    await composed.aiWorker!.drainUntilEmpty();

    const detail = await request(app).get(`${API_PREFIX}/cv-intake/${batch.id}`)
      .set('Authorization', auth()).expect(200);
    expect(detail.body.items[0].status).toBe('PARSE_FAILED');
    expect(detail.body.items[0].parsingStatus).toBe('ABSTAINED');
    expect(detail.body.items[0].parsingError).toMatch(/pdf/i);
  });

  it('404s an unknown batch', async () => {
    await request(app).get(`${API_PREFIX}/cv-intake/99999`)
      .set('Authorization', auth()).expect(404);
  });
});
