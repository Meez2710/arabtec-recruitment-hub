// Talent read-side ports.
//
// Separate file from `ports.ts` because the ATS read model is already large;
// same pattern, same rules — Drizzle-free so controllers depend on it.
//
// AI FIELDS ARE PLACEHOLDERS. Everything under `ai` is optional/nullable and
// resolves to null today. They exist now so the response SHAPE is final: when
// parsing lands, the source of these values changes and the contract does not,
// so the Lovable frontend can render badges and status chips against a stable
// schema instead of being rewritten.

import type { AuthContext } from '../../modules/shared/kernel/auth-context.js';
import type { FieldSource } from '../../modules/talent/index.js';
import type { Page, PageRequest } from './ports.js';

/**
 * AI status for one candidate.
 *
 * `proposal*` fields are REAL today — proposals exist and can come from a bulk
 * import. Everything else is null until the AI phase.
 */
export interface CandidateAIState {
  /** The pending proposal awaiting review, if any. */
  readonly pendingProposalId: number | null;
  readonly pendingProposalFieldCount: number;
  readonly lastProposalAt: Date | null;
  readonly lastProposalOrigin: string | null;
  /** Producer identity of the most recent proposal. Empty for human origins. */
  readonly lastProposalModelId: string | null;
  /** Fields whose standing value came from an accepted proposal. */
  readonly aiApprovedFields: readonly string[];

  /* --- placeholders: null until the AI phase, shape is final --- */
  /** QUEUED | RUNNING | SUCCEEDED | ABSTAINED | FAILED. */
  readonly processingStatus: string | null;
  readonly lastParsingTaskId: string | null;
  readonly lastParsingAt: Date | null;
  readonly lastMatchingTaskId: string | null;
  readonly lastMatchingAt: Date | null;
  /** Model id + dimensions of the stored résumé vector, once one exists. */
  readonly embeddingModelId: string | null;
  readonly embeddingDimensions: number | null;
  readonly embeddingUpdatedAt: Date | null;
}

export interface CandidateListItem {
  readonly id: number;
  readonly candidateNo: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly location: string | null;
  readonly currentCompany: string | null;
  readonly currentPosition: string | null;
  readonly yearsExperience: number | null;
  readonly skills: readonly string[];
  readonly tags: readonly string[];
  readonly state: string;
  readonly source: string | null;
  readonly ownerRecruiterId: number | null;
  readonly documentCount: number;
  readonly hasCv: boolean;
  readonly applicationCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
  /** Which fields are user-entered vs approved-AI. Drives the badges. */
  readonly fieldSources: Readonly<Record<string, FieldSource>>;
  readonly ai: CandidateAIState;
}

export interface CandidateFilters {
  /** Free text over name, candidate number, email, company and position. */
  readonly q?: string;
  readonly state?: readonly string[];
  readonly ownerRecruiterId?: number;
  readonly source?: string;
  /** ALL listed skills must be present. Narrowing, not ranking. */
  readonly skills?: readonly string[];
  readonly tags?: readonly string[];
  readonly minYearsExperience?: number;
  readonly maxYearsExperience?: number;
  readonly hasCv?: boolean;
  readonly hasPendingProposal?: boolean;
  readonly createdFrom?: Date;
  readonly createdTo?: Date;
}

export interface CandidateDocumentView {
  readonly documentId: string;
  readonly docType: string;
  readonly fileName: string;
  readonly fileHash: string;
  readonly fileSize: number;
  readonly mimeType: string;
  readonly note: string | null;
  readonly uploadedBy: number | null;
  readonly uploadedAt: Date;
  /** Other candidates holding the same bytes — a duplicate signal. */
  readonly sharedWithCandidateIds: readonly number[];
}

export interface ProvenanceBadge {
  readonly field: string;
  readonly source: FieldSource;
  readonly at: Date;
  readonly actorId: number | null;
  readonly taskId: string | null;
  readonly modelId: string | null;
}

export interface ProposalView {
  readonly id: number;
  readonly origin: string;
  readonly status: string;
  readonly taskId: string | null;
  readonly modelId: string | null;
  readonly documentId: string | null;
  /** Full reproduction metadata. Null for human and import origins. */
  readonly generation: Record<string, unknown> | null;
  readonly createdAt: Date;
  readonly reviewedBy: number | null;
  readonly reviewedAt: Date | null;
  readonly fields: readonly {
    readonly field: string;
    readonly value: unknown;
    readonly confidence: number;
    readonly evidence: string | null;
    readonly decision: string;
    /** The value currently on the candidate, for a side-by-side diff. */
    readonly currentValue: unknown;
  }[];
}

