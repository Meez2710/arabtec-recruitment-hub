// Competency evaluation against a job's requirements.
//
// CONSUMES THE PROPOSAL, NOT A PARSER'S OUTPUT. The evaluator is handed
// candidate fields with their evidence — a stable contract — so changing the
// parser, the OCR engine, the chunking or the extraction model does not touch
// this file. There is no `{llama_index_node_text}` here and no other
// library-shaped variable, because none is needed: the structured proposal
// already carries the text each value was read from.
//
// QUALITATIVE ONLY. Four levels, no percentages, no match score, no ranking
// array. A number invites sorting people by it, and a number a model produced
// is neither calibrated nor explainable — which under employment law is a
// decision you cannot defend.
//
// EVIDENCE IS CHECKED, NOT TRUSTED. Every quote the model returns is searched
// for in the data that was supplied to it. Quotes that are not found are
// dropped, and a competency left with no surviving quote is demoted to
// 'No Evidence Found'. A fabricated achievement therefore cannot raise a level.

import type {
  AIOutcome, CandidateEvaluation, CompetencyAssessment, CompetencyLevel,
} from '../../../modules/shared/kernel/ai/index.js';
import type { ProposedField } from '../../../modules/talent/domain/proposal.js';
import { AI_CAPABILITIES, COMPETENCY_LEVELS } from '../../../modules/shared/kernel/ai/index.js';
import { comparisonKey } from '../../../modules/shared/kernel/text.js';
import type { OllamaOptions } from '../ollama/ollama-client.js';
import { OllamaClient, OllamaError } from '../ollama/ollama-client.js';

export const EVALUATION_PROMPT_VERSION = 'competency-evaluate-prompt/1.0.0';

const LEVELS = COMPETENCY_LEVELS;

const SYSTEM_PROMPT = [
  'You assess a candidate against a job\'s requirements using ONLY the candidate',
  'data supplied in the message. You are an assessor, not an author.',
  '',
  'RULES',
  `1. Every competency must be given exactly one level: ${LEVELS.map((l) => `"${l}"`).join(', ')}.`,
  '2. Never output a score, a percentage, a rating out of ten, or a ranking.',
  '3. Every string in "evidence" must be copied VERBATIM from the candidate data.',
  '   Do not paraphrase, summarise, translate or combine lines into a quote.',
  '4. If the candidate data does not speak to a requirement, the level is',
  '   "No Evidence Found". Do not infer a skill from a job title.',
  '5. Never state an achievement, employer, qualification or skill that is not in',
  '   the candidate data.',
  '6. List requirements the data says nothing about in "gaps".',
  '',
  'Inventing supporting evidence is the worst possible outcome. "No Evidence',
  'Found" is a correct and useful answer.',
].join('\n');

const EVALUATION_SCHEMA = {
  type: 'object',
  properties: {
    competencies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          competency: { type: 'string' },
          level: { type: 'string', enum: [...LEVELS] },
          evidence: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string' },
        },
        required: ['competency', 'level', 'rationale'],
      },
    },
    overall: { type: 'string', enum: [...LEVELS] },
    summary: { type: 'string' },
    gaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['competencies', 'overall', 'summary'],
} as const;

/** The job side of the comparison. Plain strings — no repository types. */
export interface JobRequirements {
  readonly title: string;
  readonly description?: string;
  readonly requirements?: string;
}

/* ---------------------------- candidate rendering -------------------------- */

/**
 * What the evaluator is allowed to read.
 *
 * The PROPOSED fields of a `CandidateProposal` — which, by the time they exist,
 * have already been located in the document and passed deterministic
 * validation. There is no separate candidate model here on purpose: the
 * evaluator reads exactly what a human reviewer would see.
 */
export interface CandidateEvidence {
  readonly fields: readonly ProposedField[];
  readonly documentId: string;
}

/**
 * Render the proposed fields as the text the model may quote from.
 *
 * Each value is shown with the source line it was read from, so the model has
 * real sentences to quote rather than only extracted values — and so every
 * quote it returns can be checked against this exact string.
 */
export const renderCandidateEvidence = (candidate: CandidateEvidence): string => {
  const lines: string[] = [];
  for (const field of candidate.fields) {
    const value = Array.isArray(field.value) ? field.value.join(', ') : String(field.value);
    if (value.trim() === '') continue;
    const ref = field.evidenceRef;
    lines.push(ref?.page === undefined
      ? `${field.field}: ${value}`
      : `${field.field}: ${value}   [page ${ref.page}${ref.blockId === undefined ? '' : `, block ${ref.blockId}`}]`);
  }
  for (const field of candidate.fields) {
    if (field.evidence === null || field.evidence.trim() === '') continue;
    lines.push(`source (${field.field}): ${field.evidence}`);
  }
  return lines.join('\n');
};

/* ------------------------------- verification ------------------------------ */

/**
 * Keep only quotes that really appear in the supplied data.
 *
 * Compared on `comparisonKey`, so a difference in casing, spacing or Arabic
 * letter form does not reject a genuine quote — while an invented sentence,
 * which shares no such form, is still rejected.
 */
const verifyEvidence = (
  quotes: readonly string[],
  supplied: string,
): readonly string[] => {
  const haystack = comparisonKey(supplied);
  return quotes.filter((quote) => {
    const key = comparisonKey(quote);
    return key.length > 2 && haystack.includes(key);
  });
};

const isLevel = (value: unknown): value is CompetencyLevel => typeof value === 'string'
  && (LEVELS as readonly string[]).includes(value);

const extractJsonObject = (raw: string): unknown => {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
};

