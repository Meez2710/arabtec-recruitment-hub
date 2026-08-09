// BL-27 — the single place an application may become `joined`.
//
// THE BUSINESS RULE
//   A candidate may hold ONE joined application, globally. Not per requisition,
//   not per project, not per year. Closing the requisition does not release it;
//   a cancelled seat does not release it; a joining date in the past does not
//   release it. Employment ends when someone RECORDS that it ended, and that
//   workflow does not exist yet — so nothing in this file may infer it. Rehire
//   and admin override are deliberately absent, not merely unimplemented.
//
// WHY A MODULE AND NOT A ROUTE CHECK
//   Before this, `joined` was reachable from three route bodies — a single move,
//   a bulk move, and an offer result — each with its own partial version of the
//   write set and its own idea of what to check. A guard added to one of them
//   would have been bypassed by the other two on day one. Every path now enters
//   here, and the database carries a partial unique index underneath so that
//   even a path nobody has written yet cannot produce a second joined row.
//
// THE TRANSACTION IS THE UNIT
//   A join is not "set a status". It is a status change, a seat commitment, a
//   requisition counter, a stage-history row, two activity rows, an optional
//   thread post, an optional offer settlement and its audit trail. Half of that
//   is worse than none of it: a joined application with no seat silently
//   overfills the next hire, and a filled seat with no joined application makes
//   a requisition permanently unfillable. They commit together or not at all.

import { get, tx } from './db.js';
import { APP } from './stages.js';
import { fillSeatAndCount } from './vacancy.js';
import { JOINED_UNIQUE_INDEX } from './join-reconciliation.js';
import {
  Applications, Requests, StageHistory, CandidateActivity, RequestActivity,
  Candidates, Offers, OfferActivity, Posts,
} from './models.js';
import { writeAudit } from './audit.js';

/** Stable, client-facing conflict identity. Never contains SQL or table names. */
export const JOIN_CONFLICT = {
  ALREADY_JOINED_ELSEWHERE: 'CANDIDATE_ALREADY_JOINED',
  ALREADY_JOINED_HERE: 'APPLICATION_ALREADY_JOINED',
  NO_SEAT: 'NO_OPEN_SEAT',
};

export const ALREADY_JOINED_MESSAGE =
  'This candidate already has a joined application and cannot join another.';

export class JoinConflict extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'JoinConflict';
    this.status = 409;
    this.code = code;
    this.detail = detail;
  }
  /** Route-ready body. Carries IDs and a stable code — never driver text. */
  toBody() { return { error: this.message, code: this.code, ...this.detail }; }
}

/**
 * Deterministic failure injection for the BL-27 atomicity suite: fail
 * immediately AFTER write `n` and assert that nothing survives. Inert unless
 * FAIL_INJECT_JOIN is set, which never happens in production.
 */
function boundary(n) {
  if (process.env.FAIL_INJECT_JOIN === String(n)) {
    throw new Error(`injected failure after join write ${n}`);
  }
}

/* --------------------------- eligibility (read) --------------------------- */

/**
 * The candidate's blocking joined application, if any.
 *
 * `status='joined'` is exact: it is the only alias that resolves to APP.JOINED
 * (see join-reconciliation.js). Requisition status, seat status and dates are
 * deliberately NOT consulted — a closed requisition or a cancelled seat still
 * blocks, because neither one records that employment ended.
 */
export function blockingJoinedApplication(candidateId, exceptApplicationId = null) {
  const row = get(
    `SELECT id, request_id FROM application
      WHERE candidate_id=? AND status=? AND id<>? ORDER BY id LIMIT 1`,
    [candidateId, APP.JOINED, exceptApplicationId ?? -1],
  );
  return row ? { applicationId: Number(row.id), requestId: Number(row.request_id) } : null;
}

/**
 * Translate a raw uniqueness violation from the partial index into the domain
 * conflict. Both engines are matched by INDEX NAME first, which is exact; the
 * SQLite fallback exists because older builds report the column instead.
 *
 * Nothing from `err.message` reaches the client — only the code and the fixed
 * sentence above.
 */
export function isJoinedUniquenessViolation(err) {
  const m = String(err?.message || '');
  if (m.includes(JOINED_UNIQUE_INDEX)) return true;                       // postgres + modern sqlite
  return /UNIQUE constraint failed/i.test(m) && /application\.candidate_id/i.test(m); // sqlite fallback
}

/* ---------------------------- the transition ------------------------------ */

/**
 * Move ONE application to `joined`, with its complete write set, atomically.
 *
 * Caller responsibilities (route-level, before this): authorisation, the
 * transition legality check, and any reason validation. This function owns
 * everything that must be all-or-nothing.
 *
 * @param {object}  o
 * @param {object}  o.app           application row as read by the caller
 * @param {object}  o.req           express request (actor, ip, user-agent)
 * @param {string?} o.reason        free-text reason recorded on the stage move
 * @param {object?} o.offer         offer row when joining via an offer result
 * @param {boolean} o.postToThread  post a system message to the request thread
 * @returns {{filled:number, newStatus:string, application:object}}
 * @throws  {JoinConflict} 409-shaped, with a stable code
 */
