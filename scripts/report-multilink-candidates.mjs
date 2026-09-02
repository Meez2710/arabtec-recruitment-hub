// Read-only report: candidates with more than one application on a NON-TERMINAL
// recruitment request (i.e. actively linked to several open reqs at once).
//
//   node --experimental-sqlite scripts/report-multilink-candidates.mjs
//
// Uses the app's own tri-modal DB layer, so it honours DATABASE_URL (Postgres in
// production) and otherwise opens backend/data/arabtec.db. SELECT only — this
// script performs NO INSERT / UPDATE / DELETE / DDL.

import { all } from '../backend/src/lib/db.js';

// Matches the request-terminal set used by POST /applications (routes/applications.js).
const TERMINAL = ['closed', 'cancelled', 'rejected', 'filled'];

const rows = all(
  `SELECT a.candidate_id      AS candidate_id,
          c.candidate_no      AS candidate_no,
          c.full_name         AS full_name,
          r.id               AS request_id,
          r.ticket_no        AS ticket_no,
          r.title            AS title,
          r.status           AS req_status
     FROM application a
     JOIN recruitment_request r ON r.id = a.request_id
     JOIN candidate c ON c.id = a.candidate_id
    WHERE r.status NOT IN (${TERMINAL.map(() => '?').join(',')})
    ORDER BY a.candidate_id, r.id`,
  TERMINAL,
);

// Group in JS (avoids GROUP_CONCAT / string_agg engine differences).
const byCandidate = new Map();
for (const row of rows) {
  if (!byCandidate.has(row.candidate_id)) {
    byCandidate.set(row.candidate_id, {
      candidateId: row.candidate_id,
      candidateNo: row.candidate_no,
      fullName: row.full_name,
      reqs: [],
    });
  }
  byCandidate.get(row.candidate_id).reqs.push({
    ticketNo: row.ticket_no || `REQ-${row.request_id}`,
    title: row.title || '(untitled)',
    status: row.req_status,
  });
}

const offenders = [...byCandidate.values()]
  .filter((x) => x.reqs.length > 1)
  .sort((a, b) => b.reqs.length - a.reqs.length || a.candidateId - b.candidateId);

if (offenders.length === 0) {
  console.log('No candidates are linked to more than one non-terminal request. ✅');
  process.exit(0);
}

console.log(`Candidates on >1 non-terminal request: ${offenders.length}\n`);
const pad = (s, n) => String(s ?? '').padEnd(n);
console.log(`${pad('ID', 6)} ${pad('Candidate No', 14)} ${pad('Name', 26)} Open requests`);
console.log('-'.repeat(90));
for (const o of offenders) {
  const first = o.reqs[0];
  console.log(
    `${pad(o.candidateId, 6)} ${pad(o.candidateNo, 14)} ${pad((o.fullName || '').slice(0, 25), 26)} ` +
    `${first.ticketNo} — ${first.title} [${first.status}]`,
  );
  for (const rq of o.reqs.slice(1)) {
    console.log(`${' '.repeat(48)}${rq.ticketNo} — ${rq.title} [${rq.status}]`);
  }
}
console.log('-'.repeat(90));
console.log(`${offenders.length} candidate(s), ${offenders.reduce((s, o) => s + o.reqs.length, 0)} open links total.`);
