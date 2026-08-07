// AI capability ports. INTERFACES AND TYPES ONLY — no implementation, ever.
//
// Each is a capability a human could perform, described in the business's own
// vocabulary. That is what makes the model swappable: nothing below constrains
// HOW an answer is produced, only what a useful answer looks like.
//
// Every method returns `AIOutcome`, so "I could not tell" is a first-class
// result rather than a guess with low confidence. A parser that invents an email
// address because it must return something is worse than one that abstains.
//
// SYNCHRONOUS SIGNATURES, ASYNCHRONOUS USE. These are called by the AI WORKER,
// not by a command handler. A handler submits an `AITaskRequest` and commits;
// the worker resolves the capability and publishes the result as an event. Both
// paths exist because a few capabilities (skill normalisation against a cached
// vocabulary) are fast enough to call inline, and pretending otherwise would
// force a round trip through the queue for a lookup.

import type { AIOutcome } from './contracts.js';

/* ------------------------------ shared shapes ------------------------------ */

/** Raw bytes plus what little is known about them. No storage assumption. */
export interface SourceDocument {
  readonly documentId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

/** Layout-preserving text. Structure matters: a CV read as one paragraph is unusable. */
export interface ParsedDocument {
  readonly text: string;
  readonly pageCount: number;
  /** Per-page text, so an extractor can cite where a field came from. */
  readonly pages: readonly string[];
  readonly detectedLanguage?: string;
  /**
   * Structured Markdown, when the parser produced structure rather than a blob.
   *
   * OPTIONAL and PROVIDER-NEUTRAL. Added because a layout-aware parser's entire
   * value is the structure it recovers — headings, reading order, tables — and
   * flattening that into `text` at this boundary would discard exactly what was
   * gained. An extractor prefers this when present and falls back to `text`,
   * so a parser that produces only plain text stays valid.
   *
   * Markdown, not a parser-specific document model: the format is readable,
   * diffable, and a good input for a language model, and no adapter's internal
   * types cross this port.
   */
  readonly markdown?: string;
}

export interface DocumentParser {
  /**
   * Implementation version, recorded on every proposal.
   *
   * A proposal must be reproducible: knowing the model is not enough if the
   * parser that fed it changed. Bump this whenever behaviour changes.
   */
  readonly version?: string;
  parse(document: SourceDocument): Promise<AIOutcome<ParsedDocument>>;
}

/* ------------------------------ résumé extract ----------------------------- */
// Deliberately NOT a Candidate. The Talent context does not exist yet, and when
// it does, this stays a proposal that a domain service validates and applies —
// never a shortcut into an aggregate.

export interface ExtractedPeriod {
  readonly from?: string;
  readonly to?: string;
  readonly current?: boolean;
}

export interface ExtractedEmployment extends ExtractedPeriod {
  readonly employer: string;
  readonly title: string;
  readonly summary?: string;
}

export interface ExtractedEducation extends ExtractedPeriod {
  readonly institution: string;
  readonly qualification?: string;
  readonly field?: string;
}

export interface ExtractedResume {
  readonly fullName?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly location?: string;
  readonly headline?: string;
  readonly totalYearsExperience?: number;
  readonly skills: readonly string[];
  readonly employment: readonly ExtractedEmployment[];
  readonly education: readonly ExtractedEducation[];
  readonly languages: readonly string[];
  readonly certifications: readonly string[];
  /**
   * Fields the extractor was unsure about, by name.
   *
   * A UI shows these for confirmation instead of silently accepting them. One
   * confidence number for a whole résumé hides that the name was certain and
   * the phone number was a guess.
   */
  readonly uncertainFields: readonly string[];
}

export interface ResumeExtractor {
  /** Implementation version. See DocumentParser.version. */
  readonly version?: string;
  extract(document: ParsedDocument): Promise<AIOutcome<ExtractedResume>>;
}

/* -------------------------------- embeddings ------------------------------- */

/**
 * A vector plus the model that produced it.
 *
 * `modelId` and `dimensions` travel WITH the vector because vectors from
 * different models are not comparable. Storing them without provenance produces
 * a similarity search that silently returns nonsense after a model upgrade.
 */
export interface EmbeddingVector {
  readonly values: readonly number[];
  readonly dimensions: number;
  readonly modelId: string;
}

export interface ResumeEmbeddingProvider {
  embedResume(resume: ParsedDocument): Promise<AIOutcome<EmbeddingVector>>;
  embedText(text: string): Promise<AIOutcome<EmbeddingVector>>;
  /** Batched, because embedding 500 CVs one HTTP call at a time is the slow path. */
  embedBatch(texts: readonly string[]): Promise<AIOutcome<readonly EmbeddingVector[]>>;
}

/* ------------------------------ job description ---------------------------- */

export interface AnalyzedJobDescription {
  readonly normalizedTitle?: string;
  readonly requiredSkills: readonly string[];
  readonly preferredSkills: readonly string[];
  readonly minimumYearsExperience?: number;
  readonly qualifications: readonly string[];
  readonly responsibilities: readonly string[];
  readonly seniority?: string;
  /**
   * Wording that may exclude protected groups.
   *
   * Surfaced for a human to judge. The system never edits a job description on
   * its own — that is an employer's legal statement, not generated text.
   */
  readonly inclusivityConcerns: readonly string[];
}

export interface JobDescriptionAnalyzer {
  analyze(text: string): Promise<AIOutcome<AnalyzedJobDescription>>;
}

/* ------------------------------ skills ------------------------------------- */

export interface NormalizedSkill {
  readonly input: string;
  /** Canonical form, e.g. "AutoCAD" for "auto-cad", "autocad 2019". */
  readonly canonical: string;
  readonly aliases: readonly string[];
  readonly category?: string;
}

export interface SkillNormalizer {
  normalize(skills: readonly string[]): Promise<AIOutcome<readonly NormalizedSkill[]>>;
}

/* ------------------------------- matching ---------------------------------- */

/**
 * Why a candidate matched.
 *
 * `evidence` is not decoration. A recruiter must be able to see why a candidate
 * was surfaced, and a rejected applicant may be entitled to an explanation.
 * A matcher that returns a bare score cannot support either.
 */
export interface MatchEvidence {
  readonly dimension: string;
  readonly detail: string;
  readonly contribution: number;
}

export interface CandidateMatch {
  readonly candidateId: number;
  readonly score: number;
  readonly evidence: readonly MatchEvidence[];
  readonly missingRequirements: readonly string[];
}

export interface MatchCriteria {
  readonly requisitionId: number;
  readonly jobDescription?: AnalyzedJobDescription;
  readonly requiredSkills?: readonly string[];
  readonly minimumYearsExperience?: number;
  readonly limit?: number;
}

export interface CandidateMatcher {
  /** Find candidates for a requisition. Ordering is the adapter's business. */
  match(criteria: MatchCriteria): Promise<AIOutcome<readonly CandidateMatch[]>>;
  /** Score a specific pairing — the "why is this person here?" view. */
  score(candidateId: number, criteria: MatchCriteria): Promise<AIOutcome<CandidateMatch>>;
}

export interface RankedCandidate {
  readonly candidateId: number;
  readonly rank: number;
  readonly score: number;
  readonly rationale: string;
}

/**
 * Re-order an EXISTING shortlist.
 *
 * Distinct from matching on purpose: matching searches a population, ranking
 * orders a set someone already chose. Conflating them makes it impossible to
 * tell whether a candidate was surfaced by a model or by a human.
 */
export interface CandidateRankingService {
  rank(
    candidateIds: readonly number[],
    criteria: MatchCriteria,
  ): Promise<AIOutcome<readonly RankedCandidate[]>>;
}

/* ------------------------------- the registry ------------------------------ */

/**
 * Everything a composition root may wire.
 *
 * All optional: a deployment with no AI configured is a first-class
 * configuration, not a degraded one. Callers check for the port and fall back
 * to the manual path — which is the only path today.
 */
export interface AICapabilities {
  readonly documentParser?: DocumentParser;
  readonly resumeExtractor?: ResumeExtractor;
  readonly resumeEmbeddings?: ResumeEmbeddingProvider;
  readonly jobDescriptionAnalyzer?: JobDescriptionAnalyzer;
  readonly skillNormalizer?: SkillNormalizer;
  readonly candidateMatcher?: CandidateMatcher;
  readonly candidateRanking?: CandidateRankingService;
}
