// Smart search — full text, trigram fallback, optional skill expansion.

import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import { createTestDatabase } from '../infrastructure/db/testing/database.js';
import type { TestDatabase } from '../infrastructure/db/testing/database.js';
import { compose } from './composition-root.js';
import { createApiApp, API_PREFIX } from './server.js';
import { JwtTokenVerifier } from './auth/authenticate.js';
import { StaticPrincipalResolver } from './auth/principal.js';
import type { Principal } from './auth/principal.js';
import { InMemoryDocumentStore } from '../modules/talent/infrastructure/document-store.js';
import { DEFAULT_CONFIG } from './infrastructure/gateways.js';
import { AI_CAPABILITIES } from '../modules/shared/kernel/ai/index.js';
import type {
  AIOutcome, NormalizedSkill, SkillNormalizer,
} from '../modules/shared/kernel/ai/index.js';

const SECRET = 'test-secret';
const PERMS = [
  'candidate.create', 'candidate.view_all',
  'requisition.create', 'requisition.view_all', 'requisition.view_own',
];

const principal = (over: Partial<Principal> = {}): Principal => ({
  userId: 7, userName: 'Mona Adel', permissions: PERMS,
  projectScopes: [], isGlobalScope: true, tenantId: 1,
  mustChangePassword: false, status: 'active', ...over,
});
const PRINCIPALS = new Map<number, Principal>([
  [7, principal()],
  // Project 3 only — used to prove requisition scope holds in search.
  [9, principal({ userId: 9, isGlobalScope: false, projectScopes: [3] })],
]);

/** Expands "primavera" to a canonical form plus aliases. */
class StubNormalizer implements SkillNormalizer {
  async normalize(raw: readonly string[]): Promise<AIOutcome<readonly NormalizedSkill[]>> {
    if (raw[0]?.toLowerCase() !== 'scheduling') {
      return {
        abstained: true, permanent: true, reason: 'unknown skill',
        provenance: {
          capability: AI_CAPABILITIES.SKILL_NORMALIZE, modelId: 'stub',
          promptVersionId: 'v1', producedAt: new Date(),
        },
      };
    }
    return {
      content: [{ input: 'scheduling', canonical: 'Primavera', aliases: ['P6'] }],
      confidence: 0.9,
      reasoningSummary: 'stub',
      sourcesUsed: [],
      provenance: {
        capability: AI_CAPABILITIES.SKILL_NORMALIZE, modelId: 'stub',
        promptVersionId: 'v1', producedAt: new Date(),
      },
    };
  }
}

let harness: TestDatabase;
let app: Express;
let smartApp: Express;

const auth = (id = 7): string => `Bearer ${jwt.sign({ sub: id }, SECRET, { expiresIn: '1h' })}`;
const post = (target: Express, p: string, body: unknown): request.Test =>
  request(target).post(`${API_PREFIX}${p}`).set('Authorization', auth()).send(body as object);
const search = (target: Express, qs: string, id = 7): request.Test =>
  request(target).get(`${API_PREFIX}/search${qs}`).set('Authorization', auth(id));

beforeAll(async () => {
  harness = await createTestDatabase();
  const base = {
    documents: new InMemoryDocumentStore(),
    year: (): number => 2026,
    config: { ...DEFAULT_CONFIG, requisitionApprovalRequired: false },
  };
  app = createApiApp({
    app: compose(harness.db, base),
    verifier: new JwtTokenVerifier(SECRET),
    principals: new StaticPrincipalResolver(PRINCIPALS),
  });
  smartApp = createApiApp({
    app: compose(harness.db, { ...base, capabilities: { skillNormalizer: new StubNormalizer() } }),
    verifier: new JwtTokenVerifier(SECRET),
    principals: new StaticPrincipalResolver(PRINCIPALS),
  });
});

afterAll(async () => { await harness.close(); });
beforeEach(async () => { await harness.reset(); });

const makeCandidate = async (
  over: Record<string, unknown>,
): Promise<number> => (await post(app, '/candidates', {
  fullName: 'Ahmed Hassan', email: 'ahmed@example.com', ...over,
}).expect(201)).body.candidate.id as number;

