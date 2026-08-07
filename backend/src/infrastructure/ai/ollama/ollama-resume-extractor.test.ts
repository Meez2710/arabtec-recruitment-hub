// Ollama extractor contract tests. Stubbed HTTP throughout.
//
// SCOPE: mapping, schema strictness, failure classification, and the local-only
// guarantee. These prove NOTHING about Qwen's real extraction quality or speed —
// that requires the benchmark corpus on target hardware.

import { describe, expect, it } from 'vitest';
import { OllamaResumeExtractor } from './ollama-resume-extractor.js';
import { validateResume } from './resume-schema.js';
import { assertLocalHost, OllamaClient } from './ollama-client.js';
import type { FetchLike } from './ollama-client.js';
import { isProposal } from '../../../modules/shared/kernel/ai/index.js';
import type { ParsedDocument } from '../../../modules/shared/kernel/ai/index.js';

const parsed: ParsedDocument = {
  text: 'Ahmed Hassan\nSite Engineer at Orascom',
  markdown: '# Ahmed Hassan\n\n## Experience\n- Orascom — Site Engineer',
  pageCount: 1,
  pages: ['Ahmed Hassan'],
};

const GOOD = {
  fullName: 'Ahmed Hassan',
  email: 'ahmed@example.com',
  phone: '+20 100 123 4567',
  location: 'Cairo',
  skills: ['AutoCAD', 'Primavera'],
  employment: [{ employer: 'Orascom', title: 'Site Engineer', current: true }],
  education: [{ institution: 'Cairo University', field: 'Civil Engineering', to: '2018' }],
  languages: ['Arabic', 'English'],
  certifications: [],
  uncertainFields: ['phone'],
};

/** Stub Ollama: /api/show returns model info, /api/generate returns `gen`. */
const stub = (gen: unknown, opts: { status?: number; err?: Error } = {}): FetchLike =>
  async (url) => {
    if (opts.err) throw opts.err;
    if (url.endsWith('/api/show')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ digest: 'sha256:abc123', details: { quantization_level: 'Q4_K_M' } }),
      };
    }
    return { ok: (opts.status ?? 200) < 400, status: opts.status ?? 200, json: async () => gen };
  };

const genBody = (response: unknown, extra: Record<string, unknown> = {}): unknown => ({
  response: typeof response === 'string' ? response : JSON.stringify(response),
  prompt_eval_count: 300,
  eval_count: 200,
  ...extra,
});

const extractorWith = (fetchImpl: FetchLike, over = {}): OllamaResumeExtractor =>
  new OllamaResumeExtractor({ model: 'qwen3:8b', fetchImpl, ...over });

describe('local-only enforcement', () => {
  it('accepts loopback and private hosts', () => {
    for (const h of ['http://127.0.0.1:11434', 'http://localhost:11434',
      'http://192.168.1.5:11434', 'http://10.0.0.4:11434', 'http://ollama:11434']) {
      expect(() => assertLocalHost(h)).not.toThrow();
    }
  });

  it('REFUSES a public host — CV text must not leave this machine', () => {
    for (const h of ['https://api.openai.com', 'https://ollama.example.com', 'http://8.8.8.8']) {
      expect(() => assertLocalHost(h)).toThrow(/must not leave this host|non-local/i);
    }
  });

  it('refuses to construct a client without a pinned model', () => {
    expect(() => new OllamaClient({ model: '' })).toThrow(/pinned Ollama model is required/);
    expect(() => new OllamaClient({})).toThrow(/pinned Ollama model is required/);
  });
});

