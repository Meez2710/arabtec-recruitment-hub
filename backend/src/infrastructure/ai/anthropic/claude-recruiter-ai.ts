// Recruiter-facing AI: matching candidates to a requisition, and turning a
// recruiter's sentence into the filters the candidate list already supports.
//
// SEPARATE FROM THE CV PIPELINE ON PURPOSE. Reading a CV proposes values that
// get written to a person's record, so it sits behind an evidence gate and a
// human review. Nothing here writes anything: matching RANKS rows that already
// exist, and search TRANSLATES a query into parameters the API already accepts.
// A wrong answer here shows the recruiter a poor shortlist, which they can see
// and ignore — it cannot corrupt a candidate record. That difference is why
// these are allowed to reason freely where the parser is not.

import type Anthropic from '@anthropic-ai/sdk';
import { clientFor, textOf, type ClaudeConfig } from './client.js';

export const RECRUITER_AI_PROMPT_VERSION = 'arabtec-recruiter-2026-08-24';

/* ----------------------------- shared plumbing ---------------------------- */

const jsonCall = async (
  config: ClaudeConfig,
  client: Anthropic,
  args: {
    system: string;
    user: string;
    schema: Record<string, unknown>;
    maxTokens: number;
    effort?: 'low' | 'medium' | 'high';
  },
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; reason: string }> => {
  let message: Anthropic.Message;
  try {
    message = await client.messages.create({
      model: config.model,
      max_tokens: args.maxTokens,
      system: args.system,
      output_config: {
        format: { type: 'json_schema', schema: args.schema },
        ...(args.effort !== undefined ? { effort: args.effort } : {}),
      },
      messages: [{ role: 'user', content: args.user }],
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (message.stop_reason === 'refusal') return { ok: false, reason: 'Claude declined this request.' };
  try {
    const raw: unknown = JSON.parse(textOf(message));
    if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'Response was not an object.' };
    return { ok: true, data: raw as Record<string, unknown> };
  } catch {
    return { ok: false, reason: 'Response was not valid JSON.' };
  }
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/* -------------------------------- matching -------------------------------- */

export interface MatchRequisition {
  readonly id: number;
  readonly title: string;
  readonly location?: string | null;
  readonly keyRequirements?: string | null;
  readonly keyResponsibilities?: string | null;
  readonly requiredSkills?: readonly string[];
}

/** Deliberately narrow: enough to judge fit, small enough that 300 fit in one call. */
export interface MatchCandidate {
  readonly id: number;
  readonly fullName: string;
  readonly currentPosition?: string | null;
  readonly currentCompany?: string | null;
  readonly yearsExperience?: number | null;
  readonly location?: string | null;
  readonly university?: string | null;
  readonly major?: string | null;
  readonly skills?: readonly string[];
}

export interface CandidateMatchResult {
  readonly candidateId: number;
  /** 0-100. Presented as a percentage, never used to auto-advance anyone. */
  readonly score: number;
  readonly reason: string;
  readonly missingRequirements: readonly string[];
}

const MATCH_SYSTEM = [
  'You shortlist candidates for construction and engineering roles in the MENA',
  'region, for a recruiter who knows the sector.',
  '',
  'Rules:',
  '- Judge on evidence in the candidate summary: role, seniority, sector,',
  '  years, skills, education, location. Say what is missing, not only what fits.',
  '- score is 0-100 and must be discriminating. Reserve 85+ for a candidate who',
  '  could be shortlisted today. Use the middle of the range honestly; a list',
  '  where everyone scores 80 is useless to a recruiter.',
  '- Return ONLY candidates worth a recruiter\'s attention. Returning three good',
  '  matches is a better answer than twenty padded ones, and an empty list is a',
  '  valid, useful answer when nobody fits.',
  '- reason is ONE short sentence a recruiter can act on, naming the concrete',
  '  evidence. Not "strong match" — say why.',
  '- missingRequirements names requirements the summary does not evidence. An',
  '  empty list means everything asked for is evidenced.',
  '- Never invent experience, employers or skills that are not in the summary.',
  '- Rank most suitable first.',
].join('\n');

const MATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['matches'],
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['candidateId', 'score', 'reason', 'missingRequirements'],
        properties: {
          candidateId: { type: 'number' },
          score: { type: 'number' },
          reason: { type: 'string' },
          missingRequirements: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

const describeCandidate = (c: MatchCandidate): string => {
  const bits = [
    `#${c.id} ${c.fullName}`,
    c.currentPosition ? `role: ${c.currentPosition}` : null,
    c.currentCompany ? `at: ${c.currentCompany}` : null,
    c.yearsExperience != null ? `${c.yearsExperience}y exp` : null,
    c.location ? `in: ${c.location}` : null,
    c.major || c.university ? `edu: ${[c.major, c.university].filter(Boolean).join(', ')}` : null,
    c.skills && c.skills.length ? `skills: ${c.skills.slice(0, 12).join(', ')}` : null,
  ].filter(Boolean);
  return bits.join(' | ');
};

export const matchCandidates = async (
  config: ClaudeConfig,
  requisition: MatchRequisition,
  candidates: readonly MatchCandidate[],
  limit = 10,
): Promise<{ ok: true; matches: CandidateMatchResult[]; model: string } | { ok: false; reason: string }> => {
  if (candidates.length === 0) return { ok: true, matches: [], model: config.model };

  const req = [
    `ROLE: ${requisition.title}`,
    requisition.location ? `LOCATION: ${requisition.location}` : null,
    requisition.requiredSkills?.length ? `REQUIRED SKILLS: ${requisition.requiredSkills.join(', ')}` : null,
    requisition.keyRequirements ? `REQUIREMENTS:\n${requisition.keyRequirements}` : null,
    requisition.keyResponsibilities ? `RESPONSIBILITIES:\n${requisition.keyResponsibilities}` : null,
  ].filter(Boolean).join('\n');

  const user = [
    '<requisition>', req, '</requisition>', '',
    `<candidates count="${candidates.length}">`,
    ...candidates.map(describeCandidate),
    '</candidates>', '',
    `Return at most ${limit} candidates, best first.`,
  ].join('\n');

  const out = await jsonCall(config, clientFor(config), {
    system: MATCH_SYSTEM, user, schema: MATCH_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 8_000,
  });
  if (!out.ok) return out;

  const known = new Set(candidates.map((c) => c.id));
  const matches = (Array.isArray(out.data['matches']) ? out.data['matches'] : [])
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
    .map((m) => ({
      candidateId: num(m['candidateId']) ?? -1,
      score: Math.max(0, Math.min(100, Math.round(num(m['score']) ?? 0))),
      reason: str(m['reason']) ?? '',
      missingRequirements: list(m['missingRequirements']),
    }))
    // A candidate id that was not in the pool we sent is not a match, it is a
    // fabrication — drop it rather than show a recruiter a row they cannot open.
    .filter((m) => known.has(m.candidateId))
    .slice(0, limit);

  return { ok: true, matches, model: config.model };
};

/* --------------------------------- search --------------------------------- */

/** Exactly the filters GET /api/candidates already accepts. Nothing invented. */
export interface SearchFilters {
  q?: string;
  location?: string;
  currentCompany?: string;
  currentPosition?: string;
  university?: string;
  minExp?: number;
  maxExp?: number;
  tag?: string;
  screeningStatus?: string;
}

const SEARCH_SYSTEM = [
  'You turn a recruiter\'s plain-English request into search filters for a',
  'construction and engineering candidate database in the MENA region.',
  '',
  'Rules:',
  '- Use ONLY the fields in the schema. A requirement you cannot express in a',
  '  named field belongs in `q` as free text.',
  '- Set EVERY field the recruiter actually asked for. If they name a city, set',
  '  `location`. If they give a seniority or a number of years, set `minExp`',
  '  (and `maxExp` only when they gave an upper bound too).',
  '- Never add a constraint the recruiter did not ask for. That is different',
  '  from dropping one they did ask for — the first invents a filter, the',
  '  second quietly ignores them. Do neither, but never do the second.',
  '- `interpretation` and `filters` must agree exactly. If you write "in',
  '  Riyadh", `location` must be set. Say only what you filtered on.',
  '- `q` matches name, candidate id, company and email — not job titles. A role',
  '  goes in `currentPosition`.',
  '- Seniority in years where conventional: senior about 8, mid-level about 4,',
  '  junior 0-3. Prefer a `minExp` floor over inventing a range.',
  '- Do not expand a region into countries. "Gulf" or "GCC" goes in `q`.',
  '- `screeningStatus` is one of: new, screening, fit, unfit. Set it only when',
  '  the recruiter clearly asks for that state.',
  '',
  'Worked examples:',
  '  "senior structural engineers in Dubai from AUS"',
  '    -> {"currentPosition":"Structural Engineer","location":"Dubai",',
  '        "university":"AUS","minExp":8}',
  '  "quantity surveyors in Riyadh with more than 10 years"',
  '    -> {"currentPosition":"Quantity Surveyor","location":"Riyadh","minExp":10}',
  '  "anyone at Orascom"',
  '    -> {"currentCompany":"Orascom"}',
].join('\n');

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['filters', 'interpretation'],
  properties: {
    interpretation: { type: 'string' },
    filters: {
      type: 'object',
      additionalProperties: false,
      // EVERY key is required, and every key is nullable. That combination is
      // what makes this work: with `required: []` the model quietly omits
      // fields it was asked for — "quantity surveyors in Riyadh with more than
      // 10 years" came back as {currentPosition} alone, dropping both the city
      // and the years while the interpretation still promised them, and one run
      // emitted a garbage {"tag": ":10,"}. Forcing the key to be present turns
      // each field into a decision the model has to make explicitly, null or
      // value, instead of something it can pass over.
      required: [
        'q', 'location', 'currentCompany', 'currentPosition', 'university',
        'minExp', 'maxExp', 'tag', 'screeningStatus',
      ],
      properties: {
        q: { type: ['string', 'null'] },
        location: { type: ['string', 'null'] },
        currentCompany: { type: ['string', 'null'] },
        currentPosition: { type: ['string', 'null'] },
        university: { type: ['string', 'null'] },
        minExp: { type: ['number', 'null'] },
        maxExp: { type: ['number', 'null'] },
        tag: { type: ['string', 'null'] },
        screeningStatus: { type: ['string', 'null'] },
      },
    },
  },
} as const;

const SCREENING = new Set(['new', 'screening', 'fit', 'unfit']);

export const translateSearch = async (
  config: ClaudeConfig,
  query: string,
): Promise<{ ok: true; filters: SearchFilters; interpretation: string } | { ok: false; reason: string }> => {
  const out = await jsonCall(config, clientFor(config), {
    system: SEARCH_SYSTEM,
    user: `<request>\n${query}\n</request>`,
    schema: SEARCH_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 1_500,
    // Translation is mechanical once the intent is read; depth buys nothing.
    effort: 'low',
  });
  if (!out.ok) return out;

  const raw = (typeof out.data['filters'] === 'object' && out.data['filters'] !== null
    ? out.data['filters'] : {}) as Record<string, unknown>;

  const filters: SearchFilters = {
    ...(str(raw['q']) ? { q: str(raw['q']) as string } : {}),
    ...(str(raw['location']) ? { location: str(raw['location']) as string } : {}),
    ...(str(raw['currentCompany']) ? { currentCompany: str(raw['currentCompany']) as string } : {}),
    ...(str(raw['currentPosition']) ? { currentPosition: str(raw['currentPosition']) as string } : {}),
    ...(str(raw['university']) ? { university: str(raw['university']) as string } : {}),
    ...(num(raw['minExp']) != null ? { minExp: Math.max(0, num(raw['minExp']) as number) } : {}),
    ...(num(raw['maxExp']) != null ? { maxExp: Math.max(0, num(raw['maxExp']) as number) } : {}),
    ...(str(raw['tag']) ? { tag: str(raw['tag']) as string } : {}),
    ...(str(raw['screeningStatus']) && SCREENING.has(String(str(raw['screeningStatus'])).toLowerCase())
      ? { screeningStatus: String(str(raw['screeningStatus'])).toLowerCase() } : {}),
  };

  return { ok: true, filters, interpretation: str(out.data['interpretation']) ?? '' };
};
