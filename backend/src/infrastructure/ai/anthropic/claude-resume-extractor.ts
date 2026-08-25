// Extracting the résumé — the `ResumeExtractor` port, backed by Claude.
//
// WHAT THIS REPLACES. The Ollama extractor. It reads the MARKDOWN the document
// parser already produced, so this is a text call: the document is read from
// pixels exactly once, by the parser.
//
// IT PROPOSES; IT DOES NOT DECIDE. Nothing returned here reaches a candidate
// record on its own. `buildProposedFields` locates every value in the document
// and applies deterministic validation, and a human confirms what is left. So
// the prompt's job is to be HONEST — `null` where the CV does not say — rather
// than complete. An invented employer costs far more than a missing one.

import type Anthropic from '@anthropic-ai/sdk';
import type {
  AIOutcome, ExtractedResume, ParsedDocument, ResumeExtractor,
} from '../../../modules/shared/kernel/ai/index.js';
import { AI_CAPABILITIES } from '../../../modules/shared/kernel/ai/index.js';
import { clientFor, PROMPT_VERSION, textOf, type ClaudeConfig } from './client.js';

export const EXTRACTOR_VERSION = 'claude-resume-extractor@1';

const SYSTEM = [
  'You extract structured facts from curricula vitae for a construction and',
  'engineering recruiter in the MENA region. CVs may be English, Arabic, or',
  'mixed.',
  '',
  'Rules:',
  '- Use null when the CV does not state a value. Never invent an employer, an',
  '  email, a qualification or a date that is not written down.',
  '- "current" employment means the CV says the person still holds the role.',
  '- List employment most recent first.',
  '- totalYearsExperience: DO compute this. Most CVs never state it, so add up',
  '  the employment history and give your best whole-number estimate. Count from',
  '  the earliest professional role to the latest (treat "Present" as today),',
  '  and do not double-count overlapping roles. A close estimate is far more',
  '  useful to a recruiter than null. Return null ONLY when there is no dated',
  '  employment history at all to reason from.',
  '- linkedinUrl: the profile URL exactly as printed, or null. Do not construct',
  '  one from a name.',
  '- Give names, employers and institutions exactly as written, in their own',
  '  script. Do not translate or transliterate Arabic.',
  '- uncertainFields lists the names of any fields you were unsure about, so a',
  '  human reviews them. Being unsure is expected and is not a failure.',
].join('\n');

const nullableString = { type: ['string', 'null'] } as const;
const nullableNumber = { type: ['number', 'null'] } as const;
const stringArray = { type: 'array', items: { type: 'string' } } as const;

const period = {
  from: nullableString,
  to: nullableString,
  current: { type: ['boolean', 'null'] },
} as const;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'fullName', 'email', 'phone', 'location', 'linkedinUrl', 'headline', 'totalYearsExperience',
    'skills', 'employment', 'education', 'languages', 'certifications', 'uncertainFields',
  ],
  properties: {
    fullName: nullableString,
    email: nullableString,
    phone: nullableString,
    location: nullableString,
    linkedinUrl: nullableString,
    headline: nullableString,
    totalYearsExperience: nullableNumber,
    skills: stringArray,
    languages: stringArray,
    certifications: stringArray,
    uncertainFields: stringArray,
    employment: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['employer', 'title', 'summary', 'from', 'to', 'current'],
        properties: { employer: { type: 'string' }, title: { type: 'string' }, summary: nullableString, ...period },
      },
    },
    education: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['institution', 'qualification', 'field', 'from', 'to', 'current'],
        properties: {
          institution: { type: 'string' },
          qualification: nullableString,
          field: nullableString,
          ...period,
        },
      },
    },
  },
} as const;

const abstain = (reason: string, permanent: boolean): AIOutcome<ExtractedResume> => ({
  abstained: true,
  reason,
  permanent,
  provenance: {
    capability: AI_CAPABILITIES.RESUME_EXTRACT,
    modelId: EXTRACTOR_VERSION,
    promptVersionId: PROMPT_VERSION,
    producedAt: new Date(),
  },
});

/** Drop nulls: the port's optional fields mean absent, not "present and null". */
const defined = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const periodOf = (raw: Record<string, unknown>): { from?: string; to?: string; current?: boolean } => ({
  ...(defined(str(raw['from'])) ? { from: str(raw['from']) as string } : {}),
  ...(defined(str(raw['to'])) ? { to: str(raw['to']) as string } : {}),
  ...(typeof raw['current'] === 'boolean' ? { current: raw['current'] } : {}),
});

