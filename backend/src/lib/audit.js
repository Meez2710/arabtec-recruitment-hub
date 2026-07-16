import { Audit } from './models.js';

// Append-only audit writer. Never updates/deletes existing rows.
export function writeAudit(req, {
  action, entityType, entityId = null,
  oldValue = null, newValue = null, comments = null,
}) {
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
    console.error('Audit write failed:', e.message);
  }
}