export function joinApplication({ app, req, reason = null, offer = null, postToThread = false }) {
  const actor = req.user;
  const fromStatus = app.status;

  return tx(() => {
    // 1. RECHECK inside the transaction. The route's pre-check is a courtesy
    //    that produces a good error message; this one is the decision. On a
    //    clean database the unique index below is the real arbiter — this read
    //    is what turns a driver-level violation into a clean 409 for the
    //    overwhelmingly common non-racing case, and the only guard left if an
    //    environment could not adopt the index (see schema.js).
    const blocker = blockingJoinedApplication(app.candidate_id, app.id);
    if (blocker) {
      throw new JoinConflict(JOIN_CONFLICT.ALREADY_JOINED_ELSEWHERE, ALREADY_JOINED_MESSAGE, {
        blockingApplicationId: blocker.applicationId,
        blockingRequestId: blocker.requestId,
      });
    }
    if (get('SELECT status FROM application WHERE id=?', [app.id])?.status === APP.JOINED) {
      throw new JoinConflict(JOIN_CONFLICT.ALREADY_JOINED_HERE,
        'This application has already joined.', { applicationId: app.id });
    }

    // 2. STATUS FIRST, so the partial unique index adjudicates before any seat
    //    is committed. A loser writes nothing at all.
    try {
      Applications.setStatus(app.id, APP.JOINED);
    } catch (e) {
      if (isJoinedUniquenessViolation(e)) {
        throw new JoinConflict(JOIN_CONFLICT.ALREADY_JOINED_ELSEWHERE, ALREADY_JOINED_MESSAGE, {
          applicationId: app.id,
        });
      }
      throw e;
    }
    boundary(1);

    // 3. Seat + requisition counter/status. Throws NO_SEAT rather than
    //    overfilling; fillSeatAndCount claims its seat conditionally so two
    //    processes cannot both take the same row.
    const request = Requests.byId(app.request_id);
    const beforeFilled = request.headcount_filled;
    let seatResult;
    try {
      seatResult = fillSeatAndCount(request, app.id);
    } catch (e) {
      if (e?.code === 'NO_SEAT') {
        throw new JoinConflict(JOIN_CONFLICT.NO_SEAT,
          'All vacancies for this request are already filled.', { requestId: request.id });
      }
      throw e;
    }
    boundary(2);

    StageHistory.add(app.id, fromStatus, APP.JOINED, actor, reason);        // 4. history
    boundary(3);

    CandidateActivity.add({                                                 // 5. candidate timeline
      candidateId: app.candidate_id, applicationId: app.id,
      actorId: actor.id, actorName: actor.fullName,
      type: offer ? 'candidate_joined' : 'application_status_changed',
      note: offer ? null : `${fromStatus} → ${APP.JOINED}`,
    });
    boundary(4);

    RequestActivity.add(request.id, actor, 'seat_filled', {                 // 6. request timeline
      note: `${seatResult.filled}/${request.headcount} filled`
        + `${seatResult.newStatus === 'filled' ? ' — request Filled' : ''}`,
    });
    boundary(5);

    if (postToThread) {                                                     // 7. thread (move path)
      const cand = Candidates.byId(app.candidate_id);
      Posts.system(app.request_id,
        `${cand ? cand.full_name : 'Candidate'} moved: ${fromStatus} → ${APP.JOINED}.`,
        { event: 'stage_changed', applicationId: app.id, candidateId: app.candidate_id, fromStatus, toStatus: APP.JOINED },
        actor);
    }
    boundary(6);

    if (offer) {                                                            // 8. offer settlement
      Offers.setStatus(offer.id, 'joined', { joined_at: new Date().toISOString() });
      OfferActivity.add(offer.id, actor, 'joined', { toStatus: 'joined' });
    }
    boundary(7);

    // 9. Audit, STRICT — inside a transaction a swallowed audit failure would
    //    commit the join with no record of it (see the BL-34 note in audit.js).
    const strict = { strict: true };
    writeAudit(req, {
      action: 'application.status_changed', entityType: 'application', entityId: app.id,
      oldValue: { status: fromStatus }, newValue: { status: APP.JOINED },
      comments: reason || (offer ? 'Joined via offer' : null),
    }, strict);
    if (offer) writeAudit(req, { action: 'offer.joined', entityType: 'offer', entityId: offer.id }, strict);
    writeAudit(req, {
      action: 'request.seat_filled', entityType: 'recruitment_request', entityId: request.id,
      newValue: { filled: seatResult.filled, status: seatResult.newStatus },
    }, strict);
    writeAudit(req, {
      action: 'request.vacancy_changed', entityType: 'recruitment_request', entityId: request.id,
      oldValue: { headcountFilled: beforeFilled },
      newValue: {
        headcountFilled: seatResult.filled,
        remaining: request.headcount - seatResult.filled,
        status: seatResult.newStatus,
      },
    }, strict);
    boundary(8);

    return { ...seatResult, application: Applications.byId(app.id) };
  });
}
