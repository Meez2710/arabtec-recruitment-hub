// Property-based invariant test.
//
// Drives long random sequences of VALID operations against a requisition and
// asserts H1-H3 after every single step. This is the test that would have caught
// BL-03 (hire with no seat), BL-21 (headcount edit not reconciling seats) and
// BL-23 (seat never released) before any of them shipped.
//
// The PRNG is seeded so a failure is reproducible from the seed printed below.

import { describe, expect, it } from 'vitest';
import { Requisition, type Actor } from './requisition.js';
import { DomainError } from './errors.js';

const REQUESTER: Actor = { id: 10, name: 'Requester' };
const ADMIN: Actor = { id: 20, name: 'Admin' };

/** mulberry32 — small, fast, deterministic. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assertInvariants(r: Requisition): void {
  const seats = r.seats;

  // H1 — seat rows always equal headcount.
  expect(seats.length, 'H1: seats == headcount').toBe(r.headcount);

  // H2 — filled never exceeds headcount.
  expect(r.filledCount, 'H2: filled <= headcount').toBeLessThanOrEqual(r.headcount);

  // H3 — every filled seat carries exactly one application, no duplicates.
  const filled = seats.filter((s) => s.state === 'FILLED');
  for (const seat of filled) {
    expect(seat.applicationId, `H3: seat ${seat.seatNo} filled without an application`).not.toBeNull();
  }
  const ids = filled.map((s) => s.applicationId);
  expect(new Set(ids).size, 'H3: an application occupies two seats').toBe(ids.length);

  // Derived state must agree with the seats it is derived from.
  const expected =
    r.filledCount <= 0 ? 'UNFILLED'
    : r.filledCount >= r.headcount ? 'FULLY_FILLED'
    : 'PARTIALLY_FILLED';
  expect(r.fillState, 'derived fill state disagrees with seats').toBe(expected);
}

type Op = 'fill' | 'release' | 'grow' | 'shrink' | 'hold' | 'resume' | 'close' | 'reopen';
const OPS: Op[] = ['fill', 'release', 'grow', 'shrink', 'hold', 'resume', 'close', 'reopen'];

describe('Headcount invariants H1-H3 under random operation sequences', () => {
  const SEEDS = [1, 7, 42, 1337, 90210, 2026];

  it.each(SEEDS)('holds across 200 operations (seed %i)', (seed) => {
    const rand = prng(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

    const r = Requisition.create({
      id: 1, tenantId: 1, ticketNo: 'REQ-2026-00001', title: 'Site Engineer',
      projectId: 1, departmentId: 1, requesterId: REQUESTER.id,
      headcount: 1 + Math.floor(rand() * 5), createdBy: REQUESTER.id,
    });
    r.submit(REQUESTER, { approvalRequired: false });
    r.assignRecruiter(99, ADMIN);
    assertInvariants(r);

    // Applications the harness believes are currently occupying seats.
    const hired = new Set<number>();
    let nextAppId = 1000;

    for (let step = 0; step < 200; step += 1) {
      const op = pick(OPS);
      try {
        switch (op) {
          case 'fill': {
            const appId = nextAppId++;
            r.fillSeat(appId, ADMIN);
            hired.add(appId);
            break;
          }
          case 'release': {
            const [appId] = [...hired];
            if (appId === undefined) break;
            r.releaseSeat(appId, 'reversed', ADMIN);
            hired.delete(appId);
            break;
          }
          case 'grow':
            r.adjustHeadcount(r.headcount + 1 + Math.floor(rand() * 3), ADMIN);
            break;
          case 'shrink':
            r.adjustHeadcount(Math.max(1, r.headcount - 1 - Math.floor(rand() * 2)), ADMIN);
            break;
          case 'hold':
            r.hold(ADMIN, 'paused');
            break;
          case 'resume':
            r.resume(ADMIN);
            break;
          case 'close':
            r.close(ADMIN, 'closing');
            break;
          case 'reopen':
            r.reopen(ADMIN, 'restarting', 1 + Math.floor(rand() * 3));
            break;
        }
      } catch (err) {
        // Rejecting an illegal operation is correct behaviour. Any error that is
        // NOT a domain error is a real defect and must fail the test.
        if (!(err instanceof DomainError)) throw err;
      }

      // The invariant must hold after every step, accepted or rejected.
      assertInvariants(r);
    }

    // The harness's view of who holds a seat must match the aggregate's.
    const seatApps = new Set(
      r.seats.filter((s) => s.state === 'FILLED').map((s) => s.applicationId!),
    );
    expect(seatApps, 'harness and aggregate disagree on filled seats').toEqual(hired);
  });

  it('never lets a rejected operation leave partial state behind', () => {
    const r = Requisition.create({
      id: 1, tenantId: 1, ticketNo: 'REQ-1', title: 'X',
      projectId: 1, departmentId: 1, requesterId: 1, headcount: 2, createdBy: 1,
    });
    r.submit(REQUESTER, { approvalRequired: false });
    r.assignRecruiter(99, ADMIN);
    r.fillSeat(101, ADMIN);
    r.fillSeat(102, ADMIN);

    const before = JSON.stringify(r.toState());
    expect(() => r.fillSeat(103, ADMIN)).toThrow();      // no open seat
    expect(() => r.adjustHeadcount(1, ADMIN)).toThrow(); // below filled
    expect(JSON.stringify(r.toState())).toBe(before);
  });
});
