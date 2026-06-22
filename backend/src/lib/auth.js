import jwt from 'jsonwebtoken';
import { userContext } from './models.js';

// Fail closed: never sign tokens with a guessable default. In production a real
// secret MUST be provided. A dev fallback is allowed ONLY outside production.
const SECRET = process.env.JWT_SECRET
  || (process.env.NODE_ENV === 'production'
    ? (() => { throw new Error('JWT_SECRET is required in production'); })()
    : 'dev-secret-local-only');

export function signToken(payload, remember = false) {
  const expiresIn = remember
    ? (process.env.JWT_REMEMBER_EXPIRES_IN || '7d')
    : (process.env.JWT_EXPIRES_IN || '2h');
  return jwt.sign(payload, SECRET, { expiresIn });
}

export function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

// Loads full user context (roles + flattened permissions + scopes).
export function loadUserContext(userId) {
  return userContext(userId);
}
