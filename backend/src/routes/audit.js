import { Router } from 'express';
import { Audit } from '../lib/models.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requirePermission('audit.view'));

function out(l) {
  return {
    id: l.id, actorId: l.actor_id, actorName: l.actor_name, actorRole: l.actor_role,
    action: l.action, entityType: l.entity_type, entityId: l.entity_id,
    oldValue: l.old_value ? JSON.parse(l.old_value) : null,
    newValue: l.new_value ? JSON.parse(l.new_value) : null,
    comments: l.comments, ip: l.ip, userAgent: l.user_agent, occurredAt: l.occurred_at,
  };
}

router.get('/', (req, res) => {
  const { action, entityType, actorId, q, page = '1', pageSize = '50' } = req.query;
  const take = Math.min(Number(pageSize) || 50, 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;
  const { total, rows } = Audit.query({
    action, entityType, actorId: actorId ? Number(actorId) : undefined, q, skip, take,
  });
  res.json({ total, page: Number(page), pageSize: take, logs: rows.map(out) });
});

router.get('/facets', (req, res) => res.json(Audit.facets()));

export default router;
