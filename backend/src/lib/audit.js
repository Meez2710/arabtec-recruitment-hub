import { Audit } from './models.js';

// Append-only audit writer. Never updates/deletes existing rows.
export function writeAudit(req, {
  action, entityType, entityId = null,
  oldValue = null, newValue = null, comments = null,
}, { strict = false } = {}) {
  const actor = req.user || null;
  try {
    Audit.write({
      actorId: actor?.id ?? null,
      actorName: actor?.fullName ?? null,
      actorRole: actor?.roles?.[0] ?? null,
      action, entityType, entityId, oldValue, newValue, comments,
      ip: req.ip, userAgent: req.headers?.['user-agent'] || null,
    });
  } catch (e) {
    // BL-34: this helper swallows write failures so a broken audit trail cannot
    // take down an ordinary request. That is the wrong trade INSIDE a
    // transaction: swallowing would let the operation commit with no audit
    // record, and on Postgres the transaction is already aborted by the failed
    // statement, so every later write fails anyway with a far less obvious
    // error.
    //
    // `strict` is the smallest scoped fix — opted into only by call sites that
    // run inside tx(). The full BL-34 remediation is NOT done here.
    if (strict) throw e;
    console.error('Audit write failed:', e.message);
  }
}
