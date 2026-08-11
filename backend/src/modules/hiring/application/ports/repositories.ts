// Repository ports for the Hiring context.
//
// Interfaces only — no implementation lives in this module. A Drizzle/Postgres
// adapter will implement them, and an adapter over the legacy models.js can
// implement them too, which is what makes the migration incremental rather than
// big-bang (ADR-0009).
//
// Three rules hold for every method (ADR-0005):
//   1. It takes an AuthContext. There is no unscoped read.
//   2. Out-of-scope rows return null / empty — never a distinguishable error.
//      A caller must not be able to use 403-vs-404 as an existence oracle.
//   3. Scope is applied inside the query, never as a post-filter in JavaScript.

import type { Application } from '../../domain/application.js';
import type { Requisition } from '../../domain/requisition.js';
import type { AuthContext } from '../../../shared/kernel/auth-context.js';

export interface RequisitionRepository {
  findById(id: number, ctx: AuthContext): Promise<Requisition | null>;

  /**
   * Load with a row lock (SELECT … FOR UPDATE).
   *
   * The lock on the requisition row is what serialises concurrent seat
   * acquisition, so in-memory seat selection inside the aggregate is safe
   * (ADR-0004). Contention is per-requisition, which is the correct granularity.
   */
  findByIdForUpdate(id: number, ctx: AuthContext): Promise<Requisition | null>;

  /** Persist root + seats. Implementations must write both or neither. */
  save(requisition: Requisition): Promise<void>;

  /** Database sequence, not a read-modify-write on a settings row (Audit #1 F-09). */
  nextTicketNo(ctx: AuthContext): Promise<string>;

  /**
   * Allocate the identity BEFORE construction, so an aggregate is never in a
   * half-formed state with a placeholder id. Postgres: `SELECT nextval(...)`.
   */
  nextId(ctx: AuthContext): Promise<number>;
}

export interface ApplicationRepository {
  findById(id: number, ctx: AuthContext): Promise<Application | null>;
  findByIdForUpdate(id: number, ctx: AuthContext): Promise<Application | null>;

  /** Persist root + newly appended stage history. */
  save(application: Application): Promise<void>;

  nextApplicationNo(ctx: AuthContext): Promise<string>;

  /** See RequisitionRepository.nextId. */
  nextId(ctx: AuthContext): Promise<number>;

  /**
   * Invariant H5 — a candidate holds at most one filled seat across active
   * requisitions. Spans aggregates, so it cannot live inside one of them.
   * Returns the offending application id, or null.
   *
   * `excludeApplicationId` lets the caller ignore the application it is about to
   * act on, so re-running a hire on the same record is not self-blocking.
   */
  findActiveHireForCandidate(
    candidateId: number,
    ctx: AuthContext,
    opts?: { excludeApplicationId?: number },
  ): Promise<number | null>;

  /**
   * Non-terminal applications on a requisition. Used by the close/cancel cascade
   * so candidates are not left sitting at INTERVIEWING on a dead requisition
   * (BL-22). Consumed by RequisitionService, not HiringService.
   */
  findNonTerminalByRequisition(requisitionId: number, ctx: AuthContext): Promise<Application[]>;
}
