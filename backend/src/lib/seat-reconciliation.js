// BL-21 / BL-23 — seat reconciliation, kept OUT of the route.
//
// THE INVARIANT
//   recruiting requisition → active capacity = headcount - filled commitments
//   non-recruiting one     → no NEW active capacity is created here
// Cancelled rows are kept for history, so the total seat-row count legitimately
// drifts above headcount. What must hold is ACTIVE CAPACITY, never the row total.
//
// ELIGIBILITY IS LINKAGE, NOT STATUS. `filled_by_application_id IS NOT NULL`
// means the seat carries a commitment: it is never cancelled, restored, deleted,
// renumbered or reassigned. A cancelled status alone proves nothing.
//
// SCOPE. This module only moves seats. It writes no HTTP response, changes no
// request status, resets no approvals, writes no activity or audit, and never
// touches applications or candidates. The caller owns all of that.
//
// KNOWN, DELIBERATELY NOT FIXED HERE (BL-01 / BL-13): seats are created `open`
// at requisition creation, so draft/pending/approved requisitions already expose
// active capacity via hasOpenSeat() before approval or assignment. This batch
// preserves that behaviour and only reports it — see `LIFECYCLE_PREMATURE_CAPACITY`.

import { get, all, run } from './db.js';
import { REQ_OPEN, reqNorm } from './stages.js';

/** Statuses that count as active capacity, per the existing rule in vacancy.js. */
const ACTIVE = ['open', 'reopened', 'reserved'];
const ACTIVE_SQL = "('open','reopened','reserved')";

/** Upper bound on approved headcount. Mirrors the route's existing validation. */
export const MAX_HEADCOUNT = 9999;

export class ReconcileConflict extends Error {
  constructor(message) { super(message); this.code = 'CONFLICT'; }
}

const filledCount = (requestId) => get(
  "SELECT COUNT(*) c FROM requisition_seat WHERE request_id=? AND status='filled'", [requestId],
).c;

const activeCount = (requestId) => get(
  `SELECT COUNT(*) c FROM requisition_seat WHERE request_id=? AND status IN ${ACTIVE_SQL}`, [requestId],
).c;

/** Cancelled AND unlinked — the only seats that may be reused. */
const reusable = (requestId) => all(
  `SELECT id, seat_no FROM requisition_seat
    WHERE request_id=? AND status='cancelled' AND filled_by_application_id IS NULL
    ORDER BY seat_no`, [requestId],
);

/** Active AND unlinked, highest seat_no first — the deterministic retirement order. */
const retirable = (requestId) => all(
  `SELECT id, seat_no FROM requisition_seat
    WHERE request_id=? AND status IN ${ACTIVE_SQL} AND filled_by_application_id IS NULL
    ORDER BY seat_no DESC`, [requestId],
);

const maxSeatNo = (requestId) => get(
  'SELECT COALESCE(MAX(seat_no),0) n FROM requisition_seat WHERE request_id=?', [requestId],
).n;

const append = (requestId, count, siteId, status, note) => {
  const start = maxSeatNo(requestId); // never reuse a retired identity
  for (let i = 1; i <= count; i += 1) {
    run('INSERT INTO requisition_seat (request_id,seat_no,site_id,status,cancel_reason) VALUES (?,?,?,?,?)',
      [requestId, start + i, siteId ?? null, status, status === 'cancelled' ? note : null]);
  }
};

/**
 * Move seats so active capacity matches an approved headcount.
 *
 * Call INSIDE the caller's transaction. Throws ReconcileConflict — which the
 * caller maps to 409 — rather than deciding an HTTP status itself.
 *
 * @returns {{restored:number, created:number, retired:number, deferred:boolean}}
 */
export function reconcileSeatsForHeadcount({
  requestId, newHeadcount, status, siteId = null, reason = 'headcount reduced',
}) {
  const next = Number(newHeadcount);
  if (!Number.isInteger(next) || next < 1 || next > MAX_HEADCOUNT) {
    throw new ReconcileConflict(`Headcount must be a whole number between 1 and ${MAX_HEADCOUNT}.`);
  }

  const filled = filledCount(requestId);
  if (next < filled) {
    throw new ReconcileConflict(
      `Cannot reduce headcount to ${next}: ${filled} position(s) are already filled.`,
    );
  }

  const recruiting = REQ_OPEN.includes(reqNorm(status));
  const current = activeCount(requestId);
  const out = { restored: 0, created: 0, retired: 0, deferred: false };

  // A requisition that may not recruit gains INVENTORY, not capacity: the seats
  // exist as cancelled so BL-04 reopen finds exactly them reusable, but
  // hasOpenSeat() still sees nothing while it stays closed.
  if (!recruiting) {
    const needed = next - filled;
    const have = reusable(requestId).length;
    if (needed > have) {
      out.created = needed - have;
      append(requestId, out.created, siteId, 'cancelled', 'future capacity, request not recruiting');
      out.deferred = true;
    }
    return out;
  }

  const target = next - filled;
  if (target > current) {
    let missing = target - current;
    const reuse = reusable(requestId).slice(0, missing);
    for (const seat of reuse) {
      run("UPDATE requisition_seat SET status='reopened', cancel_reason=NULL WHERE id=? AND status='cancelled' AND filled_by_application_id IS NULL", [seat.id]);
    }
    out.restored = reuse.length;
    missing -= reuse.length;
    if (missing > 0) { append(requestId, missing, siteId, 'reopened', null); out.created = missing; }
    return out;
  }

  if (target < current) {
    const excess = retirable(requestId).slice(0, current - target);
    for (const seat of excess) {
      run("UPDATE requisition_seat SET status='cancelled', cancel_reason=? WHERE id=? AND filled_by_application_id IS NULL", [reason, seat.id]);
    }
    out.retired = excess.length;
    return out;
  }

  return out; // already correct — repeating a headcount is a no-op
}

