// The reconciliation checks gate an irreversible migration, so they are tested
// exhaustively — one case per finding code, plus the clean-data case.

import { describe, expect, it } from 'vitest';
import {
  reconcile,
  type LegacyApplicationRow, type LegacyRequisitionRow,
  type LegacySeatRow, type LegacySnapshot, type FindingCode,
} from './checks.js';

/* ------------------------------- builders --------------------------------- */

function req(over: Partial<LegacyRequisitionRow> = {}): LegacyRequisitionRow {
  return {
    id: 1, ticket_no: 'REQ-2026-00001', status: 'sourcing',
    headcount: 2, headcount_filled: 0, ...over,
  };
}
function seat(over: Partial<LegacySeatRow> = {}): LegacySeatRow {
  return {
    id: 1, request_id: 1, seat_no: 1, status: 'open',
    filled_by_application_id: null, ...over,
  };
}
function app(over: Partial<LegacyApplicationRow> = {}): LegacyApplicationRow {
  return {
    id: 100, application_no: 'APP-00001', candidate_id: 42,
    request_id: 1, status: 'sourced', ...over,
  };
}
function snap(over: Partial<LegacySnapshot> = {}): LegacySnapshot {
  return { requisitions: [], seats: [], applications: [], ...over };
}
const codes = (s: LegacySnapshot): FindingCode[] => reconcile(s).findings.map((f) => f.code);

/** A requisition whose data satisfies every invariant. */
function healthy(): LegacySnapshot {
  return snap({
    requisitions: [req({ headcount: 2, headcount_filled: 1 })],
    seats: [
      seat({ id: 1, seat_no: 1, status: 'filled', filled_by_application_id: 100 }),
      seat({ id: 2, seat_no: 2, status: 'open' }),
    ],
    applications: [
      app({ id: 100, status: 'joined' }),
      app({ id: 101, application_no: 'APP-00002', candidate_id: 43, status: 'sourced' }),
    ],
  });
}

describe('reconcile — clean data', () => {
  it('reports nothing and marks the migration safe', () => {
    const report = reconcile(healthy());
    expect(report.findings).toEqual([]);
    expect(report.migrationSafe).toBe(true);
    expect(report.counts).toMatchObject({ requisitions: 1, seats: 2, applications: 2, blocking: 0 });
  });

  it('handles an entirely empty database', () => {
    const report = reconcile(snap());
    expect(report.migrationSafe).toBe(true);
    expect(report.findings).toEqual([]);
  });
});

// R2 — the finding that blocks everything downstream.
describe('reconcile — H1 seat count', () => {
  it('flags too few seat rows and suggests both remedies', () => {
    const s = snap({ requisitions: [req({ headcount: 5 })], seats: [seat()] });
    const [f] = reconcile(s).findings;
    expect(f?.code).toBe('H1_SEAT_COUNT_MISMATCH');
    expect(f?.severity).toBe('BLOCKING');
    expect(f?.detail).toMatchObject({ headcount: 5, seatRows: 1, delta: -4 });
    expect(f?.suggestedRemedy).toMatch(/Create 4 open seat/);
  });

  it('flags surplus seat rows', () => {
    const s = snap({
      requisitions: [req({ headcount: 1 })],
      seats: [seat({ id: 1, seat_no: 1 }), seat({ id: 2, seat_no: 2 })],
    });
    const [f] = reconcile(s).findings;
    expect(f?.detail).toMatchObject({ delta: 1 });
    expect(f?.suggestedRemedy).toMatch(/Remove 1 surplus/);
  });

  it('flags a missing headcount and skips the dependent checks', () => {
    const s = snap({ requisitions: [req({ headcount: null })], seats: [seat()] });
    expect(codes(s)).toEqual(['MISSING_HEADCOUNT']);
  });
});

describe('reconcile — H2 overfill', () => {
  it('flags more filled seats than headcount', () => {
    const s = snap({
      requisitions: [req({ headcount: 1, headcount_filled: 2 })],
      seats: [
        seat({ id: 1, seat_no: 1, status: 'filled', filled_by_application_id: 100 }),
        seat({ id: 2, seat_no: 2, status: 'filled', filled_by_application_id: 101 }),
      ],
      applications: [app({ id: 100, status: 'joined' }),
        app({ id: 101, candidate_id: 43, status: 'joined' })],
    });
    expect(codes(s)).toContain('H2_OVERFILLED');
  });
});

