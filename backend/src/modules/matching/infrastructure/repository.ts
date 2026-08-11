// Matching repository + UnitOfWork. Persistence only.

import { and, asc, desc, eq } from 'drizzle-orm';
import type { AuthContext } from '../../shared/kernel/auth-context.js';
import { CandidateMatch } from '../domain/match.js';
import type {
  CandidateMatchProps, MatchEvidenceItem, MatchGeneration,
} from '../domain/match.js';
import type {
  CandidateMatchRepository, MatchingTransactionScope, MatchingUnitOfWork,
} from '../application/ports.js';
import { ID_SEQUENCES, candidateMatch } from '../../../infrastructure/db/schema/index.js';
import { scopedViaRequisition } from '../../../infrastructure/db/scope.js';
import type { Executor } from '../../../infrastructure/db/types.js';
import { LoadRegistry, assertUpdated } from '../../../infrastructure/db/version-guard.js';
import { nextval } from '../../../infrastructure/db/sequences.js';
import { toNumber } from '../../../infrastructure/db/numeric.js';
import { TransactionEventCollector } from '../../../infrastructure/db/outbox.js';
import { runTransactionWithOutbox } from '../../../infrastructure/db/transactional-outbox.js';
import type { OutboxAwareOptions } from '../../../infrastructure/db/transactional-outbox.js';

type Row = typeof candidateMatch.$inferSelect;

const list = <T>(raw: unknown): T[] => (Array.isArray(raw) ? raw as T[] : []);

const toProps = (row: Row): CandidateMatchProps => ({
  id: row.id,
  tenantId: row.tenantId,
  requisitionId: row.requisitionId,
  candidateId: row.candidateId,
  // numeric arrives as a string; a text score would sort "0.9" below "0.10".
  score: toNumber(row.score),
  evidence: list<MatchEvidenceItem>(row.evidence),
  missingRequirements: list<string>(row.missingRequirements),
  source: row.source,
  generation: reviveGeneration(row.generation),
  status: row.status,
  applicationId: row.applicationId,
  resolvedBy: row.resolvedBy,
  resolvedAt: row.resolvedAt,
  reason: row.reason,
  createdAt: row.createdAt,
  version: row.version,
});

const reviveGeneration = (raw: unknown): MatchGeneration | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const g = raw as Record<string, unknown>;
  if (typeof g['modelId'] !== 'string') return null;
  return {
    capability: String(g['capability'] ?? ''),
    modelId: g['modelId'],
    promptVersionId: String(g['promptVersionId'] ?? ''),
    generatedAt: new Date(String(g['generatedAt'] ?? 0)),
  };
};

const toRow = (p: CandidateMatchProps): typeof candidateMatch.$inferInsert => ({
  id: p.id,
  tenantId: p.tenantId,
  requisitionId: p.requisitionId,
  candidateId: p.candidateId,
  score: p.score.toFixed(3),
  evidence: p.evidence,
  missingRequirements: p.missingRequirements,
  source: p.source,
  generation: p.generation,
  status: p.status,
  applicationId: p.applicationId,
  resolvedBy: p.resolvedBy,
  resolvedAt: p.resolvedAt,
  reason: p.reason,
  version: p.version,
  createdAt: p.createdAt,
});

export interface MatchingRepositoryOptions {
  readonly collector?: TransactionEventCollector;
}

export class DrizzleCandidateMatchRepository implements CandidateMatchRepository {
  private readonly registry = new LoadRegistry();
  private readonly collector: TransactionEventCollector;

  constructor(private readonly db: Executor, opts: MatchingRepositoryOptions = {}) {
    this.collector = opts.collector ?? new TransactionEventCollector();
  }

  /** Scope reaches the project through the requisition the match is about. */
  private scope(ctx: AuthContext): ReturnType<typeof scopedViaRequisition> {
    return scopedViaRequisition(
      this.db, candidateMatch.tenantId, candidateMatch.requisitionId, ctx,
    );
  }

  async findById(id: number, ctx: AuthContext): Promise<CandidateMatch | null> {
    return this.load(id, ctx, false);
  }

  async findByIdForUpdate(id: number, ctx: AuthContext): Promise<CandidateMatch | null> {
    return this.load(id, ctx, true);
  }

  private async load(id: number, ctx: AuthContext, lock: boolean): Promise<CandidateMatch | null> {
    const base = this.db.select().from(candidateMatch)
      .where(and(eq(candidateMatch.id, id), this.scope(ctx)))
      .limit(1);
    const rows = lock ? await base.for('update') : await base;
    const row = rows[0];
    if (row === undefined) return null;
    this.registry.record(row.id, row.version);
    return CandidateMatch.fromState(toProps(row));
  }

  /** Baselines ARE registered — the caller refreshes and saves these back. */
  async findByRequisition(requisitionId: number, ctx: AuthContext): Promise<CandidateMatch[]> {
    const rows = await this.db.select().from(candidateMatch)
      .where(and(eq(candidateMatch.requisitionId, requisitionId), this.scope(ctx)))
      .orderBy(desc(candidateMatch.score), asc(candidateMatch.id));

    return rows.map((row) => {
      this.registry.record(row.id, row.version);
      return CandidateMatch.fromState(toProps(row));
    });
  }

  async save(aggregate: CandidateMatch): Promise<void> {
    const state = aggregate.toState();
    const baseline = this.registry.baselineOf(state.id);

    if (baseline === undefined) {
      await this.db.insert(candidateMatch).values(toRow(state));
    } else {
      const result = await this.db.update(candidateMatch)
        .set(toRow(state))
        .where(and(
          eq(candidateMatch.id, state.id),
          eq(candidateMatch.version, baseline.version),
        ))
        .returning({ id: candidateMatch.id });

      await assertUpdated(result.length, 'CandidateMatch', state.id, baseline.version, async () => {
        const rows = await this.db.select({ version: candidateMatch.version })
          .from(candidateMatch).where(eq(candidateMatch.id, state.id)).limit(1);
        return rows[0]?.version ?? null;
      });
    }

    this.registry.record(state.id, state.version);
    this.collector.collect('CandidateMatch', state.id, state.tenantId, aggregate.pullEvents());
  }

  async nextId(_ctx: AuthContext): Promise<number> {
    return nextval(this.db, ID_SEQUENCES.candidateMatch);
  }
}

export interface MatchingUnitOfWorkOptions extends OutboxAwareOptions, MatchingRepositoryOptions {}

export class DrizzleMatchingUnitOfWork implements MatchingUnitOfWork {
  constructor(
    private readonly db: Executor,
    private readonly opts: MatchingUnitOfWorkOptions = {},
  ) {}

  async transaction<T>(fn: (tx: MatchingTransactionScope) => Promise<T>): Promise<T> {
    return runTransactionWithOutbox(
      this.db,
      this.opts,
      (tx, collector) => ({
        matches: new DrizzleCandidateMatchRepository(tx, { ...this.opts, collector }),
      }),
      fn,
    );
  }
}
