// AI contracts — envelopes and provenance. INTERFACES AND TYPES ONLY.
//
// Nothing here mentions Qwen, Ollama, HTTP, a prompt, a token count or a vector
// store, and nothing here may. The first implementation will be Qwen via a local
// Ollama, but that is one adapter; a remote model must be swappable without a
// single business-layer edit.
//
// THREE RULES THIS FILE EXISTS TO ENFORCE
//
// 1. AI IS ADVISORY. Every capability returns a PROPOSAL. There is no method
//    anywhere in this folder that mutates state. Applying a proposal is an
//    ordinary domain operation, performed by a named human act through the
//    ordinary service, under the ordinary rules.
//
// 2. CAPABILITIES, NOT MODELS. A caller asks for "extract a résumé", never for
//    "run qwen2.5:7b". Swapping the model is a composition-root change.
//
// 3. ASYNCHRONOUS BY DEFAULT. Inference takes seconds. A command handler that
//    waits for it holds a transaction and a row lock while a GPU thinks. So the
//    normal path is: submit a task, commit, and let the result arrive as an
//    event through the existing outbox. `AITaskDispatcher` is that seam.

import type { DomainEvent } from '../domain.js';

/** Stable capability names. The routing key an adapter registers against. */
export const AI_CAPABILITIES = {
  DOCUMENT_PARSE: 'document.parse',
  RESUME_EXTRACT: 'resume.extract',
  RESUME_EMBED: 'resume.embed',
  CANDIDATE_MATCH: 'candidate.match',
  CANDIDATE_RANK: 'candidate.rank',
  SKILL_NORMALIZE: 'skill.normalize',
  JOB_DESCRIPTION_ANALYZE: 'job_description.analyze',
} as const;

export type AICapability = (typeof AI_CAPABILITIES)[keyof typeof AI_CAPABILITIES];

/** What the proposal is about, so a result can be routed back without a lookup. */
export interface AIEntityRef {
  readonly entityType: string;
  readonly entityId: number;
}

/**
 * Where an answer came from.
 *
 * Recorded on every proposal because an AI suggestion that cannot be traced to a
 * model and a prompt version is unreviewable — and under GDPR/PDPL, a decision
 * influenced by an untraceable system is one you cannot explain to the person it
 * affected.
 */
export interface AIProvenance {
  readonly capability: AICapability;
  /** Opaque adapter identifier, e.g. a model name and revision. Never parsed. */
  readonly modelId: string;
  readonly promptVersionId: string;
  readonly producedAt: Date;
  /** Milliseconds of inference. Operational signal, not a business value. */
  readonly latencyMs?: number;
  /**
   * Content digest of the exact model that produced this, when the runtime
   * reports one.
   *
   * OPTIONAL and PROVIDER-NEUTRAL. `modelId` is a mutable tag — the same tag
   * can point at different weights after an upgrade — so it cannot answer
   * "which model produced this proposal?". A digest can. Absent when the
   * runtime does not expose one.
   */
  readonly modelDigest?: string;
}

/**
 * An advisory answer.
 *
 * `confidence` is 0..1 and is a HINT for presentation — "show a warning banner
 * below 0.6". It must never gate a domain rule: a rule that fires at 0.61 and
 * not at 0.59 is a business rule whose threshold lives in a model's calibration,
 * which is untestable and unauditable.
 */
export interface AIProposal<T> {
  readonly content: T;
  readonly confidence: number;
  readonly reasoningSummary: string;
  /** Document ids, field names, or record refs the answer drew on. */
  readonly sourcesUsed: readonly string[];
  readonly provenance: AIProvenance;
}

/**
 * Nothing useful could be produced. Not an error — a normal outcome.
 *
 * `permanent` decides whether the work is LOST or merely DELAYED, so it is
 * required rather than optional:
 *
 *   permanent  — the input itself cannot yield an answer. A corrupt PDF, an
 *                unsupported format, an empty document. Retrying changes
 *                nothing, so the task is terminal.
 *
 *   temporary  — the ENVIRONMENT could not answer. No provider configured, a
 *                provider down, a timeout. The input is fine and the same
 *                request will succeed once the environment is. Retryable.
 *
 * Getting this wrong in the permanent direction silently discards a candidate's
 * CV because a model happened to be offline at upload time.
 */
export interface AIAbstention {
  readonly abstained: true;
  readonly reason: string;
  readonly permanent: boolean;
  readonly provenance: AIProvenance;
}

export type AIOutcome<T> = AIProposal<T> | AIAbstention;

export const isProposal = <T>(outcome: AIOutcome<T>): outcome is AIProposal<T> =>
  !('abstained' in outcome);

/* ------------------------------ async submission --------------------------- */

export type AITaskState = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'ABSTAINED' | 'FAILED';

export interface AITaskRequest<TInput> {
  readonly capability: AICapability;
  readonly input: TInput;
  readonly entityRef?: AIEntityRef;
  /**
   * Makes submission safe to retry.
   *
   * Inference is expensive and the outbox delivers at least once, so a
   * redelivered submit must not run the model twice. Same key, same task.
   */
  readonly idempotencyKey: string;
  readonly tenantId: number;
  /** Ties the task to the request that caused it, across process boundaries. */
  readonly correlationId?: string | null;
  /** Advisory ordering only. An adapter may ignore it. */
  readonly priority?: 'INTERACTIVE' | 'STANDARD' | 'BATCH';
}

export interface AITaskHandle {
  readonly taskId: string;
  readonly capability: AICapability;
  readonly state: AITaskState;
  /** True when an existing task was returned instead of a new one. */
  readonly deduplicated: boolean;
}

/**
 * Submit work and return immediately.
 *
 * THE POINT: a command handler calls this INSIDE its transaction, commits, and
 * is done. The task is durable because submitting writes a row like any other
 * write; the result arrives later as a domain event that a subscriber turns into
 * a proposal on the record. No transaction, and no row lock, is ever held across
 * inference.
 */
export interface AITaskDispatcher {
  submit<TInput>(request: AITaskRequest<TInput>): Promise<AITaskHandle>;
  /** Best-effort cancellation. A running task may still complete. */
  cancel(taskId: string): Promise<void>;
  status(taskId: string): Promise<AITaskHandle | null>;
}

/**
 * Event types a completed task publishes.
 *
 * Declared here so subscribers can be written before any adapter exists. NOTHING
 * emits these yet — the AI phase does, through the existing outbox, which is why
 * results integrate with no new delivery mechanism.
 */
export const AI_EVENTS = {
  TASK_SUBMITTED: 'AITaskSubmitted',
  PROPOSAL_READY: 'AIProposalReady',
  TASK_ABSTAINED: 'AITaskAbstained',
  TASK_FAILED: 'AITaskFailed',
} as const;

export type AIEventType = (typeof AI_EVENTS)[keyof typeof AI_EVENTS];

/** Shape of an AI result event's payload. Structural; no class, no behaviour. */
export interface AIResultEventPayload {
  readonly taskId: string;
  readonly capability: AICapability;
  readonly entityType?: string;
  readonly entityId?: number;
  readonly state: AITaskState;
  readonly modelId?: string;
  readonly promptVersionId?: string;
}

export type AIResultEvent = DomainEvent & { readonly type: AIEventType };