/* -------------------------------- the port --------------------------------- */

export interface CandidateEvaluator {
  readonly version?: string;
  evaluate(
    candidate: CandidateEvidence,
    job: JobRequirements,
  ): Promise<AIOutcome<CandidateEvaluation>>;
}

export interface EvaluatorOptions extends OllamaOptions {
  readonly maxOutputTokens?: number;
}

export class OllamaCompetencyEvaluator implements CandidateEvaluator {
  readonly version = `competency-evaluator/1.0.0+${EVALUATION_PROMPT_VERSION}`;

  private readonly client: OllamaClient;

  private readonly maxOutputTokens: number;

  constructor(opts: EvaluatorOptions = {}) {
    this.client = new OllamaClient(opts);
    this.maxOutputTokens = opts.maxOutputTokens ?? 1536;
  }

  async evaluate(
    candidate: CandidateEvidence,
    job: JobRequirements,
  ): Promise<AIOutcome<CandidateEvaluation>> {
    const provenance = {
      capability: AI_CAPABILITIES.CANDIDATE_RANK,
      modelId: this.client.model,
      promptVersionId: EVALUATION_PROMPT_VERSION,
      producedAt: new Date(),
    };

    const candidateData = renderCandidateEvidence(candidate);
    if (candidateData.trim() === '') {
      // PERMANENT: there is nothing to assess. An evaluation built on no
      // evidence is exactly what this design refuses to produce.
      return {
        abstained: true,
        reason: 'The proposal contains no document-supported candidate data to assess.',
        permanent: true,
        provenance,
      };
    }

    const prompt = [
      'JOB',
      `Title: ${job.title}`,
      job.description !== undefined && job.description !== ''
        ? `Description: ${job.description}` : '',
      job.requirements !== undefined && job.requirements !== ''
        ? `Requirements: ${job.requirements}` : '',
      '',
      'CANDIDATE DATA (the only material you may quote)',
      candidateData,
    ].filter((line) => line !== '').join('\n');

    let result;
    try {
      result = await this.client.generate({
        system: SYSTEM_PROMPT,
        prompt,
        format: EVALUATION_SCHEMA,
        maxOutputTokens: this.maxOutputTokens,
      });
    } catch (error) {
      if (error instanceof OllamaError) {
        return {
          abstained: true, reason: error.message, permanent: !error.retryable, provenance,
        };
      }
      return {
        abstained: true,
        reason: `Evaluation failed unexpectedly: ${(error as Error).message}`,
        permanent: false,
        provenance,
      };
    }

    const withTiming = { ...provenance, latencyMs: result.latencyMs };

    if (result.truncated) {
      return {
        abstained: true,
        reason: 'The evaluation was cut off before it completed.',
        permanent: false,
        provenance: withTiming,
      };
    }

    const json = extractJsonObject(result.text);
    if (typeof json !== 'object' || json === null) {
      return {
        abstained: true,
        reason: 'The model did not return parseable JSON.',
        permanent: false,
        provenance: withTiming,
      };
    }

    const body = json as Record<string, unknown>;
    const rawCompetencies = Array.isArray(body['competencies']) ? body['competencies'] : [];

    const competencies: CompetencyAssessment[] = [];
    for (const entry of rawCompetencies) {
      if (typeof entry !== 'object' || entry === null) continue;
      const row = entry as Record<string, unknown>;
      const competency = typeof row['competency'] === 'string' ? row['competency'].trim() : '';
      if (competency === '') continue;

      const claimed = isLevel(row['level']) ? row['level'] : 'No Evidence Found';
      const quotes = Array.isArray(row['evidence'])
        ? row['evidence'].filter((q): q is string => typeof q === 'string')
        : [];
      const verified = verifyEvidence(quotes, candidateData);

      // THE ANTI-HALLUCINATION RULE, ENFORCED: a level above "No Evidence
      // Found" requires at least one quote that survived verification.
      const level: CompetencyLevel = verified.length === 0 ? 'No Evidence Found' : claimed;

      competencies.push({
        competency,
        level,
        evidence: verified,
        rationale: typeof row['rationale'] === 'string' ? row['rationale'] : '',
      });
    }

    if (competencies.length === 0) {
      return {
        abstained: true,
        reason: 'The model returned no assessable competencies.',
        permanent: false,
        provenance: withTiming,
      };
    }

    // The overall level may not exceed what the individual competencies
    // support, so a demoted competency cannot leave an inflated headline.
    const claimedOverall = isLevel(body['overall']) ? body['overall'] : 'No Evidence Found';
    const anySupported = competencies.some((c) => c.level !== 'No Evidence Found');
    const overall: CompetencyLevel = anySupported ? claimedOverall : 'No Evidence Found';

    return {
      content: {
        competencies,
        overall,
        summary: typeof body['summary'] === 'string' ? body['summary'] : '',
        gaps: Array.isArray(body['gaps'])
          ? body['gaps'].filter((g): g is string => typeof g === 'string')
          : [],
        modelId: this.client.model,
        promptVersionId: EVALUATION_PROMPT_VERSION,
        documentId: candidate.documentId,
        producedAt: new Date(),
      },
      // A qualitative assessment's confidence is a presentation hint only; the
      // levels themselves carry the meaning.
      confidence: 0.6,
      reasoningSummary: `Assessed ${competencies.length} competenc(ies); `
        + `${competencies.filter((c) => c.level === 'No Evidence Found').length} had no supporting evidence.`,
      sourcesUsed: [candidate.documentId],
      provenance: withTiming,
    };
  }
}
