// Mapper round-trip tests — pure, no database.
//
// The property asserted is IDENTITY: for any state an aggregate can produce,
//
//     toProps(toRow(state), childRows) === state
//
// Example-based tests miss the field that was simply forgotten in one direction.
// Generating states from randomised sequences of REAL aggregate operations
// covers combinations nobody would think to write by hand — and it is how the
// `adjustHeadcount` mutate-before-validate bug was found in Phase 2.5.

import { describe, expect, it } from 'vitest';
import { Requisition } from '../domain/requisition.js';
import { Application } from '../domain/application.js';
import type { ApplicationStage } from '../domain/stages.js';
import type { Actor } from '../../shared/kernel/domain.js';
import {
  applicationToProps, applicationToRow, requisitionToProps, requisitionToRow,
  seatToRow, stageChangeToRow,
} from './mappers.js';
import type { ApplicationRow, RequisitionRow, SeatRow, StageHistoryRow } from './mappers.js';

const ACTOR: Actor = { id: 7, name: 'Mona Adel' };

/** mulberry32 — small, fast, deterministic. Same generator as the domain tests. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Simulate the columns the database supplies that the props do not carry.
 *
 * `createdAt`/`updatedAt` are storage bookkeeping and are deliberately absent
 * from every `*Props` interface: the domain has no opinion about them, so
 * round-tripping must not depend on them.
 */
const asRequisitionRow = (insert: ReturnType<typeof requisitionToRow>): RequisitionRow => ({
  ...insert,
  recruiterId: insert.recruiterId ?? null,
  previousState: insert.previousState ?? null,
  closeReason: insert.closeReason ?? null,
  version: insert.version ?? 0,
  tenantId: insert.tenantId ?? 1,
  id: insert.id ?? 0,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
});

