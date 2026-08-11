// Offer context — row <-> props mappers. Pure, total, no decisions.
//
// The only non-trivial conversion in this file is money. See numeric.ts for why
// `amount` must be converted explicitly rather than trusted.

import type { offer, offerCompensationLine } from '../../../infrastructure/db/schema/index.js';
import type { CompensationLine, OfferProps } from '../domain/offer.js';
import { toNumber, toNumericString } from '../../../infrastructure/db/numeric.js';

export type OfferRow = typeof offer.$inferSelect;
export type OfferInsert = typeof offer.$inferInsert;
export type CompensationLineRow = typeof offerCompensationLine.$inferSelect;
export type CompensationLineInsert = typeof offerCompensationLine.$inferInsert;

const asSnapshot = (raw: unknown): Readonly<Record<string, unknown>> | null =>
  raw === null || raw === undefined ? null : (raw as Readonly<Record<string, unknown>>);

export const offerToProps = (
  row: OfferRow,
  lines: readonly CompensationLineRow[],
): OfferProps => ({
  id: row.id,
  tenantId: row.tenantId,
  offerNo: row.offerNo,
  applicationId: row.applicationId,
  candidateId: row.candidateId,
  requisitionId: row.requisitionId,
  positionTitle: row.positionTitle,
  currency: row.currency,
  // Ordered by component code so a reload is stable. The letter's own line order
  // comes from `offer_compensation_component.display_order`, which is
  // presentation configuration and is resolved at render time — not here.
  lines: [...lines]
    .sort((a, b) => a.componentCode.localeCompare(b.componentCode))
    .map(compensationLineToProps),
  joiningDate: row.joiningDate,
  status: row.status,
  preparedBy: row.preparedBy,
  approvedBy: row.approvedBy,
  requiresDirectorApproval: row.requiresDirectorApproval,
  sentAt: row.sentAt,
  expiresAt: row.expiresAt,
  decidedAt: row.decidedAt,
  reason: row.reason,
  templateCode: row.templateCode,
  templateVersion: row.templateVersion,
  variableSnapshot: asSnapshot(row.variableSnapshot),
  version: row.version,
});

export const compensationLineToProps = (row: CompensationLineRow): CompensationLine => ({
  componentCode: row.componentCode,
  // numeric arrives as a STRING from node-postgres. Without this the aggregate's
  // plain sum becomes string concatenation and every letter carries a nonsense
  // total, silently. See numeric.ts.
  amount: toNumber(row.amount),
});

export const offerToRow = (p: OfferProps): OfferInsert => ({
  id: p.id,
  tenantId: p.tenantId,
  offerNo: p.offerNo,
  applicationId: p.applicationId,
  candidateId: p.candidateId,
  requisitionId: p.requisitionId,
  positionTitle: p.positionTitle,
  currency: p.currency,
  joiningDate: p.joiningDate,
  status: p.status,
  preparedBy: p.preparedBy,
  approvedBy: p.approvedBy,
  requiresDirectorApproval: p.requiresDirectorApproval,
  sentAt: p.sentAt,
  expiresAt: p.expiresAt,
  decidedAt: p.decidedAt,
  reason: p.reason,
  templateCode: p.templateCode,
  templateVersion: p.templateVersion,
  variableSnapshot: p.variableSnapshot,
  version: p.version,
});

export const compensationLineToRow = (
  offerId: number,
  l: CompensationLine,
): CompensationLineInsert => ({
  offerId,
  componentCode: l.componentCode,
  amount: toNumericString(l.amount),
});