describe('reconcile — H3 seat/application binding', () => {
  it('flags a filled seat with nobody in it', () => {
    const s = snap({
      requisitions: [req({ headcount: 1 })],
      seats: [seat({ status: 'filled', filled_by_application_id: null })],
    });
    expect(codes(s)).toContain('H3_FILLED_SEAT_WITHOUT_APPLICATION');
  });

  it('flags one application occupying two seats', () => {
    const s = snap({
      requisitions: [req({ headcount: 2, headcount_filled: 2 })],
      seats: [
        seat({ id: 1, seat_no: 1, status: 'filled', filled_by_application_id: 100 }),
        seat({ id: 2, seat_no: 2, status: 'filled', filled_by_application_id: 100 }),
      ],
      applications: [app({ id: 100, status: 'joined' })],
    });
    expect(codes(s)).toContain('H3_APPLICATION_IN_TWO_SEATS');
  });
});

describe('reconcile — H4 bijection, both directions', () => {
  it('flags a hired application holding no seat', () => {
    const s = snap({
      requisitions: [req({ headcount: 1 })],
      seats: [seat({ status: 'open' })],
      applications: [app({ status: 'joined' })],
    });
    expect(codes(s)).toContain('H4_HIRED_WITHOUT_SEAT');
  });

  it('flags a seat held by someone who was never hired', () => {
    const s = snap({
      requisitions: [req({ headcount: 1, headcount_filled: 1 })],
      seats: [seat({ status: 'filled', filled_by_application_id: 100 })],
      applications: [app({ id: 100, status: 'interviewing' })],
    });
    expect(codes(s)).toContain('H4_SEAT_HOLDER_NOT_HIRED');
  });
});

describe('reconcile — H5 one filled seat per candidate', () => {
  it('flags a candidate hired on two live requisitions', () => {
    const s = snap({
      requisitions: [
        req({ id: 1, ticket_no: 'REQ-1', headcount: 1, headcount_filled: 1 }),
        req({ id: 2, ticket_no: 'REQ-2', headcount: 1, headcount_filled: 1 }),
      ],
      seats: [
        seat({ id: 1, request_id: 1, status: 'filled', filled_by_application_id: 100 }),
        seat({ id: 2, request_id: 2, status: 'filled', filled_by_application_id: 200 }),
      ],
      applications: [
        app({ id: 100, request_id: 1, candidate_id: 42, status: 'joined' }),
        app({ id: 200, request_id: 2, candidate_id: 42, application_no: 'APP-2', status: 'joined' }),
      ],
    });
    expect(codes(s)).toContain('H5_CANDIDATE_HIRED_TWICE');
  });

  // Re-hiring after a requisition closed is legitimate history, not corruption.
  it('ignores a hire on a closed requisition', () => {
    const s = snap({
      requisitions: [
        req({ id: 1, ticket_no: 'REQ-1', status: 'closed', headcount: 1, headcount_filled: 1 }),
        req({ id: 2, ticket_no: 'REQ-2', status: 'sourcing', headcount: 1, headcount_filled: 1 }),
      ],
      seats: [
        seat({ id: 1, request_id: 1, status: 'filled', filled_by_application_id: 100 }),
        seat({ id: 2, request_id: 2, status: 'filled', filled_by_application_id: 200 }),
      ],
      applications: [
        app({ id: 100, request_id: 1, candidate_id: 42, status: 'joined' }),
        app({ id: 200, request_id: 2, candidate_id: 42, application_no: 'APP-2', status: 'joined' }),
      ],
    });
    expect(codes(s)).not.toContain('H5_CANDIDATE_HIRED_TWICE');
  });
});

