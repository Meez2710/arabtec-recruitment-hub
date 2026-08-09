// BL-27 — read-only detection of candidates holding more than one `joined`
// application. Kept out of the route, out of the join path, and out of any
// repair logic on purpose.
//
// WHY READ-ONLY IS THE WHOLE POINT
//   Picking which of two joined applications is "the real one" is a decision
//   about a person's employment. It depends on payroll, contracts and the
//   requisition each seat was funded from — none of which live in this database.
//   A helper that silently kept the lowest id would look like a fix and would
//   quietly discard the correct record half the time. So: report, never repair.
//
// NO PII. The output carries candidate/application/request IDs and counts only —
// never names, emails, phones or salary. It is safe to paste into a ticket, and
// safe to run against staging or production with a read-only role.
//
// WHY `status='joined'` IS AN EXACT TEST, NOT AN APPROXIMATION
//   `joined` is the only key in APP_ALIAS that resolves to APP.JOINED — the
//   aliases that could be mistaken for it (`offer_accepted`) resolve to
//   `offer_sent`, and `withdrawn` resolves to `rejected`. So the literal
//   comparison below finds every joined application and nothing else, on a
//   migrated or an unmigrated database alike. BL-22 alias cleanup does not
//   change that and is out of scope here.

import { get, all } from './db.js';
import { APP } from './stages.js';

/**
 * The partial unique index that carries the rule in the database.
 *
 * Declared here rather than in schema.js because three things must agree on the
 * name: the bootstrap that creates it, the error translator that recognises its
 * violation, and the tests that assert it exists. This module is the one they
 * can all import without dragging in the route layer.
 */
export const JOINED_UNIQUE_INDEX = 'ux_application_one_joined_per_candidate';

/** Identical DDL on PostgreSQL and SQLite; both support partial indexes. */
export const JOINED_UNIQUE_INDEX_SQL =
  `CREATE UNIQUE INDEX IF NOT EXISTS ${JOINED_UNIQUE_INDEX} `
  + `ON application(candidate_id) WHERE status='${APP.JOINED}'`;

/**
 * Candidates with more than one joined application, worst first.
 *
 * @returns {{candidateId:number, applicationIds:number[], requestIds:number[], count:number}[]}
 */
export function duplicateJoinedCandidates() {
  const groups = all(
    `SELECT candidate_id, COUNT(*) c FROM application
      WHERE status=? GROUP BY candidate_id HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC, candidate_id`,
    [APP.JOINED],
  );
  return groups.map((g) => {
    const rows = all(
      'SELECT id, request_id FROM application WHERE candidate_id=? AND status=? ORDER BY id',
      [g.candidate_id, APP.JOINED],
    );
    return {
      candidateId: Number(g.candidate_id),
      applicationIds: rows.map((r) => Number(r.id)),
      requestIds: rows.map((r) => Number(r.request_id)),
      count: Number(g.c),
    };
  });
}

/** Total joined applications held by one candidate. Read-only. */
export function joinedCount(candidateId) {
  return Number(get(
    'SELECT COUNT(*) c FROM application WHERE candidate_id=? AND status=?',
    [candidateId, APP.JOINED],
  ).c);
}

/**
 * One line per conflicted candidate, for a boot log or an operator console.
 * Deliberately ID-only so it can be copied into a ticket unredacted.
 */
export function formatDuplicateJoined(dupes) {
  return dupes.map((d) => `candidate ${d.candidateId}: ${d.count} joined applications `
    + `(applications ${d.applicationIds.join(',')} on requests ${d.requestIds.join(',')})`);
}
