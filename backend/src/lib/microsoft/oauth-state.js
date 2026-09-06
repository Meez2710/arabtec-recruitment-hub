// OAuth 2.0 `state` — CSRF protection for the Microsoft connect flow.
//
// The state is the only thing that ties the browser Microsoft redirects BACK to
// this server to the System Admin who started the flow. It is therefore treated
// like a bearer credential:
//
//   • 32 bytes from crypto.randomBytes — not guessable.
//   • Stored HASHED (sha256). A database leak yields no replayable value, the
//     same reasoning password_reset_token already uses in this schema.
//   • SINGLE USE. Consumed on the first callback; a replayed callback fails.
//   • SHORT LIVED (10 minutes) — long enough to type a password and satisfy MFA.
//   • Bound to the initiating admin's user id AND their session token, so a
//     state issued to one administrator cannot be completed under another's
//     session.

import crypto from 'node:crypto';
import { get, run } from '../db.js';

const TTL_MS = 10 * 60 * 1000;

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/** Issue a state for this admin. Returns the raw value — shown once, to Microsoft. */
export function issueState({ userId, sessionToken = null, redirectUri = null }) {
  const state = crypto.randomBytes(32).toString('base64url');
  // Opportunistic prune: expired rows are useless and nothing else deletes them.
  try { run('DELETE FROM microsoft_oauth_state WHERE expires_at < ?', [new Date().toISOString()]); } catch { /* best effort */ }
  run(`INSERT INTO microsoft_oauth_state (state_hash, user_id, session_hash, redirect_uri, expires_at, created_at)
       VALUES (?,?,?,?,?,?)`,
  [sha256(state), userId, sessionToken ? sha256(sessionToken) : null, redirectUri,
    new Date(Date.now() + TTL_MS).toISOString(), new Date().toISOString()]);
  return state;
}

/**
 * Validate and consume a state.
 *
 * Returns { ok: true, userId } or { ok: false, reason }. Consumption happens on
 * the first VALID match, so a replay of a used state is rejected.
 *
 * `sessionToken` is the session presented on the callback request, if any. The
 * callback is a top-level navigation from login.microsoftonline.com; the app's
 * cookie is SameSite=Lax so it normally arrives. When it does, it MUST match the
 * session that started the flow. When it does not (a browser that dropped it),
 * the state alone is accepted — it is itself an unguessable single-use secret
 * issued only to an authenticated System Admin.
 */
export function consumeState(state, { sessionToken = null } = {}) {
  if (!state || typeof state !== 'string') return { ok: false, reason: 'missing' };
  const row = get('SELECT * FROM microsoft_oauth_state WHERE state_hash=?', [sha256(state)]);
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.consumed_at) return { ok: false, reason: 'already-used' };
  if (new Date(row.expires_at) < new Date()) return { ok: false, reason: 'expired' };
  if (row.session_hash && sessionToken && sha256(sessionToken) !== row.session_hash) {
    return { ok: false, reason: 'session-mismatch' };
  }
  run('UPDATE microsoft_oauth_state SET consumed_at=? WHERE id=? AND consumed_at IS NULL',
    [new Date().toISOString(), row.id]);
  return { ok: true, userId: row.user_id, redirectUri: row.redirect_uri ?? null };
}
