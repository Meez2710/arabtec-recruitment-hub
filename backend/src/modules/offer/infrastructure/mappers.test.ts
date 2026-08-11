// Offer mapper tests — pure, no database.
//
// Money is the whole point of this file. `numeric` crosses the wire as a
// STRING; every assertion below checks the TYPE as well as the value, because
// the failure mode is silent: string concatenation produces a plausible-looking
// figure and nothing throws.

import { describe, expect, it } from 'vitest';
import { Offer } from '../domain/offer.js';
import type { Actor } from '../../shared/kernel/domain.js';
import {
  compensationLineToRow, offerToProps, offerToRow,
} from './mappers.js';
import type { CompensationLineRow, OfferRow } from './mappers.js';
import { MoneyPrecisionError, toNumber, toNumericString } from '../../../infrastructure/db/numeric.js';

const ACTOR: Actor = { id: 7, name: 'Mona Adel' };
const COMPONENTS = ['BASIC_SALARY', 'ACCOMMODATION', 'TRANSPORTATION', 'OTHERS', 'AREA_ALLOWANCE'];

const asOfferRow = (insert: ReturnType<typeof offerToRow>): OfferRow => ({
  ...insert,
  id: insert.id ?? 0,
  tenantId: insert.tenantId ?? 1,
  joiningDate: insert.joiningDate ?? null,
  approvedBy: insert.approvedBy ?? null,
  requiresDirectorApproval: insert.requiresDirectorApproval ?? false,
  sentAt: insert.sentAt ?? null,
  expiresAt: insert.expiresAt ?? null,
  decidedAt: insert.decidedAt ?? null,
  reason: insert.reason ?? null,
  templateCode: insert.templateCode ?? null,
  templateVersion: insert.templateVersion ?? null,
  variableSnapshot: insert.variableSnapshot ?? null,
  version: insert.version ?? 0,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
});

const asLineRows = (
  offerId: number,
  lines: ReturnType<Offer['toState']>['lines'],
): CompensationLineRow[] => lines.map((l, i) => ({
  ...compensationLineToRow(offerId, l),
  id: i + 1,
}));

const draft = (lines: readonly { componentCode: string; amount: number }[]): Offer =>
  Offer.draft({
    id: 51, tenantId: 1, offerNo: 'OFR-2026-00051',
    applicationId: 31, candidateId: 501, requisitionId: 11,
    positionTitle: 'Site Engineer', currency: 'EGP',
    lines, joiningDate: new Date('2026-05-01T00:00:00.000Z'),
    knownComponents: COMPONENTS, actor: ACTOR,
  });

