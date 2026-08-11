// The shared kernel's public surface.
//
// Every bounded context imports from here. The kernel imports from no context,
// which is what keeps the dependency graph acyclic.

export type { Actor, DomainEvent, Clock } from './domain.js';
export { systemClock } from './domain.js';

export { AuthContext } from './auth-context.js';
export type { AuthContextProps } from './auth-context.js';

export {
  ApplicationError, ForbiddenError, NotFoundError, StaleAggregateError,
} from './errors.js';
export type { ApplicationErrorCode } from './errors.js';

export type {
  AICompletionRequest, AIProposal, AIService,
  AuditTimeline, EventBus, JobPriority, JobQueue,
  NotificationChannel, NotificationHub, NotificationRequest, TimelineEntry,
} from './ports.js';

/* ----------------------------------- AI ------------------------------------ */
// Ports only. Advisory by construction: no method here mutates state, and every
// capability may abstain. Adapters (Qwen via Ollama first) arrive in the AI
// phase and are wired solely in the composition root.
export * from './ai/index.js';