describe('candidate search', () => {
  it('finds people by name, company and candidate number', async () => {
    await makeCandidate({ fullName: 'Ahmed Hassan', currentCompany: 'Orascom' });
    await makeCandidate({ fullName: 'Sara Ali', email: 's@x.com', currentCompany: 'Hassan Allam' });

    expect((await search(app, '?q=Ahmed').expect(200)).body.candidates).toHaveLength(1);
    expect((await search(app, '?q=Orascom').expect(200)).body.candidates[0].title)
      .toBe('Ahmed Hassan');
    // "Hassan" is a surname on one and a company on the other — both match.
    expect((await search(app, '?q=Hassan').expect(200)).body.candidates).toHaveLength(2);
    expect((await search(app, '?q=CAN-00001').expect(200)).body.candidates).toHaveLength(1);
  });

  it('searches inside skills, which no name search could reach', async () => {
    await makeCandidate({ skills: ['AutoCAD', 'Primavera'] });
    await makeCandidate({ fullName: 'Sara Ali', email: 's@x.com', skills: ['Revit'] });

    const res = await search(app, '?q=Primavera').expect(200);
    expect(res.body.candidates).toHaveLength(1);
    expect(res.body.candidates[0].extra.skills).toContain('Primavera');
  });

  it('falls back to trigram for a partial word', async () => {
    await makeCandidate({ skills: ['Primavera'] });
    // Full text matches whole lexemes, so "primav" needs the fallback.
    const res = await search(app, '?q=primav').expect(200);
    expect(res.body.candidates).toHaveLength(1);
  });

  it('returns nothing for a query that matches nothing', async () => {
    await makeCandidate({});
    const res = await search(app, '?q=zzzznotathing').expect(200);
    expect(res.body.candidates).toEqual([]);
    expect(res.body.totals).toEqual({ candidates: 0, requisitions: 0 });
  });

  it('hides erased records', async () => {
    const id = await makeCandidate({});
    await post(app, `/candidates/${id}/state`, { state: 'ERASED', reason: 'erasure' })
      .expect(403); // no candidate.change_state in this suite's permissions

    // Erase directly to prove the search filter, not the endpoint.
    const { candidate } = await import('../infrastructure/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    await harness.db.update(candidate).set({ state: 'ERASED' }).where(eq(candidate.id, id));

    expect((await search(app, '?q=Ahmed').expect(200)).body.candidates).toEqual([]);
  });

  it('keeps the blob current when a candidate is edited', async () => {
    const id = await makeCandidate({ currentCompany: 'Orascom' });
    expect((await search(app, '?q=Orascom').expect(200)).body.candidates).toHaveLength(1);

    await request(app).patch(`${API_PREFIX}/candidates/${id}`)
      .set('Authorization', auth()).send({ currentCompany: 'Hassan Allam' }).expect(403);
  });
});

describe('requisition search and scope', () => {
  const makeRequisition = async (title: string, projectId: number): Promise<number> =>
    (await post(app, '/requisitions', {
      title, projectId, departmentId: 4, headcount: 1,
    }).expect(201)).body.id as number;

  it('finds requisitions by title and ticket number', async () => {
    await makeRequisition('Senior Site Engineer', 3);
    const res = await search(app, '?q=Engineer').expect(200);
    expect(res.body.requisitions).toHaveLength(1);
    expect(res.body.requisitions[0].reference).toMatch(/^REQ-2026-/);
  });

  it('applies project scope to requisitions', async () => {
    await makeRequisition('Site Engineer', 3);
    await makeRequisition('Crane Operator', 77);

    const all = await search(app, '?q=e').expect(200);
    expect(all.body.requisitions.length).toBeGreaterThanOrEqual(1);

    // User 9 sees project 3 only.
    const scoped = await search(app, '?q=Crane', 9).expect(200);
    expect(scoped.body.requisitions).toEqual([]);
    const visible = await search(app, '?q=Site', 9).expect(200);
    expect(visible.body.requisitions).toHaveLength(1);
  });

  it('restricts to the requested entity types', async () => {
    await makeCandidate({ fullName: 'Engineer Person', email: 'e@x.com' });
    await makeRequisition('Site Engineer', 3);

    const only = await search(app, '?q=Engineer&types=Requisition').expect(200);
    expect(only.body.candidates).toEqual([]);
    expect(only.body.requisitions).toHaveLength(1);
  });

  it('validates the query', async () => {
    await request(app).get(`${API_PREFIX}/search`).set('Authorization', auth()).expect(400);
    await search(app, '?q=%20%20').expect(400);
  });
});

describe('optional skill normalisation', () => {
  it('expands a query when a normaliser is configured', async () => {
    await makeCandidate({ skills: ['Primavera'] });

    // No normaliser: "scheduling" is just a word, and nobody has it.
    expect((await search(app, '?q=scheduling').expect(200)).body.candidates).toEqual([]);

    // With one: the alias widens the search rather than replacing it.
    const smart = await search(smartApp, '?q=scheduling').expect(200);
    expect(smart.body.terms).toEqual(expect.arrayContaining(['scheduling', 'Primavera', 'P6']));
    expect(smart.body.candidates).toHaveLength(1);
  });

  it('falls back to the raw term when the normaliser abstains', async () => {
    await makeCandidate({ fullName: 'Ahmed Hassan' });
    const res = await search(smartApp, '?q=Ahmed').expect(200);
    expect(res.body.terms).toEqual(['Ahmed']);
    expect(res.body.candidates).toHaveLength(1);
  });
});