describe('reconcile — constraints the new schema will enforce', () => {
  it('flags two live applications for the same candidate and requisition', () => {
    const s = snap({
      requisitions: [req({ headcount: 2 })],
      seats: [seat({ id: 1, seat_no: 1 }), seat({ id: 2, seat_no: 2 })],
      applications: [
        app({ id: 100, candidate_id: 42, status: 'sourced' }),
        app({ id: 101, candidate_id: 42, application_no: 'APP-2', status: 'interviewing' }),
      ],
    });
    expect(codes(s)).toContain('DUPLICATE_LIVE_APPLICATION');
  });

  it('allows a re-application after a terminal outcome', () => {
    const s = snap({
      requisitions: [req({ headcount: 2 })],
      seats: [seat({ id: 1, seat_no: 1 }), seat({ id: 2, seat_no: 2 })],
      applications: [
        app({ id: 100, candidate_id: 42, status: 'rejected' }),
        app({ id: 101, candidate_id: 42, application_no: 'APP-2', status: 'sourced' }),
      ],
    });
    expect(codes(s)).not.toContain('DUPLICATE_LIVE_APPLICATION');
  });

  it('flags duplicate ticket and application numbers', () => {
    const s = snap({
      requisitions: [
        req({ id: 1, ticket_no: 'REQ-DUP', headcount: 1 }),
        req({ id: 2, ticket_no: 'REQ-DUP', headcount: 1 }),
      ],
      seats: [seat({ id: 1, request_id: 1 }), seat({ id: 2, request_id: 2 })],
      applications: [
        app({ id: 100, application_no: 'APP-DUP', request_id: 1 }),
        app({ id: 101, application_no: 'APP-DUP', request_id: 2, candidate_id: 43 }),
      ],
    });
    expect(codes(s).filter((c) => c === 'DUPLICATE_BUSINESS_NUMBER')).toHaveLength(2);
  });
});

describe('reconcile — vocabulary', () => {
  it('flags a requisition status with no canonical mapping', () => {
    const s = snap({
      requisitions: [req({ status: 'awaiting_moon_phase', headcount: 1 })],
      seats: [seat()],
    });
    expect(codes(s)).toContain('UNMAPPED_REQUISITION_STATUS');
  });

  it('flags an application stage with no canonical mapping', () => {
    const s = snap({
      requisitions: [req({ headcount: 1 })],
      seats: [seat()],
      applications: [app({ status: 'vibes_check' })],
    });
    expect(codes(s)).toContain('UNMAPPED_APPLICATION_STAGE');
  });

  it('accepts every legacy value the alias maps already cover', () => {
    const legacy = ['draft', 'pending_approval', 'sourcing', 'in_progress',
      'partially_filled', 'filled', 'closed', 'on_hold', 'reopened', 'expired'];
    const s = snap({
      requisitions: legacy.map((status, i) =>
        req({ id: i + 1, ticket_no: `REQ-${i}`, status, headcount: 1, headcount_filled: 0 })),
      seats: legacy.map((_, i) => seat({ id: i + 1, request_id: i + 1 })),
    });
    expect(codes(s)).not.toContain('UNMAPPED_REQUISITION_STATUS');
  });
});

describe('reconcile — referential integrity', () => {
  it('flags a seat pointing at a non-existent application', () => {
    const s = snap({
      requisitions: [req({ headcount: 1, headcount_filled: 1 })],
      seats: [seat({ status: 'filled', filled_by_application_id: 999 })],
    });
    expect(codes(s)).toContain('ORPHAN_SEAT_APPLICATION');
  });

  it('flags an application pointing at a non-existent requisition', () => {
    const s = snap({ applications: [app({ request_id: 999 })] });
    expect(codes(s)).toContain('ORPHAN_APPLICATION_REQUISITION');
  });
});

describe('reconcile — reporting', () => {
  it('treats headcount_filled drift as a warning, not a blocker', () => {
    const s = healthy();
    const drifted = snap({ ...s, requisitions: [req({ headcount: 2, headcount_filled: 99 })] });
    const report = reconcile(drifted);
    expect(report.byCode['HEADCOUNT_FILLED_DRIFT']).toBe(1);
    expect(report.migrationSafe).toBe(true); // the new model derives it
  });

  it('blocks the migration when anything blocking is present', () => {
    const s = snap({ requisitions: [req({ headcount: 5 })], seats: [seat()] });
    const report = reconcile(s);
    expect(report.migrationSafe).toBe(false);
    expect(report.counts.blocking).toBeGreaterThan(0);
  });

  it('gives every finding a message, remedy and detail', () => {
    const s = snap({
      requisitions: [req({ headcount: 5, status: 'nonsense' })],
      seats: [seat({ status: 'filled', filled_by_application_id: 999 })],
      applications: [app({ request_id: 42, status: 'joined' })],
    });
    const report = reconcile(s);
    expect(report.findings.length).toBeGreaterThan(3);
    for (const f of report.findings) {
      expect(f.message.length, f.code).toBeGreaterThan(10);
      expect(f.suggestedRemedy.length, f.code).toBeGreaterThan(10);
      expect(f.detail, f.code).toBeTypeOf('object');
    }
  });
});
