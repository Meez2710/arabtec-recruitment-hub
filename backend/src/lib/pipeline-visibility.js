import { get } from './db.js';
import { appNorm } from './stages.js';

// hr_manager added 25 Oct 2026 (audit F4): the role links and moves candidates,
// so it must also see them before Shortlisted — it could not, and its moves on
// sourced candidates 404'd.
const FULL_PIPELINE_ROLES = new Set(['system_admin', 'ceo', 'hr_director', 'hr_manager', 'recruitment_manager', 'recruiter']);
export const hasFullPipelineAccess = (user) => (user?.roles || []).some((role) => FULL_PIPELINE_ROLES.has(role));
const RELEASED = ['shortlisted', 'matched', 'unmatched', 'interviewing', 'waiting_feedback', 'issuing_offer', 'offer_sent', 'joined'];
const LEGACY_RELEASED = ['screened', 'cv_screening', 'interview_1', 'interview_2', 'final_interview', 'phone_interview', 'technical_interview', 'client_interview', 'reference_check', 'offer_preparation', 'offer_accepted'];
const SIDE = ['rejected', 'offer_declined', 'offer_rejected', 'withdrawn', 'on_hold'];
const sqlList = (xs) => xs.map((s) => `'${s}'`).join(',');

// This is an additional visibility boundary, never a replacement for request
// ownership, panel membership or the route's permission checks.
export function applicationVisibilitySql(user, alias = 'a') {
  if (hasFullPipelineAccess(user)) return '1=1';
  const released = sqlList([...RELEASED, ...LEGACY_RELEASED]);
  return `(${alias}.status IN (${released}) OR (${alias}.status IN (${sqlList(SIDE)}) AND EXISTS
    (SELECT 1 FROM application_stage_history pvh WHERE pvh.application_id=${alias}.id AND pvh.to_status IN (${released}))))`;
}

export function canSeeApplicationStage(user, application) {
  if (hasFullPipelineAccess(user)) return true;
  const a = application?.status ? application : application?.id ? get('SELECT id,status FROM application WHERE id=?', [application.id]) : null;
  if (!a) return false;
  if (RELEASED.includes(appNorm(a.status))) return true;
  return SIDE.includes(a.status) && !!get(`SELECT 1 FROM application a WHERE a.id=? AND ${applicationVisibilitySql(user)} LIMIT 1`, [a.id]);
}

/**
 * True exactly once per application: when its stage history first holds a
 * stage stakeholders may see. Call AFTER the history row for the move/create
 * has been written. This is the release point that notifies the request's
 * stakeholders — linking and Sourcing work never do.
 */
export const isReleasedStatus = (status) => RELEASED.includes(appNorm(status)) || LEGACY_RELEASED.includes(status);
export function isFirstRelease(applicationId) {
  const released = sqlList([...RELEASED, ...LEGACY_RELEASED]);
  const row = get(`SELECT COUNT(*) AS n FROM application_stage_history WHERE application_id=? AND to_status IN (${released})`, [applicationId]);
  return Number(row?.n) === 1;
}

export function visibleStageHistory(user, rows) {
  if (hasFullPipelineAccess(user)) return rows;
  const released = rows.filter((h) => RELEASED.includes(appNorm(h.to_status)));
  if (!released.length) return [];
  const first = Math.min(...released.map((h) => Number(h.id)));
  return rows.filter((h) => Number(h.id) >= first && !['sourced', 'new', 'applied'].includes(h.to_status))
    .map((h) => ({ ...h, from_status: ['sourced', 'new', 'applied'].includes(h.from_status) ? null : h.from_status }));
}
