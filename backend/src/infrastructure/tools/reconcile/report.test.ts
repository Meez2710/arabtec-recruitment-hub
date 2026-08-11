// The report is the artifact a human acts on and the CI gate reads. Its shape
// is part of the contract, so it is pinned.

import { describe, expect, it } from 'vitest';
import { reconcile, type LegacySnapshot } from './checks.js';
import { formatCsv, formatJson, formatText } from './report.js';

const CLEAN: LegacySnapshot = {
  requisitions: [{ id: 1, ticket_no: 'REQ-1', status: 'sourcing', headcount: 1, headcount_filled: 0 }],
  seats: [{ id: 1, request_id: 1, seat_no: 1, status: 'open', filled_by_application_id: null }],
  applications: [],
};

const BROKEN: LegacySnapshot = {
  requisitions: [{ id: 1, ticket_no: 'REQ-1', status: 'sourcing', headcount: 4, headcount_filled: 9 }],
  seats: [{ id: 1, request_id: 1, seat_no: 1, status: 'open', filled_by_application_id: null }],
  applications: [{ id: 7, application_no: 'APP-7', candidate_id: 3, request_id: 1, status: 'joined' }],
};

describe('formatText', () => {
  it('states the migration is safe when nothing is wrong', () => {
    const out = formatText(reconcile(CLEAN));
    expect(out).toContain('No findings');
    expect(out).toContain('1 requisitions · 1 seats · 0 applications');
    expect(out).not.toContain('MIGRATION BLOCKED');
  });

  it('states the migration is blocked and shows every finding with its remedy', () => {
    const out = formatText(reconcile(BROKEN));
    expect(out).toContain('MIGRATION BLOCKED');
    expect(out).toContain('BY CODE');
    expect(out).toContain('H1_SEAT_COUNT_MISMATCH');
    expect(out).toContain('remedy:');
    // Blocking findings must be listed before warnings — the reader acts top-down.
    expect(out.indexOf('BLOCKING (')).toBeLessThan(out.indexOf('WARNING ('));
  });
});

describe('formatJson', () => {
  it('round-trips to the same report', () => {
    const report = reconcile(BROKEN);
    const parsed = JSON.parse(formatJson(report)) as typeof report;
    expect(parsed.migrationSafe).toBe(false);
    expect(parsed.findings).toHaveLength(report.findings.length);
    expect(parsed.counts.blocking).toBe(report.counts.blocking);
  });
});

describe('formatCsv', () => {
  it('emits a header plus one row per finding', () => {
    const report = reconcile(BROKEN);
    const rows = formatCsv(report).split('\n');
    expect(rows[0]).toBe('severity,code,entity,entity_id,message,remedy,detail');
    expect(rows).toHaveLength(report.findings.length + 1);
  });

  it('escapes quotes so a message with quotes cannot break the file', () => {
    const csv = formatCsv({
      generatedAt: 'now', counts: { requisitions: 0, seats: 0, applications: 0, blocking: 1, warnings: 0 },
      byCode: {}, migrationSafe: false,
      findings: [{
        code: 'H1_SEAT_COUNT_MISMATCH', severity: 'BLOCKING', entity: 'requisition', entityId: 1,
        message: 'He said "fix it"', detail: { a: 1 }, suggestedRemedy: 'Say "no"',
      }],
    });
    expect(csv).toContain('"He said ""fix it"""');
    expect(csv.split('\n')).toHaveLength(2);
  });

  it('produces only a header when there is nothing to report', () => {
    expect(formatCsv(reconcile(CLEAN)).split('\n')).toHaveLength(1);
  });
});
