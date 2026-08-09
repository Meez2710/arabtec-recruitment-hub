// Retention policy for CV bytes and derived artifacts.
//
// WHY THIS EXISTS AS A MODULE. Retention was previously an implicit property of
// wherever a file happened to be written: intake blobs inherited the general
// upload policy, and temporary conversion files inherited whatever the OS did
// with a temp directory. Neither was stated, configurable, or testable, so
// "how long do we keep a CV that was never confirmed" had no answer.
//
// A CV is personal data. Under GDPR and the Egyptian PDPL the defensible
// position is that every class of it has a stated lifetime and something
// actually enforces that lifetime.
//
// EVERY WINDOW IS CONFIGURABLE. The defaults below are the policy the Stage 2
// hardening batch proposes; operators override per deployment. Nothing here
// touches CONFIRMED candidate records — those follow the existing ATS retention
// policy and are deliberately out of this module's scope.

/** Parse a duration env var expressed in hours. Invalid input falls back. */
function hours(name, fallbackHours) {
  const raw = process.env[name];
  if (typeof raw !== 'string' || raw.trim() === '') return fallbackHours * 3600_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallbackHours * 3600_000;
  return n * 3600_000;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export const RETENTION = Object.freeze({
  /**
   * Temporary conversion and OCR working files.
   *
   * IMMEDIATE. Not "cleaned up nightly" — deleted on every exit path of the
   * request that created them, including the error paths. The Docling sidecar
   * already uses a TemporaryDirectory context manager for exactly this reason;
   * this flag exists so the guarantee is stated rather than incidental.
   */
  tempFilesImmediate: bool('RETENTION_TEMP_IMMEDIATE', true),

  /**
   * Uploads whose intake failed or was cancelled. 24 hours.
   *
   * Not zero: a failed parse is the case an engineer most often needs to
   * reproduce, and a support request rarely arrives within the hour. A day is
   * long enough to diagnose and short enough that a rejected file is not
   * sitting in object storage a week later.
   */
  failedUploadMs: hours('RETENTION_FAILED_UPLOAD_HOURS', 24),

  /**
   * Parsed but unconfirmed drafts — a CV uploaded, extracted, and then left
   * un-reviewed. 7 days.
   *
   * This is the largest privacy exposure in the intake flow: data the
   * organisation holds about a person who was never actually entered into the
   * ATS, often because the recruiter changed their mind. It must expire on its
   * own.
   */
  unconfirmedDraftMs: hours('RETENTION_UNCONFIRMED_DRAFT_HOURS', 24 * 7),

  /**
   * Confirmed candidates: NOT governed here. The existing ATS retention policy
   * applies. This module must never delete a confirmed record — that would be
   * data loss dressed as privacy.
   */
  confirmedGovernedElsewhere: true,

  /**
   * No CV content in logs (ACCEPTANCE_CRITERIA §7 #12). Enforced at the log
   * call sites; this flag lets a deployment assert it and lets tests read it.
   */
  redactDocumentContentInLogs: bool('RETENTION_REDACT_LOGS', true),
});

/**
 * Classify a stored intake artifact for the sweeper.
 *
 * Pure and side-effect free so the policy can be tested without a database.
 *
 * @param {{state: string, updatedAt: number|Date, confirmed?: boolean}} item
 * @param {number} nowMs
 * @returns {{action: 'keep'|'delete', reason: string, ageMs: number}}
 */
export function classify(item, nowMs = Date.now()) {
  const updated = item.updatedAt instanceof Date
    ? item.updatedAt.getTime()
    : Number(item.updatedAt);
  const ageMs = nowMs - updated;

  if (item.confirmed === true || item.state === 'confirmed') {
    return { action: 'keep', reason: 'confirmed — governed by ATS retention policy', ageMs };
  }
  if (item.state === 'failed' || item.state === 'cancelled') {
    return ageMs >= RETENTION.failedUploadMs
      ? { action: 'delete', reason: 'failed/cancelled upload past 24h window', ageMs }
      : { action: 'keep', reason: 'failed/cancelled upload within window', ageMs };
  }
  if (item.state === 'draft' || item.state === 'parsed' || item.state === 'unconfirmed') {
    return ageMs >= RETENTION.unconfirmedDraftMs
      ? { action: 'delete', reason: 'unconfirmed draft past 7d window', ageMs }
      : { action: 'keep', reason: 'unconfirmed draft within window', ageMs };
  }
  // Unknown state: keep. Deleting on an unrecognised state is how a retention
  // sweep becomes an outage.
  return { action: 'keep', reason: `unknown state '${item.state}' — keeping`, ageMs };
}

/**
 * Plan a sweep. Returns what WOULD be deleted; the caller performs deletion.
 * Separating plan from execution keeps the policy unit-testable and makes a
 * dry run the default posture for a destructive job.
 */
export function planSweep(items, nowMs = Date.now()) {
  const decisions = items.map((i) => ({ id: i.id, ...classify(i, nowMs) }));
  return {
    total: items.length,
    toDelete: decisions.filter((d) => d.action === 'delete'),
    toKeep: decisions.filter((d) => d.action === 'keep'),
    policy: {
      failedUploadHours: RETENTION.failedUploadMs / 3600_000,
      unconfirmedDraftHours: RETENTION.unconfirmedDraftMs / 3600_000,
    },
  };
}

/** Operator-facing summary. Never logs an id alongside document content. */
export function describePolicy() {
  return [
    `temp conversion/OCR files: ${RETENTION.tempFilesImmediate ? 'deleted immediately' : 'DEFERRED (not recommended)'}`,
    `failed/cancelled uploads:  ${RETENTION.failedUploadMs / 3600_000}h`,
    `unconfirmed drafts:        ${RETENTION.unconfirmedDraftMs / 3600_000}h`,
    'confirmed candidates:      existing ATS retention policy (not swept here)',
    `CV content in logs:        ${RETENTION.redactDocumentContentInLogs ? 'redacted' : 'NOT REDACTED (violates ACCEPTANCE_CRITERIA §7 #12)'}`,
  ].join('\n');
}
