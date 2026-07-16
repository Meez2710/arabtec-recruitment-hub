// Notifications API (C2.3). Each user sees only their own notifications.
import { Router } from 'express';
import { Notifications } from '../lib/models.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

function serialize(n) {
  return {
    id: n.id, type: n.type, title: n.title, body: n.body,
    linkType: n.link_type, linkId: n.link_id,
    isRead: !!n.is_read, createdAt: n.created_at, readAt: n.read_at,
  };
}

// GET /api/notifications  → my notifications + unread count
router.get('/', (req, res) => {
  const unreadOnly = req.query.unread === '1';
  const list = Notifications.forUser(req.user.id, { unreadOnly });
  res.json({ notifications: list.map(serialize), unreadCount: Notifications.unreadCount(req.user.id) });
});

// POST /api/notifications/:id/read
router.post('/:id/read', (req, res) => {
  Notifications.markRead(Number(req.params.id), req.user.id);
  res.json({ ok: true, unreadCount: Notifications.unreadCount(req.user.id) });
});

// POST /api/notifications/read-all
router.post('/read-all', (req, res) => {
  Notifications.markAllRead(req.user.id);
  res.json({ ok: true, unreadCount: 0 });
});

export default router;