const toResume = (raw: Record<string, unknown>): ExtractedResume => ({
  ...(defined(str(raw['fullName'])) ? { fullName: str(raw['fullName']) as string } : {}),
  ...(defined(str(raw['email'])) ? { email: str(raw['email']) as string } : {}),
  ...(defined(str(raw['phone'])) ? { phone: str(raw['phone']) as string } : {}),
  ...(defined(str(raw['location'])) ? { location: str(raw['location']) as string } : {}),
  ...(defined(str(raw['linkedinUrl'])) ? { linkedinUrl: str(raw['linkedinUrl']) as string } : {}),
  ...(defined(str(raw['headline'])) ? { headline: str(raw['headline']) as string } : {}),
  ...(defined(num(raw['totalYearsExperience']))
    ? { totalYearsExperience: num(raw['totalYearsExperience']) as number } : {}),
  skills: list(raw['skills']),
  languages: list(raw['languages']),
  certifications: list(raw['certifications']),
  uncertainFields: list(raw['uncertainFields']),
  employment: (Array.isArray(raw['employment']) ? raw['employment'] : [])
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .filter((e) => defined(str(e['employer'])) && defined(str(e['title'])))
    .map((e) => ({
      employer: str(e['employer']) as string,
      title: str(e['title']) as string,
      ...(defined(str(e['summary'])) ? { summary: str(e['summary']) as string } : {}),
      ...periodOf(e),
    })),
  education: (Array.isArray(raw['education']) ? raw['education'] : [])
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .filter((e) => defined(str(e['institution'])))
    .map((e) => ({
      institution: str(e['institution']) as string,
      ...(defined(str(e['qualification'])) ? { qualification: str(e['qualification']) as string } : {}),
      ...(defined(str(e['field'])) ? { field: str(e['field']) as string } : {}),
      ...periodOf(e),
    })),
});

export class ClaudeResumeExtractor implements ResumeExtractor {
  readonly version = EXTRACTOR_VERSION;

  private readonly client: Anthropic;

  constructor(private readonly config: ClaudeConfig) {
    this.client = clientFor(config);
  }

  async extract(document: ParsedDocument): Promise<AIOutcome<ExtractedResume>> {
    const started = Date.now();
    // The parser's markdown when it produced structure; its flat text otherwise.
    const body = (document.markdown ?? document.text).trim();
    if (body === '') return abstain('The document produced no text to extract from.', true);

    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create({
        model: this.config.model,
        max_tokens: 8_000,
        system: SYSTEM,
        // Extraction is schema-constrained lookup over text the parser already
        // read, not judgement — the same reason the parser call uses 'low'.
        output_config: {
          effort: 'low',
          format: { type: 'json_schema', schema: SCHEMA as unknown as Record<string, unknown> },
        },
        messages: [{ role: 'user', content: `<cv>\n${body}\n</cv>` }],
      });
    } catch (error) {
      return abstain(
        `Claude could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
    }

    if (message.stop_reason === 'refusal') {
      return abstain('Claude declined to extract from this document.', true);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(textOf(message));
    } catch {
      // TEMPORARY: schema-constrained output should not be unparseable, so a
      // retry is worth one attempt before a human is asked to type it in.
      return abstain('Claude returned a response that was not valid JSON.', false);
    }
    if (typeof raw !== 'object' || raw === null) {
      return abstain('Claude returned a response that was not an object.', false);
    }

    const resume = toResume(raw as Record<string, unknown>);

    return {
      content: resume,
      // Display only, and capped downstream: a model reading alone is never
      // `verified`, however sure it says it is.
      confidence: resume.uncertainFields.length > 0 ? 0.7 : 0.85,
      reasoningSummary: resume.uncertainFields.length > 0
        ? `Unsure about: ${resume.uncertainFields.join(', ')}.`
        : 'Every extracted value was stated in the document.',
      sourcesUsed: [`${document.pageCount} page(s)`],
      provenance: {
        capability: AI_CAPABILITIES.RESUME_EXTRACT,
        modelId: `${this.config.model}/${EXTRACTOR_VERSION}`,
        promptVersionId: PROMPT_VERSION,
        producedAt: new Date(),
        latencyMs: Date.now() - started,
      },
    };
  }
}
