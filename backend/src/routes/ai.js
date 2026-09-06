import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { all } from '../lib/db.js';
import { capabilitiesFor, runAnyhelp } from '../lib/ai/anyhelp.js';

const BODY_BYTES = 32 * 1024;
const inputSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']), content: z.string().min(1).max(8000),
  }).strict()).max(8).default([]),
  contextRequestId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().default(null),
}).strict();

// Mounted before the application's general JSON parser, so oversized AI
// requests never get its larger allocation. Also usable by standalone routers.
export const aiJson = express.json({ limit: BODY_BYTES });
export function aiJsonError(error, _req, res, next) {
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'anyhelp request is too large.' });
  if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON request.' });
  next(error);
}

function configuredClient() {
  return process.env.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0, timeout: 40000 })
    : null;
}

export function createAiRouter({ client = configuredClient(), model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6', timeoutMs = 45000, maxRequests = 10, windowMs = 60000 } = {}) {
  const router = express.Router();
  // Limits are per authenticated user, per process (same deployment model as
  // the global limiter). A multi-instance deployment needs a shared limiter.
  const hits = new Map();
  const active = new Map();
  router.use(requireAuth);
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.use(aiJson, aiJsonError);
  router.get('/capabilities', (req, res) => res.json({ ...capabilitiesFor(req.user), configured: Boolean(client) }));
  router.post('/chat', async (req, res) => {
    if (Buffer.byteLength(JSON.stringify(req.body ?? {}), 'utf8') > BODY_BYTES) return res.status(413).json({ error: 'anyhelp request is too large.' });
    const parsed = inputSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Use a message of 1–4000 characters and at most 8 prior text messages.' });
    if (!client) return res.status(503).json({ error: 'anyhelp is not configured. Ask an administrator to configure the AI provider.', code: 'AI_UNAVAILABLE' });
    const userId = req.user.id;
    const now = Date.now();
    for (const [id, hit] of hits) if (now - hit.start >= windowMs) hits.delete(id);
    if (active.has(userId)) return res.status(429).set('Retry-After', '2').json({ error: 'anyhelp is already answering your previous message.', code: 'AI_BUSY' });
    const hit = hits.get(userId) || { start: now, count: 0 };
    if (hit.count >= maxRequests) return res.status(429).set('Retry-After', String(Math.max(1, Math.ceil((windowMs - now + hit.start) / 1000)))).json({ error: 'anyhelp has reached your request limit. Please wait a minute.', code: 'AI_RATE_LIMIT' });
    hit.count++;
    hits.set(userId, hit);
    const controller = new AbortController();
    active.set(userId, controller);
    const abort = () => controller.abort();
    const onClose = () => { if (!res.writableEnded) abort(); };
    req.once('aborted', abort);
    res.once('close', onClose);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
    const aborted = new Promise((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true }));
    try {
      const result = await Promise.race([
        runAnyhelp({ client, model, user: req.user, all, ...parsed.data, signal: controller.signal }), aborted,
      ]);
      if (!res.destroyed) res.json(result);
    } catch (error) {
      if (res.destroyed) return;
      if (timedOut) return res.status(504).json({ error: 'anyhelp took too long. Try a narrower question.', code: 'AI_TIMEOUT' });
      if (controller.signal.aborted) return res.status(499).json({ error: 'anyhelp was cancelled.', code: 'AI_CANCELLED' });
      const code = ['AI_LIMIT', 'AI_EMPTY'].includes(error?.code) ? error.code : 'AI_PROVIDER_ERROR';
      // Never serialize SDK errors, request headers, provider bodies or prompts.
      return res.status(502).json({ error: code === 'AI_LIMIT' ? 'anyhelp reached its reading limit. Try a narrower question.' : 'anyhelp could not answer. Please try again.', code });
    } finally {
      clearTimeout(timer);
      req.off('aborted', abort);
      res.off('close', onClose);
      if (active.get(userId) === controller) active.delete(userId);
    }
  });
  return router;
}

export default createAiRouter();
