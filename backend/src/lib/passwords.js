// Password policy. One place decides what a valid password is, so the rule is
// identical for self-service change, admin reset and user creation.
//
// Policy (hardened):
//   • minimum 12 characters (floor — the password_min_length system setting may
//     raise this but never lower it)
//   • ALL FOUR character classes: lowercase, uppercase, number, symbol
//   • must not contain the user's name or the local-part of their email
//   • rejects a deny-list of common/known-weak passwords
//
// Not a crypto function — input policy only. Never logs the candidate password.

export const PASSWORD_MIN_LENGTH = 12;

// Lower-cased exact matches. Includes the credentials that were circulated during
// setup, so they can never be re-used.
const COMMON = new Set([
  'password', 'password1', 'passw0rd', 'password123', 'password123!',
  '12345678', '123456789', '1234567890', 'qwerty123', 'qwerty123!',
  'admin123', 'admin@123', 'admin@1234', 'admin@12345', 'administrator',
  'letmein1', 'welcome1', 'welcome123', 'changeme1', 'changeme123',
  'arabtec123', 'arabtec@123', 'arabtec123!', 'arabtec@1234', 'arabtec@12345',
  'iloveyou1', 'sunshine1', 'football1', 'monkey123', 'dragon123',
]);

// Substrings that make a password guessable regardless of decoration.
const WEAK_FRAGMENTS = ['password', 'qwerty', 'arabtec', 'admin@', 'letmein', 'welcome@'];

/**
 * @param {string} pw
 * @param {object} [opts]
 * @param {number} [opts.minLength]  raises the floor; never lowers it
 * @param {string} [opts.fullName]   reject passwords containing the user's name
 * @param {string} [opts.email]      reject passwords containing the email local-part
 */
export function validatePassword(pw, { minLength, fullName, email } = {}) {
  const s = String(pw || '');
  const min = Math.max(PASSWORD_MIN_LENGTH, Number(minLength) || 0);

  if (s.length < min) return { ok: false, error: `Password must be at least ${min} characters.` };
  if (s.length > 200) return { ok: false, error: 'Password is too long.' };

  const lower = s.toLowerCase();
  if (COMMON.has(lower)) {
    return { ok: false, error: 'That password is too common. Choose something less guessable.' };
  }

  const missing = [];
  if (!/[a-z]/.test(s)) missing.push('a lowercase letter');
  if (!/[A-Z]/.test(s)) missing.push('an uppercase letter');
  if (!/[0-9]/.test(s)) missing.push('a number');
  if (!/[^A-Za-z0-9]/.test(s)) missing.push('a symbol');
  if (missing.length) {
    return { ok: false, error: `Password must include ${missing.join(', ')}.` };
  }

  for (const frag of WEAK_FRAGMENTS) {
    if (lower.includes(frag)) {
      return { ok: false, error: 'Password contains a commonly-guessed word. Choose something less predictable.' };
    }
  }

  // Must not contain the account holder's own identity.
  const localPart = String(email || '').split('@')[0].toLowerCase();
  if (localPart.length >= 3 && lower.includes(localPart)) {
    return { ok: false, error: 'Password must not contain your email address.' };
  }
  for (const part of String(fullName || '').toLowerCase().split(/[^a-z]+/)) {
    if (part.length >= 3 && lower.includes(part)) {
      return { ok: false, error: 'Password must not contain your name.' };
    }
  }

  return { ok: true };
}

// Shared with the client so the browser can show the same rules before submitting.
export const PASSWORD_RULES = [
  `At least ${PASSWORD_MIN_LENGTH} characters`,
  'An uppercase letter',
  'A lowercase letter',
  'A number',
  'A symbol',
  'Not your name or email address',
];