const asSeatRows = (requisitionId: number, seats: ReturnType<Requisition['toState']>['seats']): SeatRow[] =>
  seats.map((s, i) => {
    const row = seatToRow(requisitionId, s);
    return {
      ...row,
      id: i + 1,
      applicationId: row.applicationId ?? null,
      filledAt: row.filledAt ?? null,
      cancelReason: row.cancelReason ?? null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
  });

const asApplicationRow = (insert: ReturnType<typeof applicationToRow>): ApplicationRow => ({
  ...insert,
  recruiterId: insert.recruiterId ?? null,
  previousStage: insert.previousStage ?? null,
  nextAction: insert.nextAction ?? null,
  nextActionDueAt: insert.nextActionDueAt ?? null,
  lastActivityAt: (insert.lastActivityAt as Date | undefined) ?? new Date(0),
  reasons: insert.reasons ?? {},
  version: insert.version ?? 0,
  tenantId: insert.tenantId ?? 1,
  id: insert.id ?? 0,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
});

const asHistoryRows = (
  applicationId: number,
  history: ReturnType<Application['toState']>['history'],
): StageHistoryRow[] => history.map((c, i) => {
  const row = stageChangeToRow(applicationId, c);
  return {
    ...row,
    id: i + 1,
    fromStage: row.fromStage ?? null,
    reason: row.reason ?? null,
    actorId: row.actorId ?? null,
    actorName: row.actorName ?? null,
  };
});

/* ------------------------------- requisition ------------------------------ */

const newRequisition = (headcount: number): Requisition => Requisition.create({
  id: 11, tenantId: 1, ticketNo: 'REQ-2026-00011', title: 'Site Engineer',
  projectId: 3, departmentId: 4, requesterId: 7, headcount, createdBy: 7,
});

describe('requisition mapper', () => {
  it('round-trips a freshly created requisition', () => {
    const state = newRequisition(2).toState();
    const restored = requisitionToProps(
      asRequisitionRow(requisitionToRow(state)),
      asSeatRows(state.id, state.seats),
    );
    expect(restored).toEqual(state);
  });

  it('round-trips every state reachable by a random operation sequence', () => {
    for (const seed of [1, 7, 42, 1337, 90_210, 2026]) {
      const rand = prng(seed);
      const r = newRequisition(1 + Math.floor(rand() * 4));
      r.submit(ACTOR, { approvalRequired: false });
      r.assignRecruiter(21, ACTOR);

      let nextApplicationId = 100;
      for (let step = 0; step < 40; step += 1) {
        const pick = Math.floor(rand() * 5);
        try {
          if (pick === 0) r.adjustHeadcount(1 + Math.floor(rand() * 6), ACTOR);
          else if (pick === 1) r.fillSeat(nextApplicationId++, ACTOR);
          else if (pick === 2 && r.filledCount > 0) {
            const filled = r.seats.find((s) => s.state === 'FILLED');
            if (filled?.applicationId != null) r.releaseSeat(filled.applicationId, 'declined', ACTOR);
          } else if (pick === 3) r.hold(ACTOR, 'budget freeze');
          else if (pick === 4) r.resume(ACTOR);
        } catch {
          // A rejected operation is a valid outcome, not a test failure. What
          // matters is that whatever state we land in still round-trips.
        }

        const state = r.toState();
        const restored = requisitionToProps(
          asRequisitionRow(requisitionToRow(state)),
          // Deliberately shuffled: the mapper must impose seat order itself
          // rather than trust the caller's ORDER BY.
          [...asSeatRows(state.id, state.seats)].reverse(),
        );
        expect(restored, `seed ${seed} step ${step}`).toEqual(state);
      }
    }
  });

  it('preserves a cancelled seat with its reason', () => {
    const r = newRequisition(3);
    r.submit(ACTOR, { approvalRequired: false });
    r.assignRecruiter(21, ACTOR);
    r.adjustHeadcount(1, ACTOR);
    const state = r.toState();
    const restored = requisitionToProps(
      asRequisitionRow(requisitionToRow(state)),
      asSeatRows(state.id, state.seats),
    );
    expect(restored.seats).toEqual(state.seats);
  });
});

/* ------------------------------- application ------------------------------ */

const newApplication = (): Application => Application.create({
  id: 31, tenantId: 1, applicationNo: 'APP-00031', candidateId: 501,
  requisitionId: 11, recruiterId: 7, stage: 'SOURCED', actor: ACTOR,
});

describe('application mapper', () => {
  it('round-trips a freshly created application with its opening history entry', () => {
    const state = newApplication().toState();
    const restored = applicationToProps(
      asApplicationRow(applicationToRow(state)),
      asHistoryRows(state.id, state.history),
    );
    expect(restored).toEqual(state);
  });

  it('round-trips every state reachable by a random transition sequence', () => {
    const stages: readonly [ApplicationStage, 'MANUAL' | 'SYSTEM'][] = [
      ['MATCHED', 'MANUAL'], ['INTERVIEWING', 'MANUAL'], ['OFFER_PREPARATION', 'MANUAL'],
      ['OFFER_SENT', 'SYSTEM'], ['HIRED', 'SYSTEM'], ['ON_HOLD', 'MANUAL'],
      ['NOT_SUITABLE', 'MANUAL'], ['REJECTED', 'MANUAL'], ['WITHDRAWN', 'MANUAL'],
    ];

    for (const seed of [3, 17, 99, 4321, 88_888]) {
      const rand = prng(seed);
      const a = newApplication();

      for (let step = 0; step < 30; step += 1) {
        try {
          if (rand() < 0.2) {
            a.setNextAction('call the candidate', new Date('2026-04-01T09:00:00.000Z'), ACTOR);
          } else if (rand() < 0.1) {
            a.resume(ACTOR);
          } else {
            const entry = stages[Math.floor(rand() * stages.length)];
            if (entry) a.transitionTo(entry[0], ACTOR, { trigger: entry[1], reason: 'because' });
          }
        } catch {
          // Illegal transitions are expected; the state must still round-trip.
        }

        const state = a.toState();
        const restored = applicationToProps(
          asApplicationRow(applicationToRow(state)),
          asHistoryRows(state.id, state.history),
        );
        expect(restored, `seed ${seed} step ${step}`).toEqual(state);
      }
    }
  });

  it('keeps the reasons bag intact through jsonb', () => {
    const a = newApplication();
    a.transitionTo('NOT_SUITABLE', ACTOR, { trigger: 'MANUAL', reason: 'no site experience' });
    const state = a.toState();
    const restored = applicationToProps(
      asApplicationRow(applicationToRow(state)),
      asHistoryRows(state.id, state.history),
    );
    expect(restored.reasons).toEqual(state.reasons);
    expect(Object.keys(restored.reasons).length).toBeGreaterThan(0);
  });

  it('treats a null reasons column as an empty bag, not as a crash', () => {
    const state = newApplication().toState();
    const row = { ...asApplicationRow(applicationToRow(state)), reasons: null };
    expect(applicationToProps(row, []).reasons).toEqual({});
  });

  it('orders history by time, tie-broken by insertion id', () => {
    const sameInstant = new Date('2026-03-01T09:00:00.000Z');
    const rows: StageHistoryRow[] = [
      { id: 2, applicationId: 31, fromStage: 'SOURCED', toStage: 'MATCHED', reason: null, trigger: 'MANUAL', actorId: 7, actorName: 'Mona', movedAt: sameInstant },
      { id: 1, applicationId: 31, fromStage: null, toStage: 'SOURCED', reason: null, trigger: 'MANUAL', actorId: 7, actorName: 'Mona', movedAt: sameInstant },
    ];
    const state = newApplication().toState();
    const restored = applicationToProps(asApplicationRow(applicationToRow(state)), rows);
    // Two transitions can share a millisecond. Insertion order is then the only
    // truth about which came first, and an audit trail in the wrong order is a
    // corrupted record.
    expect(restored.history.map((h) => h.toStage)).toEqual(['SOURCED', 'MATCHED']);
  });
});