/* --------------------------- BL-23: read-only ----------------------------- */

export const ISSUE = {
  FILLED_EXCEEDS_HEADCOUNT: 'FILLED_EXCEEDS_HEADCOUNT',
  ACTIVE_CAPACITY_SHORTAGE: 'ACTIVE_CAPACITY_SHORTAGE',
  ACTIVE_CAPACITY_EXCESS: 'ACTIVE_CAPACITY_EXCESS',
  DUPLICATE_SEAT_NUMBER: 'DUPLICATE_SEAT_NUMBER',
  FILLED_SEAT_WITHOUT_LINK: 'FILLED_SEAT_WITHOUT_LINK',
  LINKED_SEAT_IN_AVAILABLE_STATUS: 'LINKED_SEAT_IN_AVAILABLE_STATUS',
  CLOSED_REQUEST_HAS_ACTIVE_CAPACITY: 'CLOSED_REQUEST_HAS_ACTIVE_CAPACITY',
  MISSING_FUTURE_CAPACITY: 'MISSING_FUTURE_CAPACITY',
  IMPOSSIBLE_SEAT_STATE: 'IMPOSSIBLE_SEAT_STATE',
  LIFECYCLE_PREMATURE_CAPACITY: 'LIFECYCLE_PREMATURE_CAPACITY',
};

const NON_RECRUITING_CLOSED = ['closed', 'cancelled', 'rejected', 'expired', 'filled'];
const PRE_RECRUITING = ['draft', 'pending', 'pending_approval', 'approved'];
const VALID_SEAT_STATUS = ['open', 'reserved', 'filled', 'cancelled', 'reopened'];

/**
 * Inspect one requisition and REPORT. It repairs nothing, by design: ambiguous
 * historical corruption is a human decision, not something to rewrite silently.
 *
 * Output carries ids and counts only — never candidate names or any other PII.
 */
export function reconciliationIssues(requestId) {
  const r = get('SELECT id, status, headcount FROM recruitment_request WHERE id=?', [requestId]);
  if (!r) return [{ code: 'REQUEST_NOT_FOUND', requestId }];

  const seats = all('SELECT id, seat_no, status, filled_by_application_id FROM requisition_seat WHERE request_id=? ORDER BY seat_no', [requestId]);
  const status = reqNorm(r.status);
  const headcount = Number(r.headcount);
  const filled = seats.filter((s) => s.status === 'filled').length;
  const active = seats.filter((s) => ACTIVE.includes(s.status)).length;
  const issues = [];
  const add = (code, detail) => issues.push({ code, requestId, ...detail });

  if (filled > headcount) add(ISSUE.FILLED_EXCEEDS_HEADCOUNT, { filled, headcount });

  const dupes = seats.map((s) => s.seat_no)
    .filter((no, i, arr) => arr.indexOf(no) !== i);
  if (dupes.length) add(ISSUE.DUPLICATE_SEAT_NUMBER, { seatNos: [...new Set(dupes)] });

  for (const s of seats) {
    if (s.status === 'filled' && s.filled_by_application_id === null) {
      add(ISSUE.FILLED_SEAT_WITHOUT_LINK, { seatId: s.id, seatNo: s.seat_no });
    }
    if (ACTIVE.includes(s.status) && s.filled_by_application_id !== null) {
      add(ISSUE.LINKED_SEAT_IN_AVAILABLE_STATUS, { seatId: s.id, seatNo: s.seat_no, seatStatus: s.status });
    }
    if (!VALID_SEAT_STATUS.includes(s.status)) {
      add(ISSUE.IMPOSSIBLE_SEAT_STATE, { seatId: s.id, seatNo: s.seat_no, seatStatus: s.status });
    }
  }

  if (REQ_OPEN.includes(status)) {
    const expected = Math.max(headcount - filled, 0);
    if (active < expected) add(ISSUE.ACTIVE_CAPACITY_SHORTAGE, { active, expected });
    if (active > expected) add(ISSUE.ACTIVE_CAPACITY_EXCESS, { active, expected });
  } else if (NON_RECRUITING_CLOSED.includes(status)) {
    if (active > 0) add(ISSUE.CLOSED_REQUEST_HAS_ACTIVE_CAPACITY, { active, status });
    const future = seats.filter((s) => s.status === 'cancelled' && s.filled_by_application_id === null).length;
    const needed = Math.max(headcount - filled, 0);
    if (future < needed) add(ISSUE.MISSING_FUTURE_CAPACITY, { future, needed });
  } else if (PRE_RECRUITING.includes(status) && active > 0) {
    // KNOWN AND OUT OF SCOPE for BL-21/BL-23. Seats are created `open` at
    // creation, so a requisition exposes capacity before it is approved or
    // assigned. Reported as a lifecycle warning; fixing it belongs with
    // BL-01/BL-13 and is a release blocker once those paths are enabled.
    add(ISSUE.LIFECYCLE_PREMATURE_CAPACITY, {
      active, status, relatedFindings: ['BL-01', 'BL-13'], severity: 'warning',
    });
  }

  return issues;
}