export interface DuplicateWarningView {
  readonly candidateId: number;
  readonly candidateNo: string;
  readonly fullName: string;
  readonly state: string;
  /** email | phone | linkedin | document */
  readonly matchedOn: readonly string[];
}

/** Everything this person has done in the pipeline, without loading it all. */
export interface CandidateActivitySummary {
  readonly applicationCount: number;
  readonly liveApplicationCount: number;
  readonly interviewCount: number;
  readonly upcomingInterviewCount: number;
  readonly offerCount: number;
  readonly liveOfferCount: number;
  readonly isHired: boolean;
  readonly lastActivityAt: Date | null;
  readonly currentStages: readonly {
    readonly applicationId: number;
    readonly requisitionId: number;
    readonly requisitionTicketNo: string;
    readonly requisitionTitle: string;
    readonly stage: string;
  }[];
}

export interface CandidateDetail extends CandidateListItem {
  readonly nationality: string | null;
  readonly linkedinUrl: string | null;
  readonly noticePeriod: string | null;
  readonly university: string | null;
  readonly major: string | null;
  readonly graduationYear: number | null;
  readonly languages: readonly string[];
  readonly certifications: readonly string[];
  readonly createdBy: number;
  readonly documents: readonly CandidateDocumentView[];
  readonly provenance: readonly ProvenanceBadge[];
  readonly pendingProposal: ProposalView | null;
  readonly duplicateWarnings: readonly DuplicateWarningView[];
  readonly activity: CandidateActivitySummary;
}

/* ------------------------------- CV intake --------------------------------- */

export interface IntakeItemView {
  readonly itemId: string;
  readonly fileName: string;
  readonly fileHash: string;
  readonly mimeType: string;
  readonly fileSize: number;
  readonly status: string;
  readonly note: string | null;
  readonly candidateId: number | null;
  /** What the parser suggested. Empty until PARSED. */
  readonly extracted: readonly {
    readonly field: string; readonly value: unknown;
    readonly confidence: number; readonly evidence: string | null;
  }[];
  readonly generation: Record<string, unknown> | null;
  /** Live task state: QUEUED | RUNNING | SUCCEEDED | ABSTAINED | FAILED | null. */
  readonly parsingStatus: string | null;
  readonly parsingTaskId: string | null;
  readonly parsingError: string | null;
}

/** Counts by item status — the progress bar, computed in SQL. */
export interface IntakeProgress {
  readonly total: number;
  readonly pendingParse: number;
  readonly parsed: number;
  readonly parseFailed: number;
  readonly converted: number;
  readonly discarded: number;
  readonly outstanding: number;
  /** 0..1. Settled items over total. */
  readonly completion: number;
}

export interface IntakeBatchListItem {
  readonly id: number;
  readonly label: string;
  readonly status: string;
  readonly uploadedBy: number;
  readonly createdAt: Date;
  readonly version: number;
  readonly progress: IntakeProgress;
  /** How many items carry parser output ready for review. */
  readonly proposalSummary: {
    readonly readyForReview: number;
    readonly totalSuggestedFields: number;
    readonly lastParsedAt: Date | null;
    readonly modelIds: readonly string[];
  };
}

export interface IntakeBatchDetail extends IntakeBatchListItem {
  readonly items: readonly IntakeItemView[];
}

export interface IntakeFilters {
  readonly status?: readonly string[];
  readonly uploadedBy?: number;
  readonly q?: string;
  /** Batches with at least one item still needing a human. */
  readonly hasOutstanding?: boolean;
  readonly createdFrom?: Date;
  readonly createdTo?: Date;
}

export interface TalentReadModel {
  intakeBatches(f: IntakeFilters, p: PageRequest, ctx: AuthContext):
    Promise<Page<IntakeBatchListItem>>;
  intakeBatch(id: number, ctx: AuthContext): Promise<IntakeBatchDetail | null>;

  candidates(f: CandidateFilters, p: PageRequest, ctx: AuthContext):
    Promise<Page<CandidateListItem>>;
  candidate(id: number, ctx: AuthContext): Promise<CandidateDetail | null>;
  proposals(candidateId: number, p: PageRequest, ctx: AuthContext):
    Promise<Page<ProposalView>>;
  duplicates(candidateId: number, ctx: AuthContext): Promise<readonly DuplicateWarningView[]>;
  activity(candidateId: number, ctx: AuthContext): Promise<CandidateActivitySummary | null>;
}
