import jwt from 'jsonwebtoken';
import { userContext } from './models.js';

const SECRET = process.env.JWT_SECRET || 'dev-secret';

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
