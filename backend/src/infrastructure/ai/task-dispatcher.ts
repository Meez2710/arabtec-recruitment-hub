// AITaskDispatcher — the durable, transactional implementation.
//
// `submit()` is a row insert, so a caller does it INSIDE its own transaction and
// commits. No inference happens on the request thread and no transaction is ever
// held while a model thinks. The worker picks the row up afterwards.
//
// Idempotent by key: a redelivered submit returns the EXISTING task rather than
// queueing a second one. That matters more here than almost anywhere else — the
// outbox delivers at least once, and running a model twice costs real seconds.

import { and, eq, sql } from 'drizzle-orm';
import { aiTask } from '../db/schema/index.js';
import type { Executor } from '../db/types.js';
import { executorFor } from '../db/current-transaction.js';
import type {
  AITaskDispatcher, AITaskHandle, AITaskRequest, AITaskState,
} from '../../modules/shared/kernel/ai/index.js';
import type { AICapability } from '../../modules/shared/kernel/ai/index.js';

export class DrizzleAITaskDispatcher implements AITaskDispatcher {
  constructor(private readonly root: Executor) {}

  /** Joins the caller's transaction when there is one — see current-transaction.ts. */
  private get db(): Executor { return executorFor(this.root); }

  async submit<TInput>(request: AITaskRequest<TInput>): Promise<AITaskHandle> {
    const inserted = await this.db
      .insert(aiTask)
      .values({
        tenantId: request.tenantId,
        capability: request.capability,
        idempotencyKey: request.idempotencyKey,
        entityType: request.entityRef?.entityType ?? null,
        entityId: request.entityRef?.entityId ?? null,
        input: request.input as Record<string, unknown>,
        priority: request.priority ?? 'STANDARD',
        correlationId: request.correlationId ?? null,
      })
      // The database decides the winner, atomically. A read-then-insert would
      // leave a window in which two callers both queue the same work.
      .onConflictDoNothing({ target: [aiTask.tenantId, aiTask.idempotencyKey] })
      .returning({ id: aiTask.id, state: aiTask.state });

    const fresh = inserted[0];
    if (fresh !== undefined) {
      return {
        taskId: String(fresh.id),
        capability: request.capability,
        state: fresh.state,
        deduplicated: false,
      };
    }

    const existing = await this.db
      .select({ id: aiTask.id, state: aiTask.state, capability: aiTask.capability })
      .from(aiTask)
      .where(and(
        eq(aiTask.tenantId, request.tenantId),
        eq(aiTask.idempotencyKey, request.idempotencyKey),
      ))
      .limit(1);

    const row = existing[0];
    if (row === undefined) {
      throw new Error(`AI task ${request.idempotencyKey} could neither be created nor found.`);
    }
    return {
      taskId: String(row.id),
      capability: row.capability as AICapability,
      state: row.state,
      deduplicated: true,
    };
  }

  /**
   * Best effort. A RUNNING task is left alone: the worker owns it, and marking
   * it cancelled underneath would make its completion write to a task that no
   * longer claims to be running.
   */
  async cancel(taskId: string): Promise<void> {
    const id = Number(taskId);
    if (!Number.isInteger(id)) return;
    await this.db
      .update(aiTask)
      .set({ state: 'FAILED', abstainReason: 'cancelled', finishedAt: sql`now()` })
      .where(and(eq(aiTask.id, id), eq(aiTask.state, 'QUEUED')));
  }

  async status(taskId: string): Promise<AITaskHandle | null> {
    const id = Number(taskId);
    if (!Number.isInteger(id)) return null;

    const rows = await this.db
      .select({ id: aiTask.id, state: aiTask.state, capability: aiTask.capability })
      .from(aiTask).where(eq(aiTask.id, id)).limit(1);

    const row = rows[0];
    return row === undefined ? null : {
      taskId: String(row.id),
      capability: row.capability as AICapability,
      state: row.state as AITaskState,
      deduplicated: false,
    };
  }
}
