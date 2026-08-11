// AI task worker.
//
// Claims queued tasks with `FOR UPDATE SKIP LOCKED`, runs the capability, and
// records the outcome. Same shape as the outbox dispatcher and safe to run in
// parallel for the same reason: a row another worker holds is skipped, not
// waited on.
//
// THE MODEL RUNS OUTSIDE THE CLAIM TRANSACTION. Inference takes seconds; holding
// a row lock across it would block every other worker and, on a small pool,
// the web tier too. So: claim and mark RUNNING in one short transaction, run,
// then settle in a second one.

import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { aiTask } from '../db/schema/index.js';
import type { Executor } from '../db/types.js';
import { runInTransaction } from '../db/transaction.js';
import { AI_CAPABILITIES } from '../../modules/shared/kernel/ai/index.js';
import type { AICapabilities } from '../../modules/shared/kernel/ai/index.js';
import { AuthContext } from '../../modules/shared/kernel/auth-context.js';
import type { CvIntakeService, DocumentStore, ProposalService } from '../../modules/talent/index.js';
import type { MatchingService } from '../../modules/matching/index.js';
import { MATCHING_PERMISSIONS } from '../../modules/matching/index.js';
import { TALENT_PERMISSIONS } from '../../modules/talent/index.js';
import { runResumeParse } from './resume-parse-handler.js';
import { runCandidateMatch } from './matching-handler.js';
import type { MatchInput } from './matching-handler.js';
import type { ParseInput } from './resume-parse-handler.js';

export interface AITaskWorkerOptions {
  readonly batchSize?: number;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
}

export interface DrainResult {
  readonly succeeded: number;
  readonly abstained: number;
  readonly failed: number;
}

export class AITaskWorker {
  constructor(
    private readonly db: Executor,
    private readonly deps: {
      capabilities: AICapabilities;
      documents: DocumentStore;
      proposals: ProposalService;
      /** Absent means intake tasks abstain — bulk upload is not wired. */
      intake?: CvIntakeService;
      /** Absent means matching tasks abstain. */
      matching?: MatchingService;
    },
    private readonly opts: AITaskWorkerOptions = {},
  ) {}

  async drainOnce(): Promise<DrainResult> {
    const now = this.opts.now?.() ?? new Date();
    const claimed = await this.claim(now);

    let succeeded = 0; let abstained = 0; let failed = 0;
    for (const task of claimed) {
      try {
        const outcome = await this.run(task);
        if (outcome === 'SUCCEEDED') succeeded += 1; else abstained += 1;
      } catch (error) {
        failed += 1;
        this.opts.onError?.(error);
        await this.recordFailure(task.id, error, now);
      }
    }
    return { succeeded, abstained, failed };
  }

