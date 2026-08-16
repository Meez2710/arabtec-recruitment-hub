// Retention enforcement — the scheduled half of the GDPR/PDPL story.
//
// The reporting half already existed: `GET /candidates/privacy/retention` lists
// candidates whose window has lapsed, and `POST /candidates/:id/erase` erases
// one. Nothing ever ran on a schedule, so retention depended on a person
// remembering — which is a policy gap, not a code bug, right up until an
// auditor asks how it is enforced.
//
// OFF BY DEFAULT, DELIBERATELY. Erasure is destructive and irreversible for the
// erased fields; nobody should discover it running because they deployed. An
// operator opts in with RETENTION_ENFORCEMENT=true, and can watch it first with
// RETENTION_DRY_RUN=true, which reports exactly what it would erase and touches
// nothing.
//
// Erasure here is the SAME `Candidates.erase` a person triggers: personal
// fields are cleared and CV binaries deleted, but the row survives as
// `candidate_state='erased'` so audit trail, counts and foreign keys stay
// intact. Retention removes personal data; it does not rewrite history.

import { Audit, Candidates, CandidateActivity } from './models.js';

const log = (level, msg, extra = {}) => {
  console.log(JSON.stringify({ level, msg, ...extra }));
};

/** The actor recorded against an automatic erasure. Never a real user. */
const SYSTEM_ACTOR = { id: null, name: 'system (retention policy)' };

const enabled = () => String(process.env.RETENTION_ENFORCEMENT || '').toLowerCase() === 'true';
const dryRun = () => String(process.env.RETENTION_DRY_RUN || '').toLowerCase() === 'true';

/**
 * Erase every candidate whose retention window has lapsed.
 *
 * Each candidate is erased in its own step and its own audit entry, so one
 * failure cannot abandon the rest of the sweep half-done — the next run simply
 * picks up whatever is still overdue.
 *
 * @param {{ dry?: boolean }} [opts]
 * @returns {{ overdue: number, erased: number, failed: number, dry: boolean, candidates: Array }}
 */
export function runRetentionSweep(opts = {}) {
  const dry = opts.dry ?? dryRun();
  const overdue = Candidates.retentionOverdue();
  const result = { overdue: overdue.length, erased: 0, failed: 0, dry, candidates: [] };

  for (const c of overdue) {
    // Identify by candidate number, never by name: this log line outlives the
    // personal data it would otherwise quote.
    const ref = { candidateId: c.id, candidateNo: c.candidate_no, retentionUntil: c.retention_until };
    result.candidates.push(ref);
    if (dry) continue;
    try {
      Candidates.erase(c.id);
      CandidateActivity.add({
        candidateId: c.id, actorId: null, actorName: SYSTEM_ACTOR.name,
        type: 'data_erased', note: `Erased automatically — retention window lapsed ${c.retention_until}`,
      });
      Audit.write({
        actorId: null, actorName: SYSTEM_ACTOR.name, actorRole: 'system',
        action: 'candidate.data_erased', entityType: 'candidate', entityId: c.id,
        oldValue: null,
        newValue: { reason: 'retention_policy', retentionUntil: c.retention_until },
        comments: 'Automatic retention enforcement', ip: null, userAgent: null,
      });
      result.erased += 1;
    } catch (e) {
      result.failed += 1;
      log('error', 'retention.erase_failed', { ...ref, detail: e.message });
    }
  }

  if (result.overdue > 0) {
    log(result.failed > 0 ? 'warn' : 'info', 'retention.sweep', {
      overdue: result.overdue, erased: result.erased, failed: result.failed, dryRun: dry,
    });
  }
  return result;
}

let timer = null;

/**
 * Start the scheduled sweep. Idempotent, and a no-op unless enabled.
 *
 * Called from the boot block next to the CV watcher, so there is one place
 * where background work starts.
 */
export function startRetentionEnforcement() {
  if (timer !== null) return getRetentionStatus();
  if (!enabled()) {
    log('info', 'retention.disabled', {
      detail: 'Set RETENTION_ENFORCEMENT=true to erase lapsed candidates automatically.',
    });
    return getRetentionStatus();
  }
  const hours = Math.max(Number(process.env.RETENTION_SWEEP_HOURS || 24), 1);
  log('info', 'retention.enabled', { everyHours: hours, dryRun: dryRun() });
  // First sweep shortly after boot rather than immediately, so a crash-looping
  // deploy cannot erase on every restart.
  timer = setInterval(() => {
    try { runRetentionSweep(); } catch (e) { log('error', 'retention.sweep_failed', { detail: e.message }); }
  }, hours * 60 * 60 * 1000);
  timer.unref?.();
  return getRetentionStatus();
}

export function stopRetentionEnforcement() {
  if (timer !== null) { clearInterval(timer); timer = null; }
}

/** For /api/health and the runbook — states what is actually configured. */
export function getRetentionStatus() {
  return {
    enforcement: enabled() ? 'scheduled' : 'manual',
    dryRun: dryRun(),
    everyHours: enabled() ? Math.max(Number(process.env.RETENTION_SWEEP_HOURS || 24), 1) : null,
    running: timer !== null,
  };
}
