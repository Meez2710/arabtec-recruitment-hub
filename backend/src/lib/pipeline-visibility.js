import { get } from './db.js';
import { appNorm } from './stages.js';

const FULL_PIPELINE_ROLES = new Set(['system_admin', 'ceo', 'hr_director', 'recruitment_manager', 'recruiter']);
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

export function visibleStageHistory(user, rows) {
  if (hasFullPipelineAccess(user)) return rows;
  const released = rows.filter((h) => RELEASED.includes(appNorm(h.to_status)));
  if (!released.length) return [];
  const first = Math.min(...released.map((h) => Number(h.id)));
  return rows.filter((h) => Number(h.id) >= first && !['sourced', 'new', 'applied'].includes(h.to_status))
    .map((h) => ({ ...h, from_status: ['sourced', 'new', 'applied'].includes(h.from_status) ? null : h.from_status }));
}