  async drainUntilEmpty(maxPasses = 20): Promise<DrainResult> {
    let succeeded = 0; let abstained = 0; let failed = 0;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const result = await this.drainOnce();
      succeeded += result.succeeded; abstained += result.abstained; failed += result.failed;
      if (result.succeeded + result.abstained + result.failed === 0) break;
    }
    return { succeeded, abstained, failed };
  }

  /** Short transaction: take the rows and mark them RUNNING, then get out. */
  private async claim(now: Date): Promise<readonly (typeof aiTask.$inferSelect)[]> {
    try {
      return await runInTransaction(this.db, async (tx) => {
        const rows = await tx
          .select().from(aiTask)
          .where(and(eq(aiTask.state, 'QUEUED'), lte(aiTask.nextAttemptAt, now)))
          .orderBy(asc(aiTask.id))
          .limit(this.opts.batchSize ?? 5)
          .for('update', { skipLocked: true });

        for (const row of rows) {
          await tx.update(aiTask)
            .set({ state: 'RUNNING', startedAt: now, attempts: sql`${aiTask.attempts} + 1` })
            .where(eq(aiTask.id, row.id));
        }
        return rows;
      });
    } catch (error) {
      // A failed claim must not kill the loop; the rows were not marked, so the
      // next pass sees them unchanged.
      this.opts.onError?.(error);
      return [];
    }
  }

  private async run(task: typeof aiTask.$inferSelect): Promise<'SUCCEEDED' | 'ABSTAINED'> {
    const now = this.opts.now?.() ?? new Date();

    if (task.capability === AI_CAPABILITIES.CANDIDATE_MATCH) {
      return this.runMatch(task, now);
    }

    if (task.capability !== AI_CAPABILITIES.RESUME_EXTRACT) {
      // PERMANENT: an unknown capability is a wiring error, not an outage.
      await this.settleAbstain(
        task.id, `No handler for capability '${task.capability}'.`, true, now,
      );
      return 'ABSTAINED';
    }

    const input = task.input as unknown as ParseInput;
    const outcome = await runResumeParse(input, {
      capabilities: this.deps.capabilities,
      documents: this.deps.documents,
    });

    // System context carrying ONLY what recording a result needs. It cannot
    // approve anything: acceptance is a human act, always.
    const ctx = AuthContext.system(task.tenantId, {
      permissions: [TALENT_PERMISSIONS.EDIT, TALENT_PERMISSIONS.VIEW_ALL,
        TALENT_PERMISSIONS.CREATE],
    });

    if (outcome.kind === 'ABSTAIN') {
      // A staged file whose parse failed must SAY so on the item, or a reviewer
      // stares at a spinner forever. Only for a permanent failure — a temporary
      // one is going to be retried.
      if (outcome.permanent && input.batchId !== undefined && input.itemId !== undefined
        && this.deps.intake !== undefined) {
        await this.deps.intake.recordParseFailure({
          batchId: input.batchId, itemId: input.itemId, reason: outcome.reason,
        }, ctx);
      }
      await this.settleAbstain(task.id, outcome.reason, outcome.permanent, now);
      return 'ABSTAINED';
    }

    if (input.batchId !== undefined && input.itemId !== undefined) {
      if (this.deps.intake === undefined) {
        await this.settleAbstain(task.id, 'CV intake is not configured.', false, now);
        return 'ABSTAINED';
      }
      await this.deps.intake.recordExtraction({
        batchId: input.batchId,
        itemId: input.itemId,
        fields: outcome.fields.map((f) => ({
          field: f.field, value: f.value, confidence: f.confidence, evidence: f.evidence,
        })),
        generation: outcome.generation,
      }, ctx);

      await this.db.update(aiTask).set({
        state: 'SUCCEEDED', finishedAt: now,
        modelId: outcome.generation.modelId,
        promptVersionId: outcome.generation.promptVersionId,
      }).where(eq(aiTask.id, task.id));
      return 'SUCCEEDED';
    }

    if (input.candidateId === undefined) {
      await this.settleAbstain(task.id, 'Task names no parse target.', true, now);
      return 'ABSTAINED';
    }

    const proposal = await this.deps.proposals.raise({
      candidateId: input.candidateId,
      origin: AI_CAPABILITIES.RESUME_EXTRACT,
      taskId: String(task.id),
      modelId: outcome.generation.modelId,
      documentId: input.documentId,
      generation: outcome.generation,
      fields: outcome.fields.map((f) => ({
        field: f.field, value: f.value, confidence: f.confidence, evidence: f.evidence,
      })),
    }, ctx);

    await this.db.update(aiTask).set({
      state: 'SUCCEEDED',
      finishedAt: now,
      modelId: outcome.generation.modelId,
      promptVersionId: outcome.generation.promptVersionId,
      proposalId: proposal.id,
    }).where(eq(aiTask.id, task.id));

    return 'SUCCEEDED';
  }

  private async runMatch(
    task: typeof aiTask.$inferSelect, now: Date,
  ): Promise<'SUCCEEDED' | 'ABSTAINED'> {
    if (this.deps.matching === undefined) {
      await this.settleAbstain(task.id, 'Matching is not configured.', false, now);
      return 'ABSTAINED';
    }

    const outcome = await runCandidateMatch(task.input as unknown as MatchInput, {
      capabilities: this.deps.capabilities,
      db: this.db,
    });

    if (outcome.kind === 'ABSTAIN') {
      await this.settleAbstain(task.id, outcome.reason, outcome.permanent, now);
      return 'ABSTAINED';
    }

    // System context with matching rights ONLY. It records suggestions; it can
    // neither dismiss nor link, because both are human decisions.
    const ctx = AuthContext.system(task.tenantId, {
      permissions: [MATCHING_PERMISSIONS.VIEW],
    });
    await this.deps.matching.recordSuggestions({
      requisitionId: (task.input as { requisitionId: number }).requisitionId,
      source: AI_CAPABILITIES.CANDIDATE_MATCH,
      generation: outcome.generation,
      suggestions: outcome.suggestions,
    }, ctx);

    await this.db.update(aiTask).set({
      state: 'SUCCEEDED', finishedAt: now,
      modelId: outcome.generation.modelId,
      promptVersionId: outcome.generation.promptVersionId,
    }).where(eq(aiTask.id, task.id));

    return 'SUCCEEDED';
  }

  /**
   * Settle an abstention according to whether it can ever succeed.
   *
   * PERMANENT — the input cannot yield an answer. Terminal.
   * TEMPORARY — the environment could not answer. Requeued with backoff, so a
   *   CV uploaded while the provider was down is parsed once it returns rather
   *   than silently lost. Still bounded: after `maxAttempts` it becomes FAILED
   *   and visible, instead of retrying forever.
   */
  private async settleAbstain(
    id: number, reason: string, permanent: boolean, now: Date,
  ): Promise<void> {
    if (permanent) {
      await this.db.update(aiTask)
        .set({ state: 'ABSTAINED', abstainReason: reason, finishedAt: now })
        .where(eq(aiTask.id, id));
      return;
    }

    const maxAttempts = this.opts.maxAttempts ?? 3;
    const base = this.opts.baseDelayMs ?? 5_000;
    await this.db.update(aiTask).set({
      state: sql`case when ${aiTask.attempts} >= ${maxAttempts} then 'FAILED'::ai_task_state
                      else 'QUEUED'::ai_task_state end`,
      abstainReason: reason,
      nextAttemptAt: sql`${now}::timestamptz
        + least(${base} * power(2, ${aiTask.attempts}), 600000) * interval '1 millisecond'`,
      finishedAt: sql`case when ${aiTask.attempts} >= ${maxAttempts} then ${now}::timestamptz
                           else null end`,
    }).where(eq(aiTask.id, id));
  }

  private async recordFailure(id: number, error: unknown, now: Date): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const maxAttempts = this.opts.maxAttempts ?? 3;
    const base = this.opts.baseDelayMs ?? 5_000;

    await this.db.update(aiTask).set({
      // Back to QUEUED while attempts remain; FAILED once they are spent, so a
      // permanently broken task is visible rather than looping forever.
      state: sql`case when ${aiTask.attempts} >= ${maxAttempts} then 'FAILED'::ai_task_state
                      else 'QUEUED'::ai_task_state end`,
      lastError: message.slice(0, 2_000),
      nextAttemptAt: sql`${now}::timestamptz
        + least(${base} * power(2, ${aiTask.attempts}), 600000) * interval '1 millisecond'`,
      finishedAt: sql`case when ${aiTask.attempts} >= ${maxAttempts} then ${now}::timestamptz
                           else null end`,
    }).where(eq(aiTask.id, id));
  }

  /** Operational counters for the health endpoint. */
  async backlog(): Promise<{ queued: number; running: number; failed: number }> {
    const rows = await this.db.select({
      queued: sql<number>`count(*) filter (where "ai_task"."state" = 'QUEUED')`.mapWith(Number),
      running: sql<number>`count(*) filter (where "ai_task"."state" = 'RUNNING')`.mapWith(Number),
      failed: sql<number>`count(*) filter (where "ai_task"."state" = 'FAILED')`.mapWith(Number),
    }).from(aiTask);
    return rows[0] ?? { queued: 0, running: 0, failed: 0 };
  }

  /** Requeue tasks a crashed worker left RUNNING. Called on startup. */
  async recoverStalled(olderThan: Date): Promise<number> {
    const rows = await this.db.update(aiTask)
      .set({ state: 'QUEUED', startedAt: null })
      .where(and(
        eq(aiTask.state, 'RUNNING'),
        or(isNull(aiTask.startedAt), lte(aiTask.startedAt, olderThan)),
      ))
      .returning({ id: aiTask.id });
    return rows.length;
  }
}
