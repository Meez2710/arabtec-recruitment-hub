// Talent repository adapters. Persistence only.
//
// SCOPE: tenant, not project. A candidate is a talent-pool record that exists
// before any requisition and outlives all of them; scoping people to projects
// would mean a recruiter cannot see someone they sourced last year. Access to a
// candidate's APPLICATIONS is still project-scoped, because that is where the
// project relationship actually lives.

import { and, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { AuthContext } from '../../shared/kernel/auth-context.js';
import { Candidate } from '../domain/candidate.js';
import { CandidateProposal } from '../domain/proposal.js';
import { CvIntakeBatch } from '../domain/cv-intake.js';
import type {
  CandidateProposalRepository, CandidateRepository, CvIntakeBatchRepository,
} from '../application/ports.js';
import {
  ID_SEQUENCES, SEQUENCES, candidate, candidateDocument, candidateProposal,
  cvIntakeBatch, cvIntakeItem,
} from '../../../infrastructure/db/schema/index.js';
import type { Executor } from '../../../infrastructure/db/types.js';
import { LoadRegistry, assertUpdated } from '../../../infrastructure/db/version-guard.js';
import { formatFlatNumber, nextval } from '../../../infrastructure/db/sequences.js';
import { ConstraintViolationError, isCheckViolation, isUniqueViolation } from '../../../infrastructure/db/errors.js';
import { TransactionEventCollector } from '../../../infrastructure/db/outbox.js';
import {
  candidateToProps, candidateToRow, dedupEmail, dedupLinkedin, dedupPhone,
  documentToRow, intakeItemToProps, intakeItemToRow, intakeToProps, intakeToRow,
  proposalToProps, proposalToRow,
} from './mappers.js';
import type { DocumentRow, IntakeItemRow } from './mappers.js';

const DOCUMENTS = 'documents';

export interface TalentRepositoryOptions {
  /** Legacy default was `CAN`. Configurable exactly as `candidate_prefix` was. */
  readonly candidatePrefix?: string;
  readonly collector?: TransactionEventCollector;
}

const tenantScope = (ctx: AuthContext): SQL => eq(candidate.tenantId, ctx.tenantId);

export class DrizzleCandidateRepository implements CandidateRepository {
  private readonly registry = new LoadRegistry();
  private readonly prefix: string;
  private readonly collector: TransactionEventCollector;

  constructor(private readonly db: Executor, opts: TalentRepositoryOptions = {}) {
    this.prefix = opts.candidatePrefix ?? 'CAN';
    this.collector = opts.collector ?? new TransactionEventCollector();
  }

  async findById(id: number, ctx: AuthContext): Promise<Candidate | null> {
    return this.load(id, ctx, false);
  }

  async findByIdForUpdate(id: number, ctx: AuthContext): Promise<Candidate | null> {
    return this.load(id, ctx, true);
  }

  private async load(id: number, ctx: AuthContext, lock: boolean): Promise<Candidate | null> {
    const base = this.db.select().from(candidate)
      .where(and(eq(candidate.id, id), tenantScope(ctx))).limit(1);
    const rows = lock ? await base.for('update') : await base;

    const row = rows[0];
    if (row === undefined) return null;

    const documents = await this.db.select().from(candidateDocument)
      .where(eq(candidateDocument.candidateId, id))
      .orderBy(candidateDocument.uploadedAt, candidateDocument.id);

    this.registry.record(row.id, row.version, { [DOCUMENTS]: documents.length });
    return Candidate.fromState(candidateToProps(row, documents));
  }

  async save(aggregate: Candidate): Promise<void> {
    const state = aggregate.toState();
    const baseline = this.registry.baselineOf(state.id);

    try {
      if (baseline === undefined) {
        await this.db.insert(candidate).values(candidateToRow(state));
        await this.writeDocuments(state.id, state.documents, []);
      } else {
        const result = await this.db.update(candidate)
          .set({ ...candidateToRow(state), updatedAt: sql`now()` })
          .where(and(eq(candidate.id, state.id), eq(candidate.version, baseline.version)))
          .returning({ id: candidate.id });

        await assertUpdated(result.length, 'Candidate', state.id, baseline.version,
          () => this.readVersion(state.id));

        const stored = await this.db.select().from(candidateDocument)
          .where(eq(candidateDocument.candidateId, state.id));
        await this.writeDocuments(state.id, state.documents, stored);
      }
    } catch (err) {
      throw this.translate(err);
    }

    this.registry.record(state.id, state.version, { [DOCUMENTS]: state.documents.length });
    this.collector.collect('Candidate', state.id, state.tenantId, aggregate.pullEvents());
  }

  /**
   * Reconcile documents, keyed on the content hash.
   *
   * Insert-and-delete only: a document row is immutable once written, so there
   * is no update path and nothing to diff field by field.
   */
  private async writeDocuments(
    candidateId: number,
    desired: readonly { fileHash: string }[],
    stored: readonly DocumentRow[],
  ): Promise<void> {
    const desiredHashes = new Set(desired.map((d) => d.fileHash));
    const storedHashes = new Set(stored.map((d) => d.fileHash));

    const removed = stored.filter((d) => !desiredHashes.has(d.fileHash)).map((d) => d.fileHash);
    if (removed.length > 0) {
      await this.db.delete(candidateDocument).where(and(
        eq(candidateDocument.candidateId, candidateId),
        inArray(candidateDocument.fileHash, removed),
      ));
    }

    const added = desired.filter((d) => !storedHashes.has(d.fileHash));
    if (added.length > 0) {
      await this.db.insert(candidateDocument).values(
        added.map((d) => documentToRow(candidateId, d as Parameters<typeof documentToRow>[1])),
      );
    }
  }

  async nextCandidateNo(_ctx: AuthContext): Promise<string> {
    return formatFlatNumber(this.prefix, await nextval(this.db, SEQUENCES.candidateNo));
  }

  async nextId(_ctx: AuthContext): Promise<number> {
    return nextval(this.db, ID_SEQUENCES.candidate);
  }

  /**
   * Report possible duplicates. Never merges, never blocks.
   *
   * Matches on the normalised copies, so "+20 100 123 4567" and "00201001234567"
   * collide. Returns which signals matched so a human can judge — an email match
   * on a shared family address is much weaker evidence than a LinkedIn match.
   */
  async findPotentialDuplicates(
    probe: { email?: string | null; phone?: string | null; linkedinUrl?: string | null },
    ctx: AuthContext,
    opts: { excludeCandidateId?: number } = {},
  ): Promise<readonly { candidateId: number; matchedOn: readonly string[] }[]> {
    const email = dedupEmail(probe.email ?? null);
    const phone = dedupPhone(probe.phone ?? null);
    const linkedin = dedupLinkedin(probe.linkedinUrl ?? null);
    if (email === null && phone === null && linkedin === null) return [];

    const signals: SQL[] = [];
    if (email !== null) signals.push(eq(candidate.dedupEmail, email));
    if (phone !== null) signals.push(eq(candidate.dedupPhone, phone));
    if (linkedin !== null) signals.push(eq(candidate.dedupLinkedin, linkedin));

    const predicates: SQL[] = [
      tenantScope(ctx),
      // An erased record must not resurface as a "duplicate" — that would leak
      // the fact it once existed.
      ne(candidate.state, 'ERASED'),
    ];
    const any = or(...signals);
    if (any) predicates.push(any);
    if (opts.excludeCandidateId !== undefined) {
      predicates.push(ne(candidate.id, opts.excludeCandidateId));
    }

    const rows = await this.db
      .select({
        id: candidate.id,
        dedupEmail: candidate.dedupEmail,
        dedupPhone: candidate.dedupPhone,
        dedupLinkedin: candidate.dedupLinkedin,
      })
      .from(candidate)
      .where(and(...predicates))
      .orderBy(candidate.id)
      .limit(20);

    return rows.map((row) => {
      const matchedOn: string[] = [];
      if (email !== null && row.dedupEmail === email) matchedOn.push('email');
      if (phone !== null && row.dedupPhone === phone) matchedOn.push('phone');
      if (linkedin !== null && row.dedupLinkedin === linkedin) matchedOn.push('linkedin');
      return { candidateId: row.id, matchedOn };
    });
  }

  async findByDocumentHash(fileHash: string, ctx: AuthContext): Promise<readonly number[]> {
    const rows = await this.db
      .selectDistinct({ candidateId: candidateDocument.candidateId })
      .from(candidateDocument)
      .innerJoin(candidate, eq(candidate.id, candidateDocument.candidateId))
      .where(and(eq(candidateDocument.fileHash, fileHash), tenantScope(ctx)));
    return rows.map((r) => r.candidateId);
  }

  private async readVersion(id: number): Promise<number | null> {
    const rows = await this.db.select({ version: candidate.version })
      .from(candidate).where(eq(candidate.id, id)).limit(1);
    return rows[0]?.version ?? null;
  }

  private translate(err: unknown): unknown {
    if (isUniqueViolation(err, 'ux_candidate_no')) {
      return new ConstraintViolationError(err, 'candidate write (duplicate candidate number)');
    }
    if (isUniqueViolation(err, 'ux_candidate_document_hash')) {
      return new ConstraintViolationError(err, 'document write (same file attached twice)');
    }
    if (isCheckViolation(err, 'ck_candidate_contact')) {
      return new ConstraintViolationError(err, 'candidate write (no contact details)');
    }
    return err;
  }
}

export class DrizzleCandidateProposalRepository implements CandidateProposalRepository {
  private readonly registry = new LoadRegistry();
  private readonly collector: TransactionEventCollector;

  constructor(private readonly db: Executor, opts: TalentRepositoryOptions = {}) {
    this.collector = opts.collector ?? new TransactionEventCollector();
  }

  async findById(id: number, ctx: AuthContext): Promise<CandidateProposal | null> {
    return this.load(id, ctx, false);
  }

  async findByIdForUpdate(id: number, ctx: AuthContext): Promise<CandidateProposal | null> {
    return this.load(id, ctx, true);
  }

  private async load(
    id: number, ctx: AuthContext, lock: boolean,
  ): Promise<CandidateProposal | null> {
    const base = this.db.select().from(candidateProposal)
      .where(and(
        eq(candidateProposal.id, id),
        eq(candidateProposal.tenantId, ctx.tenantId),
      ))
      .limit(1);
    const rows = lock ? await base.for('update') : await base;

    const row = rows[0];
    if (row === undefined) return null;
    this.registry.record(row.id, row.version);
    return CandidateProposal.fromState(proposalToProps(row));
  }

  async save(aggregate: CandidateProposal): Promise<void> {
    const state = aggregate.toState();
    const baseline = this.registry.baselineOf(state.id);

    try {
      if (baseline === undefined) {
        await this.db.insert(candidateProposal).values(proposalToRow(state));
      } else {
        const result = await this.db.update(candidateProposal)
          .set(proposalToRow(state))
          .where(and(
            eq(candidateProposal.id, state.id),
            eq(candidateProposal.version, baseline.version),
          ))
          .returning({ id: candidateProposal.id });

        await assertUpdated(
          result.length, 'CandidateProposal', state.id, baseline.version,
          async () => {
            const rows = await this.db.select({ version: candidateProposal.version })
              .from(candidateProposal).where(eq(candidateProposal.id, state.id)).limit(1);
            return rows[0]?.version ?? null;
          },
        );
      }
    } catch (err) {
      if (isUniqueViolation(err, 'ux_candidate_proposal_pending')) {
        throw new ConstraintViolationError(
          err, 'proposal write (a pending proposal already exists for this candidate)',
        );
      }
      throw err;
    }

    this.registry.record(state.id, state.version);
    this.collector.collect('CandidateProposal', state.id, state.tenantId, aggregate.pullEvents());
  }

  async nextId(_ctx: AuthContext): Promise<number> {
    return nextval(this.db, ID_SEQUENCES.candidateProposal);
  }

  async findPendingForCandidate(
    candidateId: number, ctx: AuthContext,
  ): Promise<CandidateProposal[]> {
    const rows = await this.db.select().from(candidateProposal)
      .where(and(
        eq(candidateProposal.candidateId, candidateId),
        eq(candidateProposal.tenantId, ctx.tenantId),
        eq(candidateProposal.status, 'PENDING'),
        isNotNull(candidateProposal.id),
      ))
      .orderBy(candidateProposal.id);

    return rows.map((row) => {
      // Baselines registered: the caller supersedes and saves these straight
      // back, and without one each save would attempt an insert.
      this.registry.record(row.id, row.version);
      return CandidateProposal.fromState(proposalToProps(row));
    });
  }
}


/**
 * CV intake batches.
 *
 * Items are rewritten wholesale on save: a batch holds tens of files, each row
 * is small, and item status changes in bursts as a reviewer works through them.
 * A field-by-field diff would be more code for no measurable gain at this size.
 */
export class DrizzleCvIntakeRepository implements CvIntakeBatchRepository {
  private readonly registry = new LoadRegistry();
  private readonly collector: TransactionEventCollector;

  constructor(private readonly db: Executor, opts: TalentRepositoryOptions = {}) {
    this.collector = opts.collector ?? new TransactionEventCollector();
  }

  async findById(id: number, ctx: AuthContext): Promise<CvIntakeBatch | null> {
    return this.load(id, ctx, false);
  }

  async findByIdForUpdate(id: number, ctx: AuthContext): Promise<CvIntakeBatch | null> {
    return this.load(id, ctx, true);
  }

  private async load(id: number, ctx: AuthContext, lock: boolean): Promise<CvIntakeBatch | null> {
    const base = this.db.select().from(cvIntakeBatch)
      .where(and(eq(cvIntakeBatch.id, id), eq(cvIntakeBatch.tenantId, ctx.tenantId)))
      .limit(1);
    const rows = lock ? await base.for('update') : await base;

    const row = rows[0];
    if (row === undefined) return null;

    const items = await this.db.select().from(cvIntakeItem)
      .where(eq(cvIntakeItem.batchId, id))
      .orderBy(cvIntakeItem.id);

    this.registry.record(row.id, row.version);
    return CvIntakeBatch.fromState(intakeToProps(row, items));
  }

  async save(aggregate: CvIntakeBatch): Promise<void> {
    const state = aggregate.toState();
    const baseline = this.registry.baselineOf(state.id);

    if (baseline === undefined) {
      await this.db.insert(cvIntakeBatch).values(intakeToRow(state));
      if (state.items.length > 0) {
        await this.db.insert(cvIntakeItem)
          .values(state.items.map((i) => intakeItemToRow(state.id, i)));
      }
    } else {
      const result = await this.db.update(cvIntakeBatch)
        .set(intakeToRow(state))
        .where(and(
          eq(cvIntakeBatch.id, state.id),
          eq(cvIntakeBatch.version, baseline.version),
        ))
        .returning({ id: cvIntakeBatch.id });

      await assertUpdated(result.length, 'CvIntakeBatch', state.id, baseline.version, async () => {
        const rows = await this.db.select({ version: cvIntakeBatch.version })
          .from(cvIntakeBatch).where(eq(cvIntakeBatch.id, state.id)).limit(1);
        return rows[0]?.version ?? null;
      });

      const stored = await this.db.select().from(cvIntakeItem)
        .where(eq(cvIntakeItem.batchId, state.id));
      await this.writeItems(state.id, state.items, stored);
    }

    this.registry.record(state.id, state.version);
    this.collector.collect('CvIntakeBatch', state.id, state.tenantId, aggregate.pullEvents());
  }

  private async writeItems(
    batchId: number,
    desired: readonly Parameters<typeof intakeItemToRow>[1][],
    stored: readonly IntakeItemRow[],
  ): Promise<void> {
    const storedByItem = new Map(stored.map((i) => [i.itemId, i]));

    const added = desired.filter((i) => !storedByItem.has(i.itemId));
    if (added.length > 0) {
      await this.db.insert(cvIntakeItem).values(added.map((i) => intakeItemToRow(batchId, i)));
    }

    for (const item of desired) {
      const before = storedByItem.get(item.itemId);
      if (before === undefined) continue;
      const after = intakeItemToProps(before);
      if (after.status === item.status && after.candidateId === item.candidateId
        && after.note === item.note && after.extracted.length === item.extracted.length) {
        continue;
      }
      await this.db.update(cvIntakeItem)
        .set({
          status: item.status,
          extracted: item.extracted,
          generation: item.generation,
          candidateId: item.candidateId,
          note: item.note,
        })
        .where(and(eq(cvIntakeItem.batchId, batchId), eq(cvIntakeItem.itemId, item.itemId)));
    }
  }

  async nextId(_ctx: AuthContext): Promise<number> {
    return nextval(this.db, ID_SEQUENCES.cvIntakeBatch);
  }
}
