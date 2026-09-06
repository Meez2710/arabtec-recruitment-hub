// AES-256-GCM envelope for the MSAL token cache.
//
// WHAT IS BEING PROTECTED. The serialized MSAL cache contains a refresh token
// for career@arabtecegy.com. Anyone holding it can read and send mail as that
// mailbox until it is revoked, so it must not sit in the database as plaintext
// the way a settings value would. A database dump, a backup tarball or a
// mis-scoped `SELECT` therefore yields ciphertext and nothing else.
//
// GCM, not CBC: the authentication tag means a tampered blob fails to decrypt
// rather than deserializing into something MSAL then trusts.
//
// The key lives ONLY in the environment (MICROSOFT_TOKEN_ENCRYPTION_KEY) — never
// in the database, never in the repo, never in a log line.

import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;   // 96-bit nonce, the GCM standard
const KEY_BYTES = 32;  // AES-256
const VERSION = 'v1';

export class TokenEncryptionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TokenEncryptionError';
    this.code = code; // 'missing-key' | 'invalid-key' | 'corrupt'
  }
}

/**
 * Read and validate the encryption key.
 *
 * Accepts 64 hex characters or base64 — both are natural outputs of
 * `openssl rand -hex 32` / `openssl rand -base64 32`, and requiring one exact
 * spelling is how an operator ends up storing a key that "looks fine" and fails
 * at the first sync instead of at boot.
 */
export function encryptionKey() {
  const raw = (process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY || '').trim();
  if (!raw) {
    throw new TokenEncryptionError(
      'MICROSOFT_TOKEN_ENCRYPTION_KEY is not set. Generate one with `openssl rand -hex 32`.',
      'missing-key',
    );
  }
  let key = null;
  if (/^[0-9a-f]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
  else {
    try {
      const decoded = Buffer.from(raw, 'base64');
      if (decoded.length === KEY_BYTES) key = decoded;
    } catch { /* falls through to the error below */ }
  }
  if (key === null || key.length !== KEY_BYTES) {
    throw new TokenEncryptionError(
      'MICROSOFT_TOKEN_ENCRYPTION_KEY must be 32 bytes — 64 hex characters or base64. '
      + 'Generate one with `openssl rand -hex 32`.',
      'invalid-key',
    );
  }
  return key;
}

/** True when a usable key is present. Used by startup validation and status. */
export function hasEncryptionKey() {
  try { encryptionKey(); return true; } catch { return false; }
}

/** plaintext (utf-8 string) -> "v1.<iv>.<tag>.<ciphertext>", all base64. */
export function encrypt(plaintext) {
  const key = encryptionKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), body.toString('base64')].join('.');
}

/** Inverse of encrypt(). Throws TokenEncryptionError('corrupt') on any tampering. */
export function decrypt(envelope) {
  const key = encryptionKey();
  const parts = String(envelope || '').split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new TokenEncryptionError('The stored token cache is not a recognised envelope.', 'corrupt');
  }
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(parts[1], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, or a modified blob. Never echo the ciphertext.
    throw new TokenEncryptionError(
      'The stored token cache could not be decrypted. It was written with a different '
      + 'MICROSOFT_TOKEN_ENCRYPTION_KEY, or it has been altered. Reconnect Microsoft 365.',
      'corrupt',
    );
  }
}

/** Does this string look like one of our envelopes (not plaintext JSON)? */
export function isEncryptedEnvelope(value) {
  return typeof value === 'string' && /^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(value);
}
