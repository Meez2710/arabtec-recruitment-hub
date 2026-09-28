// Panel clash detection for the interview calendar.
//
// Pure on purpose: no database, no clock, no request. The route loads the
// candidate interviews and hands them in, so every rule here is testable with
// plain objects (see interview_calendar_test.mjs).
//
// A clash is a WARNING, never a block. Panels overlap deliberately (a hiring
// manager sitting in on two back-to-back rounds, a lead joining for ten
// minutes), and the ATS exists to speed hiring up, not to add gates nobody
// asked for. The scheduler sees the clash and decides.

// Statuses that still occupy the interviewer's time. `rescheduled` is an
// interview that moved to a new slot and is still going ahead; cancelled,
// completed and no-show interviews no longer hold anyone.
export const ACTIVE_STATUSES = ['scheduled', 'rescheduled'];

// Longest interview the calendar will consider when widening the lookup
// window. Anything that started more than this long before the proposal
// cannot still be running when it begins.
export const MAX_DURATION_MIN = 8 * 60;

/**
 * Turn an ISO start and a length in minutes into a half-open interval in
 * epoch milliseconds: [start, end). Returns null for an unusable start.
 */
export function intervalOf(startIso, durationMin) {
  const start = new Date(startIso).getTime();
  if (!Number.isFinite(start)) return null;
  const minutes = Number(durationMin) > 0 ? Number(durationMin) : 60;
  return { start, end: start + minutes * 60000 };
}

/**
 * Which proposed panel members are already booked at the proposed time?
 *
 * @param {{ start: string, durationMin: number, panel: number[], excludeId?: number }} proposal
 *   `panel` is the list of interviewer user ids being booked; `excludeId` is
 *   the interview being edited, which must not clash with itself.
 * @param {Array<{ id: number, status: string, scheduledAt: string, durationMin: number,
 *                 panel: Array<{ id: number, name: string }> }>} existing
 *   Interviews near the proposed time, as the route loaded them.
 * @returns {Array<{ interviewerId: number, name: string, interviewId: number, start: string, end: string }>}
 *   One entry per (interviewer, clashing interview), `start`/`end` as ISO strings.
 */
export function findPanelClashes(proposal, existing) {
  const wanted = intervalOf(proposal.start, proposal.durationMin);
  if (!wanted) return [];
  const panel = new Set((proposal.panel || []).map(Number));
  const clashes = [];
  for (const iv of existing) {
    if (iv.id === proposal.excludeId || !ACTIVE_STATUSES.includes(iv.status)) continue;
    const held = intervalOf(iv.scheduledAt, iv.durationMin);
    // Half-open intervals: strict `<` on both sides, so back-to-back
    // (10:00–11:00 then 11:00–12:00) is not a clash.
    if (!held || !(wanted.start < held.end && held.start < wanted.end)) continue;
    for (const member of iv.panel || []) {
      if (!panel.has(Number(member.id))) continue;
      clashes.push({ interviewerId: member.id, name: member.name, interviewId: iv.id,
        start: new Date(held.start).toISOString(), end: new Date(held.end).toISOString() });
    }
  }
  return clashes;
}