describe('success mapping', () => {
  it('maps a valid response onto ExtractedResume', async () => {
    const outcome = await extractorWith(stub(genBody(GOOD))).extract(parsed);
    expect(isProposal(outcome)).toBe(true);
    if (!isProposal(outcome)) return;

    expect(outcome.content.fullName).toBe('Ahmed Hassan');
    expect(outcome.content.skills).toEqual(['AutoCAD', 'Primavera']);
    expect(outcome.content.employment[0]?.employer).toBe('Orascom');
    expect(outcome.content.uncertainFields).toContain('phone');
  });

  it('records the model digest so a proposal is reproducible', async () => {
    const outcome = await extractorWith(stub(genBody(GOOD))).extract(parsed);
    if (!isProposal(outcome)) throw new Error('expected a proposal');
    expect(outcome.provenance.modelDigest).toBe('sha256:abc123');
    expect(outcome.provenance.modelId).toBe('qwen3:8b');
    expect(outcome.provenance.promptVersionId).toMatch(/resume-extract-prompt/);
    expect(outcome.provenance.latencyMs).toBeTypeOf('number');
  });

  it('pins prompt and schema versions into the adapter version', () => {
    const v = extractorWith(stub(genBody(GOOD))).version;
    expect(v).toContain('resume-extract-prompt/1.0.0');
    expect(v).toContain('resume-extract/1.0.0');
  });

  it('prefers markdown over plain text when the parser recovered structure', async () => {
    let sentPrompt = '';
    const spy: FetchLike = async (url, init) => {
      if (url.endsWith('/api/show')) return { ok: true, status: 200, json: async () => ({}) };
      sentPrompt = JSON.parse(String(init.body)).prompt;
      return { ok: true, status: 200, json: async () => genBody(GOOD) };
    };
    const outcome = await extractorWith(spy).extract(parsed);
    expect(sentPrompt).toBe(parsed.markdown);
    if (!isProposal(outcome)) throw new Error('expected a proposal');
    expect(outcome.reasoningSummary).toMatch(/structured markdown/);
  });

  it('falls back to plain text when there is no markdown', async () => {
    let sentPrompt = '';
    const spy: FetchLike = async (url, init) => {
      if (url.endsWith('/api/show')) return { ok: true, status: 200, json: async () => ({}) };
      sentPrompt = JSON.parse(String(init.body)).prompt;
      return { ok: true, status: 200, json: async () => genBody(GOOD) };
    };
    await extractorWith(spy).extract({ ...parsed, markdown: undefined });
    expect(sentPrompt).toBe(parsed.text);
  });

  it('generates deterministically — same CV, same answer', async () => {
    let opts: Record<string, unknown> = {};
    const spy: FetchLike = async (url, init) => {
      if (url.endsWith('/api/show')) return { ok: true, status: 200, json: async () => ({}) };
      opts = JSON.parse(String(init.body)).options;
      return { ok: true, status: 200, json: async () => genBody(GOOD) };
    };
    await extractorWith(spy).extract(parsed);
    expect(opts['temperature']).toBe(0);
    expect(opts['seed']).toBe(0);
  });

  it('still produces a proposal when the digest cannot be resolved', async () => {
    const noShow: FetchLike = async (url) => {
      if (url.endsWith('/api/show')) throw new Error('show unavailable');
      return { ok: true, status: 200, json: async () => genBody(GOOD) };
    };
    const outcome = await extractorWith(noShow).extract(parsed);
    if (!isProposal(outcome)) throw new Error('expected a proposal');
    expect(outcome.provenance.modelDigest).toBeUndefined();
  });
});

describe('schema strictness — never invent a value', () => {
  it('collapses filler to absent rather than storing it', () => {
    const r = validateResume({
      fullName: 'Ahmed Hassan',
      email: 'N/A',
      phone: '   ',
      location: 'not specified',
      skills: ['AutoCAD', '', 'none'],
      employment: [],
      education: [],
      languages: [],
      certifications: [],
      uncertainFields: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.email).toBeUndefined();
    expect(r.value.phone).toBeUndefined();
    expect(r.value.location).toBeUndefined();
    expect(r.value.skills).toEqual(['AutoCAD']);
  });

  it('strips unknown keys the model volunteered', () => {
    const r = validateResume({
      fullName: 'Ahmed', salary: 50000, ssn: '123',
      skills: [], employment: [], education: [],
      languages: [], certifications: [], uncertainFields: [],
    });
    if (!r.ok) throw new Error('expected ok');
    expect('salary' in r.value).toBe(false);
    expect('ssn' in r.value).toBe(false);
  });

  it('rejects an out-of-range experience figure instead of coercing it', () => {
    const mk = (n: unknown): unknown => ({
      fullName: 'Ahmed', totalYearsExperience: n,
      skills: [], employment: [], education: [],
      languages: [], certifications: [], uncertainFields: [],
    });
    for (const bad of [2019, 240, -3, 'five']) {
      const r = validateResume(mk(bad));
      if (!r.ok) throw new Error('expected ok');
      expect(r.value.totalYearsExperience).toBeUndefined();
    }
    const good = validateResume(mk(7.5));
    if (!good.ok) throw new Error('expected ok');
    expect(good.value.totalYearsExperience).toBe(7.5);
  });

  it('drops an employment entry missing its required fields', () => {
    const r = validateResume({
      fullName: 'Ahmed',
      employment: [{ employer: 'Orascom' }],
      skills: [], education: [], languages: [], certifications: [], uncertainFields: [],
    });
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.employment).toEqual([]);
  });

  it('rejects a well-formed but entirely empty object as an abstention', () => {
    const r = validateResume({
      skills: [], employment: [], education: [],
      languages: [], certifications: [], uncertainFields: [],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/no extractable fields/i);
  });

  it('preserves Arabic script rather than transliterating', () => {
    const r = validateResume({
      fullName: 'أحمد حسن', phone: '٠١٠٠١٢٣٤٥٦٧',
      skills: [], employment: [], education: [],
      languages: [], certifications: [], uncertainFields: [],
    });
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.fullName).toBe('أحمد حسن');
    expect(r.value.phone).toBe('٠١٠٠١٢٣٤٥٦٧');
  });
});