describe('offer mapper', () => {
  it('round-trips a draft offer', () => {
    const state = draft([
      { componentCode: 'BASIC_SALARY', amount: 12_500.5 },
      { componentCode: 'TRANSPORTATION', amount: 1_250.25 },
    ]).toState();

    const restored = offerToProps(
      asOfferRow(offerToRow(state)),
      // Shuffled — the mapper imposes its own stable order.
      [...asLineRows(state.id, state.lines)].reverse(),
    );
    expect(restored).toEqual(state);
  });

  it('round-trips a fully issued offer including the pinned template', () => {
    const o = draft([{ componentCode: 'BASIC_SALARY', amount: 20_000 }]);
    o.submit({ directorThreshold: null, thresholdCurrency: 'EGP' }, ACTOR);
    o.approve({ id: 42, name: 'Director' }, { hasDirectorAuthority: true });
    o.send({
      templateCode: 'OFFER_LETTER_EN', templateVersion: 3,
      variableSnapshot: { candidateName: 'Ahmed', nested: { ok: true } },
      validityDays: 5, now: new Date('2026-03-10T09:00:00.000Z'), actor: ACTOR,
    });

    const state = o.toState();
    const restored = offerToProps(asOfferRow(offerToRow(state)), asLineRows(state.id, state.lines));
    expect(restored).toEqual(state);
    expect(restored.variableSnapshot).toMatchObject({ nested: { ok: true } });
  });

  it('returns amounts as numbers so the total is arithmetic, not concatenation', () => {
    const state = draft([
      { componentCode: 'BASIC_SALARY', amount: 12_500.5 },
      { componentCode: 'TRANSPORTATION', amount: 1_250.25 },
    ]).toState();

    const restored = offerToProps(asOfferRow(offerToRow(state)), asLineRows(state.id, state.lines));
    for (const line of restored.lines) expect(typeof line.amount).toBe('number');

    const rebuilt = Offer.fromState(restored);
    expect(rebuilt.totalNet).toBeCloseTo(13_750.75, 2);
    // The bug this guards: "12500.50" + "1250.25" = "12500.501250.25".
    expect(String(rebuilt.totalNet)).not.toContain('12500.501250');
  });

  it('encodes no ratio between components — every amount is independent', () => {
    // The 40/30/30 pattern in the sample letters was explicitly rejected as
    // company policy. Arbitrary, unrelated amounts must survive untouched.
    const state = draft([
      { componentCode: 'BASIC_SALARY', amount: 9_999.99 },
      { componentCode: 'ACCOMMODATION', amount: 1 },
      { componentCode: 'AREA_ALLOWANCE', amount: 0 },
    ]).toState();

    const restored = offerToProps(asOfferRow(offerToRow(state)), asLineRows(state.id, state.lines));
    expect(restored.lines.map((l) => l.amount).sort((a, b) => a - b)).toEqual([0, 1, 9_999.99]);
  });

  it('treats a null variable snapshot as null, not as an empty object', () => {
    const state = draft([{ componentCode: 'BASIC_SALARY', amount: 1_000 }]).toState();
    const row = { ...asOfferRow(offerToRow(state)), variableSnapshot: null };
    // A draft that was never issued has NO snapshot. Defaulting to `{}` would
    // make an un-pinned offer look pinned-with-nothing.
    expect(offerToProps(row, []).variableSnapshot).toBeNull();
  });
});

describe('numeric conversion', () => {
  it('parses the canonical two-decimal text the column stores', () => {
    expect(toNumber('12500.50')).toBe(12_500.5);
    expect(toNumber('0.00')).toBe(0);
    expect(toNumber('-1250.25')).toBe(-1_250.25);
  });

  it('emits canonical two-decimal text so a round-trip is byte-stable', () => {
    expect(toNumericString(12_500.5)).toBe('12500.50');
    expect(toNumericString(0)).toBe('0.00');
    expect(toNumericString(1_250.255)).toBe('1250.26');
  });

  it('accepts a number unchanged, for drivers that already parsed it', () => {
    expect(toNumber(1_234.56)).toBe(1_234.56);
  });

  it('treats a null amount as zero', () => {
    expect(toNumber(null)).toBe(0);
  });

  it('accepts the entire numeric(14,2) range exactly', () => {
    // Worth stating plainly: the widest value the column can hold is
    // 999999999999.99, which is 99_999_999_999_999 minor units — comfortably
    // inside Number.MAX_SAFE_INTEGER. At the CURRENT precision no legal value
    // can lose exactness, so the guard below never fires in production today.
    expect(toNumber('999999999999.99')).toBe(999_999_999_999.99);
    expect(toNumber('-999999999999.99')).toBe(-999_999_999_999.99);
  });

  it('refuses to silently round a value it cannot represent exactly', () => {
    // Defence in depth for the day someone widens the column or a corrupt row
    // is read. A silently rounded salary on a signed letter cannot be fixed
    // after the fact; a failed read can.
    expect(() => toNumber('99999999999999999.99')).toThrow(MoneyPrecisionError);
    expect(() => toNumber('not a number')).toThrow(MoneyPrecisionError);
    expect(() => toNumericString(Number.POSITIVE_INFINITY)).toThrow(MoneyPrecisionError);
    expect(() => toNumericString(Number.NaN)).toThrow(MoneyPrecisionError);
  });
});
