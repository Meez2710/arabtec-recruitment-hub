// Hiring context — row <-> props mappers.
//
// A mapper is a TOTAL, PURE function between two shapes. No defaulting that
// could mask missing data, no derivation, no validation. Every business rule
// stays in the aggregate; this file only changes the shape of the same facts.
//
// It lives INSIDE the module on purpose. Mapping requires `RequisitionProps` and
// `Seat`, which are aggregate internals — publishing them from `index.ts` just
// to let an outside adapter read them would widen the module's public surface
// for a persistence detail, which is exactly what the barrel's header forbids.
//
// The direction that matters is `toProps`: it must reconstruct precisely the
// props an aggregate was serialised from, so
// `fromState(toProps(toRow(state)))` is the identity. The mapper tests assert
// that round-trip on generated data rather than on hand-picked examples.

import type {
  hiringApplication, hiringRequisition, hiringSeat, hiringStageHistory,
} from '../../../infrastructure/db/schema/index.js';
import type { ApplicationProps, StageChange } from '../domain/application.js';
import type { RequisitionProps, Seat } from '../domain/requisition.js';

export type RequisitionRow = typeof hiringRequisition.$inferSelect;
export type RequisitionInsert = typeof hiringRequisition.$inferInsert;
export type SeatRow = typeof hiringSeat.$inferSelect;
export type SeatInsert = typeof hiringSeat.$inferInsert;
export type ApplicationRow = typeof hiringApplication.$inferSelect;
export type ApplicationInsert = typeof hiringApplication.$inferInsert;
export type StageHistoryRow = typeof hiringStageHistory.$inferSelect;
export type StageHistoryInsert = typeof hiringStageHistory.$inferInsert;

/**
 * jsonb arrives as `unknown` — Postgres does not carry the TypeScript type
 * across the wire. The cast is unavoidable at the storage boundary; it is
 * confined to this one helper so the assumption is visible and greppable rather
 * than scattered through the mappers.
 */
const asReasons = (raw: unknown): Partial<Record<string, string>> =>
  (raw ?? {}) as Partial<Record<string, string>>;

/* ------------------------------- requisition ------------------------------ */

export const requisitionToProps = (
  row: RequisitionRow,
  seats: readonly SeatRow[],
): RequisitionProps => ({
  id: row.id,
  tenantId: row.tenantId,
  ticketNo: row.ticketNo,
  title: row.title,
  projectId: row.projectId,
  departmentId: row.departmentId,
  requesterId: row.requesterId,
  recruiterId: row.recruiterId,
  headcount: row.headcount,
  state: row.state,
  previousState: row.previousState,
  createdBy: row.createdBy,
  closeReason: row.closeReason,
  // seatNo is the seat's natural key and its order is part of the aggregate's
  // observable state. ORDER BY belongs in the query; sorting here as well makes
  // the mapper correct regardless of what the caller's SQL did.
  seats: [...seats].sort((a, b) => a.seatNo - b.seatNo).map(seatToProps),
  version: row.version,
});

export const seatToProps = (row: SeatRow): Seat => ({
  seatNo: row.seatNo,
  state: row.state,
  applicationId: row.applicationId,
  filledAt: row.filledAt,
  cancelReason: row.cancelReason,
});

export const requisitionToRow = (p: RequisitionProps): RequisitionInsert => ({
  id: p.id,
  tenantId: p.tenantId,
  ticketNo: p.ticketNo,
  title: p.title,
  projectId: p.projectId,
  departmentId: p.departmentId,
  requesterId: p.requesterId,
  recruiterId: p.recruiterId,
  createdBy: p.createdBy,
  headcount: p.headcount,
  state: p.state,
  previousState: p.previousState,
  closeReason: p.closeReason,
  version: p.version,
});

export const seatToRow = (requisitionId: number, s: Seat): SeatInsert => ({
  requisitionId,
  seatNo: s.seatNo,
  state: s.state,
  applicationId: s.applicationId,
  filledAt: s.filledAt,
  cancelReason: s.cancelReason,
});

/* ------------------------------- application ------------------------------ */

export const applicationToProps = (
  row: ApplicationRow,
  history: readonly StageHistoryRow[],
): ApplicationProps => ({
  id: row.id,
  tenantId: row.tenantId,
  applicationNo: row.applicationNo,
  candidateId: row.candidateId,
  requisitionId: row.requisitionId,
  recruiterId: row.recruiterId,
  stage: row.stage,
  previousStage: row.previousStage,
  reasons: asReasons(row.reasons),
  nextAction: row.nextAction,
  nextActionDueAt: row.nextActionDueAt,
  lastActivityAt: row.lastActivityAt,
  // Chronological, tie-broken by surrogate id. Two transitions can share a
  // timestamp to the millisecond; the insertion order is then the only truth
  // about which came first, and an append-only trail in the wrong order is a
  // corrupted audit record.
  history: [...history]
    .sort((a, b) => a.movedAt.getTime() - b.movedAt.getTime() || a.id - b.id)
    .map(stageChangeToProps),
  version: row.version,
});

export const stageChangeToProps = (row: StageHistoryRow): StageChange => ({
  fromStage: row.fromStage,
  toStage: row.toStage,
  reason: row.reason,
  trigger: row.trigger,
  actorId: row.actorId,
  actorName: row.actorName,
  movedAt: row.movedAt,
});

export const applicationToRow = (p: ApplicationProps): ApplicationInsert => ({
  id: p.id,
  tenantId: p.tenantId,
  applicationNo: p.applicationNo,
  candidateId: p.candidateId,
  requisitionId: p.requisitionId,
  recruiterId: p.recruiterId,
  stage: p.stage,
  previousStage: p.previousStage,
  reasons: p.reasons,
  nextAction: p.nextAction,
  nextActionDueAt: p.nextActionDueAt,
  lastActivityAt: p.lastActivityAt,
  version: p.version,
});

export const stageChangeToRow = (
  applicationId: number,
  c: StageChange,
): StageHistoryInsert => ({
  applicationId,
  fromStage: c.fromStage,
  toStage: c.toStage,
  reason: c.reason,
  trigger: c.trigger,
  actorId: c.actorId,
  actorName: c.actorName,
  movedAt: c.movedAt,
});