describe('failure classification', () => {
  it('abstains permanently when the model is not pulled on this host', async () => {
    const missing: FetchLike = async () => ({ ok: false, status: 404, json: async () => ({}) });
    const outcome = await extractorWith(missing).extract(parsed);
    if (isProposal(outcome)) throw new Error('expected an abstention');
    expect(outcome.permanent).toBe(true);
    expect(outcome.reason).toMatch(/not available on this Ollama host/i);
  });

  it('abstains temporarily when Ollama is unreachable', async () => {
    const err = Object.assign(new Error('ECONNREFUSED'), { name: 'FetchError' });
    const outcome = await extractorWith(stub(null, { err })).extract(parsed);
    if (isProposal(outcome)) throw new Error('expected an abstention');
    expect(outcome.permanent).toBe(false);
    expect(outcome.reason).toMatch(/unreachable/i);
  });

  it('abstains temporarily on timeout', async () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const outcome = await extractorWith(stub(null, { err })).extract(parsed);
    if (isProposal(outcome)) throw new Error('expected an abstention');
    expect(outcome.permanent).toBe(false);
    expect(outcome.reason).toMatch(/timed out/i);
  });

  it('abstains on malformed JSON rather than repairing it', async () => {
    const outcome = await extractorWith(stub(genBody('Here you go: {broken,,,'))).extract(parsed);
    if (isProposal(outcome)) throw new Error('expected an abstention');
    expect(outcome.reason).toMatch(/parseable JSON/i);
  });

  it('abstains on a schema-invalid response', async () => {
    const outcome = await extractorWith(stub(genBody({
      skills: [], employment: [], education: [],
      languages: [], certifications: [], uncertainFields: [],
    }))).extract(parsed);
    if (isProposal(outcome)) throw new Error('expected an abstention');
    expect(outcome.reason).toMatch(/no extractable fields/i);
  });

  it('abstains when the response was cut off, never half-accepting it', async () => {
    const outcome = await extractorWith(
      stub(genBody(GOOD, { done_reason: 'length' })),
    ).extract(parsed);
    if (isProposal(outcome)) throw new Error('expected an abstention');
    expect(outcome.reason).toMatch(/cut off/i);
  });

  it('abstains permanently when the document cannot fit the context window', async () => {
    const huge = { ...parsed, markdown: 'x'.repeat(200_000) };
    const outcome = await extractorWith(stub(genBody(GOOD)), { contextSize: 4096 }).extract(huge);
    if (isProposal(outcome)) throw new Error('expected an abstention');
    expect(outcome.permanent).toBe(true);
    expect(outcome.reason).toMatch(/too long for the 4096-token context/i);
  });

  it('abstains permanently on an empty parsed document', async () => {
    const outcome = await extractorWith(stub(genBody(GOOD)))
      .extract({ text: '  ', markdown: undefined, pageCount: 1, pages: [] });
    if (isProposal(outcome)) throw new Error('expected an abstention');
    expect(outcome.permanent).toBe(true);
  });

  it('never returns content on any failure path — no silent fallback', async () => {
    const err = Object.assign(new Error('down'), { name: 'FetchError' });
    const outcome = await extractorWith(stub(null, { err })).extract(parsed);
    expect('content' in outcome).toBe(false);
  });
});
