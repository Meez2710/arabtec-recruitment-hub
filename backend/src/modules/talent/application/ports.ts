// Talent ports. Interfaces only.
//
// Note what is ABSENT: no parser, no extractor, no AI anything. This context
// stores and edits people and their documents; producing a proposal is
// somebody else's job, and this module only knows how to receive one.

import type { AuthContext } from '../../shared/kernel/auth-context.js';
import type { Candidate } from '../domain/candidate.js';
import type { CandidateProposal } from '../domain/proposal.js';
import type { CvIntakeBatch } from '../domain/cv-intake.js';

export interface CandidateRepository {
  findById(id: number, ctx: AuthContext): Promise<Candidate | null>;
  findByIdForUpdate(id: number, ctx: AuthContext): Promise<Candidate | null>;
  save(candidate: Candidate): Promise<void>;
  nextCandidateNo(ctx: AuthContext): Promise<string>;
  nextId(ctx: AuthContext): Promise<number>;

  /**
   * Records that may be the same person.
   *
   * Reports; never merges. Deduplication is a judgement call with legal
   * consequences — merging two people's histories is not something a heuristic
   * gets to decide.
   */
  findPotentialDuplicates(
    probe: { email?: string | null; phone?: string | null; linkedinUrl?: string | null },
    ctx: AuthContext,
    opts?: { excludeCandidateId?: number },
  ): Promise<readonly { candidateId: number; matchedOn: readonly string[] }[]>;

  /** Candidates already holding a document with this content hash. */
  findByDocumentHash(fileHash: string, ctx: AuthContext): Promise<readonly number[]>;
}

export interface CandidateProposalRepository {
  findById(id: number, ctx: AuthContext): Promise<CandidateProposal | null>;
  findByIdForUpdate(id: number, ctx: AuthContext): Promise<CandidateProposal | null>;
  save(proposal: CandidateProposal): Promise<void>;
  nextId(ctx: AuthContext): Promise<number>;
  /** Unreviewed proposals for a candidate — superseded when a new one arrives. */
  findPendingForCandidate(candidateId: number, ctx: AuthContext): Promise<CandidateProposal[]>;
}

export interface CvIntakeBatchRepository {
  findById(id: number, ctx: AuthContext): Promise<CvIntakeBatch | null>;
  findByIdForUpdate(id: number, ctx: AuthContext): Promise<CvIntakeBatch | null>;
  save(batch: CvIntakeBatch): Promise<void>;
  nextId(ctx: AuthContext): Promise<number>;
}

export interface TalentTransactionScope {
  readonly candidates: CandidateRepository;
  readonly proposals: CandidateProposalRepository;
  readonly intake: CvIntakeBatchRepository;
}

export interface TalentUnitOfWork {
  transaction<T>(fn: (tx: TalentTransactionScope) => Promise<T>): Promise<T>;
}

/**
 * Where document bytes live.
 *
 * The aggregate holds metadata; this holds content. Deliberately minimal so a
 * local disk, S3 or Azure Blob all satisfy it. `put` is keyed by content hash,
 * which makes storing the same file twice a no-op.
 */
export interface DocumentStore {
  put(input: {
    fileHash: string; bytes: Uint8Array; mimeType: string; fileName: string;
  }): Promise<{ storageKey: string }>;
  get(fileHash: string): Promise<Uint8Array | null>;
  delete(fileHash: string): Promise<void>;
}
